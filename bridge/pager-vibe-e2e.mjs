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
  env: { GROK_DEBUG_LOG: "/tmp/grokpi-vibe.log", GROK_HOME: HOME, GROK_PI_PAGER: PAGER },
});
const cap = async (label) => {
  const s = await session.screen.capture({ settleMs: 250, deadlineMs: 4000, allowIncomplete: true });
  console.log(`\n===== ${label} (reason=${s.reason}) =====`);
  console.log(s.text);
  return s.text;
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};
try {
  await session.screen.waitForText("New worktree", { timeoutMs: 40_000 });
  await session.keyboard.type("hi");
  await session.keyboard.press("Enter");
  await session.screen.waitForText("[agent:idle]", { timeoutMs: 90_000 });
  await sleep(300);
  const idle = await cap("IDLE");
  check("baseline has no vibe badge", !/· vibe/.test(idle));

  // /vibe → pager slash command → session/set_mode vibe → badge
  await session.keyboard.type("/vibe");
  await session.keyboard.press("Enter");
  await sleep(1200);
  const on = await cap("VIBE-ON");
  check("vibe badge visible", /· vibe/.test(on) || /Switched to mode: Vibe/.test(on));

  // A turn in vibe mode — the director toolset is live (vibe_spawn etc.)
  await session.keyboard.type("list your tools");
  await session.keyboard.press("Enter");
  await session.screen.waitForText("[agent:idle]", { timeoutMs: 90_000 });
  const turn = await cap("VIBE-TURN");
  check("turn completed in vibe mode", /\[agent:idle\]/.test(turn));

  // /vibe off → back to default
  await session.keyboard.type("/vibe off");
  await session.keyboard.press("Enter");
  await sleep(1200);
  const off = await cap("VIBE-OFF");
  check("vibe badge cleared", !/· vibe/.test(off));
} catch (e) {
  console.log("ERR:", e.message);
  failures++;
  await cap("FAILURE-STATE");
} finally {
  await session.stop();
  await tc.close();
}
console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURES`);
process.exit(failures ? 1 : 0);
