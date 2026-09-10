import { TerminalControl } from "@kitlangton/terminal-control";
import { join, resolve } from "node:path";
const REPO = resolve(import.meta.dir, "..");
const GROKPI = join(REPO, "dist", "grok-pi");
const PAGER = join(REPO, "target", "debug", "xai-grok-pager");
const HOME = "/tmp/grokpi-e2e-home";

const tc = await TerminalControl.make({ cwd: REPO });
const session = await tc.launch({
  command: [GROKPI, "--cwd", REPO],
  cwd: REPO,
  viewport: { cols: 110, rows: 34 },
  inheritEnv: true,
  env: { GROK_DEBUG_LOG: "/tmp/grokpi-e2e.log", GROK_HOME: HOME, GROK_PI_PAGER: PAGER },
});
const cap = async (label) => {
  const s = await session.screen.capture({ settleMs: 300, deadlineMs: 6000, allowIncomplete: true });
  console.log(`\n===== ${label} (reason=${s.reason}) =====`);
  console.log(s.text);
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const cmd = async (c, wait=1400) => { await session.keyboard.type(c); await session.keyboard.press("Enter"); await sleep(wait); };
try {
  await session.screen.waitForText("New worktree", { timeoutMs: 40_000 });
  await session.keyboard.type("hi");
  await session.keyboard.press("Enter");
  await session.screen.waitForText("[agent:idle]", { timeoutMs: 60_000 });
  await sleep(400);
  // Switch model: open picker, select DeepSeek V4 Pro (4th), then effort High (5th).
  await cmd("/model");
  for (let i=0;i<3;i++) await session.keyboard.press("ArrowDown");
  await session.keyboard.press("Enter");
  await sleep(800);
  for (let i=0;i<4;i++) await session.keyboard.press("ArrowDown"); // High
  await session.keyboard.press("Enter");
  await sleep(1500);
  await cap("AFTER-MODEL+EFFORT");
  await cmd("/skills");
  await cap("SKILLS");
  await session.keyboard.press("Escape"); await sleep(400);
  await cmd("/mcps");
  await cap("MCPS");
  await session.keyboard.press("Escape"); await sleep(400);
  await cmd("/plugins");
  await cap("PLUGINS");
} catch (e) {
  console.log("ERR:", e.message);
  await cap("FAILURE-STATE");
} finally {
  await session.stop();
  await tc.close();
}
