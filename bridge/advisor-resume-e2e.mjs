// E2E: resume an OMP session that contains an advisor custom_message.
// OMP's session/load replays it as user_message_chunk with <advisory> XML;
// the adapter must split it and the pager must render an Advisor block.
// Opens the /resume picker and picks the session by its id fragment.
import { TerminalControl } from "@kitlangton/terminal-control";
import { join, resolve } from "node:path";
const REPO = resolve(import.meta.dir, "..");
const GROKPI = join(REPO, "dist", "grok-pi");
const PAGER = join(REPO, "target", "debug", "xai-grok-pager");
const HOME = "/tmp/grokpi-advisor-e2e-home";
const SESSION_ID = process.env.ADVISOR_SESSION_ID ?? "01a08df7-e6f0-7067-a58e-48a748d67fdb";

const tc = await TerminalControl.make({ cwd: REPO });
const session = await tc.launch({
  command: [GROKPI, "--cwd", REPO],
  cwd: REPO,
  viewport: { cols: 110, rows: 34 },
  inheritEnv: true,
  env: { GROK_DEBUG_LOG: "/tmp/grokpi-advisor-resume.log", GROK_HOME: HOME, GROK_PI_PAGER: PAGER },
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
  await session.keyboard.type("/resume");
  await sleep(800);
  await session.keyboard.press("Enter");
  await sleep(2500);
  const picker = await cap("PICKER");
  // Find the target session row; the picker lists recent sessions. Type the id
  // fragment to filter if the picker supports search, else arrow to it.
  const frag = SESSION_ID.slice(0, 8);
  if (!picker.includes(frag)) {
    // Try typing the fragment as a filter query.
    await session.keyboard.type(frag);
    await sleep(1200);
    await cap("PICKER-FILTERED");
  }
  await session.keyboard.press("Enter");
  // Wait for the replayed history to settle, then look for the Advisor block.
  let found = false;
  for (let i = 0; i < 12; i++) {
    await sleep(2000);
    const text = await cap(`RESUME-POLL-${i}`);
    if (text.includes("Advisor")) { found = true; break; }
  }
  const text = await cap("FINAL");
  console.log("HAS_ADVISOR_BLOCK:", text.includes("Advisor"));
  console.log("HAS_RAW_XML:", text.includes("<advisory"));
} catch (e) {
  console.log("ERR:", e.message);
  await cap("FAILURE-STATE");
} finally {
  await session.stop();
  await tc.close();
}
