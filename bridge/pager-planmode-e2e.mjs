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
  env: { GROK_DEBUG_LOG: "/tmp/grokpi-planmode.log", GROK_HOME: HOME, GROK_PI_PAGER: PAGER },
});
const cap = async (label) => {
  const s = await session.screen.capture({ settleMs: 250, deadlineMs: 4000, allowIncomplete: true });
  console.log(`\n===== ${label} (reason=${s.reason}) =====`);
  console.log(s.text);
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
try {
  await session.screen.waitForText("New worktree", { timeoutMs: 40_000 });
  await session.keyboard.type("hi");
  await session.keyboard.press("Enter");
  await session.screen.waitForText("[agent:idle]", { timeoutMs: 90_000 });
  await sleep(300);
  await cap("IDLE");
  // always-approve → Normal → Plan → ... press twice to reach Plan
  await session.keyboard.press("Shift+Tab");
  await sleep(600);
  await cap("AFTER-SHIFTTAB-1");
  await session.keyboard.press("Shift+Tab");
  await sleep(600);
  await cap("AFTER-SHIFTTAB-2");
  await session.keyboard.press("Shift+Tab");
  await sleep(600);
  await cap("AFTER-SHIFTTAB-3");
} catch (e) {
  console.log("ERR:", e.message);
  await cap("FAILURE-STATE");
} finally {
  await session.stop();
  await tc.close();
}
