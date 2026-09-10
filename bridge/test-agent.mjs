#!/usr/bin/env bun
/**
 * Minimal ACP agent used to validate the `--agent-command` seam.
 *
 * Speaks ACP (JSON-RPC 2.0, newline-delimited) over stdin/stdout and answers the
 * subset the pager needs to reach a usable prompt:
 *
 *   initialize            -> advertises ONE non-interactive auth method
 *   authenticate          -> no-op success (this is what keeps the sign-in card away:
 *                            an empty authMethods list makes the pager force
 *                            needs_login = true, so a method must exist AND succeed)
 *   session/new           -> a session id
 *   session/prompt        -> a short streamed answer, plus one tool call
 *   session/cancel        -> stops the in-flight turn
 *
 * Not a product: it is the reference backend for stage 2 and the seed of the
 * replay agent for the tape harness. Diagnostics go to stderr, which the pager
 * inherits, so they land in the pty and in `--debug-file`.
 */

const AGENT_NAME = "acp-stub";
const AUTH_METHOD_ID = "xai.api_key"; // known non-interactive kind to the pager

let nextId = 1;
const pending = new Map(); // id -> resolver

function send(message) {
	process.stdout.write(JSON.stringify(message) + "\n");
}

function reply(id, result) {
	send({ jsonrpc: "2.0", id, result });
}

function fail(id, code, message) {
	send({ jsonrpc: "2.0", id, error: { code, message } });
}

function notify(method, params) {
	send({ jsonrpc: "2.0", method, params });
}

function sessionUpdate(sessionId, update) {
	notify("session/update", { sessionId, update });
}

function textChunk(sessionId, text) {
	sessionUpdate(sessionId, {
		sessionUpdate: "agent_message_chunk",
		content: { type: "text", text },
	});
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** sessionId -> AbortController for cancel support. */
const turns = new Map();

async function runTurn(sessionId) {
	const cancelled = { value: false };
	turns.set(sessionId, cancelled);

	const chunks = [
		"Hello from the external ACP backend. ",
		"This text crossed the stdio seam: ",
		"pager → external.rs → bridge_channels → ACP client → tracker → scrollback.",
	];
	for (const chunk of chunks) {
		if (cancelled.value) break;
		textChunk(sessionId, chunk);
		await sleep(120);
	}

	if (!cancelled.value) {
		// One tool call, so the seam is exercised on the tool path too.
		const toolCallId = `stub-tool-${nextId++}`;
		sessionUpdate(sessionId, {
			sessionUpdate: "tool_call",
			toolCallId,
			title: "Read SPEC.md",
			kind: "read",
			status: "in_progress",
			rawInput: { path: "SPEC.md" },
		});
		await sleep(150);
		sessionUpdate(sessionId, {
			sessionUpdate: "tool_call_update",
			toolCallId,
			status: "completed",
			content: [{ type: "content", content: { type: "text", text: "412 lines" } }],
		});
		await sleep(80);
		textChunk(sessionId, "\n\nStub turn complete.");
	}

	turns.delete(sessionId);
	return cancelled.value ? "cancelled" : "end_turn";
}

const handlers = {
	initialize(params) {
		console.error(`[${AGENT_NAME}] initialize from ${params?.clientCapabilities ? "pager" : "unknown"}`);
		return {
			protocolVersion: 1,
			agentCapabilities: {
				loadSession: false,
				promptCapabilities: { image: false, audio: false, embeddedContext: true },
			},
			// One method, and it must authenticate successfully. An EMPTY list makes
			// the pager's eager_auth_or_login_fallback force the login screen.
			authMethods: [
				{
					id: AUTH_METHOD_ID,
					name: "Local agent",
					description: "No credentials required",
				},
			],
			_meta: {
				grokShell: false,
				defaultAuthMethodId: AUTH_METHOD_ID,
			},
		};
	},

	authenticate() {
		console.error(`[${AGENT_NAME}] authenticate -> ok`);
		return {};
	},

	"session/new"(params) {
		const sessionId = `stub-session-${nextId++}`;
		console.error(`[${AGENT_NAME}] session/new cwd=${params?.cwd ?? "?"} -> ${sessionId}`);
		notify("x.ai/queue/changed", { sessionId, queue: [] });
		return { sessionId };
	},

	async "session/prompt"(params) {
		const sessionId = params?.sessionId ?? "stub-session-0";
		const stopReason = await runTurn(sessionId);
		return { stopReason };
	},

	"session/cancel"(params) {
		const cancelled = turns.get(params?.sessionId);
		if (cancelled) cancelled.value = true;
		return {};
	},

	"session/set_mode"() {
		return {};
	},

	"session/set_model"() {
		return {};
	},

	"session/set_config_option"() {
		return {};
	},
};

async function handle(message) {
	const { id, method, params } = message;
	if (!method) {
		// A response to something we sent (we send no requests); ignore.
		return;
	}

	const handler = handlers[method];
	if (!handler) {
		console.error(`[${AGENT_NAME}] unhandled method: ${method}`);
		if (id !== undefined) fail(id, -32601, `Method not found: ${method}`);
		return;
	}

	try {
		const result = await handler(params);
		if (id !== undefined) reply(id, result);
	} catch (error) {
		console.error(`[${AGENT_NAME}] handler error for ${method}: ${error}`);
		if (id !== undefined) fail(id, -32603, String(error));
	}
}

// NDJSON reader over stdin.
let buffer = "";
const decoder = new TextDecoder();
process.stdin.on("data", (chunk) => {
	buffer += decoder.decode(chunk, { stream: true });
	let index;
	while ((index = buffer.indexOf("\n")) >= 0) {
		const line = buffer.slice(0, index).trim();
		buffer = buffer.slice(index + 1);
		if (!line) continue;
		try {
			void handle(JSON.parse(line));
		} catch (error) {
			console.error(`[${AGENT_NAME}] bad JSON: ${error}`);
		}
	}
});
process.stdin.on("end", () => {
	console.error(`[${AGENT_NAME}] stdin closed; exiting`);
	process.exit(0);
});

console.error(`[${AGENT_NAME}] ready on stdio`);
