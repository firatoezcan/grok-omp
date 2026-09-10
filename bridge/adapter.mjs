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

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

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
		quiet: false,
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
  --quiet           silence diagnostics on stderr
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

/** Source revision of the tree under test, so a stale tape is detectable. */
function sourceRev() {
	for (const candidate of ["SOURCE_REV", ".source-rev"]) {
		const path = resolve(process.cwd(), candidate);
		if (existsSync(path)) return readFileSync(path, "utf8").trim();
	}
	return null;
}

/**
 * Records every frame crossing the adapter in one file with a single
 * cross-direction `seq` counter — two counters would destroy the interleaving
 * that makes a TUI test deterministic.
 */
class Tape {
	constructor(path, header) {
		this.path = path;
		this.seq = 0;
		mkdirSync(dirname(resolve(path)), { recursive: true });
		writeFileSync(path, `${JSON.stringify({ type: "header", format: TAPE_FORMAT, ...header })}\n`);
	}

	record(dir, frame, raw) {
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
				recordedAt: new Date().toISOString(),
			})
		: null;

	const writer = child.stdin;
	const emit = (obj) => writer.write(`${JSON.stringify(obj)}\n`);
	const forward = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

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
		tape?.record("to_agent", frame);
		emit(frame);
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
		if (opts.shape) {
			const change = shapeToClient(frame);
			if (change) log(`shaped ${change}`);
		}
		tape?.record("to_client", frame);
		forward(frame);
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
function createReplay(entries) {
	const ordered = [...entries].sort((a, b) => a.seq - b.seq);
	const responseSeqById = new Map();
	for (const entry of ordered) {
		if (entry.dir === "to_client" && (entry.kind === "response" || entry.kind === "error")) {
			responseSeqById.set(entry.id, entry.seq);
		}
	}

	let cursor = 0;
	/** Requests this client actually sent; a stray response must not leak out. */
	const seenRequestIds = new Set();

	const drain = (limit) => {
		const out = [];
		while (cursor < ordered.length) {
			const entry = ordered[cursor];
			if (entry.seq > limit) break;
			cursor++;
			if (entry.dir !== "to_client") continue;
			// Notifications and agent-initiated requests always belong to the
			// stream; a response only belongs if its request was sent.
			const isReply = entry.kind === "response" || entry.kind === "error";
			if (isReply && !seenRequestIds.has(entry.id)) continue;
			out.push(entry.frame);
		}
		return out;
	};

	return {
		/** Frames the agent emits in response to one client frame. */
		handle(frame) {
			if (!frame || typeof frame.method !== "string") return []; // a client response/notification advances nothing
			if (frame.id === undefined) return []; // client notification
			seenRequestIds.add(frame.id);
			const limit = responseSeqById.get(frame.id);
			if (limit === undefined) {
				return [{ jsonrpc: "2.0", id: frame.id, error: { code: -32601, message: `no recorded reply for ${frame.method}` } }];
			}
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
	if (stale) log(`WARNING: ${stale}`);

	const replay = createReplay(entries);
	const emit = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

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
function selfcheck(opts, header, entries) {
	const ordered = [...entries].sort((a, b) => a.seq - b.seq);
	const replay = createReplay(entries);

	const actual = [];
	for (const entry of ordered) {
		if (entry.dir !== "to_agent") continue;
		actual.push(...replay.handle(entry.frame));
	}
	actual.push(...replay.flush());

	const expected = ordered.filter((entry) => entry.dir === "to_client").map((entry) => entry.frame);

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
