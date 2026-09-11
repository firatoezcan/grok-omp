import { TerminalControl } from "@kitlangton/terminal-control";
import { join, resolve } from "node:path";
const REPO = resolve(import.meta.dir, "..");
const GROKPI = join(REPO, "dist", "grok-pi");
const PAGER = join(REPO, "target", "debug", "xai-grok-pager");
const HOME = "/tmp/grokpi-e2e-home";

const tc = await TerminalControl.make({ cwd: REPO });
const session = await tc.launch({
  command: [GROKPI, "--cwd", REPO, "--always-approve"],
  cwd: REPO,
  viewport: { cols: 110, rows: 34 },
  inheritEnv: true,
  env: { GROK_DEBUG_LOG: "/tmp/grokpi-cancel.log", GROK_HOME: HOME, GROK_PI_PAGER: PAGER },
});
const cap = async (label) => {
  const s = await session.screen.capture({ settleMs: 250, deadlineMs: 4000, allowIncomplete: true });
  console.log(`\n===== ${label} (reason=${s.reason}) =====`);
  console.log(s.text);
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
try {
  await session.screen.waitForText("New worktree", { timeoutMs: 40_000 });
  await session.keyboard.type("use the task tool to spawn a subagent that counts from 1 to 90 slowly, one number per second");
  await session.keyboard.press("Enter");
  // open tasks pane and wait for the live Agent row
  await session.keyboard.press("Control+G");
  await session.screen.waitForText("Subagents", { timeoutMs: 60_000 });
  await sleep(500);
  await cap("LIVE-ROW");
  // move selection off the section header onto the Agent row, then cancel
  await session.keyboard.press("ArrowDown");
  await sleep(300);
  await session.keyboard.type("x");
  await sleep(2500);
  await cap("AFTER-X");
  await session.keyboard.press("Control+G"); // close pane
  await sleep(400);
  await cap("SCROLLBACK-NOTE");
  // confirm the row is still live (reopen pane)
  await session.keyboard.press("Control+G");
  await sleep(800);
  await cap("ROW-STILL-LIVE");
} catch (e) {
  console.log("ERR:", e.message);
  await cap("FAILURE-STATE");
} finally {
  await session.stop();
  await tc.close();
}
