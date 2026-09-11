#!/usr/bin/env bun
/**
 * Stub ACP agent mimicking Oh My Pi for slash-completion reproduction.
 * Advertises _meta.ompAgent + a set of available commands, then idles.
 */

const AGENT_NAME = "omp-stub";
const AUTH_METHOD_ID = "xai.api_key";

const COMMANDS = [
	{ name: "security", description: "Run a security review" },
	{ name: "review", description: "Review the diff" },
	{ name: "fix-issue", description: "Fix a GitHub issue" },
	{ name: "plan-feature", description: "Plan a feature" },
];

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

const handlers = {
	initialize() {
		console.error(`[${AGENT_NAME}] initialize`);
		return {
			protocolVersion: 1,
			agentInfo: { name: "oh-my-pi", version: "0.0.0" },
			agentCapabilities: {
				loadSession: false,
				promptCapabilities: { image: false, audio: false, embeddedContext: true },
			},
			authMethods: [
				{ id: AUTH_METHOD_ID, name: "Local agent", description: "No credentials required" },
			],
			_meta: {
				ompAgent: true,
				defaultAuthMethodId: AUTH_METHOD_ID,
				availableCommands: COMMANDS,
			},
		};
	},
	authenticate() {
		return {};
	},
	"session/new"(params) {
		const sessionId = "stub-session-1";
		console.error(`[${AGENT_NAME}] session/new -> ${sessionId}`);
		// Advertise commands via the update path too (like a real agent).
		sessionUpdate(sessionId, {
			sessionUpdate: "available_commands_update",
			availableCommands: COMMANDS,
		});
		return {
			sessionId,
			// Advertise vibe so the adapter's _x.ai/omp/capabilities reports vibeCapable.
			modes: {
				availableModes: [
					{ id: "default", name: "Default", description: "Standard ACP headless mode" },
					{ id: "vibe", name: "Vibe", description: "Direct persistent worker sessions" },
				],
				currentModeId: "default",
			},
		};
	},
	async "session/prompt"(params) {
		const sessionId = params?.sessionId ?? "stub-session-1";
		sessionUpdate(sessionId, {
			sessionUpdate: "agent_message_chunk",
			content: { type: "text", text: "stub reply" },
		});
		return { stopReason: "end_turn" };
	},
	"session/cancel"() {
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
	if (!method) return;
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
