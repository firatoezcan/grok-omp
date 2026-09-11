#!/usr/bin/env bun
/**
 * omp-settings-verify.mjs — drive the real pager under termctrl against the
 * adapter + stub OMP agent, open Settings, and assert the OMP section rows
 * render with live values.
 *
 *   bun bridge/omp-settings-verify.mjs
 */
import { TerminalControl } from "@kitlangton/terminal-control";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "..");
const PAGER = process.env.GROK_PAGER_BIN ?? join(REPO, "target/debug/xai-grok-pager");
const ADAPTER = join(REPO, "bridge", "adapter.mjs");
const STUB = join(REPO, "bridge", "omp-stub-agent.mjs");
const BUN = process.env.OMP_BRIDGE_BUN ?? "bun";

const tc = await TerminalControl.make({ cwd: REPO });
const session = await tc.launch({
	command: [
		PAGER,
		"--cwd", REPO,
		"--no-leader",
		"--agent-command", `${BUN} ${ADAPTER} --agent "${BUN} ${STUB}"`,
	],
	cwd: REPO,
	viewport: { cols: 110, rows: 34 },
	inheritEnv: true,
	env: { GROK_DEBUG_LOG: "/tmp/omp-settings-verify.log" },
});

try {
	// Give the pager time to boot and complete the agent handshake, then look at
	// whatever is actually on screen (the dock label varies by build).
	await new Promise(r => setTimeout(r, 6000));
	const boot = await session.screen.capture({ settleMs: 500, deadlineMs: 8000, allowIncomplete: true });
	console.log("=== BOOT ===\n" + boot.text);

	// Open the settings modal via the slash command (termctrl has no F-keys).
	await session.keyboard.type("/settings", { paceMs: 40 });
	await session.keyboard.press("Enter");
	await session.screen.waitForText(/Settings/i, { timeoutMs: 8000 });
	await session.screen.waitForIdle({ timeoutMs: 8000, quietForMs: 600 });
	await session.keyboard.type("/", { paceMs: 30 });
	await session.keyboard.type("omp", { paceMs: 30 });
	await session.screen.waitForIdle({ timeoutMs: 8000, quietForMs: 600 });

	const { text } = await session.screen.capture({ settleMs: 800, deadlineMs: 8000, allowIncomplete: true });
	console.log("=== SETTINGS (filter: omp) ===\n" + text);

	const checks = {
		"OMP section header": /\bOMP\b/.test(text),
		"Advisor row": /Advisor/.test(text),
		"Voice dictation row": /Voice dictation/.test(text),
		"Voice model row": /Voice model/.test(text),
		"Slash commands row": /Slash commands/.test(text),
		"Agent version row": /Agent version/.test(text),
		"Agent command row": /Agent command/.test(text),
		"Vibe mode row": /Vibe mode/.test(text),
		"agent version value (oh-my-pi 0.0.0)": /oh-my-pi 0\.0\.0/.test(text),
		"agent command value (stub path)": /omp-stub-agent\.mjs/.test(text),
		"vibe capable = yes": /Vibe mode[\s\S]{0,80}\byes\b/.test(text),
		"advisor default on": /Advisor[\s\S]{0,80}\bon\b/.test(text),
	};
	let ok = true;
	for (const [name, pass] of Object.entries(checks)) {
		console.log(`${pass ? "PASS" : "FAIL"} ${name}`);
		ok &&= pass;
	}
	process.exitCode = ok ? 0 : 1;
} finally {
	await session.stop().catch(() => {});
	await tc.close().catch(() => {});
}
