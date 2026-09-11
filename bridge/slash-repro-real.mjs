#!/usr/bin/env bun
/**
 * Drive the real Settings > OMP toggle flow via search, then probe the dropdown.
 */
import { TerminalControl } from "@kitlangton/terminal-control";

const DIST = "/Users/firatoezcan/Projects/Freelancing/personal/grok-omp/dist";
const PAGER_BIN = `${DIST}/grok-pi-pager`;
const AGENT = `${DIST}/grok-pi-agent`;

const tc = await TerminalControl.make({ cwd: "/tmp", env: process.env, artifacts: "/tmp" });
const session = await tc.launch({
	command: [PAGER_BIN, "--cwd", "/tmp", "--agent-command", AGENT],
	cwd: "/tmp",
	viewport: { cols: 100, rows: 30 },
	env: { GROK_HOME: "/Users/firatoezcan/.local/share/grok-pi", GROK_DISABLE_AUTOUPDATER: "1", GROK_TELEMETRY_ENABLED: "false" },
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
	await sleep(5000);

	await session.keyboard.type("/settings", { paceMs: 40 });
	await session.keyboard.press("Enter");
	await sleep(1500);

	// Search for the OMP slash-commands row.
	await session.keyboard.type("/", { paceMs: 40 });
	await session.keyboard.type("slash", { paceMs: 60 });
	await sleep(800);
	await dump("SETTINGS-SEARCH");

	// Commit search, focus the OMP "Slash commands" row, open the sheet.
	await session.keyboard.press("Enter");
	await sleep(500);
	await session.keyboard.press("ArrowDown");
	await sleep(300);
	await session.keyboard.press("Enter");
	await sleep(800);
	await dump("OMP-SHEET");

	// Toggle the first command off, then a second one.
	await session.keyboard.press("Enter");
	await sleep(500);
	await dump("TOGGLED-1");
	await session.keyboard.press("ArrowDown");
	await session.keyboard.press("Enter");
	await sleep(500);
	await dump("TOGGLED-2");

	// Close settings, probe the dropdown.
	await session.keyboard.press("Escape");
	await sleep(400);
	await session.keyboard.press("Escape");
	await sleep(600);
	await session.keyboard.type("/", { paceMs: 60 });
	await sleep(1200);
	await dump("AFTER /");
	await session.keyboard.type("sec", { paceMs: 60 });
	await sleep(1000);
	await dump("AFTER /sec");
} finally {
	await session.stop();
	await tc.close();
}
