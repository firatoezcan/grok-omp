#!/usr/bin/env bun
/**
 * Verify the collision fix: with omp_disabled_commands = [security, model],
 * the pager builtin /model must still autocomplete while /security stays hidden.
 */
import { TerminalControl } from "@kitlangton/terminal-control";

const PAGER_BIN = process.env.PAGER_BIN ?? "/tmp/grok-omp-verify/target/debug/xai-grok-pager";
const AGENT = "/Users/firatoezcan/Projects/Freelancing/personal/grok-omp/dist/grok-pi-agent";
const GROK_HOME = "/tmp/grok-pi-verify-home";

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
	await sleep(8000);
	await session.keyboard.type("hi", { paceMs: 60 });
	await session.keyboard.press("Enter");
	await sleep(8000);
	await dump("SESSION");

	await session.keyboard.type("/mod", { paceMs: 60 });
	await sleep(1200);
	await dump("AFTER /mod (builtin must appear)");

	await session.keyboard.press("Control+U");
	await session.keyboard.type("/sec", { paceMs: 60 });
	await sleep(1200);
	await dump("AFTER /sec (disabled must NOT appear)");

	await session.keyboard.press("Control+U");
	await session.keyboard.type("/sw", { paceMs: 60 });
	await sleep(1200);
	await dump("AFTER /sw (enabled ACP must appear)");
} finally {
	await session.stop();
	await tc.close();
}
