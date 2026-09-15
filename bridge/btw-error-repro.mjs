#!/usr/bin/env bun
/**
 * Repro: failed /btw error overlay must not linger over subsequent output.
 * Uses the stub agent (rejects x.ai/btw with -32601) so the error path is deterministic.
 */
import { TerminalControl } from "@kitlangton/terminal-control";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "..");
const PAGER = join(REPO, "target", "debug", "xai-grok-pager");
const ADAPTER = join(REPO, "bridge", "adapter.mjs");
const STUB = join(REPO, "bridge", "omp-stub-agent.mjs");

const tc = await TerminalControl.make({ cwd: REPO });
const session = await tc.launch({
	command: [PAGER, "--cwd", "/tmp", "--agent-command", `bun ${ADAPTER}`],
	cwd: "/tmp",
	viewport: { cols: 110, rows: 34 },
	inheritEnv: true,
	env: {
		OMP_ACP_CMD: `bun ${STUB}`,
		GROK_HOME: "/tmp/grokpi-btw-home",
		GROK_DISABLE_AUTOUPDATER: "1",
		GROK_TELEMETRY_ENABLED: "false",
	},
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cap = async (label) => {
	const s = await session.screen.capture({ settleMs: 300, deadlineMs: 5000, allowIncomplete: true });
	console.log(`\n===== ${label} (reason=${s.reason}) =====`);
	console.log(s.text);
};

try {
	await sleep(6000);
	await cap("WELCOME");

	// trigger the failing /btw
	await session.keyboard.type("/btw what is 2+2", { paceMs: 30 });
	await session.keyboard.press("Enter");
	await sleep(3000);
	await cap("BTW-ERROR");

	// run a normal prompt — the error card must NOT still overlay the scrollback
	await session.keyboard.type("hello", { paceMs: 30 });
	await session.keyboard.press("Enter");
	await sleep(3000);
	await cap("AFTER-PROMPT");
} finally {
	await session.stop();
	await tc.close();
}
