# Vibe mode

Surfacing OMP's `/vibe` director mode — persistent `fast`/`good` worker sessions driven by `vibe_spawn`/`vibe_send`/`vibe_wait`/`vibe_kill`/`vibe_list` — in the pager's Subagent blocks and tasks pane.

## Capability

**DRIVING is implemented** via a patched OMP build (see "Drive path" below). `session/set_mode`/`set_config_option{configId:"mode"}` accept `"vibe"`; the session's toolset switches to `read` + `todo` + the five vibe tools and `current_mode_update` fires. Stock OMP remains observe-only.

Vibe mode is a **TUI-only director mode** in stock OMP. `/vibe` (`src/slash-commands/builtin-modes.ts:233-250`) has only `handleTui` — no text-mode `handle` — so `executeAcpBuiltinSlashCommand` returns `false` for it (`acp-builtins.ts:66`) and the command is neither advertised (`acp-builtins.ts:37-38` filters handle-less specs) nor dispatched; a `/vibe` prompt goes to the model as literal text. Stock `session/set_mode` offers only `default` + `plan` (`acp-agent.ts:1831-1842`; `#applyModeChange` throws on anything else, :1848-1851). Nothing outside `InteractiveMode` calls `activateVibeTools` (`interactive-mode.ts:4381-4443`), even though `createVibeTools` is wired into every top-level session including ACP ones (`sdk.ts:3774-3777`, `agent-session-types.ts:204-205`).

## Drive path (implemented)

Patch applied to the OMP source clone (`~/Projects/Freelancing/personal/oh-my-pi`, v18.1.17, **uncommitted** — separate repo), `packages/coding-agent/src/modes/acp/acp-agent.ts`:

- `ACP_VIBE_MODE_ID = "vibe"`; `#getAvailableModes` always lists `{id:"vibe", name:"Vibe"}`; `#getCurrentModeId` returns `"vibe"` when `session.getVibeModeState()?.enabled`.
- `#applyModeChange(record, modeId)` is now async and takes the `ManagedSessionRecord`. Vibe arm → `#enterAcpVibeMode` (mirrors `InteractiveMode.#enterVibeMode`: `VibeSessionRegistry.global().activateScope(ownerScope)` → `activateVibeTools(["read", "todo"?])` → `setVibeModeState({enabled:true})` → `sendVibeModeContext` if streaming → `sessionManager.appendModeChange("vibe", {previousTools})`). Leaving vibe for `default`/`plan` → `#exitAcpVibeMode` (mirrors `#exitVibeMode`: `runModeExitTeardown` → abort if streaming → `killAll` → `deactivateVibeTools(previousTools)` → `setVibeModeState(undefined)`). Mutual exclusion: entering vibe while plan is active throws; entering plan while vibe is active exits vibe first. `#disposeSessionRecord` tears down vibe so workers can't outlive a closed session.
- `#vibeParentSession(session)` mirrors `InteractiveMode.#vibeParentSession` (agent id, session id/file, sessionManager, asyncJobManager, settings, active model string). `vibeModePreviousTools`/`vibeModeOwnerScope` live on `ManagedSessionRecord`.

Build: `cd ~/Projects/Freelancing/personal/oh-my-pi && bun install && cp ~/.bun/install/global/node_modules/@oh-my-pi/pi-natives-darwin-arm64/pi_natives.darwin-arm64.node packages/natives/native/ && bun --cwd packages/coding-agent run build` → `packages/coding-agent/dist/omp` (needs the prebuilt `pi_natives` addon copied in, or `bun --cwd packages/natives run build` for a from-source build).

Enable: `grok-pi.mjs` resolves the OMP command as `OMP_ACP_CMD` (verbatim) → `GROK_PI_OMP_CMD` (binary or full command line) → patched build at `~/Projects/Freelancing/personal/oh-my-pi/packages/coding-agent/dist/omp` or `$GROK_HOME/omp-build/omp` → stock `omp`. With the clone's `dist/omp` present, vibe driving is on by default; `GROK_PI_OMP_CMD=omp` forces stock.

Verified: stdio ACP exchange against `dist/omp` — `session/new` lists `default,plan,vibe`; `session/set_mode vibe` → `current_mode_update:"vibe"`; `set_config_option{configId:"mode",value:"vibe"}` → same; back to `default` exits cleanly; session JSONL records `mode_change:"vibe"` with the 14-tool `previousTools` snapshot.

When active (TUI), the director's toolset is cut to `read` + optional `todo` + the five vibe tools (`interactive-mode.ts:4413-4420`; tool defs `src/tools/vibe.ts:50-289`), and a hidden `vibe-mode-context` custom message (`display:false`) is injected (`agent-session.ts:5946-5954`, `messages.ts:49`).

Workers are real in-process subagent sessions, not ACP sessions:

- `vibe_spawn {cli:"fast"|"good", name?, prompt}` → `VibeSessionRegistry.spawn` (`vibe/runtime.ts:843-928`). `cli` maps to bundled agents `fast→sonic`, `good→task` (`runtime.ts:56-59`). The worker gets a real child session file `<parent-stem>/<id>.jsonl` (`:868-871`), an AgentRegistry `kind:"sub"` ref, and an AsyncJobManager `"task"` job `vibe <cli> <id>: <msg>` (`:1406-1451`) running `runSubprocess` (first turn) / `runSubagentFollowUpTurn` (later turns, `:1426-1438`).
- `vibe_send` steers a streaming worker, queues mid-turn, or starts a new background turn (`runtime.ts:935-967`). `vibe_wait` blocks with hub-wait semantics and emits live `details.screens` snapshots on an interval (`tools/vibe.ts:172-183`; `VibeScreenSnapshot` = `{id, cli, state, model, turns, queued, currentTool, trace, outputTail, lastActivity}` at `runtime.ts:171-191`). `vibe_kill`/`vibe_list` terminate/roster (`tools/vibe.ts:222-278`).
- Turn results self-deliver into the director as `custom_message` `customType:"async-result"` follow-ups (`async-job-delivery.ts:23,116-120`; rendered `<vibe-turn>` text, `runtime.ts:1506-1575`), which re-wake the director's loop.
- Lifecycle is persisted to the **parent** session JSONL as `type:"custom"`, `customType:"vibe-session-lifecycle"` entries (`vibe/lifecycle.ts:15-55`): `spawn` (carries `id`, `cli`, `agent`, `childSessionFile`), `turn-started`, `turn-settled`, `tombstone` (`explicit-kill|mode-exit|spawn-failed|unrecoverable`), `tombstone-revoked`. Appended via `sessionManager.appendCustomEntry` (`runtime.ts:414-435`, `session-manager.ts:2465-2468`). Mode entry/exit lands as `mode_change` entries (`interactive-mode.ts:4432`, `session-manager.ts:2377`).

Over ACP today, a running vibe session shows only:

- `vibe_*` `tool_call`/`tool_call_update` pairs on the director session — ordinary tool calls, kind `other` (`acp-event-mapper.ts:211`). `vibe_spawn` returns immediately with `rawOutput.details.spawned = {id, cli, jobId}` and `details.screens` (`tools/vibe.ts:117-120`); `vibe_wait` streams `in_progress` updates carrying live `details.screens`.
- The director's follow-up turns after each worker settles — but **not the delivered result text**: `mapAssistantMessageEnd`/`mapAssistantMessageUpdate` drop non-assistant messages (`acp-event-mapper.ts:306,380`), so `async-result` custom messages never cross the wire live, and replay drops them too (string `content` isn't handled by `#extractReplayContent` — same gap as advisor notes, `adapter.mjs:801-808`).
- Nothing per-worker: no child `session/update`, no spawn/finish notification, no token/turn counters. Worker events go to `subagentEventBus` (`runtime.ts:1436`), which the ACP agent never subscribes; the ACP event subscription is prompt-scoped (`acp-agent.ts:1417-1477`) plus a lifetime listener that only forwards model/thinking changes (`:2103-2107`, `#handleLifetimeEvent` :1365-1368).
- `vibe_spawn`'s `approval:"exec"` does NOT trigger `session/request_permission` — the gate covers only `bash|edit|delete|move` (`acp-permission-gate.ts:7-12`).

## Wire

Pager-side decode sites (`crates/codegen/xai-grok-pager/src`):

- `x.ai/session/update` → `SessionUpdate` enum with **no catch-all** (`xai-grok-shell/src/extensions/notification.rs:470`): `SubagentSpawned` (:668-715), `SubagentProgress` (:718-743 — `turn_count`, `tool_call_count`, `tokens_used`, `context_usage_pct`, `tools_used` are required numerics), `SubagentFinished` (:747-776 — `status`, `tool_calls`, `turns`, `duration_ms`, `tokens_used`, `output`, `will_wake`).
- Spawn/finish create the Subagent block, register `subagent_sessions`/`subagent_views` keyed by `child_session_id`, and route later `session/update`s for that id into the child view (`session_notification.rs:459-741`, `subagent_lifecycle.rs:110+`, `agent_view/mod.rs:1366-1375`).
- `is_task_tool` suppression (`acp/tracker.rs:2512-2516`) covers `task`/`Task`/`spawn_subagent` only — `vibe_*` calls render as ordinary tool rows, so the director's control plane (incl. live `screens` inside `vibe_wait` updates) is already visible without any synthesis.
- Requests the pager sends: `x.ai/subagent/cancel`, `x.ai/subagent/message` (defined, unused), `x.ai/subagent/list_running`, `x.ai/task/kill`, `x.ai/task/list` — see subagents.md Wire.
- Mode surface: `session/set_mode` (`app/actions.rs:1687-1690`) + `current_mode_update` handling exists for plan (`session_notification.rs:1687` `detect_plan_mode_change`); there is no generic mode badge a synthesized `"vibe"` mode id would light up — unknown mode ids are inert.

## Gap

Adapter state today (`bridge/adapter.mjs`):

- `observeToolCallStart` (:1268-1280) does **not** misfire on `vibe_spawn`: its input is `{cli, name?, prompt}` — no `agent`/`label`/`task`/`description` field — and its title is `vibe_spawn`, not `task`. Vibe calls currently pass through as plain tool rows; no `subagent_*` synthesis exists for them.
- `AdvisorTailer` (:811-915) already tails the parent session JSONL (`findOmpSessionFile`, :485-507) but only matches `type:"custom_message", customType:"advisor"` (:896). Vibe lifecycle entries are `type:"custom"` (not `custom_message`) and `async-result` deliveries are `custom_message` with `customType:"async-result"` — both currently ignored.
- `x.ai/subagent/cancel` answers `not_found`/`already_finished` from the `subagents`/`finishedSubagents` maps (:1812-1824); `subagent/list_running` lists only task-tool subagents (:1825-1845); `subagent/message` and `task/kill` are explicit errors (:1846-1849).

Missing for vibe:

- ~~**Entry point (blocker).**~~ **RESOLVED** — see "Drive path" above. The patched `acp-agent.ts` adds a `"vibe"` arm to `#getAvailableModes`/`#applyModeChange` running the `#enterVibeMode`/`#exitVibeMode` equivalent against `AgentSession` primitives (`activateVibeTools` :5289, `deactivateVibeTools` :5294, `setVibeModeState` :5617, `getVibeModeState` :5613, `VibeSessionRegistry.ownerScope/activateScope/killAll` `runtime.ts:361-377,1131+`).
- **Spawn/finish synthesis.** `vibe_spawn` tool_call → `subagent_spawned`: the real worker id arrives in the terminal update's `rawOutput.details.spawned.id` (and `details.screens`), so the adapter can emit with the real id rather than a synthetic `omp-task-N` — either keyed on the toolCallId until completion, or emitted at completion (small delay, truthful). `subagent_type` should be `vibe-fast`/`vibe-good` (or the resolved agent name `sonic`/`task` from `details.spawned.cli`).
- **Progress.** `vibe_wait` `in_progress` updates carry `details.screens[]` → map each screen to `subagent_progress` (`turns`→`turn_count`, `trace.length`→`tool_call_count` — note trace is capped at 40, `runtime.ts:72`; `tokens_used`/`context_*` unavailable → 0). Screens also appear in every vibe tool result, so roster state can be maintained without JSONL.
- **Finish.** `turn-settled` is NOT a finish — the worker stays alive for `vibe_send`. Only `tombstone` (or mode-exit) is terminal → `subagent_finished` with status from `reason` (`explicit-kill`/`mode-exit`→`cancelled`, `spawn-failed`/`unrecoverable`→`failed`). Tombstones are only in the parent JSONL → requires extending the tailer to `type:"custom"` entries. A `vibe_kill` tool_call completing is a wire-visible proxy (`rawInput.session` = worker id).
- **Result text.** Delivered `<vibe-turn>` results live in `async-result` custom messages — invisible live and on replay. Tail `customType:"async-result"` entries (advisor pattern) → synthesize `user_message_chunk`, or attach the text to `subagent_finished.output`/`subagent_progress` output. `vibe_wait` results also carry `resultText` per settled session in content text.
- **Child transcript.** Unlike `task` subagents, vibe workers have real session files (`<id>.jsonl` siblings). The pager routes `session/update`s for a registered `child_session_id` into `subagent_views` — the adapter could tail the child JSONL and synthesize child frames so Enter-on-Subagent shows the worker's actual transcript. Larger piece; phase 2.
- **Control.** `x.ai/subagent/cancel`/`subagent/message` for vibe workers: no control channel exists (vibe_kill/vibe_send are model tools, not API). Answer `not_found`/`already_finished` honestly — same posture as task subagents (subagents.md Gap).
- **Mode chrome.** `vibe-mode-context` is `display:false` and never emitted; `mode_change` JSONL entries mark entry/exit. A synthesized `current_mode_update:"vibe"` is inert in the pager today — needs a pager-side banner/chip if wanted.

## Render

- `RenderBlock::Subagent` (`scrollback/blocks/subagent.rs`) + tasks pane (`app/tasks_pane.rs`) + subagent catalog (`views/subagent_catalog_pane.rs`) — populated from `SubagentSpawned`/`SubagentFinished`; a vibe worker maps cleanly onto one row that stays "running" across turns until tombstone.
- `vibe_*` tool calls render as ordinary tool rows today (not suppressed by `is_task_tool`); `vibe_wait` rows carry live screen JSON in `rawOutput`.
- Subagent fullscreen (`subagent_views`, opened via Enter) is empty for OMP unless the adapter synthesizes child-session updates — viable for vibe via `<id>.jsonl` tailing, unlike `task` subagents which have no per-child file contract surfaced.
- No vibe-specific surface exists or is needed for v1; a mode banner is optional pager work.

## Plan

1. ~~**OMP-side prerequisite (driving):**~~ **DONE** — see "Drive path" above.
2. `adapter.mjs`: detect `vibe_spawn` tool_calls (toolName/title `vibe_spawn` or `rawInput` `{cli, prompt}` shape) → `subagent_spawned` using `details.spawned.id` as `subagent_id`/`child_session_id` (real worker id = agent id = JSONL basename; stable across turns, matches `history://<id>`), `subagent_type` from `cli`, `description` from `rawInput.prompt`.
3. `adapter.mjs`: on `vibe_wait`/`vibe_*` updates carrying `details.screens`, emit `subagent_progress` per live screen; on `vibe_kill` completion emit `subagent_finished` `cancelled` for `rawInput.session`.
4. `adapter.mjs`: generalize `AdvisorTailer` into a session-file tailer that also matches `type:"custom", customType:"vibe-session-lifecycle"` (spawn→spawned if missed, turn-settled→progress, tombstone→finished) and `customType:"async-result"` (→ `user_message_chunk` so delivered worker results are visible). Keep the `seen` dedupe; lifecycle entries are the durable roster across resume.
5. `adapter.mjs`: include live vibe workers in `subagent/list_running`; keep `subagent/cancel`/`message` honest (`not_found`/`already_finished`, `-32601`) — no control channel exists.
6. Phase 2 (optional): tail worker `<id>.jsonl` files → synthesize child `session/update` frames so the subagent fullscreen view shows real worker transcripts; add a pager vibe-mode banner if a mode signal is wanted.
7. Verify: `bun bridge/adapter.mjs --replay` on a tape with `vibe_spawn`/`vibe_wait` frames → assert `subagent_spawned`/`subagent_progress`/`subagent_finished`; live e2e (`pager-subagent-e2e.mjs` pattern) only after the OMP entry point lands.
