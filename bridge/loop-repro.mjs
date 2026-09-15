#!/usr/bin/env bun
/**
 * Repro: /loop lifecycle messages concatenating with agent text.
 * Tapes the ACP stream so we can inspect the exact chunk frames.
 */
import { TerminalControl } from "@kitlangton/terminal-control";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "..");
const GROKPI = join(REPO, "dist", "grok-pi");
const PAGER = join(REPO, "target", "debug", "xai-grok-pager");
const TAPE = "/tmp/loop-repro.acptape";

const tc = await TerminalControl.make({ cwd: REPO });
const session = await tc.launch({
	command: [GROKPI, "--cwd", "/tmp"],
	cwd: "/tmp",
	viewport: { cols: 110, rows: 34 },
	inheritEnv: true,
	env: {
		GROK_PI_PAGER: PAGER,
		OMP_BRIDGE_TAPE: TAPE,
		GROK_PI_ADVISOR: "0",
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
	await session.screen.waitForText(/New worktree|worktree|›/, { timeoutMs: 60_000 });
	await sleep(1500);
	await cap("WELCOME");

	// /loop 2 with a trivial prompt — two iterations then "Loop limit reached."
	await session.keyboard.type("/loop 2 say exactly: Hi.", { paceMs: 30 });
	await session.keyboard.press("Enter");
	await sleep(4000);
	await cap("LOOP-T1");
	await sleep(8000);
	await cap("LOOP-T2");
	await sleep(10000);
	await cap("LOOP-DONE");
} finally {
	await session.stop();
	await tc.close();
}
