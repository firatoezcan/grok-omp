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
  env: { GROK_DEBUG_LOG: "/tmp/grokpi-subagent.log", GROK_HOME: HOME, GROK_PI_PAGER: PAGER },
});
const cap = async (label) => {
  const s = await session.screen.capture({ settleMs: 250, deadlineMs: 4000, allowIncomplete: true });
  console.log(`\n===== ${label} (reason=${s.reason}) =====`);
  console.log(s.text);
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
try {
  await session.screen.waitForText("New worktree", { timeoutMs: 40_000 });
  await session.keyboard.type("use the task tool to spawn a subagent that counts from 1 to 60 slowly, one number per second");
  await session.keyboard.press("Enter");
  // wait for the task tool_call to appear
  try { await session.screen.waitForText(/[Ss]pawn/i, { timeoutMs: 60_000 }); } catch {}
  await sleep(1500);
  await cap("SUBAGENT-SPAWNED");
  // open tasks pane — expect a running Agent row now
  await session.keyboard.press("Control+G");
  await sleep(1000);
  await cap("TASKS-PANE-LIVE");
  // cancel the selected agent row
  await session.keyboard.type("x");
  await sleep(2000);
  await cap("AFTER-X-CANCEL");
  await session.keyboard.press("Control+G");
  await sleep(500);
  // wait for the turn to go idle, then check the row state + note
  try { await session.screen.waitForText("[agent:idle]", { timeoutMs: 90_000 }); } catch {}
  await cap("TURN-IDLE");
  await session.keyboard.press("Control+G");
  await sleep(800);
  await cap("TASKS-PANE-FINAL");
} catch (e) {
  console.log("ERR:", e.message);
  await cap("FAILURE-STATE");
} finally {
  await session.stop();
  await tc.close();
}
