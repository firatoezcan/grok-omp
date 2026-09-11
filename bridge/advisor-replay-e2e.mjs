import { TerminalControl } from "@kitlangton/terminal-control";
import { join, resolve } from "node:path";
const REPO = resolve(import.meta.dir, "..");
const PAGER = join(REPO, "target", "debug", "xai-grok-pager");
const TAPE = join(REPO, "tapes", "advisor.acptape");
const HOME = "/tmp/grokpi-advisor-replay-home";

const tc = await TerminalControl.make({ cwd: REPO });
const session = await tc.launch({
  command: [PAGER, "--no-leader", "--agent-command", `bun bridge/adapter.mjs --replay ${TAPE} --allow-stale`, "--cwd", REPO],
  cwd: REPO,
  viewport: { cols: 110, rows: 34 },
  inheritEnv: true,
  env: { GROK_DEBUG_LOG: "/tmp/grokpi-advisor-replay.log", GROK_HOME: HOME },
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
  await session.keyboard.type("fix the file");
  await session.keyboard.press("Enter");
  await session.screen.waitForText("[agent:idle]", { timeoutMs: 60_000 });
  await sleep(800);
  const text = await cap("AFTER-TURN");
  console.log("\nHAS_ADVISOR_BLOCK:", text.includes("Advisor"));
  console.log("HAS_RAW_XML:", text.includes("<advisory"));
} catch (e) {
  console.log("ERR:", e.message);
  await cap("FAILURE-STATE");
} finally {
  await session.stop();
  await tc.close();
}
