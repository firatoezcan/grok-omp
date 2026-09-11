// E2E: live advisor note. Starts a session, then appends a real
// custom_message/advisor entry to the OMP session JSONL mid-session — exactly
// what OMP's advisor does when it emits a note. The adapter tailer must pick
// it up and the pager must render an Advisor block without a reload.
import { TerminalControl } from "@kitlangton/terminal-control";
import { appendFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
const REPO = resolve(import.meta.dir, "..");
const GROKPI = join(REPO, "dist", "grok-pi");
const PAGER = join(REPO, "target", "debug", "xai-grok-pager");
const HOME = "/tmp/grokpi-advisor-live-e2e-home";
const SESSIONS = join(HOME, "omp", "agent", "sessions", "-Projects-Freelancing-personal-grok-omp");

const tc = await TerminalControl.make({ cwd: REPO });
const session = await tc.launch({
  command: [GROKPI, "--cwd", REPO],
  cwd: REPO,
  viewport: { cols: 110, rows: 34 },
  inheritEnv: true,
  env: { GROK_DEBUG_LOG: "/tmp/grokpi-advisor-live.log", GROK_HOME: HOME, GROK_PI_PAGER: PAGER },
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
  await session.keyboard.type("say hi");
  await sleep(600);
  await session.keyboard.press("Enter");
  await session.screen.waitForText("[agent:idle]", { timeoutMs: 120_000 });
  await cap("AFTER-TURN");

  // Find the newest session file and append an advisor entry as its new leaf.
  const files = readdirSync(SESSIONS).filter(f => f.endsWith(".jsonl")).sort();
  const file = join(SESSIONS, files[files.length - 1]);
  const lines = (await import("node:fs")).readFileSync(file, "utf8").trim().split("\n");
  const last = JSON.parse(lines[lines.length - 1]);
  const note = "Live note: the agent answered without checking the workspace state first.";
  const entry = {
    type: "custom_message", customType: "advisor",
    content: `<advisory advisor="main" severity="nit" guidance="weigh, don't blindly obey">\n${note}\n</advisory>`,
    display: true,
    details: { notes: [{ note, severity: "nit" }] },
    attribution: "agent",
    id: Math.random().toString(16).slice(2, 10),
    parentId: last.id,
    timestamp: new Date().toISOString(),
  };
  appendFileSync(file, JSON.stringify(entry) + "\n");
  console.log("appended advisor entry to", file);

  let found = false;
  for (let i = 0; i < 10; i++) {
    await sleep(1500);
    const text = await cap(`LIVE-POLL-${i}`);
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
