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
  env: { GROK_DEBUG_LOG: "/tmp/verify.log", GROK_HOME: HOME, GROK_PI_PAGER: PAGER },
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
  await cap("WELCOME");
  await session.keyboard.type("hi");
  await session.keyboard.press("Enter");
  await idle();
  await cap("IDLE-AFTER-HI");

  // --- session admin + data surfaces (no model turn needed) ---
  await cmd("/rename e2e-sweep-name", 1800); await cap("RENAME");            // x.ai/session/rename
  await cmd("/history", 1800); await cap("HISTORY"); await esc();           // x.ai/prompt_history
  await cmd("/dashboard", 2200); await cap("DASHBOARD"); await esc();       // x.ai/sessions/list roster
  await cmd("/session-info", 1800); await cap("SESSION-INFO"); await esc(); // x.ai/session/info
  await cmd("/rewind", 1800); await cap("REWIND"); await esc();             // x.ai/rewind/points
  await cmd("/recap", 1800); await cap("RECAP");                            // x.ai/recap
  await cmd("/share", 1800); await cap("SHARE");                            // x.ai/share_session
  await cmd("/remember e2e sweep note", 1800); await cap("REMEMBER");       // x.ai/memory/rewrite
  await cmd("/btw what is 2+2", 1800); await cap("BTW");                    // x.ai/btw
  await cmd("/delete", 1500); await cap("DELETE"); await esc();             // x.ai/session/delete (confirm?)
  await cmd("/logout", 1800); await cap("LOGOUT");                          // x.ai/auth/logout
  await cmd("/login", 1800); await cap("LOGIN"); await esc();               // auth flow

  // --- queue mutations during a running turn ---
  await session.keyboard.type("count from 1 to 60 slowly, one number per second");
  await session.keyboard.press("Enter");
  await sleep(3000); // turn running
  await session.keyboard.type("queued alpha"); await session.keyboard.press("Enter"); await sleep(700);
  await session.keyboard.type("queued beta"); await session.keyboard.press("Enter"); await sleep(700);
  await session.keyboard.type("queued gamma"); await session.keyboard.press("Enter"); await sleep(1200);
  await cap("QUEUE-3-HELD");
  await cmd("/queue", 1200); await cap("QUEUE-PANE");
  // reorder: select top row, J to swap down
  await session.keyboard.press("J"); await sleep(800); await cap("QUEUE-AFTER-J");
  // edit row: e opens editor, type, Enter saves (queue/edit + hold/release)
  await session.keyboard.press("e"); await sleep(600); await cap("QUEUE-EDIT-OPEN");
  await session.keyboard.type(" edited"); await session.keyboard.press("Enter"); await sleep(900);
  await cap("QUEUE-AFTER-EDIT");
  // delete a row: x
  await session.keyboard.press("x"); await sleep(900); await cap("QUEUE-AFTER-X");
  await esc(); await esc();

  // --- interject during running turn (Ctrl+Enter / Ctrl+I) ---
  await session.keyboard.type("interjection text");
  await session.keyboard.press("Control+Enter"); await sleep(1500);
  await cap("AFTER-INTERJECT");
  await idle(120_000);
  await cap("AFTER-QUEUE-DRAIN");

  // --- compact (real turn) ---
  await cmd("/compact", 3000); await cap("COMPACT-RUNNING");
  await idle(120_000); await cap("COMPACT-DONE");
} catch (e) {
  console.log("ERR:", e.message);
  await cap("FAILURE-STATE");
} finally {
  await session.stop();
  await tc.close();
}
