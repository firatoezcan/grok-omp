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
  env: { GROK_DEBUG_LOG: "/tmp/grokpi-e2e.log", GROK_HOME: HOME, GROK_PI_PAGER: PAGER },
});
const cap = async (label) => {
  const s = await session.screen.capture({ settleMs: 300, deadlineMs: 6000, allowIncomplete: true });
  console.log(`\n===== ${label} (reason=${s.reason}) =====`);
  console.log(s.text);
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const cmd = async (c, wait = 1400) => { await session.keyboard.type(c); await session.keyboard.press("Enter"); await sleep(wait); };
const esc = async () => { await session.keyboard.press("Escape"); await sleep(400); };

try {
  await session.screen.waitForText("New worktree", { timeoutMs: 40_000 });
  await session.keyboard.type("hi");
  await session.keyboard.press("Enter");
  await session.screen.waitForText("[agent:idle]", { timeoutMs: 90_000 });
  await sleep(400);
  await cap("IDLE-AFTER-HI");

  // 1. /usage — expect real cost row (cost_usd_ticks without token counters)
  await cmd("/usage", 2000);
  await cap("USAGE");
  await esc();

  // 2. /resume picker — OMP sessions must be listed (LocalPresence::Agent)
  await cmd("/resume", 2500);
  await cap("RESUME-PICKER");
  await esc();

  // 3. Extensions modal tabs
  await cmd("/skills", 2000);
  await cap("SKILLS");
  await esc();
  await cmd("/mcps", 2000);
  await cap("MCPS");
  await esc();
  await cmd("/plugins", 2000);
  await cap("PLUGINS");
  await esc();

  // 4. Subagent spawn → Subagent block; then Ctrl+G tasks pane, x to cancel → honest note
  await session.keyboard.type("use the task tool to spawn a subagent that counts from 1 to 50 slowly, one number per second");
  await session.keyboard.press("Enter");
  // wait for a subagent/task indicator while the turn runs
  let sawSubagent = false;
  try {
    await session.screen.waitForText(/[Ss]ubagent|task/i, { timeoutMs: 45_000 });
    sawSubagent = true;
  } catch {}
  await cap("SUBAGENT-RUNNING");
  // open tasks pane and try to cancel the selected agent row
  await session.keyboard.press("Control+G");
  await sleep(800);
  await cap("TASKS-PANE");
  await session.keyboard.type("x");
  await sleep(1500);
  await cap("AFTER-CANCEL-ATTEMPT");
  await session.keyboard.press("Control+G"); // close pane
  await sleep(400);
  // let the turn finish (or the subagent keep running)
  try { await session.screen.waitForText("[agent:idle]", { timeoutMs: 60_000 }); } catch {}
  await cap("AFTER-SUBAGENT-TURN");

  // 5. Plan-mode toggle (Shift+Tab) — indicator should appear; toggle back
  await session.keyboard.press("Shift+Tab");
  await sleep(900);
  await cap("PLAN-MODE-ON");
  await session.keyboard.press("Shift+Tab");
  await sleep(900);
  await cap("PLAN-MODE-OFF");

  // 6. Queue type-ahead during a running turn must not destroy it
  await session.keyboard.type("count to 30 slowly");
  await session.keyboard.press("Enter");
  await sleep(2500); // turn running
  await session.keyboard.type("queued follow-up");
  await sleep(800);
  await cap("TYPEAHEAD-DURING-TURN");
  try { await session.screen.waitForText("[agent:idle]", { timeoutMs: 90_000 }); } catch {}
  await cap("AFTER-QUEUED-TURN");
} catch (e) {
  console.log("ERR:", e.message);
  await cap("FAILURE-STATE");
} finally {
  await session.stop();
  await tc.close();
}
