# Interaction: prompts, queue, interject, permissions, questions, elicitation

How user input flows through OMP-over-ACP vs the pager's queue/interject/btw/question/elicit surfaces.

## Capability

- `session/prompt` runs slash commands: `#runPromptOrCommand` (`src/modes/acp/acp-agent.ts:964-1045`) tries skill invocations (`#tryRunSkillCommand`, :1047) then `executeAcpBuiltinSlashCommand` (builtins like `/compact`, `/model` handled agent-side, output via `agent_message_chunk`/command output), else a normal model turn. `available_commands_update` carries the slash catalog.
- Prompt concurrency: prompts serialize per session via `#queuePrompt` (:895). A `session/prompt` arriving **while a turn streams implicitly cancels the running turn** then queues behind abort cleanup (:826-848) — there is no server-side prompt queue and no mid-turn steer over ACP.
- Steering exists inside OMP (`AgentSession.steer`/`followUp`, `session/agent-session.ts:6782,6801`; `streamingBehavior:"steer"` for extension messages) but is unreachable over ACP.
- Permissions: `session/request_permission` for `bash|edit|delete|move` only, fixed options `allow_once/allow_always/reject_once/reject_always` (`session/acp-permission-gate.ts:8-19`; bridge `modes/acp/acp-client-bridge.ts:114-143`).
- User questions: OMP's `ask` tool (`tools/ask.ts`) and plan approval go through **standard ACP `elicit/create` (form mode)** when the client advertises `elicitation.form` (`acp-agent.ts:290-430`, `createAcpExtensionUiContext`); otherwise auto-approve/undefined.
- MCP: OMP answers server→client `ping`/`roots/list` only (`mcp/manager.ts:903-915`); no elicitation relay.

## Wire

Pager sends (client→agent):

- `x.ai/interject` `{sessionId, text, interjectionId?, content?:[ContentBlock]}` → `{status:"queued"}` (`xai-grok-shell/src/extensions/interject.rs:14-55`; pager `actions.rs:1961`). Broadcast back to all panes as `x.ai/session/interjection` `{sessionId,text,interjectionId}` (`acp_handler/mod.rs:591,617+`).
- `x.ai/btw` `{sessionId, question}` → `{answer}` (`btw.rs:14-45`; pager `actions.rs:1947`). Renders as `RenderBlock::Btw`.
- `x.ai/queue/*` — **notifications** (fire-and-forget, no response): `remove{sessionId,id,expectedVersion}`, `reorder{sessionId,orderedIds}`, `clear{sessionId}`, `edit{...}`, `interject{sessionId,newText}`, `hold_edit{id}`, `release_edit{id}` (`effects/mod.rs:1476-1560`; shell mapping `agent/mvp_agent/tests.rs:5004-5117`). Truth broadcast: `x.ai/queue/changed` `{sessionId, entries:[{id,version,owner?,lastEditor?,kind,text,combinedTexts?,position}], runningPromptId?, runningText?, runningKind?, runningCombedTexts?}` (`xai-prompt-queue/src/types.rs:30-80`; handler `acp_handler/queue.rs:99+`).
- `x.ai/ask_user_question` — agent→client **request**: `{sessionId, toolCallId, questions:[Question], mode:"default"|"plan"}` → `{outcome:"accepted"{answers:{qid:[labels]},annotations?}|"chat_about_this"{partialAnswers}|"skip_interview"{partialAnswers}|"cancelled"}` (`xai-grok-tools/.../ask_user_question/types.rs:51-110`; pager `acp_handler/interactions.rs:88+`).
- `x.ai/mcp/elicit` — agent→client request, see extensions.md.
- Standard `session/request_permission` — pager renders permission view (`app/permission_view.rs`, `acp_handler/permissions.rs`).

## Gap

- **Prompt queue**: the pager's queue pane is server-authoritative — it sends `x.ai/queue/*` mutations and repaints only on `x.ai/queue/changed`. OMP has no queue over ACP; a second `session/prompt` mid-turn *cancels* the running turn. Adapter options:
  1. Synthesize a virtual queue: hold `session/prompt` requests that arrive while a turn is in flight (track via prompt request/response + `session/cancel`), answer `x.ai/queue/*` against the held list, and emit `_x.ai/queue/changed` snapshots. On turn end, release the next held prompt. This makes "type-ahead queueing" work instead of destroying the running turn — **the single highest-value interaction fix**.
  2. `x.ai/interject` → enqueue into the same virtual queue and answer `{status:"queued"}`; emit `_x.ai/session/interjection` echo so the pane paints it (pager dedups self-originated via `interjectionId`). True mid-turn steer is impossible — the interjection lands as the next prompt.
  3. `x.ai/queue/interject` (send-now) → flush: send `session/cancel` then immediately the held prompt (matches OMP's implicit-cancel semantics).
- **btw**: no OMP equivalent (side question without disturbing the turn). Options: `-32601`, or spawn a throwaway `session/new`+`session/prompt`+`session/close` against OMP with the question — expensive but truthful. Recommend error first; note the Btw block exists if implemented later.
- **ask_user_question**: OMP's `ask` tool emits standard `elicit/create`, which the pager cannot decode (`xai-acp-lib` `AcpClientMessage` has no `ElicitationRequest` variant → method_not_found). Adapter can bridge: intercept OMP's `_session/elicitation` (wire name for `elicit/create`) requests, translate `{message, requestedSchema.properties.value.enum...}` into `_x.ai/ask_user_question` `{sessionId, toolCallId, questions:[{question, options}], mode:"default"}`, and map `accepted{answers}` back to `{action:"accept", content:{value:...}}`. Shape mismatch is real (OMP form schema is arbitrary JSON-schema; ask_user_question is fixed Question/Option) — feasible for `select`/`confirm` (enum/boolean properties), degrade `input`/`editor` to a single freeform question or return cancel.
- **request_permission**: works as-is (standard ACP); verify the pager's permission view handles OMP's four option ids.
- **mcp/elicit**: OMP never emits it; only relevant if the adapter bridges `elicit/create` for MCP-originated elicitations (OMP doesn't relay those at all today).

## Render

- Queue pane (`app/queue_pane.rs`, `agent_view/queue.rs`) — driven solely by `x.ai/queue/changed`.
- `RenderBlock::Btw` (`scrollback/blocks/btw.rs`) — side Q&A.
- Question view (`views/question_view.rs`) — `x.ai/ask_user_question` card.
- Elicitation view (`views/elicitation_view/`) — `x.ai/mcp/elicit` form/url cards.
- Permission view (`app/permission_view.rs`) — `session/request_permission`.
- Interjection renders as `RenderBlock::interjection_prompt` (UserPrompt variant).

## Plan

1. `adapter.mjs` `ExtSurface`: add `promptQueue` state — `held: [{id, params}]`, `runningPromptId`. In `runLive` toAgent pump: when `session/prompt` arrives while `running`, hold it (don't forward), push `_x.ai/queue/changed` with the held entries; on prompt response or `session/cancel` settle, release FIFO.
2. Answer `x.ai/interject` by appending to the held queue + `{status:"queued"}` + emit `_x.ai/session/interjection` echo with the client's `interjectionId`.
3. Answer `x.ai/queue/{remove,reorder,clear,edit,hold_edit,release_edit}` notifications against the held list; rebroadcast `queue/changed` after each. `queue/interject` → `session/cancel` + promote.
4. Intercept agent→client `_session/elicitation` requests: translate select/confirm forms to `_x.ai/ask_user_question`; map the response back to `elicit/create`'s `{action,content}`. Fall through (forward verbatim → method_not_found) for shapes that don't map.
5. `x.ai/btw` → `-32601` with a clear message (documented non-goal until a cheap side-channel exists).
6. Verify: tape/live run — send two `session/prompt`s back-to-back; assert the second queues (queue/changed broadcast) instead of cancelling turn 1.
