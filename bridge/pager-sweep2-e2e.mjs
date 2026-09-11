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
  env: { GROK_DEBUG_LOG: "/tmp/verify2.log", GROK_HOME: HOME, GROK_PI_PAGER: PAGER },
});
const cap = async (label) => {
  const s = await session.screen.capture({ settleMs: 250, deadlineMs: 4000, allowIncomplete: true });
  console.log(`\n===== ${label} (reason=${s.reason}) =====`);
  console.log(s.text);
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const cmd = async (c, wait = 1500) => { await session.keyboard.type(c); await session.keyboard.press("Enter"); await sleep(wait); };
const esc = async () => { await session.keyboard.press("Escape"); await sleep(400); };
const idle = async (ms = 90_000) => { try { await session.screen.waitForText("[agent:idle]", { timeoutMs: ms }); } catch {} };

try {
  await session.screen.waitForText("New worktree", { timeoutMs: 40_000 });
  await session.keyboard.type("hi");
  await session.keyboard.press("Enter");
  await idle();
  await cap("IDLE");

  // --- session/search: /resume picker, type a query ---
  await cmd("/resume", 2200);
  await cap("RESUME-PICKER");
  await session.keyboard.type("e2e-sweep"); // deep-search query
  await sleep(2500);
  await cap("RESUME-SEARCH");
  // Ctrl+W on a row → worktree resume (real git op)
  await session.keyboard.press("Control+W");
  await sleep(4000);
  await cap("WORKTREE-RESUME");
  // if a session loaded in the worktree, we're now in a new session — wait idle
  await idle(60_000);
  await cap("AFTER-WORKTREE");

  // --- dashboard roster ---
  await cmd("/dashboard", 2500);
  await cap("DASHBOARD");
  await esc(); await esc();

  // --- btw while idle ---
  await cmd("/btw what is 2+2", 2000);
  await cap("BTW-IDLE");

  // --- queue mutations during a running turn ---
  await session.keyboard.type("count from 1 to 90 slowly, one number per second");
  await session.keyboard.press("Enter");
  await sleep(3500);
  await session.keyboard.type("queued alpha"); await session.keyboard.press("Enter"); await sleep(600);
  await session.keyboard.type("queued beta"); await session.keyboard.press("Enter"); await sleep(600);
  await session.keyboard.type("queued gamma"); await session.keyboard.press("Enter"); await sleep(1200);
  await cap("QUEUE-3-HELD");
  await cmd("/queue", 1200);
  await cap("QUEUE-PANE");
  // reorder: J (Shift+J) swaps selected row down
  await session.keyboard.type("J"); await sleep(900);
  await cap("QUEUE-AFTER-J");
  // edit: e loads row into composer; append text; Enter saves → queue/edit + hold/release
  await session.keyboard.type("e"); await sleep(700);
  await cap("QUEUE-EDIT-OPEN");
  await session.keyboard.type(" EDITED"); await session.keyboard.press("Enter"); await sleep(1000);
  await cap("QUEUE-AFTER-EDIT");
  // delete a row with x
  await session.keyboard.type("x"); await sleep(1000);
  await cap("QUEUE-AFTER-X");
  await esc(); await esc();

  // --- interject during running turn ---
  await session.keyboard.type("interjection text");
  await session.keyboard.press("Control+Enter");
  await sleep(2000);
  await cap("AFTER-INTERJECT");
  await idle(150_000);
  await cap("AFTER-DRAIN");

  // --- compact (real turn) ---
  await cmd("/compact", 3000);
  await cap("COMPACT-RUNNING");
  await idle(150_000);
  await cap("COMPACT-DONE");

  // --- logout last: expect welcome screen ---
  await cmd("/logout", 2500);
  await cap("LOGOUT");
} catch (e) {
  console.log("ERR:", e.message);
  await cap("FAILURE-STATE");
} finally {
  await session.stop();
  await tc.close();
}
