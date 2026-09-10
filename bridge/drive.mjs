#!/usr/bin/env bun
/**
 * drive.mjs — scripted ACP client for the bridge.
 *
 * Runs a full turn against the adapter (or any ACP agent) with no TUI, then
 * reports what came back: the handshake, every tool call's identity, and —
 * the question SPEC.md §7.3.1 exists to answer — whether the agent tried to
 * delegate `fs/*` or `terminal/*` to the client.
 *
 * The client advertises the *hostile* capability set on purpose (fs + terminal
 * + auth.terminal). If the adapter's hygiene works, the agent never calls them;
 * if it does not, this script names the exact method that would have hung the
 * pager. `--no-hygiene` runs the same probe with the rewrite disabled, which is
 * how the capability question gets a control group instead of an assertion.
 *
 * USAGE
 *   bun bridge/drive.mjs                                  # adapter -> `omp acp`
 *   bun bridge/drive.mjs --no-hygiene                     # control group
 *   bun bridge/drive.mjs --agent "omp acp"                # skip the adapter
 *   bun bridge/drive.mjs --prompt "say hi" --json         # raw frame dump
 */

import { spawn } from "node:child_process";

const DEFAULTS = {
	agent: `bun ${new URL("./adapter.mjs", import.meta.url).pathname}`,
	prompt: "Reply with exactly the word: bridge-ok",
	cwd: process.cwd(),
	timeoutMs: 120_000,
	json: false,
	quiet: false,
};

function parseArgs(argv) {
	const opts = { ...DEFAULTS, noHygiene: false };
	for (let i = 0; i < argv.length; i++) {
		switch (argv[i]) {
			case "--agent":
				opts.agent = argv[++i];
				break;
			case "--prompt":
				opts.prompt = argv[++i];
				break;
			case "--cwd":
				opts.cwd = argv[++i];
				break;
			case "--timeout":
				opts.timeoutMs = Number(argv[++i]);
				break;
			case "--no-hygiene":
				opts.noHygiene = true;
				break;
			case "--json":
				opts.json = true;
				break;
			case "--quiet":
				opts.quiet = true;
				break;
			case "-h":
			case "--help":
				process.stdout.write(
					`drive.mjs — scripted ACP client\n\n  --agent <cmd>  --prompt <text>  --cwd <dir>  --timeout <ms>  --no-hygiene  --json\n`,
				);
				process.exit(0);
			default:
				process.stderr.write(`drive: unknown argument ${argv[i]}\n`);
				process.exit(2);
		}
	}
	if (opts.noHygiene) opts.agent += " --no-hygiene";
	return opts;
}

const opts = parseArgs(process.argv.slice(2));
const note = (msg) => {
	if (!opts.quiet) process.stderr.write(`${msg}\n`);
};

// ---------------------------------------------------------------------------
// frames observed
// ---------------------------------------------------------------------------

const frames = []; // every frame, both directions
const updates = []; // session/update payloads from the agent
const clientRequests = []; // requests the AGENT sent to us (delegation lives here)
const toolCalls = new Map(); // toolCallId -> merged view

let nextId = 1;
const pending = new Map();

/** The hostile capability set: everything OMP would delegate through. */
function hostileCapabilities() {
	return {
		fs: { readTextFile: true, writeTextFile: true },
		terminal: true,
		auth: { terminal: true },
	};
}

function send(method, params) {
	const id = nextId++;
	write({ jsonrpc: "2.0", id, method, params });
	return new Promise((resolve, reject) => {
		pending.set(id, { resolve, reject, method });
	});
}

function write(frame) {
	frames.push({ dir: "to_agent", frame });
	if (opts.json) process.stdout.write(`${JSON.stringify({ dir: "to_agent", frame })}\n`);
	child.stdin.write(`${JSON.stringify(frame)}\n`);
}

/** Answer the agent's client-bound requests the way the pager would. */
function handleAgentRequest(frame) {
	clientRequests.push(frame);
	if (opts.json) process.stdout.write(`${JSON.stringify({ dir: "to_client", frame })}\n`);

	switch (frame.method) {
		case "session/request_permission": {
			const options = frame.params?.options ?? [];
			const allow = options.find((o) => o.kind === "allow_once") ?? options[0];
			respond(frame.id, {
				outcome: allow ? { outcome: "selected", optionId: allow.optionId } : { outcome: "cancelled" },
			});
			return;
		}
		case "fs/read_text_file":
			// The pager drops this; we answer, so a delegation attempt is visible
			// as a completed call instead of a timeout.
			respond(frame.id, { content: "" });
			return;
		case "fs/write_text_file":
			respond(frame.id, {});
			return;
		default:
			respond(frame.id, {});
	}
}

function respond(id, result) {
	write({ jsonrpc: "2.0", id, result });
}

function respondError(id, code, message) {
	write({ jsonrpc: "2.0", id, error: { code, message } });
}

// ---------------------------------------------------------------------------
// agent stdout
// ---------------------------------------------------------------------------

const child = spawn("sh", ["-c", opts.agent], { stdio: ["pipe", "pipe", "inherit"] });

let buffer = "";
child.stdout.on("data", (chunk) => {
	buffer += chunk.toString("utf8");
	let index;
	while ((index = buffer.indexOf("\n")) >= 0) {
		const line = buffer.slice(0, index);
		buffer = buffer.slice(index + 1);
		if (line.trim()) onLine(line);
	}
});

function onLine(line) {
	let frame;
	try {
		frame = JSON.parse(line);
	} catch {
		note(`drive: unparsable agent line: ${line.slice(0, 200)}`);
		return;
	}
	frames.push({ dir: "to_client", frame });
	if (opts.json) process.stdout.write(`${JSON.stringify({ dir: "to_client", frame })}\n`);

	if (frame.method && frame.id !== undefined) {
		handleAgentRequest(frame);
		return;
	}
	if (frame.method === "session/update") {
		recordUpdate(frame.params);
		return;
	}
	if (frame.id !== undefined) {
		const waiter = pending.get(frame.id);
		if (!waiter) return;
		pending.delete(frame.id);
		if (frame.error) waiter.reject(new Error(`${waiter.method}: ${frame.error.message}`));
		else waiter.resolve(frame.result);
	}
}

function recordUpdate(params) {
	const update = params?.update;
	if (!update) return;
	updates.push(update);
	if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
		const id = update.toolCallId;
		toolCalls.set(id, { ...(toolCalls.get(id) ?? {}), ...update });
	}
}

// ---------------------------------------------------------------------------
// the turn
// ---------------------------------------------------------------------------

const text = [];
const thoughts = [];
let stopReason = null;

const deadline = setTimeout(() => {
	note(`drive: TIMEOUT after ${opts.timeoutMs}ms`);
	report();
	child.kill("SIGKILL");
	process.exit(3);
}, opts.timeoutMs);

try {
	const init = await send("initialize", {
		protocolVersion: 1,
		clientCapabilities: hostileCapabilities(),
		clientInfo: { name: "grok-omp-drive", version: "0.1.0" },
	});

	note(`handshake: agent=${init?.agentInfo?.name ?? "?"} protocolVersion=${init?.protocolVersion}`);
	note(`authMethods: ${JSON.stringify((init?.authMethods ?? []).map((m) => m.id))}`);

	const authId = init?.authMethods?.[0]?.id;
	if (authId) await send("authenticate", { methodId: authId }).catch((e) => note(`authenticate: ${e.message}`));

	const session = await send("session/new", { cwd: opts.cwd, mcpServers: [] });
	const sessionId = session?.sessionId;
	note(`session: ${sessionId}`);
	note(`configOptions: ${JSON.stringify(session?.configOptions ?? null)}`);

	const result = await send("session/prompt", {
		sessionId,
		prompt: [{ type: "text", text: opts.prompt }],
	});
	stopReason = result?.stopReason ?? null;

	clearTimeout(deadline);

	// Drain a moment for trailing notifications to land before reporting.
	await new Promise((r) => setTimeout(r, 500));
} catch (error) {
	clearTimeout(deadline);
	note(`drive: turn failed: ${error?.message ?? error}`);
	report();
	process.exit(1);
}

for (const update of updates) {
	if (update.sessionUpdate === "agent_message_chunk" && update.content?.type === "text") {
		text.push(update.content.text);
	}
	if (update.sessionUpdate === "agent_thought_chunk" && update.content?.type === "text") {
		thoughts.push(update.content.text);
	}
}

function report() {
	const delegations = clientRequests.filter((f) => /^(fs|terminal)\//.test(f.method ?? ""));
	const kinds = {};
	for (const call of toolCalls.values()) kinds[call.kind ?? "?"] = (kinds[call.kind ?? "?"] ?? 0) + 1;

	note("");
	note("=== turn ===");
	note(`stopReason: ${stopReason}`);
	note(`assistant text: ${JSON.stringify(text.join("").slice(0, 200))}`);
	note(`thinking chars: ${thoughts.join("").length}`);
	note(`tool calls: ${toolCalls.size} ${JSON.stringify(kinds)}`);
	for (const call of toolCalls.values()) {
		const meta = call._meta?.["x.ai/tool"];
		note(
			`  - id=${call.toolCallId} kind=${call.kind} title=${JSON.stringify(call.title)} ` +
				`variant=${JSON.stringify(call.rawInput?.variant ?? null)} meta=${meta ? `${meta.name}/${meta.kind}` : "none"}`,
		);
	}
	note("");
	note("=== delegation (SPEC.md §7.3.1) ===");
	if (delegations.length === 0) {
		note("client requests: none — agent stayed local");
	} else {
		for (const frame of delegations) note(`DELEGATED: ${frame.method}`);
	}
	const others = clientRequests.filter((f) => !/^(fs|terminal)\//.test(f.method ?? ""));
	if (others.length) note(`other client requests: ${others.map((f) => f.method).join(", ")}`);
	note(`total frames: ${frames.length}`);

	if (opts.json) {
		process.stdout.write(
			`${JSON.stringify({
				ok: !delegations.length,
				stopReason,
				text: text.join(""),
				tools: [...toolCalls.values()].map((c) => ({
					id: c.toolCallId,
					kind: c.kind,
					title: c.title,
					variant: c.rawInput?.variant ?? null,
					meta: c._meta?.["x.ai/tool"] ?? null,
				})),
				delegations: delegations.map((f) => f.method),
			})}\n`,
		);
	}
}

report();
child.kill("SIGTERM");
process.exit(0);
