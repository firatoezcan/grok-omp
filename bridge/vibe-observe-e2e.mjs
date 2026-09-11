#!/usr/bin/env bun
/**
 * Stdio-level verification of vibe-mode observe-only synthesis:
 *   - vibe_spawn tool_call → subagent_spawned with the REAL worker id
 *   - vibe_wait in_progress details.screens → subagent_progress
 *   - parent-JSONL vibe-session-lifecycle entries → spawn/turn progress/tombstone finish
 *   - parent-JSONL async-result custom_message → interjection user_message_chunk
 *   - worker <id>.jsonl tail → child session/update frames (subagent_views)
 *   - subagent/cancel + subagent/message stay honest for vibe workers
 */
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "..");
const ADAPTER = join(REPO, "bridge", "adapter.mjs");
const STUB = "/tmp/stub-vibe-agent.mjs";
const SID = "stub-sess-1";

// Fake OMP session store: <agentDir>/sessions/<cwd-dir>/<stem>_<sid>.jsonl
const AGENT_DIR = mkdtempSync(join(tmpdir(), "omp-vibe-"));
const SESS_DIR = join(AGENT_DIR, "sessions", "e2e");
mkdirSync(SESS_DIR, { recursive: true });
const PARENT_FILE = join(SESS_DIR, `2026-09-11T00-00-00-000Z_${SID}.jsonl`);
writeFileSync(PARENT_FILE, JSON.stringify({ type: "session", version: 3, id: SID, timestamp: "2026-09-11T00:00:00.000Z", cwd: "/tmp" }) + "\n");
const lifecycle = (id, data) =>
	appendFileSync(PARENT_FILE, JSON.stringify({ type: "custom", customType: "vibe-session-lifecycle", data: { version: 1, id, ownerId: "main", parentSessionId: SID, ...data }, id: `lc-${data.action}-${id}-${data.turn ?? 0}`, timestamp: new Date().toISOString() }) + "\n");
const asyncResult = (text, jobs) =>
	appendFileSync(PARENT_FILE, JSON.stringify({ type: "custom_message", customType: "async-result", content: text, display: true, details: { jobs }, id: `ar-${++asyncResult.n}`, timestamp: new Date().toISOString() }) + "\n");
asyncResult.n = 0;

writeFileSync(STUB, `#!/usr/bin/env bun
// Stub ACP agent emitting vibe_* tool_call frames like a /vibe director.
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const upd = (sessionId, update) => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });
const screen = (state, extra = {}) => ({ id: "w1", cli: "fast", state, turns: 1, queued: 0, trace: ["read(a.ts)", "grep(foo)"], outputTail: ["working…"], lastActivity: "grep foo", lastActivityAt: Date.now(), ...extra });
let buf = "";
process.stdin.on("data", (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.method === "initialize") send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
    else if (m.method === "session/new") send({ jsonrpc: "2.0", id: m.id, result: { sessionId: "${SID}", modes: { currentModeId: "default", availableModes: [{ id: "default" }] } } });
    else if (m.method === "session/prompt") {
      const sessionId = m.params?.sessionId;
      // vibe_spawn tool_call → completed with details.spawned + screens
      upd(sessionId, { sessionUpdate: "tool_call", toolCallId: "tc-spawn", title: "vibe_spawn", kind: "other", status: "in_progress", rawInput: { cli: "fast", prompt: "audit the adapter" } });
      setTimeout(() => {
        upd(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "tc-spawn", status: "completed", rawOutput: { content: [{ type: "text", text: "Spawned fast session w1" }], details: { op: "spawn", spawned: { id: "w1", cli: "fast", jobId: "w1-t1" }, screens: [screen("running")] } } });
      }, 100);
      // vibe_wait in_progress update streaming screens
      setTimeout(() => {
        upd(sessionId, { sessionUpdate: "tool_call", toolCallId: "tc-wait", title: "vibe_wait", kind: "other", status: "in_progress", rawInput: { sessions: ["w1"], timeout: 5 } });
        upd(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "tc-wait", status: "in_progress", rawOutput: { details: { op: "wait", screens: [screen("running", { turns: 1 })], wait: { settled: [], stillRunning: ["w1"], timedOut: false, waiting: true } } } });
      }, 250);
      setTimeout(() => {
        upd(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "tc-wait", status: "completed", rawOutput: { content: [{ type: "text", text: "## w1 — completed" }], details: { op: "wait", screens: [screen("idle")], wait: { settled: [{ id: "w1", jobId: "w1-t1", status: "completed" }], stillRunning: [], timedOut: false } } } });
        send({ jsonrpc: "2.0", id: m.id, result: { stopReason: "end_turn" } });
      }, 500);
    }
    else if (m.method === "session/cancel") { if (m.id !== undefined) send({ jsonrpc: "2.0", id: m.id, result: {} }); }
    else if (m.id !== undefined) send({ jsonrpc: "2.0", id: m.id, result: {} });
  }
});
`);

const proc = spawn("bun", [ADAPTER, "--agent", `bun ${STUB}`, "--quiet"], {
	stdio: ["pipe", "pipe", "inherit"],
	env: { ...process.env, PI_CODING_AGENT_DIR: AGENT_DIR },
});
const out = [];
let buf = "";
proc.stdout.on("data", (c) => {
	buf += c;
	let i;
	while ((i = buf.indexOf("\n")) >= 0) {
		const line = buf.slice(0, i); buf = buf.slice(i + 1);
		if (line.trim()) out.push(JSON.parse(line));
	}
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sendReq = (method, params) => proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: `t${++sendReq.id}`, method, params }) + "\n");
sendReq.id = 0;
const findAll = (pred, since = 0) => out.slice(since).filter(pred);
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"} ${name} :: ${detail}`); };

sendReq("initialize", { protocolVersion: 1, clientCapabilities: {} });
await sleep(300);
sendReq("session/new", { cwd: "/tmp", mcpServers: [] });
await sleep(500); // tailer attaches + finds the parent file

const mark = out.length;
sendReq("session/prompt", { sessionId: SID, prompt: [{ type: "text", text: "vibe-demo" }] });
await sleep(300);

// Worker transcript lands as <parent-stem>/w1.jsonl — the tailer picks it up
// once the lifecycle spawn entry (below) registers the child watch.
const CHILD_FILE = join(SESS_DIR, `2026-09-11T00-00-00-000Z_${SID}`, "w1.jsonl");
mkdirSync(join(SESS_DIR, `2026-09-11T00-00-00-000Z_${SID}`), { recursive: true });
writeFileSync(CHILD_FILE, [
	JSON.stringify({ type: "session", version: 3, id: "w1", timestamp: "2026-09-11T00:00:01.000Z", cwd: "/tmp" }),
	JSON.stringify({ type: "message", id: "m1", timestamp: "2026-09-11T00:00:01.100Z", message: { role: "user", content: [{ type: "text", text: "audit the adapter" }] } }),
	JSON.stringify({ type: "message", id: "m2", timestamp: "2026-09-11T00:00:02.000Z", message: { role: "assistant", content: [{ type: "thinking", thinking: "checking files" }, { type: "toolCall", id: "call_1", name: "read", arguments: { path: "a.ts" }, intent: "Reading a.ts" }] } }),
	JSON.stringify({ type: "custom", customType: "tool_execution_start", data: { toolCallId: "call_1", toolName: "read", startedAt: "2026-09-11T00:00:02.050Z", args: { path: "a.ts" } }, id: "c1", timestamp: "2026-09-11T00:00:02.050Z" }),
	JSON.stringify({ type: "message", id: "m3", timestamp: "2026-09-11T00:00:02.500Z", message: { role: "toolResult", toolCallId: "call_1", toolName: "read", content: [{ type: "text", text: "file body" }], isError: false } }),
	JSON.stringify({ type: "message", id: "m4", timestamp: "2026-09-11T00:00:03.000Z", message: { role: "assistant", content: [{ type: "text", text: "audit complete: clean" }] } }),
].join("\n") + "\n");

// Lifecycle entries: spawn (durable roster), turn-settled (progress), then the
// delivered async-result, then tombstone (authoritative finish).
lifecycle("w1", { action: "spawn", cli: "fast", agent: "sonic", childSessionFile: "w1.jsonl", createdAt: Date.now() });
await sleep(600);
lifecycle("w1", { action: "turn-settled", turn: 1 });
asyncResult(`<system-notice>\nBackground job w1-t1 has completed. Resume your work using the result below.\n<vibe-turn session="w1" cli="fast" turn="1" status="completed">\n<response>\naudit complete: clean\n</response>\n</vibe-turn>\n</system-notice>`, [{ jobId: "w1-t1", type: "task", label: "vibe fast w1" }]);
await sleep(900);

const spawned = findAll((f) => f.params?.update?.sessionUpdate === "subagent_spawned" && f.params?.update?.subagent_id === "w1", mark);
check("vibe_spawn → subagent_spawned with real worker id", spawned.length >= 1, `count=${spawned.length} first=${JSON.stringify(spawned[0]?.params?.update).slice(0, 260)}`);
check("subagent_spawned dedup (wire + lifecycle)", spawned.length === 1, `count=${spawned.length}`);
check("subagent_type/description from spawn", spawned[0]?.params?.update?.subagent_type === "vibe-fast" && spawned[0]?.params?.update?.description === "audit the adapter", JSON.stringify(spawned[0]?.params?.update?.subagent_type));

const progress = findAll((f) => f.params?.update?.sessionUpdate === "subagent_progress" && f.params?.update?.subagent_id === "w1", mark);
check("vibe_wait screens → subagent_progress", progress.length >= 1, `count=${progress.length} last=${JSON.stringify(progress.at(-1)?.params?.update).slice(0, 260)}`);
check("progress carries turn/tool counts", progress.at(-1)?.params?.update?.turn_count >= 1, `turns=${progress.at(-1)?.params?.update?.turn_count} tools=${progress.at(-1)?.params?.update?.tool_call_count}`);
check("progress carries parent_session_id (pager schema requires it)", progress.every((f) => f.params?.update?.parent_session_id === SID), `missing=${progress.filter((f) => f.params?.update?.parent_session_id !== SID).length}/${progress.length}`);

const interjection = findAll((f) => f.params?.update?.sessionUpdate === "user_message_chunk" && f.params?.update?._meta?.interjection === true, mark);
check("async-result → interjection user_message_chunk", interjection.length === 1 && interjection[0].params.update.content.text.includes("audit complete: clean"), `count=${interjection.length} text=${interjection[0]?.params?.update?.content?.text?.slice(0, 120)}`);

// Child transcript frames routed by sessionId = worker id.
const childUser = findAll((f) => f.method === "session/update" && f.params?.sessionId === "w1" && f.params?.update?.sessionUpdate === "user_message_chunk", mark);
const childTool = findAll((f) => f.method === "session/update" && f.params?.sessionId === "w1" && f.params?.update?.sessionUpdate === "tool_call", mark);
const childToolEnd = findAll((f) => f.method === "session/update" && f.params?.sessionId === "w1" && f.params?.update?.sessionUpdate === "tool_call_update", mark);
const childAgent = findAll((f) => f.method === "session/update" && f.params?.sessionId === "w1" && f.params?.update?.sessionUpdate === "agent_message_chunk", mark);
check("worker transcript → child user_message_chunk", childUser.length === 1 && childUser[0].params.update.content.text === "audit the adapter", `count=${childUser.length}`);
check("worker transcript → child tool_call (deduped vs tool_execution_start)", childTool.length === 1 && childTool[0].params.update.title === "Reading a.ts" && childTool[0].params.update.kind === "read", `count=${childTool.length} title=${childTool[0]?.params?.update?.title}`);
check("worker transcript → child tool_call_update completed", childToolEnd.length === 1 && childToolEnd[0].params.update.status === "completed", `count=${childToolEnd.length}`);
check("worker transcript → child agent_message_chunk", childAgent.length === 1 && childAgent[0].params.update.content.text === "audit complete: clean", `count=${childAgent.length}`);

// list_running includes the live worker.
sendReq("_x.ai/subagent/list_running", { sessionId: SID });
await sleep(300);
const listResp = findAll((f) => f.id && String(f.id).startsWith("t") && f.result?.result?.subagents, mark).at(-1);
check("subagent/list_running includes vibe worker", listResp?.result?.result?.subagents?.some((s) => s.subagentId === "w1" && s.subagentType === "vibe-fast"), JSON.stringify(listResp?.result?.result?.subagents).slice(0, 300));

// cancel/message stay honest for a live vibe worker.
sendReq("_x.ai/subagent/cancel", { sessionId: SID, subagentId: "w1" });
sendReq("_x.ai/subagent/message", { sessionId: SID, subagentId: "w1", text: "hi" });
await sleep(300);
const cancelResp = findAll((f) => f.id && String(f.id).startsWith("t") && f.result?.result?.outcome, mark).at(-1);
const msgResp = findAll((f) => f.id && String(f.id).startsWith("t") && f.error, mark).at(-1);
check("subagent/cancel live vibe worker → not_found", cancelResp?.result?.result?.outcome?.kind === "not_found" && cancelResp?.result?.result?.cancelled === false, JSON.stringify(cancelResp?.result));
check("subagent/message → -32601 honest", msgResp?.error?.code === -32601, JSON.stringify(msgResp?.error));
lifecycle("w1", { action: "tombstone", reason: "explicit-kill" });
await sleep(700);
const finished = findAll((f) => f.params?.update?.sessionUpdate === "subagent_finished" && f.params?.update?.subagent_id === "w1", mark);
check("tombstone → subagent_finished cancelled", finished.length === 1 && finished[0].params.update.status === "cancelled" && finished[0].params.update.output === "audit complete: clean", `count=${finished.length} u=${JSON.stringify(finished[0]?.params?.update).slice(0, 300)}`);

sendReq("_x.ai/subagent/cancel", { sessionId: SID, subagentId: "w1" });
await sleep(300);
const cancelResp2 = findAll((f) => f.id && String(f.id).startsWith("t") && f.result?.result?.outcome, mark).at(-1);
check("subagent/cancel finished vibe worker → already_finished", cancelResp2?.result?.result?.outcome?.kind === "already_finished", JSON.stringify(cancelResp2?.result));

proc.kill();
const fails = results.filter((r) => !r.ok);
console.log(`\n${results.length - fails.length}/${results.length} pass`);
process.exit(fails.length ? 1 : 0);
