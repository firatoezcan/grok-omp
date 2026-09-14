#!/usr/bin/env bun
/**
 * grok-omp-bridge — ACP adapter between the Grok pager (client) and an ACP agent
 * (child, `omp acp` by default).
 *
 * WHY THIS EXISTS
 * ---------------
 * OMP's ACP server is almost the right backend for the Grok TUI, but three
 * things break at the seam, all fixable without touching either side's source:
 *
 *   1. Client delegation. OMP routes `fs/read_text_file`, `fs/write_text_file`
 *      and the `terminal/*` family through the client when the client
 *      advertises those capabilities (src/session/client-bridge.ts). The Grok
 *      pager advertises `terminal` but its handler answers only five variants
 *      and swallows the rest, so the agent's request hangs. We strip the
 *      capabilities in the client's `initialize` instead of trusting either
 *      side to stay well-behaved.
 *   2. Identity. Grok's TUI classifies tool calls from `kind`, `title`, and
 *      `raw_input.variant` (see xai-grok-pager/src/acp/tracker.rs). OMP sets a
 *      human `title` ("Reading 1 file") and a coarse ACP `kind`, so several
 *      tools land in the generic bucket. We rewrite those fields to the
 *      vocabulary Grok's dispatch expects and stamp the canonical
 *      `_meta["x.ai/tool"]` identity envelope.
 *   3. Evidence. Nothing here records ACP frames, so a rendering bug has no
 *      reproducible fixture. Every forwarded frame is taped, and a tape can be
 *      replayed as a deterministic agent with no model and no network.
 *
 * INVARIANTS (safe-proxy rules — see SPEC.md §7.3)
 * -----------------------------------------------
 *   - Whole lines only. Never buffer across a frame boundary.
 *   - `id` values are preserved; unknown methods and malformed frames are
 *     forwarded verbatim so the two sides can still fail on their own terms.
 *   - Cross-direction ordering is preserved: one output writer per direction,
 *     writes serialized through a single queue.
 *   - Rewriting is opt-out (`--no-hygiene`, `--no-shape`) so a fidelity
 *     difference can always be attributed to the adapter or to the agent.
 *
 * USAGE
 *   bun bridge/adapter.mjs                       # spawn `omp acp`, forward, shape
 *   bun bridge/adapter.mjs --agent "omp acp"
 *   bun bridge/adapter.mjs --tape tapes/x.acptape
 *   bun bridge/adapter.mjs --replay tapes/x.acptape     # deterministic agent
 *   bun bridge/adapter.mjs --replay tapes/x.acptape --selfcheck
 *
 * The pager reaches this through `--agent-command "bun bridge/adapter.mjs"`.
 */

import { appendFileSync, closeSync, cpSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { execFile } from "node:child_process";
import { Database } from "bun:sqlite";

const BRIDGE_NAME = "grok-omp-bridge";
const BRIDGE_VERSION = "0.1.0";
const TAPE_FORMAT = "acp-tape-v1";

// ---------------------------------------------------------------------------
// argv
// ---------------------------------------------------------------------------

/** @returns {{agent: string, tape: string|null, replay: string|null, selfcheck: boolean, hygiene: boolean, shape: boolean, quiet: boolean}} */
function parseArgs(argv) {
	const opts = {
		agent: process.env.OMP_ACP_CMD || "omp acp",
		tape: process.env.OMP_BRIDGE_TAPE || null,
		replay: null,
		selfcheck: false,
		hygiene: true,
		shape: true,
		mcp: true,
		allowStale: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		switch (arg) {
			case "--agent":
			case "--agent-command":
				opts.agent = argv[++i];
				break;
			case "--tape":
				opts.tape = argv[++i];
				break;
			case "--replay":
				opts.replay = argv[++i];
				break;
			case "--selfcheck":
				opts.selfcheck = true;
				break;
			case "--no-hygiene":
				opts.hygiene = false;
				break;
			case "--no-shape":
				opts.shape = false;
				break;
			case "--no-mcp":
				opts.mcp = false;
				break;
			case "--allow-stale":
				opts.allowStale = true;
				break;
			case "--quiet":
				opts.quiet = true;
				break;
			case "-h":
			case "--help":
				process.stdout.write(helpText());
				process.exit(0);
			default:
				fail(`unknown argument: ${arg}`);
		}
	}
	if (opts.selfcheck && !opts.replay) fail("--selfcheck requires --replay <tape>");
	return opts;
}

function helpText() {
	return `grok-omp-bridge ${BRIDGE_VERSION} — ACP adapter (client <-> agent)

  --agent <cmd>     child command to spawn (default: "omp acp")
  --tape <path>     record every forwarded frame as .acptape JSONL
  --replay <path>   serve a tape instead of spawning a child (no model, no net)
  --selfcheck       with --replay: assert two replays are byte-identical
  --no-hygiene      do not rewrite client capabilities
  --no-shape        do not rewrite tool-call identity
  --no-mcp          strip mcpServers from session/new (hermetic test fixtures)
  --allow-stale     replay a tape recorded against a different sourceRev
`;
}

function log(msg) {
	if (!optsRef.quiet) process.stderr.write(`[${BRIDGE_NAME}] ${msg}\n`);
}

function fail(msg) {
	process.stderr.write(`[${BRIDGE_NAME}] fatal: ${msg}\n`);
	process.exit(2);
}

/** Set by main() before anything logs. */
const optsRef = { quiet: false, shape: true };

// ---------------------------------------------------------------------------
// tape
// ---------------------------------------------------------------------------

/**
 * Source revision of the tree under test, so a stale tape is detectable.
 * Resolved from the bridge's own location, not the working directory: the pager
 * spawns the child in whatever directory the session uses, which is usually not
 * the repo.
 */
function sourceRev() {
	const roots = [resolve(import.meta.dir, ".."), process.cwd()];
	for (const root of roots) {
		const path = resolve(root, "SOURCE_REV");
		if (existsSync(path)) return readFileSync(path, "utf8").trim();
	}
	return null;
}

/**
 * Records every frame crossing the adapter in one file with a single
 * cross-direction `seq` counter — two counters would destroy the interleaving
 * that makes a TUI test deterministic.
 *
 * The header is written lazily, on the first frame, so it can name the client.
 * That identity matters: ACP request ids are client-local, so a tape replays
 * only for the client that recorded it, and a mismatch should be diagnosable
 * from the file rather than from a failed replay.
 */
class Tape {
	constructor(path, header) {
		this.path = path;
		this.seq = 0;
		this.header = { type: "header", format: TAPE_FORMAT, ...header };
		this.headerWritten = false;
		mkdirSync(dirname(resolve(path)), { recursive: true });
	}

	record(dir, frame, raw) {
		if (!this.headerWritten) {
			// The pager sends no `clientInfo`; it identifies itself under
			// `params._meta.clientType`. Accept either so the header names the
			// client that owns this tape's id space.
			if (frame && typeof frame === "object") {
				const info = frame.params?.clientInfo;
				const clientType = frame.params?._meta?.clientType;
				if (info?.name || clientType) {
					this.header.client = { name: info?.name ?? clientType, version: info?.version ?? null };
				}
			}
			writeFileSync(this.path, `${JSON.stringify(this.header)}\n`);
			this.headerWritten = true;
		}
		const entry = {
			dir,
			t: Date.now() - this.startedAt(),
			seq: this.seq++,
			kind: frameKind(frame),
			id: frame && typeof frame === "object" && frame.id !== undefined ? frame.id : null,
			method: frame && typeof frame === "object" && typeof frame.method === "string" ? frame.method : null,
			frame: frame === undefined ? { __raw: raw } : frame,
		};
		appendFileSync(this.path, `${JSON.stringify(entry)}\n`);
	}

	startedAt() {
		this._start ??= Date.now();
		return this._start;
	}
}

function frameKind(frame) {
	if (!frame || typeof frame !== "object") return "raw";
	if (typeof frame.method === "string") return frame.id === undefined ? "notification" : "request";
	if (frame.error !== undefined) return "error";
	return "response";
}

function readTape(path) {
	const text = readFileSync(path, "utf8");
	const entries = [];
	let header = null;
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		const parsed = JSON.parse(line);
		if (parsed.type === "header") {
			header = parsed;
			continue;
		}
		entries.push(parsed);
	}
	return { header, entries };
}

// ---------------------------------------------------------------------------
// hygiene: stop OMP delegating fs/terminal to a client that drops them
// ---------------------------------------------------------------------------

/**
 * Rewrite the client's advertised capabilities so OMP's ClientBridge never
 * routes file or terminal work back through the pager. Mutates `frame`.
 * @returns {string[]} names of the capabilities removed, for the log
 */
function applyHygiene(frame) {
	const caps = frame?.params?.clientCapabilities;
	if (!caps || typeof caps !== "object") return [];
	const removed = [];
	if (caps.fs !== undefined) {
		delete caps.fs;
		removed.push("fs");
	}
	if (caps.terminal !== undefined) {
		delete caps.terminal;
		removed.push("terminal");
	}
	if (caps.auth && typeof caps.auth === "object" && caps.auth.terminal !== undefined) {
		delete caps.auth.terminal;
		removed.push("auth.terminal");
		if (Object.keys(caps.auth).length === 0) delete caps.auth;
	}
	return removed;
}

// ---------------------------------------------------------------------------
// identity: rewrite tool calls into the vocabulary Grok's dispatch expects
// ---------------------------------------------------------------------------

/** ACP ToolKind wire values Grok's tracker matches on. */
const KIND = {
	read: "read",
	edit: "edit",
	delete: "delete",
	move: "move",
	search: "search",
	execute: "execute",
	think: "think",
	fetch: "fetch",
	other: "other",
};

/** `ToolKind::presentation_name` for the kinds we emit (xai-grok-tools). */
const LABEL = {
	read: "Read",
	edit: "Edit",
	delete: "Delete",
	move: "Move",
	search: "Search",
	execute: "Run Command",
	think: "Plan",
	fetch: "Web Fetch",
	other: "Tool",
};

const READ_ONLY = new Set(["read", "search", "fetch", "think"]);

/**
 * Per-tool shaping. Keys are OMP tool ids; values override what OMP emitted.
 *
 * Only two overrides are justified by observation, both because Grok's renderer
 * dispatches on a value OMP computes differently:
 *
 *   - `web_search`: OMP reports kind `fetch` (mapToolKind, acp-event-mapper.ts),
 *     which Grok renders as a URL fetch. Grok's web-search block needs
 *     kind `search` plus a `WebSearch` variant tag.
 *   - `write`: OMP reports kind `edit`, identical to a targeted replacement.
 *     Grok distinguishes a whole-file write by the `Write` variant tag, and
 *     otherwise labels a new file as an edit.
 *
 * Everything else keeps OMP's kind, which the recorded turns show is already
 * right for read/edit/execute/search. `todo` and `task` are deliberately NOT
 * tagged: Grok would suppress those rows from scrollback into a todo pane and a
 * subagent pane, and nothing in OMP feeds those private panes — they would
 * render as nothing at all. A visible generic row is the better degradation;
 * see SPEC.md §7.4.
 */
const TOOL_SHAPING = {
	read: { kind: KIND.read, name: "read_file" },
	write: { kind: KIND.edit, variant: "Write", name: "write_file" },
	edit: { kind: KIND.edit, name: "edit_file" },
	bash: { kind: KIND.execute, name: "bash" },
	grep: { kind: KIND.search, name: "grep" },
	glob: { kind: KIND.search, name: "glob" },
	web_search: { kind: KIND.search, variant: "WebSearch", name: "web_search" },
	todo: { kind: KIND.think, name: "todo_write" },
};

/**
 * Apply a tool's overrides in place and return its canonical identity envelope
 * for `_meta["x.ai/tool"]` (CanonicalToolMeta v1, xai-grok-tools).
 */
function shapeToolUpdate(toolName, update) {
	const spec = TOOL_SHAPING[toolName];
	if (!spec) return undefined;

	if (spec.kind) update.kind = spec.kind;
	if (spec.variant) {
		update.rawInput = update.rawInput && typeof update.rawInput === "object" ? update.rawInput : {};
		update.rawInput.variant = spec.variant;
	}
	const kind = spec.kind || update.kind || KIND.other;
	return {
		version: 1,
		name: spec.name || toolName,
		kind,
		namespace: "grok_build",
		label: LABEL[kind] || "Tool",
		read_only: READ_ONLY.has(kind),
	};
}

/**
 * Tool signatures.
 *
 * An ACP tool-call frame carries no machine-readable tool name: OMP composes
 * `title` as `<tool>: <subject>` only when it has no intent, otherwise as a
 * human sentence ("Reading SPEC.md lines 1-20"). The one stable signal is the
 * pair (ACP kind, rawInput shape), so each signature below is grounded in OMP's
 * own tool schema (src/tools/*.ts, src/edit/schemas.ts) and was confirmed
 * against a recorded turn. A call matching no signature is forwarded untouched:
 * a generic row beats a wrongly-labelled one.
 */
const SIGNATURES = [
	{ name: "todo", kind: "think", test: (raw) => Array.isArray(raw.phases) },
	{ name: "web_search", kind: "fetch", test: (raw) => typeof raw.query === "string" },
	{ name: "bash", kind: "execute", test: (raw) => typeof raw.command === "string" },
	{ name: "read", kind: "read", test: (raw) => typeof raw.path === "string" },
	{ name: "write", kind: "edit", test: (raw) => typeof raw.content === "string" && raw.old_string === undefined },
	{ name: "edit", kind: "edit", test: (raw) => typeof raw.old_string === "string" || typeof raw.new_string === "string" },
	{ name: "edit", kind: "edit" }, // any other edit-shaped payload is still an edit
	{ name: "grep", kind: "search", test: (raw) => typeof raw.pattern === "string" },
	{ name: "glob", kind: "search" }, // OMP's remaining search tool is glob
];

function applySignature(update) {
	for (const signature of SIGNATURES) {
		if (update.kind !== signature.kind) continue;
		const raw = update.rawInput;
		if (signature.test && !(raw && typeof raw === "object" && signature.test(raw))) continue;
		return signature.name;
	}
	return null;
}

/**
 * Recover OMP's tool id, preferring an explicit name when the frame happens to
 * carry one. `titleById` keeps the classification stable: the completion update
 * for a call may omit the fields that identified it.
 */
function classifyTool(update) {
	const toolCallId = update.toolCallId;
	const known = titleById.get(toolCallId);
	if (known) return known;

	const title = typeof update.title === "string" ? update.title : "";
	const prefix = /^([a-z_][a-z0-9_]*): /.exec(title)?.[1];
	const name = prefix && TOOL_SHAPING[prefix] ? prefix : TOOL_SHAPING[title] ? title : applySignature(update);
	if (name) titleById.set(toolCallId, name);
	return name;
}

/**
 * Rewrite one agent→client frame in place. Returns a short description of what
 * changed, or null. Unknown methods and unrecognised shapes are left verbatim.
 */
function shapeToClient(frame) {
	if (!frame || typeof frame !== "object") return null;
	if (frame.method !== "session/update") return null;
	const update = frame.params?.update;
	if (!update || typeof update !== "object") return null;
	if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") return null;

	const toolName = classifyTool(update);
	if (!toolName) return null;
	const meta = shapeToolUpdate(toolName, update);
	if (!meta) return null;

	update._meta = { ...(update._meta && typeof update._meta === "object" ? update._meta : {}), "x.ai/tool": meta };
	return `${toolName} -> ${meta.kind}`;
}

// ---------------------------------------------------------------------------
// advisor notes: OMP serializes advisor notes into a user_message_chunk whose
// text is `<advisory advisor="NAME" severity="SEV" guidance="…">NOTE</advisory>`
// (one element per note, joined by "\n"; customType/severity/attribution are
// dropped on the wire). Split each element into its own chunk carrying
// `content._meta["x.ai/advisor"]` so the pager renders a distinct advisor block
// instead of a user echo full of raw XML.
// ---------------------------------------------------------------------------

/** One `<advisory …>…</advisory>` element; body is `escapeXmlText`-encoded. */
const ADVISORY_RE = /<advisory\b([^>]*)>([\s\S]*?)<\/advisory>/g;
const ADVISORY_ATTR_RE = /(\w+)="([^"]*)"/g;

/** Reverse OMP's escapeXmlText/escapeXmlAttribute (`&` decoded last). */
function unescapeXml(s) {
	return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
}

/**
 * Split chunk text into ordered segments: `{kind:"text"}` runs pass through
 * verbatim, `{kind:"advisory", advisor, severity, text}` carry the parsed
 * attributes and the unescaped note body. Returns null when no advisory
 * element is present.
 */
function splitAdvisoryText(text) {
	ADVISORY_RE.lastIndex = 0;
	const segments = [];
	let last = 0;
	let match;
	while ((match = ADVISORY_RE.exec(text)) !== null) {
		if (match.index > last) segments.push({ kind: "text", text: text.slice(last, match.index) });
		const attrs = {};
		for (const [, name, value] of match[1].matchAll(ADVISORY_ATTR_RE)) attrs[name] = unescapeXml(value);
		segments.push({
			kind: "advisory",
			advisor: attrs.advisor,
			severity: attrs.severity,
			text: unescapeXml(match[2].replace(/^\n/, "").replace(/\n$/, "")),
		});
		last = match.index + match[0].length;
	}
	if (segments.length === 0) return null;
	if (last < text.length) segments.push({ kind: "text", text: text.slice(last) });
	return segments;
}

// ---------------------------------------------------------------------------
// session/list enrichment: OMP's ACP `session/list` returns only
// {sessionId, cwd, title, updatedAt, _meta}. The pager's resume picker drops
// any entry without `summary`/`firstPrompt` (its last fallback reads the Grok
// session store, which knows nothing about OMP files). We recover the first
// user prompt from the OMP session JSONL so OMP sessions are resumable — the
// only path that replays advisor notes to the pager.
// ---------------------------------------------------------------------------

/** OMP sessions root: $PI_CODING_AGENT_DIR/sessions (default ~/.omp/agent). */
function ompSessionsRoot() {
	const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".omp", "agent");
	return join(agentDir, "sessions");
}

/** Locate `<root>/<cwd-dir>/*_<sessionId>.jsonl`; returns null when absent. */
function findOmpSessionFile(sessionId) {
	const root = ompSessionsRoot();
	let dirs;
	try {
		dirs = readdirSync(root, { withFileTypes: true });
	} catch {
		return null;
	}
	const suffix = `_${sessionId}.jsonl`;
	for (const d of dirs) {
		if (!d.isDirectory()) continue;
		let files;
		try {
			files = readdirSync(join(root, d.name));
		} catch {
			continue;
		}
		for (const f of files) {
			if (f.endsWith(suffix)) return join(root, d.name, f);
		}
	}
	return null;
}

/**
 * Read the first user-message text from an OMP session JSONL. Returns null
 * when the file is unreadable or has no user text.
 */
function firstUserPrompt(sessionFile) {
	let raw;
	try {
		raw = readFileSync(sessionFile, "utf8");
	} catch {
		return null;
	}
	for (const line of raw.split("\n")) {
		if (!line.includes('"role":"user"')) continue;
		try {
			const entry = JSON.parse(line);
			if (entry.type !== "message" || entry.message?.role !== "user") continue;
			const content = entry.message.content;
			const text = Array.isArray(content)
				? content.find((c) => c?.type === "text")?.text
				: typeof content === "string" ? content : undefined;
			if (typeof text === "string" && text.trim()) return text;
		} catch {
			continue;
		}
	}
	return null;
}

/**
 * Add `summary`/`firstPrompt` to each OMP session/list entry so the pager's
 * resume picker keeps it. `title` maps to `summary`; the first user prompt
 * comes from the session file when the wire omits it.
 */
function enrichSessionList(result) {
	const sessions = result?.sessions ?? result;
	if (!Array.isArray(sessions)) return { sessions: [] };
	for (const s of sessions) {
		if (!s || typeof s !== "object") continue;
		// The agent owns the session store; "agent" routes the pick straight to
		// ACP session/load instead of the pager's local/remote lookups.
		s.source = "agent";
		if (typeof s.title === "string" && s.title.trim() && !s.summary) {
			s.summary = s.title;
		}
		if (s.firstPrompt === undefined && typeof s.sessionId === "string") {
			const file = findOmpSessionFile(s.sessionId);
			const prompt = file && firstUserPrompt(file);
			if (prompt) {
				s.firstPrompt = prompt;
				if (!s.summary) s.summary = prompt.split("\n", 1)[0].slice(0, 120);
			}
		}
	}
	return { sessions };
}

/** Flatten ACP prompt ContentBlocks to display text for the queue pane. */
function promptBlocksText(prompt) {
	if (!Array.isArray(prompt)) return "";
	return prompt
		.map((b) => (b?.type === "text" ? b.text : b?.type === "resource_link" ? (b.name ?? b.uri ?? "") : ""))
		.filter(Boolean)
		.join("\n");
}

/**
 * Read OMP's prompt history db (<agentDir>/history.db or
 * $XDG_DATA_HOME/omp/history.db; table history(prompt,created_at,cwd,
 * session_id)). Newest first; filter_session_id narrows to that session,
 * otherwise cwd narrows to the project. Missing db → [].
 */
function readOmpPromptHistory(params) {
	const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".omp", "agent");
	const candidates = [
		join(agentDir, "history.db"),
		join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "omp", "history.db"),
	];
	const dbPath = candidates.find((p) => existsSync(p));
	if (!dbPath) return [];
	let db;
	try {
		db = new Database(dbPath, { readonly: true });
	} catch {
		return [];
	}
	try {
		const sid = params?.filter_session_id ?? params?.filterSessionId;
		const cwd = params?.cwd;
		let rows;
		if (typeof sid === "string" && sid) {
			rows = db
				.query("SELECT prompt FROM history WHERE session_id = ? ORDER BY created_at DESC LIMIT 200")
				.all(sid);
		} else if (typeof cwd === "string" && cwd) {
			rows = db
				.query("SELECT prompt FROM history WHERE cwd = ? ORDER BY created_at DESC LIMIT 200")
				.all(cwd);
		} else {
			rows = db.query("SELECT prompt FROM history ORDER BY created_at DESC LIMIT 200").all();
		}
		return rows.map((r) => r.prompt).filter((p) => typeof p === "string");
	} catch {
		return [];
	} finally {
		try {
			db.close();
		} catch {}
	}
}

/** OMP extension source → pager SkillInfo scope. */
function skillScope(source) {
	if (source === "user") return "user";
	if (source === "project") return "repo";
	if (source === "plugin") return "plugin";
	if (source === "bundled") return "bundled";
	return "local";
}

/** _omp/extensions skill-kind entry → pager SkillInfo (camelCase). */
function extensionToSkillInfo(e) {
	const paths =
		typeof e.trigger === "string" && e.trigger.trim()
			? e.trigger.split(",").map((s) => s.trim()).filter(Boolean)
			: undefined;
	return {
		name: e.name,
		displayName: e.displayName !== e.name ? e.displayName : undefined,
		description: e.description ?? "",
		hasUserSpecifiedDescription: Boolean(e.description),
		paths,
		path: e.path ?? "",
		scope: skillScope(e.source),
		userInvocable: true,
	};
}

/** OMP hook trigger name → pager HookEvent (snake_case). */
const OMP_HOOK_EVENT = {
	tool_call: "pre_tool_use",
	tool_result: "post_tool_use",
	session_start: "session_start",
	session_end: "session_end",
	user_prompt_submit: "user_prompt_submit",
	notification: "notification",
	stop: "stop",
	subagent_stop: "subagent_stop",
	pre_compact: "pre_compact",
};

/** _omp/extensions hook-kind entry → pager HookInfo (camelCase). */
function extensionToHookInfo(e) {
	const raw = e.raw && typeof e.raw === "object" ? e.raw : {};
	return {
		name: e.name,
		event: OMP_HOOK_EVENT[e.trigger] ?? e.trigger ?? "unknown",
		handlerType: "command",
		matcher: raw.matcher ?? raw.when,
		command: raw.command ?? raw.cmd,
		url: raw.url,
		timeoutMs: raw.timeoutMs ?? raw.timeout_ms,
		sourceDir: e.path ? dirname(e.path) : "",
		disabled: e.state === "disabled",
		pinned: e.source === "bundled",
		removable: e.source !== "bundled",
	};
}

/** _omp/extensions plugin-kind entry → pager PluginInfo (camelCase). */
function extensionToPluginInfo(e) {
	const scope =
		e.source === "project" ? "project" : e.source === "user" ? "user" : e.source === "cli" ? "cli" : "config";
	return {
		name: e.name,
		id: e.id ?? e.name,
		root: e.path ?? "",
		scope,
		trusted: true,
		enabled: e.state !== "disabled",
		version: e.raw?.version,
		description: e.description,
		skillCount: 0,
		skillNames: [],
		agentCount: 0,
		agentNames: [],
		hookStatus: "none",
		hookCount: 0,
		mcpServerCount: 0,
		mcpStatus: "none",
	};
}

/** Pager ActionOutcome for extension mutations. */
function actionOutcome(status, message, requiresReload = false) {
	return { status, message, requiresReload, requiresRestart: false };
}

/**
 * One JSON-schema property → one pager Question. Returns null when the shape
 * can't be represented (caller falls through to verbatim forwarding, which
 * yields method_not_found → OMP auto-approve, same as no elicitation.form).
 * Freeform props (string/number without enum) get options:[] — the pager's
 * question view always appends a freeform "Other" row, and a freeform-only
 * answer arrives as labels:["Other"] with the typed text in annotations notes.
 */
function schemaPropToQuestion(key, prop, message) {
	if (!prop || typeof prop !== "object") return null;
	const question =
		(typeof prop.title === "string" && prop.title) ||
		(typeof prop.description === "string" && prop.description) ||
		(typeof message === "string" && message) ||
		key;
	if (Array.isArray(prop.enum) && prop.enum.length) {
		return {
			question,
			options: prop.enum.map((v) => ({ label: String(v), description: "" })),
			multiSelect: false,
			id: key,
		};
	}
	if (prop.type === "boolean") {
		return {
			question,
			options: [
				{ label: "Yes", description: "" },
				{ label: "No", description: "" },
			],
			multiSelect: false,
			id: key,
		};
	}
	if (prop.type === "string" || prop.type === "number" || prop.type === "integer") {
		return { question, options: [], multiSelect: false, id: key };
	}
	return null;
}

/** JSON-RPC error object thrown by async worktree handlers. */
function rpcError(code, message) {
	const e = new Error(message);
	e.rpcCode = code;
	return e;
}

/** Run git in `cwd`; resolve stdout, reject with stderr text. */
function gitOut(cwd, args) {
	return new Promise((res, rej) => {
		execFile("git", args, { cwd, timeout: 30000 }, (err, stdout, stderr) => {
			if (err) rej(rpcError(-32603, `git ${args[0]}: ${(stderr || err.message).trim()}`));
			else res(stdout);
		});
	});
}

/** `git worktree add`; retry --detach when the ref is checked out elsewhere. */
async function gitWorktreeAdd(root, dest, ref) {
	try {
		await gitOut(root, ["worktree", "add", dest, ref]);
	} catch (e) {
		if (/already checked out|is already used by worktree/i.test(e.message)) {
			await gitOut(root, ["worktree", "add", "--detach", dest, ref]);
		} else {
			throw e;
		}
	}
}

/** Copy dirty (modified/untracked) files from src worktree into dest. */
async function copyDirtyFiles(src, dest) {
	const out = await gitOut(src, ["status", "--porcelain", "-z"]);
	for (const rec of out.split("\0")) {
		if (!rec || rec.length < 4) continue;
		const path = rec.slice(3).split(" -> ").pop();
		if (!path) continue;
		const from = join(src, path);
		const to = join(dest, path);
		try {
			if (!existsSync(from)) continue;
			mkdirSync(dirname(to), { recursive: true });
			cpSync(from, to, { recursive: true });
		} catch {
			// file vanished between status and copy — skip
		}
	}
}

/** Filesystem-safe worktree directory label. */
function sanitizeLabel(s) {
	return String(s).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "worktree";
}

// ---------------------------------------------------------------------------
// vibe mode (observe-only): OMP's /vibe director drives persistent worker
// sessions via vibe_spawn/vibe_send/vibe_wait/vibe_kill/vibe_list. Over ACP
// those arrive as ordinary tool_call frames whose rawOutput.details carry
// {op, screens, spawned?, killed?, wait?}; the durable roster lives in the
// parent session JSONL as type:"custom" customType:"vibe-session-lifecycle"
// entries (spawn/turn-started/turn-settled/tombstone/tombstone-revoked), and
// settled worker turns self-deliver as custom_message customType:"async-result"
// follow-ups — neither of which crosses the wire (see specs/vibe-mode.md).
// ---------------------------------------------------------------------------

const VIBE_TOOL_NAMES = new Set(["vibe_spawn", "vibe_send", "vibe_wait", "vibe_kill", "vibe_list"]);
const VIBE_DETAIL_OPS = new Set(["spawn", "send", "wait", "kill", "list"]);

/** Identify a vibe tool_call from its title or rawInput shape. */
function vibeToolOp(update) {
	const title = typeof update.title === "string" ? update.title : "";
	if (VIBE_TOOL_NAMES.has(title)) return title.slice(5);
	const raw = update.rawInput;
	if (!raw || typeof raw !== "object") return null;
	if ((raw.cli === "fast" || raw.cli === "good") && typeof raw.prompt === "string") return "spawn";
	if (typeof raw.session === "string" && typeof raw.message === "string") return "send";
	if (typeof raw.session === "string" && raw.message === undefined && raw.prompt === undefined) return "kill";
	if (Array.isArray(raw.sessions) || typeof raw.timeout === "number") return "wait";
	return null;
}

/** ACP kind for a worker-side tool call, mirroring OMP's mapToolKind. */
function vibeChildToolKind(toolName) {
	switch (toolName) {
		case "read": return "read";
		case "write": case "edit": return "edit";
		case "delete": return "delete";
		case "move": return "move";
		case "bash": case "shell": case "exec": case "eval": return "execute";
		case "grep": case "glob": case "ast_grep": return "search";
		case "web_search": return "fetch";
		case "todo": return "think";
		default: return "other";
	}
}

/** Tool-call title for a worker-side call, mirroring OMP's buildToolTitle. */
function vibeChildToolTitle(toolName, args, intent) {
	if (typeof intent === "string" && intent.trim()) return intent;
	const subject =
		(typeof args?.path === "string" && args.path) ||
		(typeof args?.command === "string" && args.command) ||
		(typeof args?.pattern === "string" && args.pattern) ||
		(typeof args?.query === "string" && args.query);
	return subject ? `${toolName}: ${subject}` : toolName;
}

/** Strip the <system-notice>…</system-notice> wrapper from a delivered async result. */
function stripSystemNotice(text) {
	const m = /^\s*<system-notice>\s*([\s\S]*?)\s*<\/system-notice>\s*$/.exec(text);
	return (m ? m[1] : text).trim();
}

/** Worker id from a vibe turn jobId (`<id>-t<turn>`; agentId is the worker id). */
function vibeWorkerIdFromJobId(jobId) {
	const m = /^([A-Za-z0-9_-]+)-t\d+$/.exec(typeof jobId === "string" ? jobId : "");
	return m?.[1];
}

/** <response> body of a delivered <vibe-turn> result, when present. */
function vibeTurnResponseText(text) {
	const m = /<response[^>]*>([\s\S]*?)<\/response>/.exec(text);
	return m ? m[1].trim() : undefined;
}

/** Flatten a persisted message's content into ACP text/image content blocks. */
function vibeContentBlocks(content) {
	const blocks = [];
	const items = Array.isArray(content) ? content : typeof content === "string" ? [{ type: "text", text: content }] : [];
	for (const item of items) {
		if (!item || typeof item !== "object") continue;
		if (item.type === "text" && typeof item.text === "string" && item.text.length > 0) {
			blocks.push({ type: "text", text: item.text });
		} else if (item.type === "image" && typeof item.data === "string" && typeof item.mimeType === "string") {
			blocks.push({ type: "image", data: item.data, mimeType: item.mimeType });
		}
	}
	return blocks;
}

// ---------------------------------------------------------------------------
// session-file tailer: several OMP surfaces never reach the ACP wire —
//   - advisor notes (custom_message/customType:"advisor"): mapAssistantMessageEnd
//     drops non-assistant messages live and #extractReplayContent skips their
//     string content on replay, so we synthesize the user_message_chunk frames
//     OMP's replay would have sent; observeAdvisoryChunk then splits/meta-stamps
//     them exactly like a wire frame.
//   - vibe lifecycle (custom/customType:"vibe-session-lifecycle"): the durable
//     worker roster — spawn/turn-settled/tombstone drive subagent_* synthesis.
//   - async results (custom_message/customType:"async-result"): settled worker
//     turns delivered to the director; rendered as interjection user chunks.
//   - worker transcripts: each vibe worker owns <parent-stem>/<id>.jsonl; we
//     tail it and synthesize child session/update frames so the pager's
//     subagent fullscreen view shows the real transcript.
// ---------------------------------------------------------------------------

class SessionTailer {
	/**
	 * @param {(frame: object, raw?: boolean) => void} emit to_client sender.
	 *   raw=false frames run through ExtSurface.observeToClient + forward (the
	 *   advisor pipeline); raw=true frames are already-final synthesized
	 *   notifications forwarded verbatim (subagent_* and child-session frames
	 *   must not re-enter parent-side observation).
	 * @param {ExtSurface} ext bookkeeping owner for vibe worker records.
	 */
	constructor(emit, ext) {
		this.emit = emit;
		this.ext = ext;
		this.sessionId = null;
		this.file = null;
		this.offset = 0;
		this.pending = "";
		this.seen = new Set();
		this.timer = null;
		/** workerId → {file, offset, pending, seen, seenToolCalls} tail state. */
		this.children = new Map();
	}

	/** Point the tailer at a session; no-op when already attached. */
	attach(sessionId) {
		if (!sessionId || this.sessionId === sessionId) return;
		log(`session tailer: attach ${sessionId}`);
		this.sessionId = sessionId;
		this.file = null;
		this.offset = 0;
		this.pending = "";
		this.seen.clear();
		this.children.clear();
		if (!this.timer) {
			this.timer = setInterval(() => this.poll(), 400);
			this.timer.unref?.();
		}
	}

	stop() {
		clearInterval(this.timer);
		this.timer = null;
	}

	/** Read complete new lines from `state` ({file, offset, pending}); null when the file vanished. */
	readNewLines(state) {
		let size;
		try {
			size = statSync(state.file).size;
		} catch {
			return null;
		}
		if (size < state.offset) {
			// Full rewrite (load-migration/sanitize): rescan; `seen` dedupes.
			state.offset = 0;
			state.pending = "";
		}
		if (size === state.offset) return [];
		let text;
		try {
			const fd = openSync(state.file, "r");
			try {
				const len = size - state.offset;
				const buf = Buffer.alloc(len);
				const got = readSync(fd, buf, 0, len, state.offset);
				state.offset += got;
				text = buf.subarray(0, got).toString("utf8");
			} finally {
				closeSync(fd);
			}
		} catch {
			return [];
		}
		const chunk = state.pending + text;
		const nl = chunk.lastIndexOf("\n");
		if (nl < 0) {
			state.pending = chunk;
			return [];
		}
		state.pending = chunk.slice(nl + 1);
		return chunk.slice(0, nl).split("\n");
	}

	poll() {
		if (!this.sessionId) return;
		if (!this.file) {
			this.file = findOmpSessionFile(this.sessionId);
			if (this.file) log(`session tailer: file ${this.file}`);
		}
		if (this.file) {
			const lines = this.readNewLines(this);
			if (lines === null) {
				this.file = null;
			} else {
				for (const line of lines) this.handleParentLine(line);
			}
		}
		for (const [id, child] of this.children) {
			if (!child.file) {
				// Worker files live beside the parent under <parent-stem>/<id>.jsonl.
				child.file = this.file ? join(this.file.slice(0, -".jsonl".length), `${id}.jsonl`) : null;
				if (child.file && !existsSync(child.file)) child.file = null;
				if (child.file) log(`session tailer: worker ${id} file ${child.file}`);
			}
			if (!child.file) continue;
			const lines = this.readNewLines(child);
			if (lines === null) {
				child.file = null;
				continue;
			}
			for (const line of lines) this.handleChildLine(id, child, line);
		}
	}

	handleParentLine(line) {
		if (
			!line.includes('"advisor"') &&
			!line.includes('"vibe-session-lifecycle"') &&
			!line.includes('"async-result"')
		) {
			return;
		}
		let entry;
		try {
			entry = JSON.parse(line);
		} catch {
			return;
		}
		const key = entry.id ?? line;
		if (this.seen.has(key)) return;

		if (entry.type === "custom" && entry.customType === "vibe-session-lifecycle") {
			const data = entry.data;
			if (!data || typeof data !== "object" || typeof data.id !== "string") return;
			this.seen.add(key);
			if (data.action === "spawn") this.watchChild(data.id);
			for (const frame of this.ext.observeVibeLifecycle(data)) this.emit(frame, true);
			return;
		}

		if (entry.type !== "custom_message") return;

		if (entry.customType === "async-result") {
			const text = typeof entry.content === "string"
				? entry.content
				: Array.isArray(entry.content)
					? entry.content.find((c) => c?.type === "text")?.text
					: undefined;
			if (typeof text !== "string" || !text.trim()) return;
			this.seen.add(key);
			const frame = this.ext.vibeAsyncResultFrame(text, entry.details);
			if (frame) this.emit(frame);
			return;
		}

		if (entry.customType !== "advisor") return;
		if (typeof entry.content !== "string" || !entry.content.includes("<advisory")) return;
		this.seen.add(key);
		this.emit({
			jsonrpc: "2.0",
			method: "session/update",
			params: {
				sessionId: this.sessionId,
				update: {
					sessionUpdate: "user_message_chunk",
					content: { type: "text", text: entry.content },
					messageId: crypto.randomUUID(),
				},
			},
		});
	}

	/** Begin tailing a vibe worker's child session file (idempotent). */
	watchChild(id) {
		if (typeof id !== "string" || !id || this.children.has(id)) return;
		this.children.set(id, { file: null, offset: 0, pending: "", seen: new Set(), seenToolCalls: new Set() });
	}

	handleChildLine(workerId, child, line) {
		if (!line.includes('"type":"message"') && !line.includes('"tool_execution_start"')) return;
		let entry;
		try {
			entry = JSON.parse(line);
		} catch {
			return;
		}
		const key = entry.id ?? line;
		if (child.seen.has(key)) return;
		child.seen.add(key);
		for (const frame of this.ext.observeVibeChildEntry(workerId, entry, child)) this.emit(frame, true);
	}
}

/** toolCallId -> OMP tool name, so later updates inherit the classification. */
const titleById = new Map();

// ---------------------------------------------------------------------------
// framing
// ---------------------------------------------------------------------------

/**
 * A newline-delimited JSON reader that never splits a frame across writes.
 * Async-iterates the stream, which is the one shape that works for both
 * `Bun.stdin.stream()` and a `Bun.spawn` child's piped stdout.
 */

// ---------------------------------------------------------------------------
// ext surface: answer the pager's private `x.ai/*` rail from observed state
// ---------------------------------------------------------------------------
//
// The pager drives its settings modal, model picker, tasks pane, and session
// chrome over a private `x.ai/*` extension rail that OMP does not implement —
// every such request forwarded to OMP comes back `-32603 Unknown ACP ext
// method`. This layer answers the rail itself, from state the adapter already
// observes in the standard ACP stream, so the pager's surfaces populate with
// real data instead of hanging or erroring.
//
// Truthfulness rule (SPEC.md §7.4): answer only what the adapter can derive
// from frames it actually saw. Where OMP genuinely has no data (billing,
// subscription, auth, marketplace), return a JSON-RPC error rather than
// fabricate an entitlement or an empty-but-plausible payload.

/**
 * Reasoning-effort options the pager's `/effort` picker offers, in the wire
 * shape `reasoningEfforts` expects (ReasoningEffortOption). OMP's thinking
 * levels map onto these; "auto" is OMP-specific and surfaced as a no-op effort.
 */
const EFFORT_OPTIONS = [
	{ id: "none", value: "none", label: "None", description: "No extended reasoning" },
	{ id: "minimal", value: "minimal", label: "Minimal" },
	{ id: "low", value: "low", label: "Low" },
	{ id: "medium", value: "medium", label: "Medium", default: true },
	{ id: "high", value: "high", label: "High" },
	{ id: "xhigh", value: "xhigh", label: "Xhigh" },
	{ id: "max", value: "max", label: "Max" },
];

/** OMP thinking-level values the pager's ReasoningEffort maps onto. */
const EFFORT_TO_THINKING = {
	none: "off",
	minimal: "minimal",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	max: "max",
};

// ---------------------------------------------------------------------------
// OMP provider connect (Settings › OMP › Providers)
// ---------------------------------------------------------------------------
// OMP has no ACP surface for adding credentials, so the adapter owns it: API
// keys are written straight into the isolated profile's agent.db
// (auth_credentials, same row shape `AuthStorage.login` persists), and OAuth
// providers run `omp auth-broker login <provider>` as a child whose stdout the
// pager renders. The running `omp acp` caches credentials in memory, so a new
// credential only takes effect on the next grok-pi start — the UI says so.

/**
 * API-key providers worth offering in the sheet: id, display name, and the env
 * var OMP resolves for that provider (from pi-catalog descriptors). `env` is
 * also how the sheet reports an env-sourced connection. Providers whose only
 * auth is OAuth (or ambient cloud credentials) are absent here; the OAuth set
 * below covers them.
 */
const OMP_API_KEY_PROVIDERS = [
	{ id: "anthropic", name: "Anthropic", env: "ANTHROPIC_API_KEY" },
	{ id: "openai", name: "OpenAI", env: "OPENAI_API_KEY" },
	{ id: "google", name: "Google (Gemini API)", env: "GEMINI_API_KEY" },
	{ id: "xai", name: "xAI", env: "XAI_API_KEY" },
	{ id: "deepseek", name: "DeepSeek", env: "DEEPSEEK_API_KEY" },
	{ id: "mistral", name: "Mistral", env: "MISTRAL_API_KEY" },
	{ id: "groq", name: "Groq", env: "GROQ_API_KEY" },
	{ id: "openrouter", name: "OpenRouter", env: "OPENROUTER_API_KEY" },
	{ id: "together", name: "Together", env: "TOGETHER_API_KEY" },
	{ id: "fireworks", name: "Fireworks", env: "FIREWORKS_API_KEY" },
	{ id: "cerebras", name: "Cerebras", env: "CEREBRAS_API_KEY" },
	{ id: "perplexity", name: "Perplexity", env: "PERPLEXITY_API_KEY" },
	{ id: "github-copilot", name: "GitHub Copilot", env: "COPILOT_GITHUB_TOKEN" },
	{ id: "kilo", name: "Kilo", env: "KILO_API_KEY" },
	{ id: "moonshot", name: "Moonshot (Kimi)", env: "MOONSHOT_API_KEY" },
	{ id: "zai", name: "Z.AI", env: "ZAI_API_KEY" },
	{ id: "minimax", name: "MiniMax", env: "MINIMAX_API_KEY" },
	{ id: "ollama-cloud", name: "Ollama Cloud", env: "OLLAMA_CLOUD_API_KEY" },
	{ id: "huggingface", name: "Hugging Face", env: "HF_TOKEN" },
	{ id: "siliconflow", name: "SiliconFlow", env: "SILICONFLOW_API_KEY" },
	{ id: "novita", name: "Novita", env: "NOVITA_API_KEY" },
	{ id: "deepinfra", name: "DeepInfra", env: "DEEPINFRA_API_KEY" },
	{ id: "venice", name: "Venice", env: "VENICE_API_KEY" },
	{ id: "vercel-ai-gateway", name: "Vercel AI Gateway", env: "VERCEL_AI_GATEWAY_API_KEY" },
	{ id: "coreweave", name: "CoreWeave", env: "COREWEAVE_API_KEY" },
	{ id: "baseten", name: "Baseten", env: "BASETEN_API_KEY" },
	{ id: "nvidia", name: "NVIDIA", env: "NVIDIA_API_KEY" },
	{ id: "azure", name: "Azure OpenAI", env: "AZURE_OPENAI_API_KEY" },
	{ id: "qianfan", name: "Qianfan", env: "QIANFAN_API_KEY" },
	{ id: "gmi-cloud", name: "GMI Cloud", env: "GMI_API_KEY" },
	{ id: "nanogpt", name: "NanoGPT", env: "NANO_GPT_API_KEY" },
	{ id: "lm-studio", name: "LM Studio", env: "LM_STUDIO_API_KEY" },
	{ id: "vllm", name: "vLLM", env: "VLLM_API_KEY" },
	{ id: "litellm", name: "LiteLLM", env: "LITELLM_API_KEY" },
	{ id: "synthetic", name: "Synthetic", env: "SYNTHETIC_API_KEY" },
	{ id: "opencode-zen", name: "OpenCode Zen", env: "OPENCODE_API_KEY" },
	{ id: "zenmux", name: "ZenMux", env: "ZENMUX_API_KEY" },
];

/**
 * OAuth-capable providers (`omp auth-broker login <id>`). Mirrored from
 * `omp auth-broker list`; ids are the login targets, `storeAs` is the
 * provider the credential lands under when it differs (device/paste variants).
 */
const OMP_OAUTH_PROVIDERS = [
	{ id: "anthropic", name: "Anthropic (Claude Pro/Max)" },
	{ id: "openai-codex", name: "ChatGPT Plus/Pro (Codex)" },
	{ id: "openai-codex-device", name: "ChatGPT (Codex, headless/device)", storeAs: "openai-codex" },
	{ id: "github-copilot", name: "GitHub Copilot" },
	{ id: "google-gemini-cli", name: "Google Cloud Code Assist (Gemini CLI)" },
	{ id: "google-antigravity", name: "Antigravity (Gemini 3, Claude, GPT-OSS)" },
	{ id: "xai-oauth", name: "xAI Grok OAuth (SuperGrok / X Premium+)" },
	{ id: "cursor", name: "Cursor" },
	{ id: "devin", name: "Devin" },
	{ id: "gitlab-duo", name: "GitLab Duo" },
	{ id: "gitlab-duo-agent", name: "GitLab Duo Agent" },
	{ id: "zai-coding-plan", name: "Z.AI GLM Coding Plan", storeAs: "zai" },
	{ id: "kimi-code", name: "Kimi Code" },
	{ id: "alibaba-coding-plan", name: "Alibaba Coding Plan" },

	{ id: "alibaba-token-plan", name: "QwenCloud Token Plan" },
	{ id: "qwen-portal", name: "Qwen Portal" },
	{ id: "minimax-code", name: "MiniMax Token Plan (Intl)" },
	{ id: "minimax-code-cn", name: "MiniMax Token Plan (China)" },
	{ id: "xiaomi", name: "Xiaomi MiMo" },
	{ id: "xiaomi-token-plan-sgp", name: "Xiaomi Token Plan (Singapore)" },
	{ id: "xiaomi-token-plan-ams", name: "Xiaomi Token Plan (Europe)" },
	{ id: "xiaomi-token-plan-cn", name: "Xiaomi Token Plan (China)" },
	{ id: "deepseek", name: "DeepSeek (OAuth)" },
	{ id: "moonshot", name: "Moonshot (Kimi, OAuth)" },
	{ id: "muse-code", name: "Muse Code" },
	{ id: "meta", name: "Meta Model API" },
	{ id: "sakana", name: "Sakana AI" },
	{ id: "umans", name: "Umans AI Coding Plan" },
	{ id: "zhipu-coding-plan", name: "Zhipu Coding Plan" },
	{ id: "firepass", name: "Fire Pass (Fireworks)" },
	{ id: "cline-pass", name: "ClinePass" },
	{ id: "commandcode", name: "Command Code" },
	{ id: "aiand", name: "ai&" },
	{ id: "abliteration", name: "Abliteration" },
	{ id: "cerebras", name: "Cerebras (OAuth)" },
	{ id: "openrouter", name: "OpenRouter (OAuth)" },
];

/** The `omp` binary the adapter spawns (argv[0] of the agent command). */
function ompBinary(agentArgv) {
	return agentArgv?.[0] ?? "omp";
}

/**
 * agent.db path for the ISOLATED grok-pi profile. PI_CODING_AGENT_DIR is set
 * by the launcher; the GROK_HOME fallback covers a bare `bun adapter.mjs` dev
 * run. Never resolves to the real ~/.omp — when neither env is set we return
 * null and the caller reports "profile unknown" instead of touching user auth.
 */
function ompAgentDbPath() {
	const dir = process.env.PI_CODING_AGENT_DIR;
	if (dir) return join(dir, "agent.db");
	const grokHome = process.env.GROK_HOME;
	if (grokHome) return join(grokHome, "omp", "agent", "agent.db");
	return null;
}

/**
 * Open (creating if needed) the isolated agent.db with the auth_credentials
 * schema + change-revision trigger OMP installs. Mirrors
 * SqliteAuthCredentialStore's DDL so a first-run profile gets a compatible
 * store and cross-process readers see the revision bump.
 */
function openOmpAuthDb() {
	const dbPath = ompAgentDbPath();
	if (!dbPath) return null;
	mkdirSync(dirname(dbPath), { recursive: true });
	const db = new Database(dbPath);
	db.run(`CREATE TABLE IF NOT EXISTS auth_credentials (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		provider TEXT NOT NULL,
		credential_type TEXT NOT NULL,
		data TEXT NOT NULL,
		disabled_cause TEXT DEFAULT NULL,
		identity_key TEXT DEFAULT NULL,
		created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
		updated_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
	)`);
	db.run(`CREATE TABLE IF NOT EXISTS auth_change_revision (
		id INTEGER PRIMARY KEY CHECK (id = 1),
		revision INTEGER NOT NULL
	)`);
	db.run("INSERT OR IGNORE INTO auth_change_revision (id, revision) VALUES (1, 0)");
	for (const event of ["insert", "update", "delete"]) {
		db.run(`CREATE TRIGGER IF NOT EXISTS auth_change_revision_auth_credentials_${event}
			AFTER ${event.toUpperCase()} ON auth_credentials
			BEGIN
				UPDATE auth_change_revision SET revision = revision + 1 WHERE id = 1;
			END`);
	}
	return db;
}

/** Active (non-disabled) credential rows, optionally for one provider. */
function listOmpCredentials(db, provider) {
	const sql =
		"SELECT id, provider, credential_type, data FROM auth_credentials WHERE disabled_cause IS NULL" +
		(provider ? " AND provider = ?" : "") +
		" ORDER BY id ASC";
	try {
		return provider ? db.query(sql).all(provider) : db.query(sql).all();
	} catch {
		return [];
	}
}

/**
 * Persist an API key exactly as `AuthStorage.login` does: credential_type
 * 'api_key', data {"key","source":"login"}. Updating the existing active
 * api_key row keeps one credential per provider; OAuth rows are untouched.
 */
function storeOmpApiKey(provider, key) {
	const db = openOmpAuthDb();
	if (!db) throw new Error("isolated OMP profile not found (PI_CODING_AGENT_DIR unset)");
	try {
		const data = JSON.stringify({ key, source: "login" });
		const existing = listOmpCredentials(db, provider).find((r) => r.credential_type === "api_key");
		if (existing) {
			db.run(
				"UPDATE auth_credentials SET data = ?, updated_at = CAST(strftime('%s','now') AS INTEGER) WHERE id = ?",
				[data, existing.id],
			);
		} else {
			db.run(
				"INSERT INTO auth_credentials (provider, credential_type, data) VALUES (?, 'api_key', ?)",
				[provider, data],
			);
		}
		return ompAgentDbPath();
	} finally {
		db.close();
	}
}

/**
 * Tracks session/agent state from agent→client frames and answers the pager's
 * `x.ai/*` extension requests. One instance per live run.
 */
class ExtSurface {
	constructor() {
		/** session/new result fields we answer from. */
		this.session = null; // {sessionId, modes}
		/** mcpServers array the pager sent in session/new params. */
		this.mcpServers = [];
		/** Last available_commands_update payload. */
		this.commands = [];
		/** Resolvers parked by commands/list while the first ACU is in flight. */
		this.commandsWaiters = [];
		/** Last usage_update payload ({size, used}). */
		this.usage = null;
		/** initialize result (agent name/version). */
		this.agentInfo = null;
		/** configOptions[id="model"] → SessionModelState source. */
		this.modelConfig = null;
		/** configOptions[id="mode"] → current mode. */
		this.modeConfig = null;
		/** id → translate(result) for requests forwarded to OMP. */
		this.pendingTranslated = new Map();
		/** toolCallId → subagent record for task-tool subagent synthesis. */
		this.subagents = new Map();
		/** toolCallId → terminal status, for subagent/cancel already_finished. */
		this.finishedSubagents = new Map();
		this.subagentSeq = 0;
		/** workerId → vibe worker record (persistent across director turns). */
		this.vibeWorkers = new Map();
		/** toolCallId → {op, prompt?, session?} for in-flight vibe_* calls. */
		this.vibeCalls = new Map();
		/** selector → OMP model metadata (from `omp models --json`). */
		this.catalog = null;
		/** Extra client→agent requests to send right after the current one. */
		this.followUp = [];
		// -- usage/cost tracking (usage-cost.md) ------------------------------
		/** Completed session/prompt turns observed this session. */
		this.turns = 0;
		/** Cumulative session cost in USD from usage_update.cost.amount. */
		this.lastCost = null;
		/** Summed per-turn token usage from session/prompt responses. */
		this.turnTokens = { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 };
		/** True once any prompt response carried a usage object. */
		this.sawTurnUsage = false;
		/** True when the session was loaded/resumed/forked (pre-bridge history). */
		this.sessionResumed = false;
		/** Last session_info_update title. */
		this.sessionTitle = null;
		// -- virtual prompt queue (interaction.md) ----------------------------
		// OMP cancels a running turn when a second session/prompt arrives, so
		// the adapter holds extra prompts client-side and drains FIFO on turn
		// end. `held` entries: {queueId, kind, text, version, frame|params,
		// clientId, agentId, answerResult}.
		this.held = [];
		/** The prompt OMP is currently answering: {agentId, queueId, kind, text}. */
		this.running = null;
		/** agentId → true for every session/prompt in flight (running or
		 *  implicitly-cancelled-but-unsettled). */
		this.inFlightPrompts = new Set();
		/** agentId → {kind, clientId, answerResult} for adapter-internal
		 *  requests whose responses must not reach the pager. */
		this.internalIds = new Map();
		/** pager request id → {ompId, kind, prop} for bridged elicitations. */
		this.bridgedElicits = new Map();
		this.internalSeq = 0;
		/** Client-bound frames to emit after the current one. */
		this.outToClient = [];
		/** Agent-bound frames to emit after the current one. */
		this.outToAgent = [];
		/** Last enriched session/list rows (roster + search source). */
		this.lastSessionRows = [];
		/** Last _omp/extensions response (toggle id resolution). */
		this.extCache = null;
		/** cwd → worktree label for rows created via git/worktree/*. */
		this.knownWorktrees = new Map();
		/** argv of the spawned agent command (for `omp auth-broker login`). */
		this.agentArgv = null;
		/** In-flight `omp auth-broker login` child: {proc, provider, phase, authUrl, lines, needsCode, error}. */
		this.ompLogin = null;
		/** request id → sessionId for session/load|resume|fork in flight. */
		this.pendingSessionSwitch = new Map();
		/** The command the adapter spawned (`opts.agent` / `OMP_ACP_CMD`), stamped
		 *  into initialize `_meta.ompAgentCommand` for the pager's status row. */
		this.agentCommand = null;
		/** Last reported vibe capability (modes.availableModes contains "vibe"). */
		this.vibeCapable = undefined;
	}

	// -- state capture ------------------------------------------------------

	/**
	 * Observe an agent→client frame; update tracked state.
	 * @returns {object[]} extra frames to inject into the client stream after
	 *   this one (synthesized notifications the pager needs but OMP never sends).
	 */
	observeToClient(frame) {
		const extra = [];
		if (!frame || typeof frame !== "object") return extra;

		// initialize result → agent identity.
		if (frame.result?.protocolVersion !== undefined && frame.result?.agentInfo) {
			this.agentInfo = frame.result.agentInfo;
			// Stamp the OMP identity flag so the pager can gate OMP-only surfaces
			// (Settings › OMP) without sniffing agentInfo.name.
			frame.result._meta = { ...(frame.result._meta ?? {}), ompAgent: true, ompAgentCommand: this.agentCommand };
		}

		// Any session response carrying modes tells us whether this OMP build is
		// vibe-capable (`modes.availableModes[].id === "vibe"`). Report it once per
		// session switch so the pager's Settings › OMP "Vibe mode" row stays live.
		const modes = frame.result?.modes;
		if (modes?.availableModes) {
			const vibeCapable = modes.availableModes.some(m => m?.id === "vibe");
			if (this.vibeCapable !== vibeCapable) {
				this.vibeCapable = vibeCapable;
				extra.push(this.notif("_x.ai/omp/capabilities", { vibeCapable }));
			}
		}

		// session/new result → session identity + model catalog.
		if (frame.result?.sessionId !== undefined && frame.id !== undefined) {
			this.captureSessionNew(frame.result);
			// A new session replaces the queue scope: held prompts belonged to
			// the previous session and must not drain into this one.
			this.resetQueue();
			// The pager's model picker reads `resp.models` (SessionModelState)
			// from session/new; OMP omits it. Inject the catalog synthesized from
			// configOptions so the picker populates on connect, not just on the
			// models/update notification below.
			const models = this.modelState();
			if (frame.result.models === undefined && models) {
				frame.result.models = models;
			}
			// The pager seeds a "Starting session…" MCP row that only
			// `x.ai/mcp_initialized` clears. OMP never sends it; synthesize it
			// so the seed resolves instead of animating ~30s then freezing.
			extra.push(this.notif("_x.ai/mcp_initialized", {
				sessionId: frame.result.sessionId,
				mcpToolCount: this.mcpServers.length,
				elapsedMs: 0,
			}));
			// The pager's model picker refreshes on `x.ai/models/update`; OMP
			// only emits configOptions. Synthesize the model-state notification
			// so the picker populates without a manual refetch.
			if (models) extra.push(this.notif("_x.ai/models/update", models));
			// FleetView roster: announce the live session.
			extra.push(this.notif("_x.ai/sessions/changed", {
				upserted: [this.rosterEntryFor(this.session?.sessionId, true)],
				removed: [],
			}));
		}

		// session/load|resume|fork responses switch the active session: reset
		// queue + usage scope, and adopt the sessionId (fork results carry it;
		// load/resume results don't, so fall back to the request's param).
		if (
			frame.id !== undefined &&
			frame.result !== undefined &&
			this.pendingSessionSwitch?.has(frame.id)
		) {
			const sid = frame.result.sessionId ?? this.pendingSessionSwitch.get(frame.id);
			this.pendingSessionSwitch.delete(frame.id);
			this.resetQueue();
			this.sessionResumed = true;
			if (sid) {
				this.session = { sessionId: sid, modes: frame.result.modes ?? this.session?.modes ?? null };
			}
			this.captureConfigOptions(frame.result.configOptions);
		}

		// session/close response → roster removal broadcast.
		if (frame.id !== undefined && this.pendingClose?.has(frame.id)) {
			const closedId = this.pendingClose.get(frame.id);
			this.pendingClose.delete(frame.id);
			if (closedId) {
				this.lastSessionRows = this.lastSessionRows.filter((r) => r.sessionId !== closedId);
				extra.push(this.notif("_x.ai/sessions/changed", { upserted: [], removed: [closedId] }));
			}
		}

		// session/update notifications → commands, usage, config, subagents.
		const update = frame.params?.update;
		if (frame.method === "session/update" && update && typeof update === "object") {
			switch (update.sessionUpdate) {
				case "available_commands_update":
					this.commands = update.availableCommands ?? [];
					// Release commands/list waiters parked while the first ACU was in flight.
					for (const w of this.commandsWaiters.splice(0)) {
						clearTimeout(w.timer);
						w.resolve({ commands: this.commands });
					}
					break;
				case "usage_update":
					this.usage = { size: update.size, used: update.used };
					if (typeof update.cost?.amount === "number") this.lastCost = update.cost.amount;
					break;
				case "config_option_update":
					this.captureConfigOptions(update.configOptions);
					break;
				case "session_info_update":
					if (typeof update.title === "string") this.sessionTitle = update.title;
					break;
				case "tool_call":
					this.observeToolCallStart(update, extra);
					break;
				case "tool_call_update":
					this.observeToolCallEnd(update, extra);
					break;
				case "user_message_chunk":
					this.observeAdvisoryChunk(frame, update, extra);
					break;
			}
		}
		return extra;
	}

	/** Record the session/new params the pager sent (mcpServers, cwd). */
	observeToAgent(frame) {
		if (frame?.method === "session/new" && frame.params) {
			this.mcpServers = Array.isArray(frame.params.mcpServers) ? frame.params.mcpServers : [];
			this.sessionCwd = frame.params.cwd ?? null;
		}
		if (
			frame?.id !== undefined &&
			(frame.method === "session/load" || frame.method === "session/resume" || frame.method === "session/fork")
		) {
			(this.pendingSessionSwitch ??= new Map()).set(
				frame.id,
				frame.method === "session/fork" ? undefined : frame.params?.sessionId,
			);
		}
		// session/close: remember the id so the response can broadcast the
		// roster removal (sessions.md: synthesize sessions/changed on close).
		if (frame?.id !== undefined && frame.method === "session/close") {
			(this.pendingClose ??= new Map()).set(frame.id, frame.params?.sessionId);
		}
	}

	captureSessionNew(result) {
		this.session = {
			sessionId: result.sessionId,
			modes: result.modes ?? null,
		};
		this.captureConfigOptions(result.configOptions);
	}

	captureConfigOptions(configOptions) {
		if (!Array.isArray(configOptions)) return;
		for (const opt of configOptions) {
			if (opt?.id === "model") this.modelConfig = opt;
			if (opt?.id === "mode") this.modeConfig = opt;
		}
	}

	/** Build an ACP SessionModelState from the model configOption, enriched. */
	modelState() {
		const cfg = this.modelConfig;
		if (!cfg || !Array.isArray(cfg.options)) return null;
		return {
			currentModelId: cfg.currentValue,
			availableModels: cfg.options.map((o) => this.enrichModel(o)),
		};
	}

	/**
	 * Map one configOptions entry to ACP ModelInfo, enriched with the metadata
	 * the pager's model picker reads: vision (`acceptsImages`/`inputModalities`),
	 * reasoning effort (`supportsReasoningEffort`/`reasoningEfforts`), and the
	 * context window (`totalContextTokens`). Source: `omp models --json`.
	 */
	enrichModel(opt) {
		const meta = this.catalog?.get(opt.value);
		const info = {
			modelId: opt.value,
			name: opt.name ?? opt.value,
			description: opt.description,
		};
		if (!meta) return info;
		const m = {};
		if (meta.contextWindow) m.totalContextTokens = meta.contextWindow;
		if (meta.maxTokens) m.maxOutputTokens = meta.maxTokens;
		// Vision: OMP reports input modalities; "image" present → acceptsImages.
		const inputs = Array.isArray(meta.input) ? meta.input : [];
		const acceptsImages = inputs.some((s) => String(s).toLowerCase() === "image");
		m.acceptsImages = acceptsImages;
		m.inputModalities = inputs.length ? inputs : ["text"];
		// Reasoning effort: OMP's `reasoning` flag → the pager's effort surface.
		if (meta.reasoning) {
			m.supportsReasoningEffort = true;
			m.reasoningEfforts = EFFORT_OPTIONS;
		}
		info._meta = m;
		return info;
	}

	/**
	 * Load `omp models --json` once into a selector→metadata map. Best-effort:
	 * a failure leaves the catalog null and models render unenriched rather than
	 * blocking startup.
	 */
	async loadCatalog(agentArgv) {
		try {
			const omp = agentArgv[0]; // the `omp` binary, not the `acp` subcommand
			const proc = Bun.spawn([omp, "models", "--json"], { stdout: "pipe", stderr: "ignore" });
			const text = await new Response(proc.stdout).text();
			await proc.exited;
			const parsed = JSON.parse(text);
			const list = Array.isArray(parsed) ? parsed : (parsed.models ?? parsed.data ?? []);
			this.catalog = new Map();
			for (const m of list) {
				const key = m.selector ?? `${m.provider}/${m.id}`;
				if (key) this.catalog.set(key, m);
			}
			log(`model catalog: ${this.catalog.size} models enriched`);
		} catch (e) {
			log(`model catalog unavailable: ${e?.message ?? e}`);
			this.catalog = null;
		}
	}

	// -- subagent synthesis ---------------------------------------------------
	//
	// OMP runs subagents through its `task` tool as an ordinary tool_call. The
	// pager's tasks pane and subagent tracker only light up on the private
	// `subagent_spawned`/`subagent_finished` notifications. Synthesize them from
	// the task tool_call lifecycle so the pane reflects real work. Without
	// `subagent_spawned`, an intent-less `task` call renders as a bare "task"
	// row and the tracker waits on a subagent that never reports.

	observeToolCallStart(update, extra) {
		const raw = update.rawInput ?? {};
		const toolCallId = update.toolCallId;
		// Vibe director calls (vibe_spawn/vibe_send/vibe_wait/vibe_kill/vibe_list)
		// are ordinary tool_call frames; remember the op so the terminal update —
		// which carries details.spawned/screens — can synthesize subagent_*.
		const vibeOp = vibeToolOp(update);
		if (vibeOp) {
			if (toolCallId) {
				this.vibeCalls.set(toolCallId, {
					op: vibeOp,
					prompt: typeof raw.prompt === "string" ? raw.prompt : undefined,
					session: typeof raw.session === "string" ? raw.session : undefined,
				});
			}
			return;
		}
		// OMP's task tool isn't in TOOL_SHAPING, so no _meta stamp. Detect it by
		// an explicit tool id, a bare "task" title, the task_* toolCallId prefix
		// OMP assigns, or the task-tool input shape (prompt + description).
		const toolName = update._meta?.["x.ai/tool"] ?? raw.tool;
		const isTask =
			toolName === "task" ||
			update.title === "task" ||
			(typeof update.toolCallId === "string" && update.toolCallId.startsWith("task_")) ||
			(typeof raw.prompt === "string" &&
				(raw.agent !== undefined || raw.label !== undefined || raw.task !== undefined || raw.description !== undefined));
		if (!isTask) return;
		if (!toolCallId || this.subagents.has(toolCallId)) return;
		const subagentId = `omp-task-${++this.subagentSeq}`;
		const childSessionId = `${this.session?.sessionId ?? "session"}:sub:${this.subagentSeq}`;
		// Batch spawns arrive as {context, tasks:[{agent, task}]} — the first
		// task entry carries the agent type and per-spawn prompt.
		const firstTask = Array.isArray(raw.tasks) && raw.tasks.length > 0 ? raw.tasks[0] : undefined;
		const agentName =
			(typeof raw.agent === "string" && raw.agent) ||
			(typeof firstTask?.agent === "string" && firstTask.agent) ||
			"general-purpose";
		const description =
			raw.prompt ?? raw.description ?? (typeof firstTask?.task === "string" ? firstTask.task : undefined) ?? update.title ?? "subagent";
		this.subagents.set(toolCallId, {
			subagentId,
			toolCallId,
			childSessionId,
			subagentType: agentName,
			description,
			startedAt: Date.now(),
			toolCalls: 0,
			tokensUsed: 0,
			// undefined until a tool_call_update reveals OMP's async dispatch
			// shape (details.async); then mirrors the aggregate job state.
			asyncState: undefined,
		});
		extra.push(this.notif("_x.ai/session/update", {
			sessionId: this.session?.sessionId,
			update: {
				sessionUpdate: "subagent_spawned",
				subagent_id: subagentId,
				parent_session_id: this.session?.sessionId,
				child_session_id: childSessionId,
				subagent_type: this.subagents.get(toolCallId).subagentType,
				description,
				context_normalized: false,
			},
		}));
	}

	observeToolCallEnd(update, extra) {
		const toolCallId = update.toolCallId;
		const out = update.rawOutput && typeof update.rawOutput === "object" ? update.rawOutput : {};
		const details = out.details && typeof out.details === "object" ? out.details : {};
		// Vibe tool updates carry details.{op,screens,spawned?,killed?,wait?} —
		// the worker roster. Synthesize spawn/progress/finish from them.
		const vibeOp = VIBE_DETAIL_OPS.has(details.op) && Array.isArray(details.screens)
			? details.op
			: (toolCallId && this.vibeCalls.get(toolCallId)?.op);
		if (vibeOp) {
			this.observeVibeToolUpdate(update, vibeOp, out, details, extra);
			return;
		}
		const rec = toolCallId && this.subagents.get(toolCallId);
		if (!rec) return;
		// OMP's task tool returns as soon as the subagent jobs are *dispatched*;
		// details.async.state is the aggregate over those jobs ("running" until
		// every spawn settles — task/index.ts buildAsyncDetails). The tool_call's
		// own terminal status only means the dispatch finished, so a "running"
		// async state must NOT emit subagent_finished: the subagent is genuinely
		// still running. Its real finish reaches the wire as a later
		// tool_call_update (status "in_progress") whose details.async.state has
		// settled — the job's onProgress keeps calling the tool's onUpdate while
		// the parent turn's event stream is still open.
		const asyncState = typeof details.async?.state === "string" ? details.async.state : undefined;
		if (asyncState !== undefined) {
			rec.asyncState = asyncState;
		}
		// Lift live counters from the per-spawn progress snapshots when present.
		if (Array.isArray(details.progress)) {
			let tools = 0;
			let tokens = 0;
			for (const p of details.progress) {
				if (typeof p?.toolCount === "number") tools += p.toolCount;
				if (typeof p?.tokens === "number") tokens += p.tokens;
			}
			rec.toolCalls = tools;
			rec.tokensUsed = tokens;
		}
		const ASYNC_TERMINAL = new Set(["completed", "failed", "cancelled", "aborted"]);
		if (rec.asyncState !== undefined && !ASYNC_TERMINAL.has(rec.asyncState)) {
			// Dispatched but still running — hold the finish.
			return;
		}
		const status = update.status;
		if (status !== "completed" && status !== "failed" && status !== "cancelled") {
			// Non-terminal tool_call_update: only interesting when it carries the
			// subagent's terminal async state (the real finish signal).
			if (rec.asyncState === undefined || !ASYNC_TERMINAL.has(rec.asyncState)) return;
			this.finishSubagent(rec, rec.asyncState === "aborted" ? "cancelled" : rec.asyncState, out);
			return;
		}
		// Terminal tool_call_update: emit when the call was synchronous (no
		// details.async — the tool result IS the subagent's result) or when the
		// async aggregate already settled before the call returned.
		const finalStatus =
			rec.asyncState !== undefined && ASYNC_TERMINAL.has(rec.asyncState)
				? rec.asyncState === "aborted"
					? "cancelled"
					: rec.asyncState
				: status;
		this.finishSubagent(rec, finalStatus, out);
	}

	/**
	 * Emit `subagent_finished` for a tracked task-tool subagent and record the
	 * terminal status so `x.ai/subagent/cancel` answers already_finished.
	 */
	finishSubagent(rec, status, out) {
		// Index by both ids: the pager cancels by subagent_id, but a caller may
		// also address the row by its ACP toolCallId.
		this.finishedSubagents.set(rec.subagentId, status);
		if (rec.toolCallId) this.finishedSubagents.set(rec.toolCallId, status);
		this.subagents.delete(rec.toolCallId);
		const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
		this.outToClient.push(this.notif("_x.ai/session/update", {
			sessionId: this.session?.sessionId,
			update: {
				sessionUpdate: "subagent_finished",
				subagent_id: rec.subagentId,
				child_session_id: rec.childSessionId,
				status,
				error: status === "failed" ? (out.error ?? "subagent failed") : undefined,
				tool_calls: num(out.toolCalls ?? out.tool_calls) ?? rec.toolCalls,
				turns: num(out.turns) ?? 1,
				duration_ms: Date.now() - rec.startedAt,
				tokens_used: num(out.tokensUsed ?? out.tokens_used) ?? rec.tokensUsed,
				will_wake: false,
				output: typeof out.summary === "string" ? out.summary : undefined,
			},
		}));
	}

	/**
	 * Turn settle fallback: a tracked subagent whose tool_call never produced a
	 * terminal update (dropped frame, aborted batch) is finished with the turn.
	 * Records last seen with async state "running" are skipped — the subagent
	 * genuinely outlives the turn and stays live in the pager's tasks pane.
	 */
	finishSubagentsAtTurnEnd(stopReason) {
		const fallback = stopReason === "cancelled" ? "cancelled" : stopReason === "error" ? "failed" : "completed";
		for (const rec of [...this.subagents.values()]) {
			if (rec.asyncState !== undefined) continue;
			this.finishSubagent(rec, fallback, {});
		}
	}

	// -- vibe worker synthesis (vibe-mode.md) ---------------------------------
	//
	// Vibe workers are persistent: they outlive the director's turns and the
	// vibe_* tool_calls that steer them. Records are keyed by the real worker
	// id (details.spawned.id / lifecycle event id — also the child JSONL
	// basename and the history://<id> handle), never by toolCallId.

	/**
	 * Register a vibe worker if unknown; returns {rec, created}. A finished
	 * record is left finished — only tombstone-revoked (or a fresh spawn event
	 * after a stale finished mark) resurrects it.
	 */
	ensureVibeWorker(id, info = {}) {
		let rec = this.vibeWorkers.get(id);
		if (rec) {
			if (info.cli && !rec.cli) {
				rec.cli = info.cli;
				rec.subagentType = `vibe-${info.cli}`;
			}
			if (info.agent && !rec.agent) rec.agent = info.agent;
			if (info.description && rec.description === `vibe worker ${id}`) rec.description = info.description;
			return { rec, created: false };
		}
		rec = {
			subagentId: id,
			childSessionId: id,
			cli: info.cli,
			agent: info.agent,
			subagentType: info.cli ? `vibe-${info.cli}` : "vibe-worker",
			description: info.description ?? `vibe worker ${id}`,
			startedAt: typeof info.createdAt === "number" ? info.createdAt : Date.now(),
			turns: 0,
			toolCalls: 0,
			errorCount: 0,
			toolsUsed: new Set(),
			finished: null,
			finishSource: null,
			lastOutput: undefined,
		};
		this.vibeWorkers.set(id, rec);
		// A stale finished mark (session switch, prior tombstone) must not
		// shadow a worker the roster says is live.
		this.finishedSubagents.delete(id);
		return { rec, created: true };
	}

	vibeSpawnedFrame(rec) {
		return this.notif("_x.ai/session/update", {
			sessionId: this.session?.sessionId,
			update: {
				sessionUpdate: "subagent_spawned",
				subagent_id: rec.subagentId,
				parent_session_id: this.session?.sessionId,
				child_session_id: rec.childSessionId,
				subagent_type: rec.subagentType,
				description: rec.description,
				context_normalized: false,
				...(rec.agent ? { persona: rec.agent } : {}),
			},
		});
	}

	vibeProgressFrame(rec) {
		return this.notif("_x.ai/session/update", {
			sessionId: this.session?.sessionId,
			update: {
				sessionUpdate: "subagent_progress",
				subagent_id: rec.subagentId,
				parent_session_id: this.session?.sessionId,
				child_session_id: rec.childSessionId,
				duration_ms: Date.now() - rec.startedAt,
				turn_count: rec.turns,
				tool_call_count: rec.toolCalls,
				tokens_used: 0,
				context_window_tokens: 0,
				context_usage_pct: 0,
				tools_used: [...rec.toolsUsed].sort(),
				error_count: rec.errorCount,
			},
		});
	}

	/**
	 * Emit subagent_finished for a vibe worker. `source` ranks the signal:
	 * "lifecycle" (persisted tombstone) is authoritative and may correct an
	 * earlier screen/kill-derived finish; "screen" and "kill" are wire proxies.
	 */
	finishVibeWorker(id, status, opts = {}) {
		const { rec, created } = this.ensureVibeWorker(id, opts.info);
		const frames = created ? [this.vibeSpawnedFrame(rec)] : [];
		if (rec.finished && !(opts.source === "lifecycle" && rec.finishSource !== "lifecycle")) {
			return frames;
		}
		rec.finished = status;
		rec.finishSource = opts.source ?? "wire";
		this.finishedSubagents.set(id, status);
		frames.push(this.notif("_x.ai/session/update", {
			sessionId: this.session?.sessionId,
			update: {
				sessionUpdate: "subagent_finished",
				subagent_id: rec.subagentId,
				child_session_id: rec.childSessionId,
				status,
				error: status === "failed" ? (opts.error ?? "vibe worker failed") : undefined,
				tool_calls: rec.toolCalls,
				turns: rec.turns || 1,
				duration_ms: Date.now() - rec.startedAt,
				tokens_used: 0,
				// Settled turns self-deliver an async-result that re-wakes the
				// director; only a spawn-failed worker produces no delivery.
				will_wake: opts.willWake ?? true,
				output: rec.lastOutput,
			},
		}));
		return frames;
	}

	/**
	 * One vibe_* tool_call_update: details.screens is the live roster,
	 * details.spawned/killed carry the terminal spawn/kill outcomes.
	 */
	observeVibeToolUpdate(update, op, out, details, extra) {
		const toolCallId = update.toolCallId;
		const call = toolCallId ? this.vibeCalls.get(toolCallId) : undefined;

		// vibe_spawn completion: the real worker id arrives in details.spawned.
		const spawned = details.spawned;
		if (spawned && typeof spawned.id === "string" && spawned.id) {
			const { rec, created } = this.ensureVibeWorker(spawned.id, {
				cli: spawned.cli,
				description: call?.prompt,
			});
			if (created) extra.push(this.vibeSpawnedFrame(rec));
		}

		// Every vibe tool result carries the roster snapshot.
		for (const s of Array.isArray(details.screens) ? details.screens : []) {
			if (!s || typeof s.id !== "string" || !s.id) continue;
			if (s.state === "dead" && this.vibeWorkers.get(s.id)?.finished) continue;
			const { rec, created } = this.ensureVibeWorker(s.id, { cli: s.cli });
			if (created) extra.push(this.vibeSpawnedFrame(rec));
			if (typeof s.turns === "number") rec.turns = Math.max(rec.turns, s.turns);
			// trace is the in-flight turn's last ≤6 calls — names only, not a
			// cumulative count; the child tailer owns the real toolCalls total.
			for (const t of Array.isArray(s.trace) ? s.trace : []) {
				const name = typeof t === "string" ? t.split("(", 1)[0].trim() : "";
				if (name) rec.toolsUsed.add(name);
			}
			if (s.state === "dead") {
				// Wire-visible terminal proxy; the persisted tombstone (tailer)
				// may still correct the status with the real reason.
				extra.push(...this.finishVibeWorker(s.id, "cancelled", { source: "screen" }));
			} else {
				extra.push(this.vibeProgressFrame(rec));
			}
		}

		// vibe_kill completion: details.killed.id is the terminated worker.
		const killedId = typeof details.killed?.id === "string" ? details.killed.id : undefined;
		if (killedId) {
			extra.push(...this.finishVibeWorker(killedId, "cancelled", { source: "kill" }));
		} else if (op === "kill" && update.status === "completed" && call?.session) {
			extra.push(...this.finishVibeWorker(call.session, "cancelled", { source: "kill" }));
		}

		if (toolCallId && (update.status === "completed" || update.status === "failed" || update.status === "cancelled")) {
			this.vibeCalls.delete(toolCallId);
		}
	}

	/**
	 * One vibe-session-lifecycle entry from the parent JSONL → frames.
	 * spawn → subagent_spawned (if the wire spawn didn't already); turn events →
	 * progress (workers persist across turns — never finish); tombstone →
	 * subagent_finished with the authoritative reason; tombstone-revoked →
	 * resurrect a worker we finished on a mode-exit tombstone.
	 */
	observeVibeLifecycle(data) {
		const id = data.id;
		switch (data.action) {
			case "spawn": {
				const { rec, created } = this.ensureVibeWorker(id, {
					cli: data.cli,
					agent: data.agent,
					createdAt: data.createdAt,
				});
				return created ? [this.vibeSpawnedFrame(rec)] : [];
			}
			case "turn-started":
			case "turn-settled": {
				const { rec, created } = this.ensureVibeWorker(id);
				const frames = created ? [this.vibeSpawnedFrame(rec)] : [];
				if (typeof data.turn === "number") rec.turns = Math.max(rec.turns, data.turn);
				frames.push(this.vibeProgressFrame(rec));
				return frames;
			}
			case "tombstone": {
				const status =
					data.reason === "explicit-kill" || data.reason === "mode-exit" ? "cancelled" : "failed";
				return this.finishVibeWorker(id, status, {
					source: "lifecycle",
					error: status === "failed" ? `vibe worker terminated (${data.reason})` : undefined,
					willWake: data.reason !== "spawn-failed",
				});
			}
			case "tombstone-revoked": {
				const rec = this.vibeWorkers.get(id);
				if (!rec || !rec.finished) return [];
				rec.finished = null;
				rec.finishSource = null;
				this.finishedSubagents.delete(id);
				return [this.vibeSpawnedFrame(rec)];
			}
			default:
				return [];
		}
	}

	/**
	 * A delivered async-result follow-up (custom_message/customType:
	 * "async-result") — the settled worker turn's result text, invisible on the
	 * wire. Rendered as a user_message_chunk flagged `interjection` so the
	 * pager paints a distinct block instead of merging it into agent text.
	 * Also feeds the owning worker's lastOutput for subagent_finished.output.
	 */
	vibeAsyncResultFrame(text, details) {
		const jobs = Array.isArray(details?.jobs) ? details.jobs : [];
		for (const job of jobs) {
			const workerId = vibeWorkerIdFromJobId(job?.jobId);
			const rec = workerId && this.vibeWorkers.get(workerId);
			if (rec) rec.lastOutput = vibeTurnResponseText(text) ?? rec.lastOutput;
		}
		return {
			jsonrpc: "2.0",
			method: "session/update",
			params: {
				sessionId: this.session?.sessionId,
				update: {
					sessionUpdate: "user_message_chunk",
					content: { type: "text", text: stripSystemNotice(text) },
					messageId: crypto.randomUUID(),
					_meta: { interjection: true },
				},
			},
		};
	}

	/**
	 * One entry from a vibe worker's child session JSONL → child session/update
	 * frames (standard `session/update` method — the pager routes by sessionId
	 * into subagent_views; the x.ai ext carrier drops non-xAI child updates).
	 * `child` is the tailer's per-worker state ({seenToolCalls}).
	 */
	observeVibeChildEntry(workerId, entry, child) {
		const frames = [];
		const push = (update) =>
			frames.push({
				jsonrpc: "2.0",
				method: "session/update",
				params: { sessionId: workerId, update },
			});
		const rec = this.vibeWorkers.get(workerId);

		const pushToolCall = (toolCallId, toolName, args, intent) => {
			if (!toolCallId || child.seenToolCalls.has(toolCallId)) return;
			child.seenToolCalls.add(toolCallId);
			if (rec) {
				rec.toolCalls++;
				if (toolName) rec.toolsUsed.add(toolName);
			}
			const update = {
				sessionUpdate: "tool_call",
				toolCallId,
				title: vibeChildToolTitle(toolName, args, intent),
				kind: vibeChildToolKind(toolName),
				status: "pending",
				rawInput: args && typeof args === "object" ? args : {},
			};
			if (optsRef.shape) {
				const meta = shapeToolUpdate(toolName, update);
				if (meta) update._meta = { "x.ai/tool": meta };
			}
			push(update);
		};

		if (entry.type === "custom" && entry.customType === "tool_execution_start") {
			// Fallback for a call whose assistant-message item was missed; the
			// persisted args here are only the command/path summary.
			const d = entry.data;
			if (d && typeof d === "object") pushToolCall(d.toolCallId, d.toolName, d.args, d.intent);
			return frames;
		}

		if (entry.type !== "message") return frames;
		const msg = entry.message;
		if (!msg || typeof msg !== "object") return frames;
		const messageId = crypto.randomUUID();

		if (msg.role === "user") {
			for (const block of vibeContentBlocks(msg.content)) {
				push({ sessionUpdate: "user_message_chunk", content: block, messageId });
			}
			return frames;
		}
		if (msg.role === "assistant") {
			const content = Array.isArray(msg.content) ? msg.content : [];
			for (const item of content) {
				if (!item || typeof item !== "object") continue;
				if (item.type === "text" && typeof item.text === "string" && item.text.length > 0) {
					push({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: item.text }, messageId });
				} else if (item.type === "thinking" && typeof item.thinking === "string" && item.thinking.length > 0) {
					push({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: item.thinking }, messageId });
				} else if ((item.type === "toolCall" || item.type === "tool_use") && typeof item.id === "string") {
					// Full arguments live on the assistant message's toolCall item.
					const args = item.arguments ?? item.input;
					pushToolCall(item.id, item.name, args, item.intent);
				}
			}
			if (frames.length === 0 && typeof msg.errorMessage === "string" && msg.errorMessage) {
				push({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: msg.errorMessage }, messageId });
			}
			return frames;
		}
		if (msg.role === "toolResult" && typeof msg.toolCallId === "string") {
			pushToolCall(msg.toolCallId, msg.toolName, msg.details?.path ? { path: msg.details.path } : {}, undefined);
			if (msg.isError === true && rec) rec.errorCount++;
			const texts = vibeContentBlocks(msg.content);
			push({
				sessionUpdate: "tool_call_update",
				toolCallId: msg.toolCallId,
				status: msg.isError === true ? "failed" : "completed",
				rawOutput: { content: msg.content, details: msg.details },
				...(texts.length ? { content: texts.map((t) => ({ type: "content", content: t })) } : {}),
			});
			return frames;
		}
		return frames;
	}


	/**
	 * Split a `user_message_chunk` carrying `<advisory>` elements into one chunk
	 * per segment. The first segment rewrites `update.content` in place (the
	 * caller forwards `frame` after this returns); the rest go out as extras so
	 * ordering is preserved. Advisory segments get
	 * `content._meta["x.ai/advisor"] = {advisor, severity}`; plain text passes
	 * through unchanged. Whitespace-only separators between elements are dropped.
	 */
	observeAdvisoryChunk(frame, update, extra) {
		const content = update.content;
		if (!content || content.type !== "text" || typeof content.text !== "string") return;
		if (!content.text.includes("<advisory")) return;
		const segments = splitAdvisoryText(content.text);
		if (!segments) return;

		const toContent = (seg) => {
			if (seg.kind === "text") return { ...content, text: seg.text };
			const meta = {};
			if (seg.advisor !== undefined) meta.advisor = seg.advisor;
			if (seg.severity !== undefined) meta.severity = seg.severity;
			return {
				...content,
				text: seg.text,
				_meta: {
					...(content._meta && typeof content._meta === "object" ? content._meta : {}),
					"x.ai/advisor": meta,
				},
			};
		};
		const toFrame = (seg) => ({
			...frame,
			params: { ...frame.params, update: { ...update, content: toContent(seg) } },
		});

		const kept = segments.filter((seg) => seg.kind === "advisory" || seg.text.trim().length > 0);
		if (kept.length === 0) return;
		update.content = toContent(kept[0]);
		for (const seg of kept.slice(1)) extra.push(toFrame(seg));
		const count = kept.filter((seg) => seg.kind === "advisory").length;
		log(`advisor: split chunk into ${kept.length} segment(s), ${count} advisor note(s)`);
	}

	// -- request answering ----------------------------------------------------

	/**
	 * Decide how to handle a client→agent request.
	 * @returns {null|{action:string,result?:any,error?:any,as?:string,translate?:Function}}
	 *   null → forward verbatim; 'answer' → respond locally; 'forward' → send to
	 *   OMP under `as` and translate the response; 'error' → respond with error.
	 */
	answerRequest(frame) {
		const method = frame.method;
		if (typeof method !== "string") return null;

		// `session/set_model` is standard ACP, not x.ai/* — but OMP doesn't
		// implement it (only set_config_option). Translate it so the pager's
		// `/model` picker works, and carry `_meta.reasoningEffort` into a
		// follow-up `thinking` config set so `/effort` works too.
		if (method === "session/set_model") {
			const p = frame.params ?? {};
			const effort = p._meta?.reasoningEffort ?? p.meta?.reasoningEffort;
			const thinking = effort ? EFFORT_TO_THINKING[String(effort).toLowerCase()] : undefined;
			if (thinking !== undefined) {
				this.followUp.push({
					jsonrpc: "2.0",
					id: `effort-${frame.id}`,
					method: "session/set_config_option",
					params: { sessionId: p.sessionId, configId: "thinking", value: thinking },
				});
			}
			return {
				action: "forward",
				as: "session/set_config_option",
				rewriteParams: { sessionId: p.sessionId, configId: "model", value: p.modelId },
				translate: () => ({}),
			};
		}

		// Virtual prompt queue (interaction.md): OMP has no server-side queue —
		// a second session/prompt mid-turn cancels the running turn. Hold extra
		// prompts client-side and drain FIFO when the turn settles. `_meta.
		// sendNow` is the pager's send-now flag: dispatch immediately and let
		// OMP's implicit cancel do exactly what send-now means.
		if (method === "session/prompt") {
			const p = frame.params ?? {};
			const promptText = promptBlocksText(p.prompt);
			// `/vibe` passthrough: the pager forwards unknown slash commands as
			// prompt text (and other ACP clients may send it raw). Translate to
			// session/set_mode against the patched OMP's vibe arm — stock OMP
			// answers with an error, which is surfaced to the client verbatim.
			const vibeMatch = /^\/vibe(?:[ \t]+([^\n]*))?(?:\n|$)/.exec(promptText.trim());
			if (vibeMatch) {
				const arg = (vibeMatch[1] ?? "").trim();
				const current = this.modeConfig?.currentValue;
				let target;
				let rest = "";
				if (/^(off|disable|exit)$/i.test(arg)) {
					target = this.defaultModeId();
				} else if (/^(on|enable)$/i.test(arg)) {
					target = "vibe";
				} else if (arg === "") {
					target = current === "vibe" ? this.defaultModeId() : "vibe";
				} else {
					target = "vibe";
					rest = arg;
				}
				const setId = `xai-int-${++this.internalSeq}`;
				const rec = { kind: "vibeMode", clientId: frame.id };
				if (rest) {
					// `/vibe <prompt>`: enter vibe, then run the prompt. The prompt
					// entry carries clientId === agentId === the pager's request id so
					// its response passes through like a normal session/prompt.
					rec.followUp = {
						queueId: p._meta?.promptId ?? `prompt-${frame.id}`,
						kind: "prompt",
						text: rest,
						version: 0,
						params: { sessionId: p.sessionId, prompt: [{ type: "text", text: rest }] },
						clientId: frame.id,
						agentId: frame.id,
					};
				}
				this.internalIds.set(setId, rec);
				this.outToAgent.push({
					jsonrpc: "2.0",
					id: setId,
					method: "session/set_mode",
					params: { sessionId: p.sessionId ?? this.session?.sessionId, modeId: target },
				});
				return { action: "defer" };
			}
			const entry = {
				queueId: p._meta?.promptId ?? `prompt-${frame.id}`,
				kind: "prompt",
				text: promptText,
				version: 0,
				frame,
				clientId: frame.id,
				agentId: frame.id,
			};
			if (this.running && !p._meta?.sendNow) this.held.push(entry);
			else this.dispatchEntry(entry);
			this.broadcastQueue();
			return { action: "hold" };
		}

		if (!method.startsWith("x.ai/") && !method.startsWith("_x.ai/")) {
			return null;
		}
		const m = method.replace(/^_?x\.ai\//, "");
		const p = frame.params ?? {};

		switch (m) {
			// -- answered from observed state ----------------------------------
			case "session/info": {
				// This call site reads `response.result` (double-wrapped), unlike
				// the bare-payload sites — see acp_handler session_info fetch.
				const used = this.usage?.used ?? 0;
				const total = this.usage?.size ?? 0;
				const usagePct = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0;
				return this.answer({
					result: {
						sessionId: this.session?.sessionId ?? "",
						cwd: this.sessionCwd ?? "",
						agentName: this.agentInfo?.name ?? "oh-my-pi",
						model: this.modelConfig?.currentValue ?? null,
						resolvedModelId: null,
						modelFingerprint: null,
						turns: this.turns,
						turnIndex: this.turns > 0 ? this.turns - 1 : 0,
						context: {
							used,
							total,
							usagePct,
							freeTokens: Math.max(0, total - used),
							turnCount: this.turns,
							compactionCount: 0,
							usageCategories: this.usageCategories(),
						},
					},
				});
			}
			case "session/usage": {
				// Bare {usage: PromptUsage}. Token counters are the sums of the
				// per-turn `usage` objects on prompt responses; cost is OMP's
				// cumulative session cost in 1e10 ticks/USD. usageIsIncomplete
				// stays honest: true for resumed sessions (pre-bridge turns we
				// never saw) and before the first usage-bearing response.
				const usage = {
					inputTokens: this.turnTokens.input,
					outputTokens: this.turnTokens.output,
					totalTokens: this.turnTokens.total,
					cachedReadTokens: this.turnTokens.cacheRead,
					cacheCreationTokens: this.turnTokens.cacheWrite,
					modelCalls: this.turns,
					modelUsage: {},
					numTurns: this.turns,
					usageIsIncomplete: this.sessionResumed || !this.sawTurnUsage,
				};
				if (this.lastCost != null) usage.costUsdTicks = Math.round(this.lastCost * 1e10);
				return this.answer({ usage });
			}
			case "commands/list": {
				// The pager fires this right after session/new, racing OMP's bootstrap
				// available_commands_update (which lands ~50ms later). Answering [] here
				// is worse than useless: the pager discards empty results, so a session
				// whose ACU was dropped (bind race) could never heal. Wait briefly for
				// the first ACU when a session exists but no catalog has arrived yet.
				if (this.commands.length === 0 && this.session) {
					return {
						action: "answerAsync",
						promise: new Promise((resolve) => {
							const waiter = { resolve, timer: null };
							waiter.timer = setTimeout(() => {
								this.commandsWaiters = this.commandsWaiters.filter((w) => w !== waiter);
								resolve({ commands: this.commands });
							}, 2000);
							this.commandsWaiters.push(waiter);
						}),
					};
				}
				return this.answer({ commands: this.commands });
			}
			case "prompt_history":
				return this.answer({ prompts: readOmpPromptHistory(p) });
			case "bundle/status":
				return this.answer({
					hasCache: false,
					personas: [],
					roles: [],
					agents: [],
					skills: [],
					personaDetails: [],
					roleDetails: [],
				});
			case "suggest":
			case "suggestPrompt":
				return this.answer({ generation: 0, ghost: null, completions: [] });

			// -- sessions (sessions.md) -----------------------------------------
			case "session/list":
				return {
					action: "forward",
					as: "session/list",
					rewriteParams: { cwd: p.cwd, cursor: p.cursor },
					translate: (r) => this.translateSessionList(r, p),
				};
			case "session/search":
				// OMP has no query param; search the full listing adapter-side.
				return {
					action: "forward",
					as: "_omp/sessions/listAll",
					rewriteParams: { limit: 1000 },
					translate: (r) => this.translateSessionSearch(r, p),
				};
			case "session/fork":
				// Pager sends sourceSessionId/newCwd; OMP wants sessionId/cwd and
				// answers {sessionId} which the pager reads back as newSessionId.
				return {
					action: "forward",
					as: "session/fork",
					rewriteParams: {
						sessionId: p.sourceSessionId ?? p.sessionId,
						cwd: p.newCwd ?? p.sourceCwd ?? p.cwd,
					},
					translate: (r) => ({ ...r, newSessionId: r?.sessionId ?? r?.newSessionId }),
				};
			case "sessions/list": {
				// FleetView roster: live session + dormant rows from the last
				// session/list. Kick a refresh so the next fetch is populated.
				if (!this.lastSessionRows.length) this.requestSessionList();
				const rows = this.lastSessionRows.map((r) => this.rosterEntryFor(r.sessionId, false));
				const liveId = this.session?.sessionId;
				if (liveId && !rows.some((r) => r.sessionId === liveId)) {
					rows.unshift(this.rosterEntryFor(liveId, true));
				} else if (liveId) {
					const i = rows.findIndex((r) => r.sessionId === liveId);
					if (i >= 0) rows[i] = this.rosterEntryFor(liveId, true);
				}
				return this.answer({ sessions: rows });
			}
			case "session/delete":
				return this.err(`session/delete: OMP exposes no ACP or CLI delete verb (SessionManager.deleteSessionWithArtifacts is internal)`);
			case "session/rename":
				return this.err(`session/rename: OMP exposes no ACP or CLI rename verb (SessionManager.setSessionName is internal)`);

			// -- interaction (interaction.md) ------------------------------------
			case "interject": {
				// True mid-turn steer is impossible over ACP: the interjection
				// lands as the next queued prompt. Echo it back so every pane
				// paints the row (the pager dedups self-originated echoes via
				// interjectionId).
				const text = typeof p.text === "string" ? p.text : "";
				const content = Array.isArray(p.content) && p.content.length ? p.content : [{ type: "text", text }];
				const entry = {
					queueId: p.interjectionId ?? `interject-${++this.internalSeq}`,
					kind: "interjection",
					text,
					version: 0,
					params: { sessionId: p.sessionId ?? this.session?.sessionId, prompt: content },
					clientId: undefined,
					agentId: `xai-int-${++this.internalSeq}`,
				};
				if (this.running) this.held.push(entry);
				else this.dispatchEntry(entry);
				this.broadcastQueue();
				this.outToClient.push(this.notif("_x.ai/session/interjection", {
					sessionId: p.sessionId ?? this.session?.sessionId,
					text,
					interjectionId: p.interjectionId,
				}));
				return this.answer({ status: "queued" });
			}
			case "btw":
				return this.err("x.ai/btw: OMP has no side-question channel over ACP");

			// -- session control (session-control.md) ----------------------------
			case "compact_conversation": {
				// OMP's /compact is a builtin slash command — a real prompt turn.
				// Queue it like any other prompt; answer {} when it settles.
				const text = `/compact${typeof p.userContext === "string" && p.userContext ? ` ${p.userContext}` : ""}`;
				const entry = {
					queueId: `compact-${++this.internalSeq}`,
					kind: "compact",
					text,
					version: 0,
					params: { sessionId: p.sessionId ?? this.session?.sessionId, prompt: [{ type: "text", text }] },
					clientId: frame.id,
					agentId: `xai-int-${++this.internalSeq}`,
					answerResult: {},
				};
				if (this.running) this.held.push(entry);
				else this.dispatchEntry(entry);
				this.broadcastQueue();
				return { action: "defer" };
			}
			case "rewind/points":
				return this.err("x.ai/rewind/points: OMP rewind is tool-driven (checkpoint tool); no per-prompt-index ACP surface");
			case "rewind/execute":
				return this.err("x.ai/rewind/execute: OMP rewind is tool-driven; no client-initiated rewind over ACP");
			case "recap":
				return this.err("x.ai/recap: OMP has no recap generator over ACP");

			// -- extensions (extensions.md) --------------------------------------
			case "skills/list":
				return {
					action: "forward",
					as: "_omp/extensions",
					rewriteParams: { cwd: p.cwd ?? this.sessionCwd },
					translate: (r) => ({ skills: this.extensionsOfKind(r, "skill").map(extensionToSkillInfo) }),
				};
			case "skills/toggle": {
				const name = p.name ?? p.skillName ?? p.skill;
				if (typeof name !== "string" || !name) return this.err("skills/toggle: missing skill name");
				const enabled = p.enabled ?? (p.disabled === true ? false : undefined);
				return {
					action: "forward",
					as: "_omp/extensions/toggle",
					rewriteParams: { providerId: `skill:${name}`, enabled: enabled !== false },
					translate: (r) => ({ result: { ok: true, enabled: r?.enabled !== false } }),
				};
			}
			case "skills/add":
			case "skills/remove":
			case "skills/reset":
			case "skills/config":
				return this.err(`x.ai/${m}: OMP has no skill ${m.split("/")[1]} over ACP`);
			case "workflows/list":
				return this.answer({ workflows: [] });
			case "hooks/list":
				return {
					action: "forward",
					as: "_omp/extensions",
					rewriteParams: { cwd: p.cwd ?? this.sessionCwd },
					translate: (r) => ({
						hooks: this.extensionsOfKind(r, "hook").map(extensionToHookInfo),
						projectTrusted: true,
						loadErrors: [],
					}),
				};
			case "hooks/action": {
				const a = p.action ?? {};
				if ((a.type === "enable" || a.type === "disable") && typeof a.hookName === "string") {
					return {
						action: "forward",
						as: "_omp/extensions/toggle",
						rewriteParams: { providerId: `hook:${a.hookName}`, enabled: a.type === "enable" },
						translate: () => {
							this.setExtState(`hook:${a.hookName}`, a.type === "enable");
							this.pushHooksChanged();
							return { result: actionOutcome("success", `hook ${a.hookName} ${a.type}d`, true) };
						},
					};
				}
				return this.answer({ result: actionOutcome("unsupported", `hooks action '${a.type ?? "?"}' has no OMP ACP path`) });
			}
			case "plugins/list":
				return {
					action: "forward",
					as: "_omp/extensions",
					rewriteParams: { cwd: p.cwd ?? this.sessionCwd },
					translate: (r) => ({ plugins: this.extensionsOfKind(r, "plugin").map(extensionToPluginInfo) }),
				};
			case "plugins/action": {
				const a = p.action ?? {};
				if ((a.type === "enable" || a.type === "disable") && typeof a.pluginId === "string") {
					return {
						action: "forward",
						rewriteParams: { providerId: `plugin:${a.pluginId}`, enabled: a.type === "enable" },
						translate: () => {
							this.setExtState(`plugin:${a.pluginId}`, a.type === "enable");
							this.pushPluginsChanged();
							return { result: actionOutcome("success", `plugin ${a.pluginId} ${a.type}d`, true) };
						},
					};
				}
				return this.answer({ result: actionOutcome("unsupported", `plugins action '${a.type ?? "?"}' has no OMP ACP path`) });
			}
			case "plugins/reload":
				return this.answer({ result: actionOutcome("unsupported", "OMP reloads plugins internally; no ACP reload") });
			case "marketplace/list":
				return this.answer({ sources: [] });
			case "marketplace/action":
				return this.err("x.ai/marketplace/action: OMP marketplace has no ACP surface");
			case "mcp/list":
				return {
					action: "forward",
					as: "_omp/extensions",
					rewriteParams: { cwd: this.sessionCwd },
					translate: (r) => ({ servers: this.mcpServerEntries(r) }),
				};
			case "mcp/toggle": {
				const serverName = p.serverName ?? p.server_name;
				if (typeof serverName !== "string" || !serverName) return this.err("mcp/toggle: missing serverName");
				return {
					action: "forward",
					as: "_omp/extensions/toggle",
					rewriteParams: { providerId: `mcp:${serverName}`, enabled: p.enabled !== false },
					translate: () => {
						this.setExtState(`mcp:${serverName}`, p.enabled !== false);
						// Real wire shape: {mcpServers:[...]} with NO sessionId — the
						// pager broadcasts to every agent with an open modal.
						this.outToClient.push(this.notif("_x.ai/mcp/servers_updated", { mcpServers: [] }));
						return { result: { ok: true } };
					},
				};
			}
			case "mcp/toggle_tool":
			case "mcp/upsert":
			case "mcp/delete":
			case "mcp/setup":
			case "mcp/auth_status":
			case "mcp/auth_trigger":
			case "mcp/read_resource":
			case "mcp/call":
				return this.err(`x.ai/${m}: OMP MCP ${m.split("/")[1]} has no ACP surface`);

			// -- subagents & tasks (subagents.md) --------------------------------
			case "subagent/cancel": {
				// No per-subagent cancel crosses ACP — session/cancel would kill
				// the whole turn. Answer truthfully: not_found for unknown ids,
				// already_finished for completed ones, and (per the pager-side
				// contract) not_found for live omp-task rows so the pager keeps
				// the row live with a note instead of stamping it cancelled.
				const id = p.subagentId ?? p.subagent_id;
				const finished = this.finishedSubagents?.get(id);
				const outcome = finished
					? { kind: "already_finished", status: finished }
					: { kind: "not_found" };
				return this.answer({ result: { subagentId: id, cancelled: false, outcome } });
			}
			case "subagent/list_running":
				return this.answer({
					result: {
						subagents: [
							...[...this.subagents.values()].map((r) => ({
								subagentId: r.subagentId,
								parentSessionId: this.session?.sessionId ?? "",
								childSessionId: r.childSessionId,
								subagentType: r.subagentType,
								description: r.description,
								startedAtEpochMs: r.startedAt,
								durationMs: Date.now() - r.startedAt,
								turnCount: 0,
								toolCallCount: r.toolCalls,
								tokensUsed: 0,
								contextWindowTokens: this.usage?.size ?? 0,
								contextUsagePct: this.usage?.size ? Math.min(100, Math.round(((this.usage?.used ?? 0) / this.usage.size) * 100)) : 0,
								toolsUsed: [],
								errorCount: 0,
							})),
							// Live vibe workers persist across director turns.
							...[...this.vibeWorkers.values()].filter((r) => !r.finished).map((r) => ({
								subagentId: r.subagentId,
								parentSessionId: this.session?.sessionId ?? "",
								childSessionId: r.childSessionId,
								subagentType: r.subagentType,
								description: r.description,
								startedAtEpochMs: r.startedAt,
								durationMs: Date.now() - r.startedAt,
								turnCount: r.turns,
								toolCallCount: r.toolCalls,
								tokensUsed: 0,
								contextWindowTokens: this.usage?.size ?? 0,
								contextUsagePct: this.usage?.size ? Math.min(100, Math.round(((this.usage?.used ?? 0) / this.usage.size) * 100)) : 0,
								toolsUsed: [...r.toolsUsed].sort(),
								errorCount: r.errorCount,
							})),
						],
					},
				});
			case "subagent/message":
				return this.err("x.ai/subagent/message: OMP subagent steering does not cross ACP");
			case "task/kill":
				return this.err("x.ai/task/kill: OMP exposes no background-task registry over ACP; bash{async} completions arrive as ordinary tool_call results");
			case "task/list":
				return this.answer({ result: { tasks: [] } });
			// -- OMP provider connect (Settings › OMP › Providers) -------------
			case "omp/providers":
				return { action: "answerAsync", promise: Promise.resolve().then(() => this.ompProvidersList()) };
			case "omp/connect":
				return { action: "answerAsync", promise: this.ompConnect(p) };
			case "omp/connect_status":
				return this.answer(this.ompConnectStatus());
			case "omp/connect_code":
				return { action: "answerAsync", promise: this.ompConnectCode(p) };
			case "omp/connect_cancel":
				return this.answer(this.ompConnectCancel());


			// -- auth & billing (auth-accounts.md, usage-cost.md) ----------------
			case "auth/info":
				// Minimal honest account row: OMP auth is ambient local
				// credentials; retention opt-out fails closed like the shell's
				// no-credential default.
				return this.answer({ result: { methodId: "agent", codingDataRetentionOptOut: true } });
			case "auth/get_url":
			case "auth/submit_code":
			case "auth/cancel":
			case "auth/logout":
			case "auth/check_subscription":
			case "auth/getBearerToken":
			case "getApiKey":
			case "setApiKey":
				return this.err(`x.ai/${m}: no xAI auth flow exists behind OMP; credentials live in OMP's own store`);
			case "consent/record":
				return this.err("x.ai/consent/record: consent notices are xAI-server-targeted; none apply to OMP");
			case "billing":
			case "auto-topup-rule":
				return this.err(`x.ai/${m}: OMP has no xAI billing concept`);

			// -- data surfaces (data-surfaces.md) --------------------------------
			case "share_session":
				return this.err("x.ai/share_session: OMP has no remote share service");
			case "memory/flush":
			case "memory/rewrite":
				return this.err(`x.ai/${m}: OMP session memory is internal; no ACP flush/rewrite`);
			case "scheduler/delete":
				return this.err("x.ai/scheduler/delete: OMP has no scheduler");

			// -- worktrees (worktrees.md) — real local git work ------------------
			case "git/worktree/create_from_worktree_sync":
				return { action: "answerAsync", promise: this.worktreeCreate(p) };
			case "git/worktree/resume_session":
				return { action: "answerAsync", promise: this.worktreeResume(p) };
			case "git/worktree/list":
				return { action: "answerAsync", promise: this.worktreeList(p) };
			case "git/worktree/remove":
				return { action: "answerAsync", promise: this.worktreeRemove(p) };

			// -- no OMP data source: error, don't fabricate ---------------------
			default:
				return {
					action: "error",
					error: { code: -32601, message: `x.ai method not available via OMP: ${method}` },
				};
		}
	}

	err(message) {
		return { action: "error", error: { code: -32601, message } };
	}

	// -- virtual prompt queue ---------------------------------------------------

	/** Send a held/new prompt to OMP and mark it running. */
	dispatchEntry(entry) {
		const agentId = entry.agentId ?? `xai-int-${++this.internalSeq}`;
		entry.agentId = agentId;
		const req = entry.frame ?? {
			jsonrpc: "2.0",
			id: agentId,
			method: "session/prompt",
			params: entry.params,
		};
		if (entry.clientId !== agentId) this.internalIds.set(agentId, entry);
		this.inFlightPrompts.add(agentId);
		this.running = { agentId, queueId: entry.queueId, kind: entry.kind, text: entry.text };
		this.outToAgent.push(req);
	}

	/** A prompt response arrived: settle the turn and release the next held. */
	settleTurn(agentId, stopReason) {
		this.inFlightPrompts.delete(agentId);
		if (this.running?.agentId !== agentId) return; // implicitly-cancelled prompt settling late
		this.running = null;
		this.finishSubagentsAtTurnEnd(stopReason);
		this.broadcastQueue();
	}

	/** Accumulate per-turn usage from a session/prompt response. */
	noteTurnSettled(frame) {
		this.turns++;
		const u = frame?.result?.usage;
		if (u && typeof u === "object") {
			this.sawTurnUsage = true;
			this.turnTokens.input += u.inputTokens ?? 0;
			this.turnTokens.output += u.outputTokens ?? 0;
			this.turnTokens.total += u.totalTokens ?? 0;
			this.turnTokens.cacheRead += u.cachedReadTokens ?? 0;
			this.turnTokens.cacheWrite += u.cachedWriteTokens ?? 0;
		}
	}

	/**
	 * Agent→client response handling for adapter-internal requests and turn
	 * bookkeeping. Returns true when the frame was consumed (must not reach the
	 * pager), false/null to pass through.
	 */
	handleAgentResponse(frame) {
		if (!frame || typeof frame !== "object" || frame.id === undefined || frame.method !== undefined) return null;
		const rec = this.internalIds.get(frame.id);
		if (rec) {
			this.internalIds.delete(frame.id);
			if (rec.kind === "prompt" || rec.params) {
				this.noteTurnSettled(frame);
				this.settleTurn(frame.id, frame.result?.stopReason);
			}
			if (rec.kind === "vibeMode") {
				// `/vibe` interception: the set_mode response settles the client's
				// prompt request. On error the client gets the error verbatim; on
				// success a `/vibe <prompt>` follow-up is dispatched (or held behind
				// a running turn) and its own response answers the client.
				if (frame.error !== undefined) {
					this.outToClient.push({ jsonrpc: "2.0", id: rec.clientId, error: frame.error });
				} else if (rec.followUp) {
					if (this.running) this.held.push(rec.followUp);
					else this.dispatchEntry(rec.followUp);
					this.broadcastQueue();
				} else {
					this.outToClient.push({
						jsonrpc: "2.0",
						id: rec.clientId,
						result: { stopReason: "end_turn" },
					});
				}
				return true;
			}
			if (rec.kind === "sessionList" && frame.result !== undefined) {
				this.lastSessionRows = this.translateSessionList(frame.result, {}).sessions;
				this.outToClient.push(this.notif("_x.ai/sessions/changed", {
					upserted: this.lastSessionRows.map((r) => this.rosterEntryFor(r.sessionId, false)),
					removed: [],
				}));
			}
			if (rec.clientId !== undefined) {
				this.outToClient.push(
					frame.error !== undefined
						? { jsonrpc: "2.0", id: rec.clientId, error: frame.error }
						: { jsonrpc: "2.0", id: rec.clientId, result: rec.answerResult ?? {} },
				);
			}
			return true;
		}
		if (this.inFlightPrompts.has(frame.id)) {
			this.noteTurnSettled(frame);
			this.settleTurn(frame.id, frame.result?.stopReason);
			return null; // pager-originated prompt: response passes through
		}
		return null;
	}

	/**
	 * Client→agent response handling: answers to adapter-bridged elicitation
	 * requests are translated back to OMP's `elicitation/create` shape and
	 * re-emitted under OMP's original request id. Returns the frame to send to
	 * OMP, or null when the frame isn't a bridged response.
	 */
	handleClientResponse(frame) {
		if (!frame || typeof frame !== "object" || frame.id === undefined || frame.method !== undefined) return null;
		const rec = this.bridgedElicits.get(frame.id);
		if (!rec) return null;
		this.bridgedElicits.delete(frame.id);
		const result = frame.error !== undefined ? { action: "cancel" } : this.elicitResultToOmp(rec, frame.result);
		return { jsonrpc: "2.0", id: rec.ompId, result };
	}

	/**
	 * Client→agent notifications on the x.ai rail (no id): queue mutations and
	 * plan-mode toggle. Returns true when consumed; false → forward verbatim.
	 */
	handleNotification(frame) {
		const method = frame?.method;
		if (typeof method !== "string" || frame.id !== undefined) return false;
		if (!method.startsWith("x.ai/") && !method.startsWith("_x.ai/")) return false;
		const m = method.replace(/^_?x\.ai\//, "");
		const p = frame.params ?? {};
		switch (m) {
			case "toggle_plan_mode": {
				const current = this.modeConfig?.currentValue;
				const target = current === "plan" ? this.defaultModeId() : "plan";
				this.emitAgentRequest("session/set_mode", {
					sessionId: p.sessionId ?? this.session?.sessionId,
					modeId: target,
				});
				return true;
			}
			case "queue/remove": {
				const i = this.held.findIndex((e) => e.queueId === p.id);
				if (i >= 0) this.cancelHeld(this.held.splice(i, 1)[0]);
				this.broadcastQueue();
				return true;
			}
			case "queue/reorder": {
				if (Array.isArray(p.orderedIds)) {
					const rank = new Map(p.orderedIds.map((id, i) => [id, i]));
					this.held.sort((a, b) => (rank.get(a.queueId) ?? 1e9) - (rank.get(b.queueId) ?? 1e9));
				}
				this.broadcastQueue();
				return true;
			}
			case "queue/clear": {
				for (const e of this.held.splice(0)) this.cancelHeld(e);
				this.broadcastQueue();
				return true;
			}
			case "queue/edit": {
				const e = this.held.find((x) => x.queueId === p.id);
				if (e && typeof p.newText === "string") {
					e.text = p.newText;
					e.version++;
					const blocks = [{ type: "text", text: p.newText }];
					if (e.frame?.params?.prompt) e.frame.params.prompt = blocks;
					if (e.params?.prompt) e.params.prompt = blocks;
				}
				this.broadcastQueue();
				return true;
			}
			case "queue/interject": {
				// Send-now: promote the held entry immediately. OMP cancels the
				// running turn on the new prompt — exactly send-now semantics.
				const i = this.held.findIndex((e) => e.queueId === p.id);
				const e = i >= 0 ? this.held.splice(i, 1)[0] : null;
				if (e) {
					if (typeof p.newText === "string") {
						e.text = p.newText;
						const blocks = [{ type: "text", text: p.newText }];
						if (e.frame?.params?.prompt) e.frame.params.prompt = blocks;
						if (e.params?.prompt) e.params.prompt = blocks;
					}
					this.dispatchEntry(e);
				}
				this.broadcastQueue();
				return true;
			}
			case "queue/hold_edit":
			case "queue/release_edit":
				// Advisory edit locks; the virtual queue has no in-place editor.
				return true;
			default:
				return false;
		}
	}

	/** Answer a removed/cleared held prompt so no pager request hangs. */
	cancelHeld(entry) {
		if (entry.clientId === undefined) return;
		const result = entry.clientId === entry.agentId ? { stopReason: "cancelled" } : (entry.answerResult ?? {});
		this.outToClient.push({ jsonrpc: "2.0", id: entry.clientId, result });
	}

	/** Broadcast the virtual queue snapshot the pager's queue pane repaints on. */
	broadcastQueue() {
		const sessionId = this.session?.sessionId;
		if (!sessionId) return;
		const params = {
			sessionId,
			entries: this.held.map((e, i) => ({
				id: e.queueId,
				version: e.version,
				kind: e.kind,
				text: e.text,
				position: i,
			})),
		};
		if (this.running) {
			params.runningPromptId = this.running.queueId;
			params.runningText = this.running.text;
			params.runningKind = this.running.kind;
		}
		this.outToClient.push(this.notif("_x.ai/queue/changed", params));
	}

	/** Drop all queue state on a session switch; held prompts get cancelled answers. */
	resetQueue() {
		for (const e of this.held.splice(0)) this.cancelHeld(e);
		this.running = null;
		this.inFlightPrompts.clear();
		// A session switch orphans every tracked subagent: the new session can't
		// report their finish, so record them cancelled for cancel-answer
		// accuracy and stop listing them as running.
		for (const rec of this.subagents.values()) {
			this.finishedSubagents.set(rec.subagentId, "cancelled");
		}
		this.subagents.clear();
		for (const rec of this.vibeWorkers.values()) {
			if (!rec.finished) this.finishedSubagents.set(rec.subagentId, "cancelled");
		}
		this.vibeWorkers.clear();
		this.vibeCalls.clear();
		this.turns = 0;
		this.lastCost = null;
		this.turnTokens = { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 };
		this.sawTurnUsage = false;
		this.sessionTitle = null;
		this.broadcastQueue();
	}

	/** Emit an adapter-internal request to OMP; its response never reaches the pager. */
	emitAgentRequest(method, params) {
		const id = `xai-int-${++this.internalSeq}`;
		this.internalIds.set(id, { kind: "internal" });
		this.outToAgent.push({ jsonrpc: "2.0", id, method, params });
		return id;
	}

	/** Refresh the session-list cache via an internal session/list request. */
	requestSessionList() {
		const id = `xai-int-${++this.internalSeq}`;
		this.internalIds.set(id, { kind: "sessionList" });
		this.outToAgent.push({
			jsonrpc: "2.0",
			id,
			method: "session/list",
			params: this.sessionCwd ? { cwd: this.sessionCwd } : {},
		});
	}

	/** The non-modal mode to toggle back to (skips plan AND vibe). */
	defaultModeId() {
		const opts = this.modeConfig?.options ?? this.session?.modes?.availableModes ?? [];
		for (const o of opts) {
			const id = o?.value ?? o?.id ?? o;
			if (id && id !== "plan" && id !== "vibe") return id;
		}
		return "default";
	}

	// -- session list/search/roster translation ---------------------------------

	/** Enrich OMP session/list rows into the pager's picker shape, then filter. */
	translateSessionList(result, params) {
		const enriched = enrichSessionList(result);
		for (const s of enriched.sessions) {
			s.numMessages ??= s._meta?.messageCount;
			s.createdAt ??= s.updatedAt;
			const label = s.cwd && this.knownWorktrees.get(s.cwd);
			if (label) {
				s.worktreeLabel = label;
				s.sessionKind = "worktree";
			}
		}
		this.lastSessionRows = enriched.sessions;
		let rows = enriched.sessions;
		const q = typeof params?.query === "string" ? params.query.trim().toLowerCase() : "";
		if (q) {
			rows = rows.filter(
				(s) =>
					(s.summary ?? "").toLowerCase().includes(q) ||
					(s.firstPrompt ?? "").toLowerCase().includes(q),
			);
		}
		if (typeof params?.limit === "number" && params.limit > 0) rows = rows.slice(0, params.limit);
		return { sessions: rows };
	}

	/** Substring-filter the full session listing into SearchSessionHit rows. */
	translateSessionSearch(result, params) {
		const { sessions } = this.translateSessionList(result, {});
		const q = (params?.query ?? "").toLowerCase();
		const limit = typeof params?.limit === "number" && params.limit > 0 ? params.limit : 20;
		const hits = [];
		for (const s of sessions) {
			const hay = `${s.summary ?? ""}\n${s.firstPrompt ?? ""}`.toLowerCase();
			if (q && !hay.includes(q)) continue;
			hits.push({
				sessionId: s.sessionId,
				cwd: s.cwd ?? "",
				summary: s.summary ?? s.firstPrompt ?? "",
				updatedAt: s.updatedAt ?? "",
				score: 1,
				matchedFields: ["title"],
			});
			if (hits.length >= limit) break;
		}
		return { results: hits, bootstrapping: false };
	}

	/** One FleetView roster row from a cached session-list row or live state. */
	rosterEntryFor(sessionId, live) {
		const row = this.lastSessionRows.find((r) => r.sessionId === sessionId);
		const isLive = live && sessionId === this.session?.sessionId;
		const cwd = row?.cwd ?? (isLive ? this.sessionCwd : "") ?? "";
		return {
			sessionId,
			title: row?.summary ?? (isLive ? this.sessionTitle : undefined) ?? undefined,
			cwd,
			isWorktree: row?.worktreeLabel !== undefined || this.knownWorktrees.has(cwd),
			modelId: isLive ? (this.modelConfig?.currentValue ?? undefined) : row?.modelId,
			yolo: false,
			activity: isLive ? (this.running ? "working" : "idle") : "dormant",
			lastTurnSummary: row?.lastTurnSummary,
			resident: isLive === true,
			lastChangeUnixMs: Date.parse(row?.updatedAt ?? "") || Date.now(),
			origin: { kind: "local" },
		};
	}

	// -- extensions translation ---------------------------------------------------

	extensionsOfKind(result, kind) {
		const exts = Array.isArray(result?.extensions) ? result.extensions : [];
		this.extCache = result;
		return exts.filter((e) => e?.kind === kind);
	}

	/** Update a cached extension's state after a successful toggle. */
	setExtState(providerId, enabled) {
		const e = this.extCache?.extensions?.find((x) => x?.id === providerId || x?.name === providerId.split(":")[1]);
		if (e) e.state = enabled ? "active" : "disabled";
	}

	/** Push hooks_changed with the post-toggle list (pager applies the payload). */
	pushHooksChanged() {
		const sessionId = this.session?.sessionId;
		if (!sessionId || !this.extCache) return;
		this.outToClient.push(this.notif("_x.ai/session/update", {
			sessionId,
			update: {
				sessionUpdate: "hooks_changed",
				hooks: this.extensionsOfKind(this.extCache, "hook").map(extensionToHookInfo),
				project_trusted: true,
				load_errors: [],
			},
		}));
	}

	/** Push plugins_changed with the post-toggle list (pager applies the payload). */
	pushPluginsChanged() {
		const sessionId = this.session?.sessionId;
		if (!sessionId || !this.extCache) return;
		this.outToClient.push(this.notif("_x.ai/session/update", {
			sessionId,
			update: {
				sessionUpdate: "plugins_changed",
				plugins: this.extensionsOfKind(this.extCache, "plugin").map(extensionToPluginInfo),
			},
		}));
	}

	/** Merge session/new mcpServers with _omp/extensions mcp-kind entries. */
	mcpServerEntries(result) {
		const byName = new Map();
		for (const s of this.mcpServers) {
			if (!s?.name) continue;
			byName.set(s.name, {
				name: s.name,
				source: "local",
				...(s.url
					? { type: "http", url: s.url }
					: { type: "stdio", command: s.command ?? "", args: s.args ?? [], env: s.env ?? [] }),
				session: { enabled: true },
			});
		}
		for (const e of this.extensionsOfKind(result, "mcp")) {
			const enabled = e.state !== "disabled";
			const existing = byName.get(e.name);
			if (existing) {
				existing.session.enabled = enabled;
			} else {
				byName.set(e.name, {
					name: e.name,
					displayName: e.displayName !== e.name ? e.displayName : undefined,
					source: "local",
					type: "stdio",
					command: "",
					session: { enabled },
				});
			}
		}
		return [...byName.values()];
	}

	/** usageCategories for ContextInfo: real counts, unknown token costs stay 0. */
	usageCategories() {
		const cats = [];
		const exts = this.extCache?.extensions;
		const active = (k) => (Array.isArray(exts) ? exts.filter((e) => e.kind === k && e.state === "active").length : 0);
		const skills = active("skill");
		if (skills) cats.push({ label: "Skills", tokens: 0, detail: `${skills} skill${skills === 1 ? "" : "s"}` });
		const mcps = active("mcp") || this.mcpServers.length;
		if (mcps) cats.push({ label: "MCP servers", tokens: 0, detail: `${mcps} server${mcps === 1 ? "" : "s"}` });
		return cats;
	}

	// -- elicitation bridge (interaction.md, session-control.md) ------------------
	//
	// OMP's ask tool and plan approval use standard ACP `elicitation/create`,
	// which the pager cannot decode (no ElicitationRequest variant). Translate
	// to the pager's private question/elicit/plan-approval requests and map the
	// outcome back to {action, content}. Unrepresentable schemas fall through
	// verbatim — the pager's method_not_found makes OMP auto-approve, same as
	// a client without elicitation.form.

	bridgeElicitation(frame) {
		const p = frame.params ?? {};
		const pagerId = `xai-elicit-${++this.internalSeq}`;
		const sessionId = p.sessionId ?? this.session?.sessionId;
		const valueProp = p.requestedSchema?.properties?.value;
		const enumVals = Array.isArray(valueProp?.enum) ? valueProp.enum : null;

		// OMP's plan approval: a select over ["Approve and execute","Refine plan"]
		// on an "Approve plan …" message → the pager's plan-approval view.
		if (enumVals?.includes("Approve and execute") && typeof p.message === "string" && p.message.startsWith("Approve plan")) {
			this.bridgedElicits.set(pagerId, { ompId: frame.id, kind: "plan" });
			return {
				jsonrpc: "2.0",
				id: pagerId,
				method: "_x.ai/exit_plan_mode",
				params: { sessionId, toolCallId: pagerId, planContent: p.message },
			};
		}

		if (p.mode === "url" && typeof p.url === "string") {
			this.bridgedElicits.set(pagerId, { ompId: frame.id, kind: "mcp" });
			return {
				jsonrpc: "2.0",
				id: pagerId,
				method: "_x.ai/mcp/elicit",
				params: {
					sessionId,
					toolCallId: pagerId,
					serverName: "omp",
					message: p.message ?? "",
					mode: "url",
					url: p.url,
					elicitationId: p.elicitationId ?? pagerId,
				},
			};
		}

		const props = p.requestedSchema?.properties;
		if (props && typeof props === "object") {
			const questions = [];
			const keyByQuestion = new Map();
			for (const [key, prop] of Object.entries(props)) {
				const q = schemaPropToQuestion(key, prop, p.message);
				if (!q) return null;
				questions.push(q);
				// The pager keys answers/annotations by question text, not id.
				keyByQuestion.set(q.question, key);
			}
			if (!questions.length) return null;
			this.bridgedElicits.set(pagerId, { ompId: frame.id, kind: "ask", props, keyByQuestion });
			return {
				jsonrpc: "2.0",
				id: pagerId,
				method: "_x.ai/ask_user_question",
				params: {
					sessionId,
					toolCallId: pagerId,
					questions,
					mode: this.modeConfig?.currentValue === "plan" ? "plan" : "default",
				},
			};
		}
		return null;
	}

	/** Map a pager question/elicit/plan outcome back to elicitation/create's shape. */
	elicitResultToOmp(rec, result) {
		const outcome = result?.outcome;
		if (rec.kind === "plan") {
			return outcome === "approved"
				? { action: "accept", content: { value: "Approve and execute" } }
				: { action: "cancel" };
		}
		if (rec.kind === "mcp") {
			if (outcome === "accept") return { action: "accept", content: result.content ?? {} };
			return { action: outcome === "decline" ? "decline" : "cancel" };
		}
		// ask_user_question → form content keyed by property name. The pager
		// keys answers/annotations by question TEXT; keyByQuestion maps back.
		if (outcome === "accepted") {
			const content = {};
			const answers = result.answers ?? {};
			const annotations = result.annotations ?? {};
			for (const [key, prop] of Object.entries(rec.props ?? {})) {
				const qText = [...(rec.keyByQuestion?.entries() ?? [])].find(([, k]) => k === key)?.[0] ?? key;
				const labels = answers[qText];
				const first = Array.isArray(labels) ? labels[0] : labels;
				const notes = annotations[qText]?.notes;
				if (prop?.type === "boolean") {
					const v = first ?? notes;
					if (v !== undefined) content[key] = v === "Yes" || v === "true" || v === true;
				} else if (prop?.type === "number" || prop?.type === "integer") {
					const raw = first === "Other" ? notes : (first ?? notes);
					const n = Number(raw);
					if (raw !== undefined && Number.isFinite(n)) content[key] = n;
				} else {
					// Freeform answers arrive as labels:["Other"] + notes holding
					// the typed text — prefer notes in that case.
					const v = first === "Other" && notes !== undefined
						? notes
						: (Array.isArray(labels) && labels.length > 1 ? labels : first) ?? notes;
					if (v !== undefined) content[key] = v;
				}
			}
			return { action: "accept", content };
		}
		// chat_about_this / skip_interview carry partial answers but no commit —
		// decline so OMP treats it as a non-answer, never an approval.
		if (outcome === "chat_about_this" || outcome === "skip_interview") return { action: "decline" };
		return { action: "cancel" };
	}

	// -- worktrees (worktrees.md): real local git work, nothing from OMP ---------

	async worktreeCreate(p) {
		const src = p.sourceWorktreePath ?? p.sourceCwd;
		if (typeof src !== "string" || !src) throw rpcError(-32602, "sourceWorktreePath required");
		const root = (await gitOut(src, ["rev-parse", "--show-toplevel"])).trim();
		const label = sanitizeLabel(p.label ?? p.newSessionId ?? "worktree");
		const dest = join(dirname(root), `${root.split("/").pop()}.worktrees`, label);
		await gitWorktreeAdd(root, dest, p.gitRef ?? "HEAD");
		if (p.copyMode === "dirty") await copyDirtyFiles(src, dest);
		this.knownWorktrees.set(dest, label);
		return { worktreePath: dest, sourceGitRoot: root };
	}

	async worktreeResume(p) {
		const src = p.sourceCwd;
		if (typeof src !== "string" || !src) throw rpcError(-32602, "sourceCwd required");
		const root = (await gitOut(src, ["rev-parse", "--show-toplevel"])).trim();
		const label = sanitizeLabel(p.label ?? `resume-${p.sessionId ?? "session"}`);
		const dest = join(dirname(root), `${root.split("/").pop()}.worktrees`, label);
		await gitWorktreeAdd(root, dest, p.gitRef ?? "HEAD");
		if (p.copyMode === "dirty") await copyDirtyFiles(src, dest);
		this.knownWorktrees.set(dest, label);
		const rel = relative(root, src);
		return {
			worktreePath: dest,
			effectiveCwd: rel && rel !== "." ? join(dest, rel) : dest,
			sessionId: p.sessionId,
			codeRestored: false, // OMP checkpoint/rewind is tool-driven; nothing to restore client-side
		};
	}

	async worktreeList(p) {
		const cwd = p.cwd ?? p.sourceCwd ?? this.sessionCwd;
		if (typeof cwd !== "string" || !cwd) return { result: [] };
		const root = (await gitOut(cwd, ["rev-parse", "--show-toplevel"])).trim();
		const out = await gitOut(root, ["worktree", "list", "--porcelain"]);
		const records = [];
		let cur = null;
		for (const line of out.split("\n")) {
			if (line.startsWith("worktree ")) {
				if (cur) records.push(cur);
				cur = { path: line.slice(9), head: null, branch: null };
			} else if (cur && line.startsWith("HEAD ")) {
				cur.head = line.slice(5);
			} else if (cur && line.startsWith("branch ")) {
				cur.branch = line.slice(7).replace(/^refs\/heads\//, "");
			}
		}
		if (cur) records.push(cur);
		return {
			result: records.map((r) => ({
				id: r.path,
				path: r.path,
				source_repo: root,
				repo_name: root.split("/").pop(),
				kind: "session",
				creation_mode: "unknown",
				git_ref: r.branch,
				head_commit: r.head,
				session_id: null,
				creator_pid: null,
				created_at: 0,
				last_accessed_at: null,
				status: "alive",
				metadata: this.knownWorktrees.has(r.path) ? { label: this.knownWorktrees.get(r.path) } : null,
			})),
		};
	}

	// -- OMP provider connect -------------------------------------------------

	/**
	 * `x.ai/omp/providers`: every connectable provider with its auth status.
	 * Status is read live from the isolated agent.db plus the process env, so a
	 * key written by `omp/connect` shows up on the next call.
	 */
	ompProvidersList() {
		const db = openOmpAuthDb();
		const rows = db ? listOmpCredentials(db) : [];
		const byProvider = new Map();
		for (const r of rows) {
			const list = byProvider.get(r.provider) ?? [];
			list.push(r);
			byProvider.set(r.provider, list);
		}
		const providers = [];
		const seen = new Set();
		const push = (id, name, kind, env) => {
			if (seen.has(id)) return;
			seen.add(id);
			const creds = byProvider.get(id) ?? [];
			const stored = creds.some((c) => c.credential_type === "oauth")
				? "oauth"
				: creds.length > 0
					? "api_key"
					: null;
			const envSet = env ? Boolean(process.env[env]?.trim()) : false;
			providers.push({
				id,
				name,
				kind, // "api_key" | "oauth" | "both"
				env: env ?? null,
				connected: stored !== null || envSet,
				source: stored ?? (envSet ? "env" : null),
			});
		};
		for (const p of OMP_API_KEY_PROVIDERS) {
			const oauth = OMP_OAUTH_PROVIDERS.find((o) => o.id === p.id);
			push(p.id, p.name, oauth ? "both" : "api_key", p.env);
		}
		for (const o of OMP_OAUTH_PROVIDERS) {
			push(o.id, o.name, "oauth", null);
		}
		// Stored credentials for providers outside both catalogs still surface —
		// connected, connectable via key replace.
		for (const [provider] of byProvider) {
			if (!seen.has(provider)) push(provider, provider, "api_key", null);
		}
		if (db) db.close();
		return { providers, dbPath: ompAgentDbPath() };
	}

	/**
	 * `x.ai/omp/connect` {provider, apiKey?}: with an apiKey, persist it to the
	 * isolated agent.db and finish. Without one, start `omp auth-broker login
	 * <provider>` and return the initial state (the pager polls
	 * omp/connect_status for the URL / code prompt / outcome).
	 */
	async ompConnect(p) {
		const provider = typeof p.provider === "string" ? p.provider.trim() : "";
		if (!provider) throw new Error("omp/connect: provider required");
		const apiKey = typeof p.apiKey === "string" ? p.apiKey.trim() : "";
		if (apiKey) {
			const dbPath = storeOmpApiKey(provider, apiKey);
			return { status: "connected", provider, kind: "api_key", dbPath, restartRequired: true };
		}
		const oauth = OMP_OAUTH_PROVIDERS.find((o) => o.id === provider);
		if (!oauth) {
			throw new Error(`omp/connect: ${provider} takes an API key (no OAuth flow); pass apiKey`);
		}
		this.ompLoginCancel();
		const omp = ompBinary(this.agentArgv);
		const proc = Bun.spawn([omp, "auth-broker", "login", provider], {
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			env: process.env,
		});
		const login = {
			proc,
			provider,
			phase: "starting", // starting → waiting_url → waiting_browser | needs_code → done | failed
			authUrl: null,
			launchUrl: null,
			instructions: null,
			lines: [],
			error: null,
			exitCode: null,
		};
		this.ompLogin = login;

		// Drain stdout/stderr: the login flow prints the auth URL, progress lines, and
		// (for paste-code providers) a code prompt. Bun yields Uint8Array chunks —
		// decode them (chunk.toString() would produce comma-separated byte values).
		const decoder = new TextDecoder();
		let stdoutBuf = "";
		let stderrBuf = "";
		void (async () => {
			try {
				for await (const chunk of proc.stdout) {
					stdoutBuf += decoder.decode(chunk, { stream: true });
					const parts = stdoutBuf.split("\n");
					stdoutBuf = parts.pop() ?? "";
					login.lines.push(...parts.filter((l) => l.trim()));
					this.#ompLoginScan(login);
				}
			} catch {}
		})();
		void (async () => {
			try {
				for await (const chunk of proc.stderr) {
					stderrBuf += decoder.decode(chunk, { stream: true });
					const parts = stderrBuf.split("\n");
					stderrBuf = parts.pop() ?? "";
					login.lines.push(...parts.filter((l) => l.trim()));
				}
			} catch {}
		})();
		void proc.exited.then((code) => {
			login.exitCode = code;
			if (login.phase !== "done" && login.phase !== "failed") {
				login.phase = code === 0 ? "done" : "failed";
				if (code !== 0 && !login.error) {
					login.error = login.lines.at(-1) ?? `omp auth-broker login exited ${code}`;
				}
			}
		});
		// Give the child a moment to print the auth URL so the first response
		// usually already carries it; the pager polls for the rest.
		const deadline = Date.now() + 8000;
		while (Date.now() < deadline && login.phase === "starting" && !login.authUrl) {
			await new Promise((r) => setTimeout(r, 100));
		}
		return this.ompConnectStatus();
	}

	/** Scan accumulated login output for the auth URL and code prompt. */
	#ompLoginScan(login) {
		for (const line of login.lines) {
			if (!login.authUrl) {
				const m = line.match(/https?:\/\/\S+/);
				if (m && !/local shortcut/i.test(line)) login.authUrl = m[0];
			}
			if (/local shortcut.*https?:\/\/\S+/i.test(line)) {
				login.launchUrl = line.match(/https?:\/\/\S+/)?.[0] ?? null;
			}
			// Device-code flows print "Enter code: XXXX" (a code to type into the browser),
			// not a code to paste back — only "paste"/"redirect url" lines mean stdin input.
			if (/paste the (authorization )?code|redirect url/i.test(line)) {
				login.phase = "needs_code";
			}
		}
		if (login.authUrl && login.phase === "starting") login.phase = "waiting_browser";
	}

	/** `x.ai/omp/connect_status`: current login state for the pager's poll. */
	ompConnectStatus() {
		const login = this.ompLogin;
		if (!login) return { status: "idle" };
		return {
			status: login.phase,
			provider: login.provider,
			authUrl: login.authUrl,
			launchUrl: login.launchUrl,
			instructions: login.instructions,
			lines: login.lines.slice(-20),
			error: login.error,
			restartRequired: login.phase === "done",
		};
	}

	/** `x.ai/omp/connect_code` {code}: feed a pasted code/redirect URL to the login child's stdin. */
	async ompConnectCode(p) {
		const login = this.ompLogin;
		if (!login || login.phase !== "needs_code") throw new Error("omp/connect_code: no login is waiting for a code");
		const code = typeof p.code === "string" ? p.code.trim() : "";
		if (!code) throw new Error("omp/connect_code: empty code");
		login.phase = "verifying";
		try {
			login.proc.stdin.write(`${code}\n`);
			await login.proc.stdin.flush();
		} catch (e) {
			throw new Error(`omp/connect_code: could not write to login process: ${e?.message ?? e}`);
		}
		return this.ompConnectStatus();
	}

	/** `x.ai/omp/connect_cancel`: kill an in-flight login child. */
	ompConnectCancel() {
		const login = this.ompLogin;
		if (login && login.phase !== "done" && login.phase !== "failed") {
			try {
				login.proc.kill("SIGTERM");
			} catch {}
			login.phase = "failed";
			login.error = "cancelled";
		}
		this.ompLogin = null;
		return { status: "idle" };
	}

	ompLoginCancel() {
		this.ompConnectCancel();
	}


	async worktreeRemove(p) {
		const target = p.path ?? p.worktreePath ?? p.id;
		if (typeof target !== "string" || !target) throw rpcError(-32602, "worktree path required");
		let base = dirname(target);
		try {
			base = (await gitOut(target, ["rev-parse", "--show-toplevel"])).trim();
		} catch {
			// target may not be a repo root itself; remove relative to its parent
		}
		await gitOut(base, ["worktree", "remove", "--force", target]);
		this.knownWorktrees.delete(target);
		return { result: { removed: true, resolvedPath: target } };
	}

	answer(result) {
		return { action: "answer", result };
	}

	notif(method, params) {
		return { jsonrpc: "2.0", method, params };
	}

	/** Register a forwarded request whose response needs translation. */
	trackForwarded(id, translate) {
		if (translate) this.pendingTranslated.set(id, translate);
	}

	/** Apply a pending translation to an agent→client response, if registered. */
	translateResponse(frame) {
		if (frame?.id === undefined || !this.pendingTranslated.has(frame.id)) return frame;
		const translate = this.pendingTranslated.get(frame.id);
		this.pendingTranslated.delete(frame.id);
		if (frame.error !== undefined) return frame;
		try {
			return { ...frame, result: translate(frame.result) };
		} catch {
			return frame;
		}
	}
}
async function lineReader(stream, onLine) {
	const decoder = new TextDecoder();
	let buffer = "";
	for await (const chunk of stream) {
		buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
		let index;
		while ((index = buffer.indexOf("\n")) >= 0) {
			const line = buffer.slice(0, index);
			buffer = buffer.slice(index + 1);
			onLine(line);
		}
	}
	if (buffer.trim()) onLine(buffer);
	onLine(null);
}

function parseFrame(line) {
	const trimmed = line.trim();
	if (!trimmed) return undefined;
	try {
		const parsed = JSON.parse(trimmed);
		return parsed && typeof parsed === "object" ? parsed : undefined;
	} catch {
		return undefined; // forwarded verbatim; the peer can complain
	}
}

// ---------------------------------------------------------------------------
// live mode: spawn the child and forward both directions
// ---------------------------------------------------------------------------

async function runLive(opts) {
	const argv = splitCommand(opts.agent);
	log(`spawning agent: ${argv.join(" ")}`);
	const child = Bun.spawn(argv, { stdin: "pipe", stdout: "pipe", stderr: "inherit" });

	const tape = opts.tape
		? new Tape(opts.tape, {
				sourceRev: sourceRev(),
				adapter: `${BRIDGE_NAME} ${BRIDGE_VERSION}`,
				agentCommand: opts.agent,
				hygiene: opts.hygiene,
				shape: opts.shape,
				mcp: opts.mcp,
				recordedAt: new Date().toISOString(),
			})
		: null;

	const writer = child.stdin;
	const emit = (obj) => writer.write(`${JSON.stringify(obj)}\n`);
	const forward = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
	const ext = new ExtSurface();
	ext.agentArgv = argv;
	ext.agentCommand = opts.agent;
	// Enrich the model catalog before session/new so the picker gets vision,
	// effort, and context-window metadata on first connect.
	await ext.loadCatalog(argv);

	// Drain adapter-synthesized frames in both directions. Adapter-internal
	// requests (virtual-queue dispatches, _omp/* probes, set_mode toggles) are
	// NOT taped: replay matches client requests to recorded agent requests by
	// method+occurrence, and taping synthesized traffic would shift every
	// later occurrence index.
	const drainExt = () => {
		while (ext.outToClient.length) {
			const f = ext.outToClient.shift();
			tape?.record("to_client", f);
			forward(f);
		}
		while (ext.outToAgent.length) {
			const f = ext.outToAgent.shift();
			if (!ext.internalIds.has(f.id)) tape?.record("to_agent", f);
			emit(f);
		}
		while (ext.followUp.length) {
			const f = ext.followUp.shift();
			tape?.record("to_agent", f);
			emit(f);
		}
	};

	// Advisor notes, vibe lifecycle, async results, and worker transcripts never
	// reach the wire (see SessionTailer); tail the OMP session files and
	// synthesize the missing frames instead. raw=false frames run through the
	// same observe/forward pipeline as real agent frames so advisory splitting
	// applies identically; raw=true frames are already-final synthesized
	// notifications (subagent_*, child-session updates) forwarded verbatim.
	const tailer = new SessionTailer((frame, raw) => {
		if (raw) {
			tape?.record("to_client", frame);
			forward(frame);
			return;
		}
		const extras = ext.observeToClient(frame);
		tape?.record("to_client", frame);
		forward(frame);
		for (const extra of extras) {
			tape?.record("to_client", extra);
			forward(extra);
		}
	}, ext);
	// session/load and session/resume responses carry no sessionId; remember
	// the id from the forwarded request so the response can attach the tailer.
	const pendingLoadSession = new Map();

	// Both directions run concurrently; each pump owns one direction, so
	// cross-direction interleaving is preserved without a lock.
	const toAgent = lineReader(Bun.stdin.stream(), (line) => {
		if (line === null) {
			log("client closed stdin; shutting agent down");
			try {
				writer.end();
			} catch {}
			return;
		}
		const frame = parseFrame(line);
		if (frame === undefined) {
			tape?.record("to_agent", undefined, line);
			writer.write(`${line}\n`);
			return;
		}

		// Response to an adapter-bridged elicitation: translate back to
		// elicitation/create's shape and re-emit under OMP's original id.
		const bridged = ext.handleClientResponse(frame);
		if (bridged) {
			emit(bridged);
			drainExt();
			return;
		}

		// x.ai/* notifications (queue mutations, plan-mode toggle) are consumed
		// adapter-side; everything else falls through to verbatim forwarding.
		if (ext.handleNotification(frame)) {
			tape?.record("to_agent", frame);
			drainExt();
			return;
		}

		if (opts.hygiene && frame.method === "initialize") {
			const removed = applyHygiene(frame);
			if (removed.length) log(`capability hygiene: removed ${removed.join(", ")} from initialize`);
		}
		if (!opts.mcp && frame.method === "session/new" && frame.params?.mcpServers !== undefined) {
			// OMP reads `params.mcpServers.length` unguarded — deleting the field
			// crashes session/new; an empty array passes through with nothing to
			// connect.
			frame.params.mcpServers = [];
		}
		ext.observeToAgent(frame);
		if (
			frame.id !== undefined &&
			(frame.method === "session/load" || frame.method === "session/resume") &&
			typeof frame.params?.sessionId === "string"
		) {
			pendingLoadSession.set(frame.id, frame.params.sessionId);
		}
		// The pager's private `x.ai/*` rail: answer locally where the adapter has
		// the data, forward-and-translate where OMP owns it, error where neither
		// does. Forwarding verbatim would surface OMP's -32603 to the user.
		const decision = frame.id !== undefined ? ext.answerRequest(frame) : null;
		if (decision?.action === "answer") {
			tape?.record("to_agent", frame);
			forward({ jsonrpc: "2.0", id: frame.id, result: decision.result });
			drainExt();
			return;
		}
		if (decision?.action === "error") {
			tape?.record("to_agent", frame);
			forward({ jsonrpc: "2.0", id: frame.id, error: decision.error });
			drainExt();
			return;
		}
		if (decision?.action === "hold" || decision?.action === "defer") {
			// Held prompt / deferred internal prompt: the dispatch (now or on
			// turn settle) emits via outToAgent; the client answer comes later.
			drainExt();
			return;
		}
		if (decision?.action === "answerAsync") {
			tape?.record("to_agent", frame);
			decision.promise.then(
				(result) => {
					forward({ jsonrpc: "2.0", id: frame.id, result });
					drainExt();
				},
				(error) => {
					forward({
						jsonrpc: "2.0",
						id: frame.id,
						error: { code: error?.rpcCode ?? -32603, message: error?.message ?? String(error) },
					});
					drainExt();
				},
			);
			return;
		}
		if (decision?.action === "forward") {
			frame.method = decision.as;
			if (decision.rewriteParams) frame.params = decision.rewriteParams;
			ext.trackForwarded(frame.id, decision.translate);
		}
		tape?.record("to_agent", frame);
		emit(frame);
		drainExt();
	});

	const toClient = lineReader(child.stdout, (line) => {
		if (line === null) {
			log("agent closed stdout");
			process.exit(0);
		}
		const frame = parseFrame(line);
		if (frame === undefined) {
			tape?.record("to_client", undefined, line);
			process.stdout.write(`${line}\n`);
			return;
		}
		// Adapter-internal request responses (virtual-queue dispatches, _omp/*
		// probes) are consumed here — they must never reach the pager.
		if (ext.handleAgentResponse(frame)) {
			drainExt();
			return;
		}

		// OMP's elicitation/create (ask tool, plan approval) is standard ACP the
		// pager can't decode; bridge it to the pager's private question views.
		if (frame.method === "elicitation/create" && frame.id !== undefined) {
			const bridged = ext.bridgeElicitation(frame);
			if (bridged) {
				tape?.record("to_client", bridged);
				forward(bridged);
				drainExt();
				return;
			}
			// Unrepresentable schema: forward verbatim → method_not_found → OMP
			// auto-approves, same as a client without elicitation.form.
		}

		// Attach the advisor tailer once a session is known: session/new and
		// session/fork carry result.sessionId; load/resume resolve via the
		// request id recorded above.
		if (frame.id !== undefined && frame.result !== undefined) {
			const sid = frame.result.sessionId ?? pendingLoadSession.get(frame.id);
			if (typeof sid === "string") tailer.attach(sid);
		}
		if (frame.id !== undefined) pendingLoadSession.delete(frame.id);
		if (opts.shape) {
			const change = shapeToClient(frame);
			if (change) log(`shaped ${change}`);
		}
		// Translate any forwarded x.ai/* response back to the pager's shape.
		const shaped = ext.translateResponse(frame);
		// Observe BEFORE forwarding: observeToClient may mutate the frame (it
		// injects `result.models` into session/new), and JSON.stringify captures
		// the object at forward time. Extras are emitted after the main frame.
		const extras = ext.observeToClient(shaped);
		tape?.record("to_client", shaped);
		forward(shaped);
		for (const extra of extras) {
			tape?.record("to_client", extra);
			forward(extra);
		}
		drainExt();
	});

	void toClient;

	const code = await child.exited;
	log(`agent exited with ${code}`);
	void toAgent;
	process.exit(code ?? 0);
}

/** Split a command string into argv, honouring single and double quotes. */
function splitCommand(command) {
	const argv = [];
	let current = "";
	let quote = null;
	let started = false;
	for (const ch of command) {
		if (quote) {
			if (ch === quote) quote = null;
			else current += ch;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			started = true;
			continue;
		}
		if (/\s/.test(ch)) {
			if (started || current) {
				argv.push(current);
				current = "";
				started = false;
			}
			continue;
		}
		current += ch;
		started = true;
	}
	if (started || current) argv.push(current);
	if (!argv.length) fail("empty agent command");
	return argv;
}

// ---------------------------------------------------------------------------
// replay mode: a tape IS the agent
// ---------------------------------------------------------------------------

/**
 * The replay engine — the single implementation used by both `--replay` (over
 * stdio) and `--selfcheck` (in-process), so the check exercises the code that
 * actually serves a tape instead of a parallel copy of it.
 *
 * Emission is gated on the client's progress: a client request releases every
 * recorded client-bound frame up to and including its own recorded response,
 * in `seq` order. That reproduces the recorded interleaving exactly — including
 * notifications that arrive mid-request and agent-initiated requests such as
 * `session/request_permission` — which a "drain everything on prompt" heuristic
 * would flatten.
 */
/**
 * Replay-only stubs for pager probes whose truthful answer is empty and whose
 * error poisons a pending turn ("Turn failed", SPEC §7.4). Only history/info
 * queries qualify: `x.ai/prompt_history` decodes `result.prompts`/`prompts` as
 * Vec<String>, and OMP genuinely has no x.ai history, so `[]` is the truth.
 * Subscription/billing are NOT here — the pager applies their result
 * authoritatively, so they keep their recorded error.
 */
const PROBE_STUBS = {
	"x.ai/prompt_history": { prompts: [] },
};

function createReplay(header, entries) {
	const ordered = [...entries].sort((a, b) => a.seq - b.seq);

	// Recorded pairing is by request id. Live pairing cannot be: the pager's
	// x.ai/* probes fire on timers, so the id space drifts run to run. Match a
	// live request to its recorded counterpart by method + occurrence index —
	const responseSeqByRecordedId = new Map();
	const recordedIdsByMethod = new Map();
	/** recorded request id -> stub result, for probes whose recorded reply was an error. */
	const stubByRecordedId = new Map();
	for (const entry of ordered) {
		if (entry.dir === "to_client" && (entry.kind === "response" || entry.kind === "error")) {
			responseSeqByRecordedId.set(entry.id, entry.seq);
		}
		if (entry.dir === "to_agent" && entry.kind === "request") {
			const ids = recordedIdsByMethod.get(entry.method) ?? [];
			ids.push(entry.id);
			recordedIdsByMethod.set(entry.method, ids);
			if (PROBE_STUBS[entry.method] !== undefined) stubByRecordedId.set(entry.id, PROBE_STUBS[entry.method]);
		}
	}

	let cursor = 0;
	const liveCounts = new Map();
	/** recorded request id -> live request id, so emitted replies echo the id the client actually used. */
	const idAlias = new Map();

	const drain = (limit) => {
		const out = [];
		while (cursor < ordered.length) {
			const entry = ordered[cursor];
			if (entry.seq > limit) break;
			cursor++;
			if (entry.dir !== "to_client") continue;
			const isReply = entry.kind === "response" || entry.kind === "error";
			if (isReply) {
				const liveId = idAlias.get(entry.id);
				if (liveId === undefined) continue; // reply to a request this client never sent
				const stub = entry.kind === "error" ? stubByRecordedId.get(entry.id) : undefined;
				out.push(stub !== undefined ? { jsonrpc: "2.0", id: liveId, result: stub } : { ...entry.frame, id: liveId });
			} else {
				out.push(entry.frame); // notifications and agent-initiated requests pass verbatim
			}
		}
		return out;
	};

	return {
		/** Frames the agent emits in response to one client frame. */
		handle(frame) {
			if (!frame || typeof frame.method !== "string") return []; // a client response/notification advances nothing
			if (frame.id === undefined) return []; // client notification
			const n = liveCounts.get(frame.method) ?? 0;
			liveCounts.set(frame.method, n + 1);
			const ids = recordedIdsByMethod.get(frame.method) ?? [];
			// x.ai/* probes are idempotent status queries on timers; a live run may
			// fire them more often than the tape recorded. Reuse the last recorded
			// reply rather than failing a probe the pager only logs anyway. Core
			// ACP methods stay strict — a mismatched prompt must error, not replay.
			const isProbe = frame.method.startsWith("_x.ai/") || frame.method.startsWith("x.ai/");
			// Replay-only stub: a probe the tape never recorded gets a benign
			// success, not an error — an error during a pending turn surfaces as
			// "Turn failed" in the pager (SPEC §7.4). Only history/info queries
			// are stubbed; subscription/billing stay errors because the pager
			// applies their result authoritatively.
			const stub = PROBE_STUBS[frame.method];
			if (isProbe && ids.length === 0 && stub !== undefined) {
				return [{ jsonrpc: "2.0", id: frame.id, result: stub }];
			}
			const recordedId = isProbe ? ids[Math.min(n, ids.length - 1)] : ids[n];
			if (recordedId === undefined) {
				return [
					{
						jsonrpc: "2.0",
						id: frame.id,
						error: {
							code: -32601,
							message:
								`no recorded reply for ${frame.method} (call #${n + 1}) — tape recorded by ` +
							`${header?.client?.name ?? "another client"} has ${ids.length} call(s)`,
						},
					},
				];
			}
			idAlias.set(recordedId, frame.id);
			const limit = responseSeqByRecordedId.get(recordedId);
			if (limit === undefined) return []; // recorded request had no reply
			return drain(limit);
		},
		/** Any client-bound frames recorded after the last client request. */
		flush: () => drain(Infinity),
	};
}

/**
 * Serve a recorded session over stdio. Deterministic and offline: the client's
 * requests are answered from the tape rather than by a model, which is what
 * makes an L2 or L3 rendering test reproducible.
 */
async function runReplay(opts) {
	const { header, entries } = readTape(opts.replay);
	if (opts.selfcheck) return selfcheck(opts, header, entries);

	const stale = staleReason(header);
	if (stale && !opts.allowStale) {
		// C5: a tape recorded against a different upstream base is rejected, not
		// replayed — the recorded stream may not match this tree's behaviour.
		fail(`stale tape: ${stale} (re-record, or --allow-stale to override)`);
	}

	const replay = createReplay(header, entries);
	const ext = new ExtSurface();
	const emit = (obj) => {
		// Replay emits recorded frames verbatim, but the advisory split still
		// applies: a taped `<advisory>` chunk must reach the pager in the same
		// shape a live run produces, or replay can't reproduce advisor rendering.
		const update = obj?.params?.update;
		if (obj?.method === "session/update" && update?.sessionUpdate === "user_message_chunk") {
			const extra = [];
			ext.observeAdvisoryChunk(obj, update, extra);
			process.stdout.write(`${JSON.stringify(obj)}\n`);
			for (const e of extra) process.stdout.write(`${JSON.stringify(e)}\n`);
			return;
		}
		process.stdout.write(`${JSON.stringify(obj)}\n`);
	};

	void lineReader(Bun.stdin.stream(), (line) => {
		if (line === null) {
			for (const frame of replay.flush()) emit(frame);
			return;
		}
		const frame = parseFrame(line);
		if (frame === undefined) return;
		for (const out of replay.handle(frame)) emit(out);
	});
}

/** A tape from a different tree is reported stale, never silently replayed. */
function staleReason(header) {
	const current = sourceRev();
	if (!header?.sourceRev || !current) return null;
	if (header.sourceRev !== current) {
		return `tape recorded from sourceRev ${header.sourceRev.slice(0, 12)}, tree is ${current.slice(0, 12)}`;
	}
	return null;
}

/**
 * Structural problems a byte-comparison cannot see, because a corrupt file
 * corrupts both sides equally: missing frames, duplicate or non-contiguous
 * `seq` (the replay ordering key — SPEC.md §10.2), and entries with no `dir`.
 */
function validateTape(entries) {
	const problems = [];
	const seen = new Set();
	let allInteger = true;
	for (const [index, entry] of entries.entries()) {
		if (entry.dir !== "to_agent" && entry.dir !== "to_client") {
			problems.push(`line ${index + 2}: dir must be to_agent|to_client, got ${JSON.stringify(entry.dir)}`);
			continue;
		}
		// seq is the replay ordering key: it must be a finite, unique number.
		// Fractional seqs are legal — older recorders interleaved tailer-
		// synthesized frames between integer seqs (e.g. 36.5 between 36 and 37).
		if (typeof entry.seq !== "number" || !Number.isFinite(entry.seq)) {
			problems.push(`line ${index + 2}: seq must be a number, got ${JSON.stringify(entry.seq)}`);
			continue;
		}
		if (!Number.isInteger(entry.seq)) allInteger = false;
		if (seen.has(entry.seq)) problems.push(`line ${index + 2}: duplicate seq ${entry.seq}`);
		seen.add(entry.seq);
		if (entry.frame === undefined) problems.push(`line ${index + 2}: frame missing`);
	}
	// Contiguity (a dropped frame leaves a gap) is only checkable when every
	// seq is an integer; fractional-seq tapes can't be gap-checked this way.
	if (allInteger) {
		for (let seq = 0; seq < entries.length; seq++) {
			if (!seen.has(seq)) problems.push(`seq ${seq} missing (stream must be contiguous from 0)`);
		}
	}
	return problems;
}

/**
 * C0 — replay a tape through the replay engine and compare the emitted stream
 * with what was recorded. This is a round trip, not a comparison of a value
 * with itself: it fails when a client request has no recorded reply, when an
 * `id` does not round-trip, or when emission reorders the recorded stream.
 */

/** The method of the recorded request a response id belongs to. */
function requestMethodById(ordered, id) {
	return ordered.find((e) => e.dir === "to_agent" && e.id === id)?.method;
}

function selfcheck(opts, header, entries) {
	const ordered = [...entries].sort((a, b) => a.seq - b.seq);
	const replay = createReplay(header, entries);

	const actual = [];
	for (const entry of ordered) {
		if (entry.dir !== "to_agent") continue;
		actual.push(...replay.handle(entry.frame));
	}
	actual.push(...replay.flush());
	const expected = ordered
		.filter((entry) => entry.dir === "to_client")
		.map((entry) => {
			// Replay substitutes stubs for recorded probe errors; expected must too.
			if (entry.kind === "error" && PROBE_STUBS[requestMethodById(ordered, entry.id)] !== undefined) {
				return { jsonrpc: "2.0", id: entry.id, result: PROBE_STUBS[requestMethodById(ordered, entry.id)] };
			}
			return entry.frame;
		});


	let mismatchAt = -1;
	for (let i = 0; i < Math.max(actual.length, expected.length); i++) {
		if (JSON.stringify(actual[i]) !== JSON.stringify(expected[i])) {
			mismatchAt = i;
			break;
		}
	}

	const problems = validateTape(ordered);
	const stale = staleReason(header);

	for (const problem of problems) process.stdout.write(`${BRIDGE_NAME} selfcheck: malformed tape — ${problem}\n`);

	if (mismatchAt === -1 && problems.length === 0) {
		process.stdout.write(
			`${BRIDGE_NAME} selfcheck: OK — ${expected.length} client-bound frames replayed byte-identically (${ordered.length} total)\n`,
		);
	} else if (mismatchAt !== -1) {
		process.stdout.write(
			`${BRIDGE_NAME} selfcheck: MISMATCH at frame ${mismatchAt} of ${expected.length}\n` +
				`  recorded: ${JSON.stringify(expected[mismatchAt])?.slice(0, 300)}\n` +
				`  replayed: ${JSON.stringify(actual[mismatchAt])?.slice(0, 300)}\n`,
		);
	}
	if (stale) process.stdout.write(`  note: ${stale}\n`);
	process.exit(mismatchAt === -1 && problems.length === 0 ? 0 : 1);
}

// ---------------------------------------------------------------------------

const opts = parseArgs(Bun.argv.slice(2));
optsRef.quiet = opts.quiet;
optsRef.shape = opts.shape;
if (opts.replay) await runReplay(opts);
else await runLive(opts);
