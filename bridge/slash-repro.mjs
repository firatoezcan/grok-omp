#!/usr/bin/env bun
/**
 * Probe several slash prefixes against the OMP stub.
 */
import { TerminalControl } from "@kitlangton/terminal-control";

const PAGER_BIN = process.env.PAGER_BIN ?? "/Users/firatoezcan/Projects/Freelancing/personal/grok-omp/target/debug/xai-grok-pager";
const AGENT = `bun /Users/firatoezcan/Projects/Freelancing/personal/grok-omp/bridge/omp-stub-agent.mjs`;
const GROK_HOME = process.env.REPRO_HOME ?? "/tmp/grok-pi-repro-home";

const tc = await TerminalControl.make({ cwd: "/tmp", env: process.env, artifacts: "/tmp" });
const session = await tc.launch({
	command: [PAGER_BIN, "--cwd", "/tmp", "--agent-command", AGENT],
	cwd: "/tmp",
	viewport: { cols: 100, rows: 30 },
	env: { GROK_HOME, GROK_DISABLE_AUTOUPDATER: "1", GROK_TELEMETRY_ENABLED: "false" },
	inheritEnv: true,
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dump = async (label) => {
	const snap = await session.screen.capture({ settleMs: 300, deadlineMs: 3000, allowIncomplete: true });
	console.log(`=== ${label} ===`);
	console.log(snap.text);
};

try {
	await sleep(6000);
	await session.keyboard.type("hi", { paceMs: 60 });
	await session.keyboard.press("Enter");
	await sleep(4000);

	for (const q of ["/rev", "/fix", "/plan"]) {
		// clear input then type query
		await session.keyboard.press("Escape");
		await session.keyboard.type(q, { paceMs: 60 });
		await sleep(1000);
		await dump(`AFTER ${q}`);
		// select-all + delete to reset
		await session.keyboard.press("Escape");
		await session.keyboard.press("Control+U");
	}
} finally {
	await session.stop();
	await tc.close();
}
