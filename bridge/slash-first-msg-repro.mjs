#!/usr/bin/env bun
/**
 * Cold-start repro: launch the pager and type `/` at the very first composer,
 * as early as the terminal accepts input. Captures the dropdown at tight
 * intervals to see whether OMP commands appear and when.
 *
 * Usage: bun bridge/slash-first-msg-repro.mjs [delayMs]
 *   delayMs — wait this long after launch before typing `/` (default 0).
 */
import { TerminalControl } from "@kitlangton/terminal-control";

const DIST = "/Users/firatoezcan/Projects/Freelancing/personal/grok-omp/dist";
const PAGER_BIN = process.env.PAGER_BIN ?? "/Users/firatoezcan/Projects/Freelancing/personal/grok-omp/target/debug/xai-grok-pager";
const AGENT = `${DIST}/grok-pi-agent`;
const GROK_HOME = process.env.GROK_HOME ?? "/Users/firatoezcan/.local/share/grok-pi";
const DELAY = Number(process.argv[2] ?? 0);

const tc = await TerminalControl.make({ cwd: "/tmp", env: process.env, artifacts: "/tmp" });
const session = await tc.launch({
	command: [PAGER_BIN, "--cwd", "/tmp", "--agent-command", AGENT, "--no-leader"],
	cwd: "/tmp",
	viewport: { cols: 100, rows: 30 },
	env: { GROK_HOME, GROK_DISABLE_AUTOUPDATER: "1", GROK_TELEMETRY_ENABLED: "false", GROK_DEBUG_LOG: "/tmp/grok-wire.log" },
	inheritEnv: true,
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const dump = async (label) => {
	const snap = await session.screen.capture({ settleMs: 60, deadlineMs: 800, allowIncomplete: true });
	console.log(`=== ${label} @${Date.now() - t0}ms ===`);
	console.log(snap.text);
};

try {
	if (DELAY > 0) await sleep(DELAY);
	// Type `/` as early as possible — before the welcome screen may even be up.
	await session.keyboard.type("/", { paceMs: 0 });
	console.log(`sent '/' at +${Date.now() - t0}ms`);
	for (const wait of [50, 150, 350, 700, 1500, 3000]) {
		await sleep(wait);
		await dump(`after / (+${wait} cumulative-ish)`);
	}
	// Now refine: type "sec" to see if OMP /security-style commands match.
	await session.keyboard.type("sec", { paceMs: 30 });
	await sleep(800);
	await dump("after /sec");
} finally {
	await session.stop();
	await tc.close();
}
