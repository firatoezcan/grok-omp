#!/usr/bin/env bun
/**
 * Stdio-level verification of the adapter's x.ai/* rail against a stub agent.
 * The stub holds session/prompt open until session/cancel, so the virtual
 * queue can be exercised deterministically.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const REPO = resolve(import.meta.dir, "..");
const ADAPTER = join(REPO, "bridge", "adapter.mjs");
const STUB = "/tmp/stub-agent.mjs";

writeFileSync(STUB, `#!/usr/bin/env bun
// Stub ACP agent: prompt turns hang until session/cancel; emits an
// elicitation/create request when the prompt text is "elicit-form" or
// "elicit-url".
const pending = new Map();
let seq = 0;
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
let buf = "";
process.stdin.on("data", (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.method === "initialize") send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [{ id: "agent", name: "agent" }] } });
    else if (m.method === "authenticate") send({ jsonrpc: "2.0", id: m.id, result: {} });
    else if (m.method === "session/new") send({ jsonrpc: "2.0", id: m.id, result: { sessionId: "stub-sess-1", modes: { currentModeId: "default", availableModes: [{ id: "default" }, { id: "plan" }] } } });
    else if (m.method === "session/prompt") {
      const text = m.params?.prompt?.[0]?.text ?? "";
      if (text === "elicit-form") {
        const eid = "elicit-" + (++seq);
        pending.set(eid, m.id);
        send({ jsonrpc: "2.0", id: eid, method: "elicitation/create", params: { sessionId: m.params.sessionId, message: "Pick one", requestedSchema: { type: "object", properties: { choice: { type: "string", enum: ["alpha", "beta"] } }, required: ["choice"] } } });
      } else if (text === "elicit-url") {
        const eid = "elicit-" + (++seq);
        pending.set(eid, m.id);
        send({ jsonrpc: "2.0", id: eid, method: "elicitation/create", params: { sessionId: m.params.sessionId, message: "Open this", mode: "url", url: "https://example.com/auth", elicitationId: "el-1" } });
      } else if (text === "elicit-plan") {
        const eid = "elicit-" + (++seq);
        pending.set(eid, m.id);
        send({ jsonrpc: "2.0", id: eid, method: "elicitation/create", params: { sessionId: m.params.sessionId, message: "Approve plan to proceed", requestedSchema: { type: "object", properties: { value: { type: "string", enum: ["Approve and execute", "Refine plan"] } }, required: ["value"] } } });
      } else {
        pending.set("prompt-" + m.id, m.id); // held open until cancel
      }
    }
    else if (m.method === "session/cancel") {
      for (const [k, pid] of pending) { send({ jsonrpc: "2.0", id: pid, result: { stopReason: "cancelled" } }); pending.delete(k); }
      send({ jsonrpc: "2.0", id: m.id, result: {} });
    }
    else if (m.id !== undefined && m.method === undefined) {
      // response to our elicitation request
      const pid = pending.get(m.id);
      if (pid) { pending.delete(m.id); send({ jsonrpc: "2.0", id: pid, result: { stopReason: "end_turn" } }); }
    }
    else if (m.method === "session/list") send({ jsonrpc: "2.0", id: m.id, result: { sessions: [] } });
    else if (m.id !== undefined) send({ jsonrpc: "2.0", id: m.id, result: {} });
  }
});
`);

// scratch git repo for worktree ops
const WT = mkdtempSync(join(tmpdir(), "wt-src-"));
execFileSync("git", ["init", "-q"], { cwd: WT });
execFileSync("git", ["-C", WT, "config", "user.email", "t@t"], {});
execFileSync("git", ["-C", WT, "config", "user.name", "t"], {});
writeFileSync(join(WT, "f.txt"), "x");
execFileSync("git", ["-C", WT, "add", "."], {});
execFileSync("git", ["-C", WT, "commit", "-qm", "init"], {});

const proc = spawn("bun", [ADAPTER, "--agent", `bun ${STUB}`, "--quiet"], { stdio: ["pipe", "pipe", "inherit"] });
const out = [];
let buf = "";
proc.stdout.on("data", (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l.trim()) out.push(JSON.parse(l)); }
});
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let id = 0;
const sendReq = (method, params) => proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: `t${++id}`, method, params }) + "\n");
const sendNotif = (method, params) => proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
const respond = (id, result) => proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
const find = (pred, since = 0) => out.slice(since).find(pred);
const findAll = (pred, since = 0) => out.slice(since).filter(pred);
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${name} :: ${detail}`); };

sendReq("initialize", { protocolVersion: 1, clientCapabilities: {} });
await sleep(400);
sendReq("session/new", { cwd: WT, mcpServers: [] });
await sleep(400);
const sid = "stub-sess-1";

// --- virtual queue: prompt 1 runs, prompt 2+3 held ---
sendReq("session/prompt", { sessionId: sid, prompt: [{ type: "text", text: "run1" }] });
await sleep(300);
sendReq("session/prompt", { sessionId: sid, prompt: [{ type: "text", text: "held-A" }] });
sendReq("session/prompt", { sessionId: sid, prompt: [{ type: "text", text: "held-B" }] });
await sleep(300);
let qc = findAll((f) => f.method === "_x.ai/queue/changed");
check("queue holds 2nd+3rd prompt", qc.length >= 3 && JSON.stringify(qc.at(-1).params).includes("held-A") && JSON.stringify(qc.at(-1).params).includes("held-B"), `broadcasts=${qc.length} last=${JSON.stringify(qc.at(-1)?.params)}`);

const heldIds = qc.at(-1).params.entries.map(e => e.id);
// reorder: swap A and B
sendNotif("_x.ai/queue/reorder", { sessionId: sid, orderedIds: [heldIds[1], heldIds[0]] });
await sleep(200);
qc = findAll((f) => f.method === "_x.ai/queue/changed");
check("queue/reorder", qc.at(-1).params.entries[0].text === "held-B", `order=${JSON.stringify(qc.at(-1).params.entries.map(e => e.text))}`);

// edit held-B
sendNotif("_x.ai/queue/hold_edit", { sessionId: sid, id: heldIds[1] });
sendNotif("_x.ai/queue/edit", { sessionId: sid, id: heldIds[1], newText: "held-B-edited" });
sendNotif("_x.ai/queue/release_edit", { sessionId: sid, id: heldIds[1] });
await sleep(200);
qc = findAll((f) => f.method === "_x.ai/queue/changed");
check("queue/edit + hold/release", qc.at(-1).params.entries.some(e => e.text === "held-B-edited"), `entries=${JSON.stringify(qc.at(-1).params.entries.map(e => [e.text, e.version]))}`);

// remove held-A
sendNotif("_x.ai/queue/remove", { sessionId: sid, id: heldIds[0], expectedVersion: 0 });
await sleep(200);
qc = findAll((f) => f.method === "_x.ai/queue/changed");
check("queue/remove", qc.at(-1).params.entries.length === 1 && qc.at(-1).params.entries[0].text === "held-B-edited", `entries=${JSON.stringify(qc.at(-1).params.entries.map(e => e.text))}`);

// interject (request) while running → queued + echo
sendReq("_x.ai/interject", { sessionId: sid, text: "steer-me", interjectionId: "ij-1" });
await sleep(200);
const ijResp = find((f) => f.id && String(f.id).startsWith("t") && f.result?.status === "queued");
const ijEcho = find((f) => f.method === "_x.ai/session/interjection");
check("interject → queued + echo", !!ijResp && ijEcho?.params?.text === "steer-me", `resp=${JSON.stringify(ijResp)} echo=${JSON.stringify(ijEcho?.params)}`);

// btw → -32601
const btwMark = out.length;
sendReq("_x.ai/btw", { sessionId: sid, question: "q" });
await sleep(200);
const btwResp = find((f) => f.error && /btw/.test(f.error.message), btwMark);
check("btw → -32601", btwResp?.error?.code === -32601, JSON.stringify(btwResp?.error));

// queue/interject (send-now): promotes held row, cancels running
sendNotif("_x.ai/queue/interject", { sessionId: sid, id: heldIds[1] });
await sleep(400);
qc = findAll((f) => f.method === "_x.ai/queue/changed");
check("queue/interject promotes row", qc.at(-1).params.entries.length === 0 || qc.at(-1).params.runningText === "held-B-edited", `last=${JSON.stringify(qc.at(-1)?.params)}`);

// queue/clear
sendReq("session/prompt", { sessionId: sid, prompt: [{ type: "text", text: "run2" }] });
await sleep(200);
sendReq("session/prompt", { sessionId: sid, prompt: [{ type: "text", text: "held-C" }] });
await sleep(200);
sendNotif("_x.ai/queue/clear", { sessionId: sid });
await sleep(200);
qc = findAll((f) => f.method === "_x.ai/queue/changed");
check("queue/clear", qc.at(-1).params.entries.length === 0, `entries=${JSON.stringify(qc.at(-1).params.entries)}`);

// --- elicitation bridging ---
for (const [kind, prompt, expectMethod] of [["form", "elicit-form", "_x.ai/ask_user_question"], ["url", "elicit-url", "_x.ai/mcp/elicit"], ["plan", "elicit-plan", "_x.ai/exit_plan_mode"]]) {
  const mark = out.length;
  sendReq("session/prompt", { sessionId: sid, prompt: [{ type: "text", text: prompt }] });
  await sleep(400);
  const bridged = find((f) => f.method === expectMethod, mark);
  if (!bridged) { check(`elicit ${kind} → ${expectMethod}`, false, `frames=${JSON.stringify(out.slice(mark).map(f => f.method ?? f.id))}`); continue; }
  const outcome = kind === "form" ? { outcome: "accepted", answers: { "Pick one": ["alpha"] } } : kind === "url" ? { outcome: "accept", content: { ok: true } } : { outcome: "approved" };
  respond(bridged.id, outcome);
  await sleep(300);
  const settled = find((f) => f.id && String(f.id).startsWith("t") && f.result?.stopReason, mark);
  check(`elicit ${kind} → ${expectMethod}`, !!settled, `bridged params=${JSON.stringify(bridged.params).slice(0, 200)} settled=${!!settled}`);
}

// --- worktree rail (real git ops on scratch repo) ---
const wtMark = out.length;
sendReq("_x.ai/git/worktree/create_from_worktree_sync", { sourceWorktreePath: WT, newSessionId: "wt-e2e", copyMode: "clean", label: "e2e-wt" });
await sleep(1500);
const wtCreate = find((f) => f.id && String(f.id).startsWith("t") && (f.result || f.error), wtMark);
const wtPath = wtCreate?.result?.worktreePath ?? wtCreate?.result?.result?.worktreePath;
check("worktree create", typeof wtPath === "string" && wtPath.includes("e2e-wt"), JSON.stringify(wtCreate?.result ?? wtCreate?.error));

sendReq("_x.ai/git/worktree/list", { cwd: WT });
await sleep(800);
const wtList = findAll((f) => f.id && String(f.id).startsWith("t") && f.result).at(-1);
const wtRows = wtList?.result?.result ?? wtList?.result ?? [];
check("worktree list", Array.isArray(wtRows) && wtRows.some(r => r.path === wtPath), `rows=${JSON.stringify(wtRows).slice(0, 300)}`);

sendReq("_x.ai/git/worktree/resume_session", { sessionId: "sess-x", sourceCwd: WT, copyMode: "clean", worktreeType: "local" });
await sleep(1500);
const wtResume = findAll((f) => f.id && String(f.id).startsWith("t") && (f.result || f.error)).at(-1);
const resumePath = wtResume?.result?.worktreePath ?? wtResume?.result?.result?.worktreePath;
check("worktree resume_session", typeof resumePath === "string" && resumePath.includes("resume-sess-x"), JSON.stringify(wtResume?.result ?? wtResume?.error).slice(0, 300));

for (const p of [wtPath, resumePath].filter(Boolean)) {
  sendReq("_x.ai/git/worktree/remove", { idOrPath: p, path: p });
  await sleep(800);
}
const wtRm = findAll((f) => f.id && String(f.id).startsWith("t") && f.result).slice(-2);
const removedOk = [wtPath, resumePath].filter(Boolean).every(p => { try { execFileSync("git", ["-C", WT, "worktree", "list", "--porcelain"], {}); return !execFileSync("git", ["-C", WT, "worktree", "list", "--porcelain"], {}).toString().includes(p); } catch { return false; } });
check("worktree remove", removedOk, `removed ${wtPath} + ${resumePath}`);

// --- unsupported surfaces → -32601 ---
for (const m of ["session/delete", "session/rename", "rewind/points", "rewind/execute", "recap", "share_session", "memory/flush", "memory/rewrite", "scheduler/delete", "auth/get_url", "auth/submit_code", "auth/cancel", "auth/logout", "auth/check_subscription", "consent/record", "billing", "auto-topup-rule", "announcements/update"]) {
  const mark = out.length;
  sendReq(`_x.ai/${m}`, { sessionId: sid });
  await sleep(120);
  const r = find((f) => f.error, mark);
  check(`${m} → -32601`, r?.error?.code === -32601, r?.error?.message?.slice(0, 110) ?? JSON.stringify(out.slice(mark).map(f => f.id ?? f.method)));
}

// prompt_history + sessions/list + session/search + session/info + session/usage
for (const [m, params, field] of [["prompt_history", { cwd: WT }, "prompts"], ["sessions/list", {}, "sessions"], ["session/search", { query: "x", limit: 5 }, "results"], ["session/info", { sessionId: sid }, "result"], ["session/usage", { sessionId: sid }, "usage"], ["auth/info", {}, "result"], ["commands/list", {}, "commands"], ["workflows/list", {}, "workflows"], ["marketplace/list", {}, "sources"], ["task/list", {}, "result"], ["subagent/list_running", {}, "result"]]) {
  const mark = out.length;
  sendReq(`_x.ai/${m}`, params);
  await sleep(150);
  const r = find((f) => f.id && String(f.id).startsWith("t") && (f.result || f.error), mark);
  const ok = r?.result !== undefined && (field === "result" ? r.result.result !== undefined || r.result !== undefined : r.result[field] !== undefined);
  check(`${m} answers`, ok, JSON.stringify(r?.result ?? r?.error).slice(0, 160));
}

proc.kill();
const fails = results.filter(r => !r.ok);
console.log(`\n${results.length - fails.length}/${results.length} pass`);
process.exit(fails.length ? 1 : 0);
