import { TerminalControl } from "@kitlangton/terminal-control";
import { join, resolve } from "node:path";
const REPO = resolve(import.meta.dir, "..");
const GROKPI = join(REPO, "dist", "grok-pi");
const PAGER = join(REPO, "target", "debug", "xai-grok-pager");
const HOME = "/tmp/grokpi-advisor-e2e-home";

const tc = await TerminalControl.make({ cwd: REPO });
const session = await tc.launch({
  command: [GROKPI, "--cwd", REPO],
  cwd: REPO,
  viewport: { cols: 110, rows: 34 },
  inheritEnv: true,
  env: { GROK_DEBUG_LOG: "/tmp/grokpi-advisor-e2e.log", GROK_HOME: HOME, GROK_PI_PAGER: PAGER },
});
const cap = async (label) => {
  const s = await session.screen.capture({ settleMs: 300, deadlineMs: 6000, allowIncomplete: true });
  console.log(`\n===== ${label} (reason=${s.reason}) =====`);
  console.log(s.text);
  return s.text;
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
try {
  await session.screen.waitForText("New worktree", { timeoutMs: 40_000 });
  // An edit task like the ones that produced real advisor notes.
  await session.keyboard.type("create /tmp/adv-e2e.txt with lines alpha beta gamma then change beta to BETA");
  await sleep(600);
  await session.keyboard.press("Enter");
  await session.screen.waitForText("[agent:idle]", { timeoutMs: 120_000 });
  // Advisor reviews asynchronously — give it time to emit a note.
  for (let i = 0; i < 12; i++) {
    await sleep(5000);
    const text = await cap(`ADVISOR-POLL-${i}`);
    if (text.includes("Advisor") || text.includes("advisory")) break;
  }
} catch (e) {
  console.log("ERR:", e.message);
  await cap("FAILURE-STATE");
} finally {
  await session.stop();
  await tc.close();
}
