// Real-pager /voice smoke: launch dist/grok-pi (compiled launcher + compiled
// grok-pi-stt sibling + debug pager) under termctrl, enter the agent view,
// trigger /voice, and check the shim log for the pager's own WSS connection.
import { TerminalControl } from "@kitlangton/terminal-control";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const REPO = resolve(import.meta.dir, "..");
const GROK_HOME = "/tmp/grok-pi-test-home";
const SHIM_LOG = `${GROK_HOME}/stt-shim.log`;
const logBefore = existsSync(SHIM_LOG) ? readFileSync(SHIM_LOG, "utf8").length : 0;

const tc = await TerminalControl.make({ cwd: REPO });
const session = await tc.launch({
	command: [`${REPO}/dist/grok-pi`],
	cwd: REPO,
	viewport: { cols: 100, rows: 30 },
	inheritEnv: true,
	env: {
		GROK_HOME,
		GROK_PI_PAGER: `${REPO}/target/debug/xai-grok-pager`,
		GROK_PI_AGENT: `${REPO}/dist/grok-pi-agent`,
		GROK_DEBUG_LOG: "/tmp/voice-smoke-pager.log",
	},
	record: "/tmp/voice-smoke.termctrl",
});

function shimLogTail() {
	if (!existsSync(SHIM_LOG)) return "";
	return readFileSync(SHIM_LOG, "utf8").slice(logBefore);
}
async function screenText() {
	return session.screen.text({ settleMs: 400, deadlineMs: 5000 }).catch(() => "");
}

try {
	// Welcome screen: wait for the prompt box, then send a trivial prompt to
	// enter the agent view (voice has no target on the welcome screen).
	await session.screen.waitForText("❯", { timeoutMs: 60_000 });
	console.log("== welcome screen up");
	await session.keyboard.type("reply with just: ok");
	await session.keyboard.press("Enter");

	// Agent view is live once the status bar shows the agent state.
	await session.screen.waitForText(/agent:idle|agent:running|Worked for/, { timeoutMs: 60_000 });
	await session.screen.waitForIdle({ timeoutMs: 20_000, quietForMs: 1200 }).catch(() => {});

	// Trigger /voice via the slash command.
	await session.keyboard.type("/voice");
	await session.keyboard.press("Enter");
	await new Promise(r => setTimeout(r, 7000));

	let text = await screenText();
	console.log("== screen after /voice:\n" + text);
	console.log("== shim log delta:\n" + shimLogTail());

	if (!shimLogTail().includes("ws open")) {
		// Fallback: Ctrl+Space (raw NUL byte).
		console.log("== /voice produced no ws open; trying Ctrl+Space");
		await session.keyboard.write(new Uint8Array([0x00]));
		await new Promise(r => setTimeout(r, 7000));
		text = await screenText();
		console.log("== screen after Ctrl+Space:\n" + text);
		console.log("== shim log delta:\n" + shimLogTail());
	}

	// Stop recording if live, then leave.
	await session.keyboard.press("Escape").catch(() => {});
	await new Promise(r => setTimeout(r, 1500));
	const finalText = await screenText();
	writeFileSync("/tmp/voice-smoke-final.txt", finalText);
	console.log("== final screen:\n" + finalText);
	console.log("== final shim log delta:\n" + shimLogTail());
} finally {
	await session.stop().catch(() => {});
	await tc.close();
}
