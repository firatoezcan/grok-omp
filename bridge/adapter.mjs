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

import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

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
const optsRef = { quiet: false };

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

// ---------------------------------------------------------------------------
// advisor session tailer: OMP 18.1.17 never puts advisor notes on the ACP
// wire — mapAssistantMessageEnd drops non-assistant messages live, and
// #extractReplayContent only handles array content while advisor entries
// persist a string, so session/load replay emits nothing either. The notes do
// land in the session JSONL as custom_message/customType:"advisor", so we
// tail that file and synthesize the same user_message_chunk frames OMP's
// replay would have sent. observeAdvisoryChunk then splits/meta-stamps them
// exactly like a wire frame.
// ---------------------------------------------------------------------------

class AdvisorTailer {
	/**
	 * @param {(frame: object) => void} emit synthesized to_client frame sender
	 *   (must run the frame through ExtSurface.observeToClient + forward).
	 */
	constructor(emit) {
		this.emit = emit;
		this.sessionId = null;
		this.file = null;
		this.offset = 0;
		this.pending = "";
		this.seen = new Set();
		this.timer = null;
	}

	/** Point the tailer at a session; no-op when already attached. */
	attach(sessionId) {
		if (!sessionId || this.sessionId === sessionId) return;
		log(`advisor tailer: attach ${sessionId}`);
		this.sessionId = sessionId;
		this.file = null;
		this.offset = 0;
		this.pending = "";
		this.seen.clear();
		if (!this.timer) {
			this.timer = setInterval(() => this.poll(), 400);
			this.timer.unref?.();
		}
	}

	stop() {
		clearInterval(this.timer);
		this.timer = null;
	}

	poll() {
		if (!this.sessionId) return;
		if (!this.file) {
			this.file = findOmpSessionFile(this.sessionId);
			if (this.file) log(`advisor tailer: file ${this.file}`);
		}
		if (!this.file) return;
		let size;
		try {
			size = statSync(this.file).size;
		} catch {
			this.file = null;
			return;
		}
		if (size < this.offset) {
			// Full rewrite (load-migration/sanitize): rescan; `seen` dedupes.
			this.offset = 0;
			this.pending = "";
		}
		if (size === this.offset) return;
		let text;
		try {
			const fd = openSync(this.file, "r");
			try {
				const len = size - this.offset;
				const buf = Buffer.alloc(len);
				const got = readSync(fd, buf, 0, len, this.offset);
				this.offset += got;
				text = buf.subarray(0, got).toString("utf8");
			} finally {
				closeSync(fd);
			}
		} catch {
			return;
		}
		const chunk = this.pending + text;
		const nl = chunk.lastIndexOf("\n");
		if (nl < 0) {
			this.pending = chunk;
			return;
		}
		this.pending = chunk.slice(nl + 1);
		for (const line of chunk.slice(0, nl).split("\n")) {
			if (!line.includes('"advisor"')) continue;
			let entry;
			try {
				entry = JSON.parse(line);
			} catch {
				continue;
			}
			if (entry.type !== "custom_message" || entry.customType !== "advisor") continue;
			if (typeof entry.content !== "string" || !entry.content.includes("<advisory")) continue;
			const key = entry.id ?? entry.content;
			if (this.seen.has(key)) continue;
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
		this.subagentSeq = 0;
		/** selector → OMP model metadata (from `omp models --json`). */
		this.catalog = null;
		/** Extra client→agent requests to send right after the current one. */
		this.followUp = [];
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
		}

		// session/new result → session identity + model catalog.
		if (frame.result?.sessionId !== undefined && frame.id !== undefined) {
			this.captureSessionNew(frame.result);
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
		}

		// session/update notifications → commands, usage, config, subagents.
		const update = frame.params?.update;
		if (frame.method === "session/update" && update && typeof update === "object") {
			switch (update.sessionUpdate) {
				case "available_commands_update":
					this.commands = update.availableCommands ?? [];
					break;
				case "usage_update":
					this.usage = { size: update.size, used: update.used };
					break;
				case "config_option_update":
					this.captureConfigOptions(update.configOptions);
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
		// OMP's task tool isn't in TOOL_SHAPING, so no _meta stamp. Detect it by
		// an explicit tool id, a bare "task" title, or the task-tool input shape
		// (a prompt plus an agent/label selector).
		const toolName = update._meta?.["x.ai/tool"] ?? raw.tool;
		const isTask =
			toolName === "task" ||
			update.title === "task" ||
			(typeof raw.prompt === "string" && (raw.agent !== undefined || raw.label !== undefined || raw.task !== undefined));
		if (!isTask) return;
		const toolCallId = update.toolCallId;
		if (!toolCallId || this.subagents.has(toolCallId)) return;
		const subagentId = `omp-task-${++this.subagentSeq}`;
		const childSessionId = `${this.session?.sessionId ?? "session"}:sub:${this.subagentSeq}`;
		const description = raw.prompt ?? raw.description ?? update.title ?? "subagent";
		this.subagents.set(toolCallId, {
			subagentId,
			childSessionId,
			startedAt: Date.now(),
			toolCalls: 0,
		});
		extra.push(this.notif("_x.ai/session/update", {
			sessionId: this.session?.sessionId,
			update: {
				sessionUpdate: "subagent_spawned",
				subagent_id: subagentId,
				parent_session_id: this.session?.sessionId,
				child_session_id: childSessionId,
				subagent_type: "general-purpose",
				description,
				context_normalized: false,
			},
		}));
	}

	observeToolCallEnd(update, extra) {
		const toolCallId = update.toolCallId;
		const rec = toolCallId && this.subagents.get(toolCallId);
		if (!rec) return;
		const status = update.status;
		if (status !== "completed" && status !== "failed" && status !== "cancelled") return;
		this.subagents.delete(toolCallId);
		extra.push(this.notif("_x.ai/session/update", {
			sessionId: this.session?.sessionId,
			update: {
				sessionUpdate: "subagent_finished",
				subagent_id: rec.subagentId,
				child_session_id: rec.childSessionId,
				status,
				error: status === "failed" ? (update.rawOutput?.error ?? "subagent failed") : undefined,
				tool_calls: rec.toolCalls,
				turns: 1,
				duration_ms: Date.now() - rec.startedAt,
				tokens_used: 0,
				will_wake: false,
			},
		}));
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

		if (!method.startsWith("x.ai/") && !method.startsWith("_x.ai/")) {
			return null;
		}
		const m = method.replace(/^_?x\.ai\//, "");

		switch (m) {
			// -- answered from observed state ----------------------------------
			case "session/info":
				// This call site reads `response.result` (double-wrapped), unlike
				// the bare-payload sites — see acp_handler session_info fetch.
				return this.answer({
					result: {
						sessionId: this.session?.sessionId,
						cwd: this.sessionCwd,
						agentName: this.agentInfo?.name ?? "oh-my-pi",
						model: this.modelConfig?.currentValue,
						turns: 0,
						context: this.usage
							? { size: this.usage.size, used: this.usage.used }
							: { size: 0, used: 0 },
					},
				});
			case "session/usage":
				// OMP's usage_update reports context-window size/used, not token
				// counts. Return an honest, explicitly-incomplete usage rather
				// than fabricate token numbers.
				return this.answer({
					usage: {
						numTurns: 0,
						modelUsage: {},
						usageIsIncomplete: true,
					},
				});
			case "commands/list":
				return this.answer({ commands: this.commands });
			case "mcp/list":
				return this.answer({
					servers: this.mcpServers.map((s) => ({
						name: s.name,
						session: { enabled: true },
					})),
				});
			case "prompt_history":
				return this.answer({ prompts: [] });
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
			case "session/search":
				return this.answer({ results: [] });

			// -- forwarded to OMP, response translated --------------------------
			case "session/list":
				return {
					action: "forward",
					as: "session/list",
					translate: enrichSessionList,
				};
			case "session/fork":
				return {
					action: "forward",
					as: "session/fork",
					translate: (r) => r,
				};

			// -- truthful empty lists (OMP has the concept, no data source) -----
			// Each endpoint decodes a distinct envelope; `{items:[]}` fits none.
			case "hooks/list":
				return this.answer({ hooks: [], project_trusted: true, load_errors: [] });
			case "plugins/list":
				return this.answer({ plugins: [] });
			case "marketplace/list":
				return this.answer({ sources: [] });
			case "skills/list":
				return this.answer({ skills: [] });
			case "workflows/list":
				return this.answer({ workflows: [] });

			// -- no OMP data source: error, don't fabricate ---------------------
			default:
				return {
					action: "error",
					error: { code: -32601, message: `x.ai method not available via OMP: ${method}` },
				};
		}
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
	// Enrich the model catalog before session/new so the picker gets vision,
	// effort, and context-window metadata on first connect.
	await ext.loadCatalog(argv);

	// Advisor notes never reach the wire (see AdvisorTailer); tail the OMP
	// session file and synthesize the user_message_chunk frames instead.
	// Emitted frames run through the same observe/forward pipeline as real
	// agent frames so advisory splitting and meta-stamping apply identically.
	const tailer = new AdvisorTailer((frame) => {
		const extras = ext.observeToClient(frame);
		tape?.record("to_client", frame);
		forward(frame);
		for (const extra of extras) {
			tape?.record("to_client", extra);
			forward(extra);
		}
	});
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
			return;
		}
		if (decision?.action === "error") {
			tape?.record("to_agent", frame);
			forward({ jsonrpc: "2.0", id: frame.id, error: decision.error });
			return;
		}
		if (decision?.action === "forward") {
			frame.method = decision.as;
			if (decision.rewriteParams) frame.params = decision.rewriteParams;
			ext.trackForwarded(frame.id, decision.translate);
		}
		tape?.record("to_agent", frame);
		emit(frame);
		// A translation may queue a follow-up request (e.g. set_model also sets
		// the thinking effort). Drain it so OMP sees both.
		while (ext.followUp.length) {
			const f = ext.followUp.shift();
			tape?.record("to_agent", f);
			emit(f);
		}
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
	for (const [index, entry] of entries.entries()) {
		if (entry.dir !== "to_agent" && entry.dir !== "to_client") {
			problems.push(`line ${index + 2}: dir must be to_agent|to_client, got ${JSON.stringify(entry.dir)}`);
			continue;
		}
		if (!Number.isInteger(entry.seq)) {
			problems.push(`line ${index + 2}: seq must be an integer, got ${JSON.stringify(entry.seq)}`);
			continue;
		}
		if (seen.has(entry.seq)) problems.push(`line ${index + 2}: duplicate seq ${entry.seq}`);
		seen.add(entry.seq);
		if (entry.frame === undefined) problems.push(`line ${index + 2}: frame missing`);
	}
	for (let seq = 0; seq < entries.length; seq++) {
		if (!seen.has(seq)) problems.push(`seq ${seq} missing (stream must be contiguous from 0)`);
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
if (opts.replay) await runReplay(opts);
else await runLive(opts);
