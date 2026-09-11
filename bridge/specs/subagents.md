# Subagents & background tasks

Surfacing OMP's `task` tool (subagents) and background work in the pager's Subagent/BgTask blocks and tasks pane.

## Capability

OMP runs subagents through the `task` tool. Over ACP a subagent is **not** a separate session — it is an ordinary `tool_call`/`tool_call_update` pair whose `rawInput` carries `{prompt, agent?, label?, task?}` (`src/task/executor.ts`, `src/task/workpool.ts`; emission via `buildToolCallStartUpdate` in `src/modes/acp/acp-event-mapper.ts:478-505`).

- Lifecycle: `tool_call` (status `pending`/`in_progress`) → `tool_call_update` (status `completed`/`failed`/`cancelled`). No child session id, no per-subagent token/turn counters on the wire.
- Cancellation: there is no per-subagent ACP cancel. `session/cancel` aborts the whole turn (`acp-agent.ts:1072-1113`); subagent aborts happen internally via `AbortSignal` (`task/executor.ts:350-376`, `abortActiveSession` at :1062).
- Steering: OMP supports `hub`-style messaging to live subagents (`task/` workpool, `sendUserMessage`), but none of it crosses ACP.
- Background tasks: OMP's `bash` tool has `async?: boolean` ("run in background", `src/tools/bash.ts:335`) and auto-backgrounding (:1147-1206). Over ACP these surface only as the originating `tool_call` completing; there is no task-id registry, stdout stream, or completion notification on the wire.

## Wire

Pager-side decode sites (`crates/codegen/xai-grok-pager/src`):

- `x.ai/session_notification` / `x.ai/session/update` → `SessionNotification{sessionId, update}` where `update` is internally tagged on `sessionUpdate` with **no catch-all** — unknown variants fail decode and the notification is dropped (`app/acp_handler/session_notification.rs:174+`, enum at `xai-grok-shell/src/extensions/notification.rs:470`).
- `SessionUpdate::SubagentSpawned{subagent_id, parent_session_id, child_session_id, subagent_type, description, context_normalized, capability_mode?, persona?, role?, model?}` — handled at `app/acp_handler/session_notification.rs:459` and `subagent_lifecycle.rs:110`. Creates the Subagent block + registers `child_session_id` for event routing (`app/agent_view/mod.rs:1367`).
- `SessionUpdate::SubagentFinished{subagent_id, child_session_id, status, error?, tool_calls, turns, duration_ms, tokens_used, will_wake, output?}` — `session_notification.rs:756`, `subagent_lifecycle.rs:130`.
- `x.ai/task_backgrounded` (dedicated method, NOT a session/update): `SessionNotification` wrapping `TaskBackgrounded{tool_call_id, task_id, command, cwd, output_file, monitor_description?, description?}` — `app/acp_handler/background.rs:61`, dispatched at `acp_handler/mod.rs:584`.
- `x.ai/task_completed`: `TaskCompleted{task_snapshot: TaskSnapshot, will_wake}` — `background.rs:504`. `TaskSnapshot` = `{task_id, tool_call_id, command, cwd, start_time, end_time, output, output_file, truncated, exit_code, signal, completed, block_waited, explicitly_killed}` (`xai-grok-shell-terminal/src/background_task.rs:16`).
- Requests the pager sends:
  - `x.ai/task/kill` `{sessionId, taskId, source: "clientUi"|"teardown"}` → `{taskId, outcome: KillOutcome}` (`effects/mod.rs:1769`; DTO `xai-grok-shell/src/extensions/task.rs:19-56`).
  - `x.ai/subagent/cancel` `{sessionId, subagentId}` → `{subagentId, cancelled: bool, outcome?: {kind: "cancelled"|"already_finished"{status}|"not_found"}}` (`effects/mod.rs:1802`; DTO `task.rs:74-127`; pager maps via `parse_subagent_kill_outcome`, `effects/helpers.rs:1250`).
  - `x.ai/subagent/message` `{sessionId, agentAddress, queue, content:[ContentBlock]}` → `{kind: "accepted"{messageId}|"rejected"|"not_active"|"unsupported_content"|"limit"|"saturated"|...}` (`subagent_message.rs:15-45`). Defined but **not currently called** by the pager app.
  - `x.ai/subagent/list_running` `{sessionId}` → `{subagents:[{subagentId,parentSessionId,childSessionId,subagentType,description,startedAtEpochMs,durationMs,turnCount,toolCallCount,tokensUsed,contextWindowTokens,contextUsagePct,toolsUsed,errorCount}]}` (`task.rs:130-160`). Not currently called.
  - `x.ai/task/list` `{sessionId}` → `{tasks:[TaskSnapshot]}` (`task.rs:391-401`). Not currently called by the pager app.

## Gap

Adapter state today (`bridge/adapter.mjs`):

- `ExtSurface.subagents` map + `observeToolCallStart`/`observeToolCallEnd` (:670-728) already synthesize `subagent_spawned`/`subagent_finished` inside `_x.ai/session/update` when a `task` tool_call is detected (tool id `task`, bare title, or `{prompt + agent|label|task}` input shape). Ids are synthetic (`omp-task-N`, `sessionId:sub:N`); `tool_calls`, `tokens_used` are 0; `turns` hardcoded 1.
- Missing:
  - `x.ai/subagent/cancel` → currently falls to the default `-32601`. Must answer truthfully: `not_found` for unknown ids; for a live `omp-task-N` there is no ACP way to kill just that subagent — options are (a) answer `already_finished`/`not_found` so the pager finalizes the row itself (honest, leaves the subagent running), or (b) send `session/cancel` and report `cancelled` (kills the whole turn — wrong granularity). Recommend (a) plus a pager-visible note; never fake `cancelled` without a real `subagent_finished` following.
  - `x.ai/task/kill` → no OMP background-task registry over ACP; answer `-32601` (truthful) unless the adapter grows an OMP-side task list.
  - `x.ai/task_backgrounded`/`x.ai/task_completed` synthesis: OMP's `bash {async:true}` completes its `tool_call` immediately with a task handle in `rawOutput`; the adapter could detect that shape and emit `task_backgrounded` + later `task_completed` — but OMP emits no event when the background process exits, so `task_completed` cannot be synthesized truthfully today. Leave BgTask unsupported; document.
  - `subagent_type`: adapter hardcodes `"general-purpose"`; OMP's `rawInput.agent` carries the real agent name — map it through.
  - `tokens_used`/`tool_calls`/`turns`: OMP's `tool_call_update.rawOutput` for `task` carries a result summary (`task/result-summary.ts`); extract counts when present instead of emitting 0/1.

## Render

- `RenderBlock::Subagent` (`scrollback/blocks/subagent.rs`) — Started/Completed/Failed rows; Enter opens the subagent view.
- `RenderBlock::BgTask` (`scrollback/blocks/bg_task.rs`) — background command rows.
- Tasks pane (`app/tasks_pane.rs`) + subagent catalog pane (`app/subagent_catalog_pane.rs`) — populated from `SubagentSpawned`/`TaskBackgrounded` state, not from list RPCs.
- Kill affordances: tasks-pane `[×]` → `x.ai/task/kill`; subagent row kill → `x.ai/subagent/cancel` (`app/actions.rs:1541`, `dispatch/turn.rs:806`).

## Plan

1. `adapter.mjs` `ExtSurface`: map `rawInput.agent` → `subagent_type`; parse `tool_call_update.rawOutput` for OMP's task result summary to fill `tool_calls`, `turns`, `tokens_used` when present (else omit rather than emit 0 — the pager tolerates missing fields better than wrong ones).
2. `adapter.mjs` `answerRequest`: add `case "subagent/cancel"` — look up `this.subagents` by synthetic id; answer `{subagentId, cancelled:false, outcome:{kind:"not_found"}}` for unknown, `{kind:"already_finished", status}` for completed; for live ones answer `not_found` (documented limitation) — never claim `cancelled`.
3. `adapter.mjs`: add `case "task/kill"` → `-32601` explicit error (already the default; add a named case with a clear message so the tape shows intent).
4. Optionally `case "subagent/list_running"` → synthesize `{subagents:[...]}` from the live `this.subagents` map (fields the adapter knows: ids, type, description, startedAt, durationMs; omit counters it can't see).
5. Pager-side (only if BgTask is wanted later): `tracker.rs` would need to treat an OMP `bash{async:true}` tool_call completion as a backgrounding event — defer; OMP gives no exit notification, so a BgTask row would sit "running" forever. Skip.
6. Verify with `bun bridge/adapter.mjs --replay` on a tape containing a `task` tool_call: assert `subagent_spawned`/`subagent_finished` frames and the cancel response shape.
