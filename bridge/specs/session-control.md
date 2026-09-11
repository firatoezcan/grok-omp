# Session control: compact, rewind, plan mode, recap

OMP's compaction/checkpoint/plan-mode features vs the pager's session-control rail.

## Capability

- **Compaction**: `/compact` builtin with modes `soft|remote|snapcompact` (`src/session/compact-modes.ts:15-60`); runs through `executeAcpBuiltinSlashCommand` when sent as a `session/prompt` text (`acp-agent.ts:964-1000`). Auto-compaction exists internally (`auto_compaction_start/end` hook events, `extensibility/hooks/types.ts:388-404`) but emits **no** `SessionUpdate` variants over ACP.
- **Rewind/checkpoint**: `checkpoint` and `rewind` are *model tools* (`src/tools/checkpoint.ts:53,89` — git-based snapshot + restore), plus `session/checkpoint-entries.ts` persistence. There is no client-driven "rewind to prompt N" ACP method; rewind is agent-initiated via the tool.
- **Plan mode**: real mode. `setSessionMode{modeId:"plan"}` supported (`acp-agent.ts:763-772`, `ACP_PLAN_MODE_ID` :96); modes advertised in `session/new` `modes` + `config_option_update`. Plan approval: OMP calls `unstable_createElicitation` (form) for the approve/refine choice, auto-approves when the client lacks `elicitation.form` (`acp-agent.ts:1873-1920`, :2013-2030).
- **Recap/memory flush**: no OMP equivalent over ACP (session-memory is internal, `session/session-memory.ts`).

## Wire

- `x.ai/compact_conversation` `{sessionId, userContext?}` → `{}` (`effects/mod.rs:1699`; shell `extensions/memory.rs:15-40`).
- `x.ai/rewind/points` `{sessionId}` → `{rewind_points:[{prompt_index, created_at, num_file_snapshots, has_file_changes, prompt_preview?}]}` (`xai-grok-shell/src/session/acp_types.rs:383-398`; handler `extensions/rewind.rs:54-95`).
- `x.ai/rewind/execute` `{sessionId, targetPromptIndex?|targetResponseId?, force?, mode?}` → rewind result (`rewind.rs:25-50,65-90`). `targetResponseId` is chat-only.
- `x.ai/toggle_plan_mode` `{sessionId}` — **notification**, fire-and-forget (`effects/mod.rs:1466`).
- `x.ai/exit_plan_mode` — agent→client **request** `{sessionId, toolCallId, planContent?}` → `{outcome:"approved"|"cancelled"|"abandoned", feedback?}` (`xai-grok-tools/.../exit_plan_mode/types.rs:11-25`; pager `acp_handler/interactions.rs:216+` → `PlanApprovalViewState`).
- `x.ai/restore_code` — not a method: a `_meta` flag on `session/load` (`effects/helpers.rs:303-306`, `effects/mod.rs:478-480`).
- `x.ai/recap` `{sessionId, auto?}` → `{ok:true}` ack; the recap arrives later as `SessionUpdate::SessionRecap{summary,auto}` or `SessionRecapUnavailable` (`extensions/recap.rs:20-50`; `notification.rs`).
- Standard: `session/set_mode` `{sessionId, modeId}` → OMP implements; emits `current_mode_update` + `config_option_update` (`acp-agent.ts:763-772`).

## Gap

- `x.ai/compact_conversation` → translate to `session/prompt` with text `/compact` (optionally `userContext` appended as focus text — OMP's `/compact` accepts a focus arg, `compact-modes.ts:65`). Response maps to `{}`. Caveat: a prompt is a full turn — the pager's compact button expects a command, not a queued user message; acceptable since OMP's `/compact` is exactly that.
- `x.ai/rewind/points` → OMP has no per-prompt-index rewind. Honest options: `-32601`, or `{rewind_points:[]}` (pager shows empty picker). Recommend error — an empty list implies "no points" rather than "unsupported". Keep error.
- `x.ai/rewind/execute` → `-32601`. OMP's rewind is tool-driven; a client-side equivalent would be `session/load` of a checkpointed state — not exposed. Document as unsupported.
- `x.ai/toggle_plan_mode` → translate to `session/set_mode` `{modeId: current=="plan" ? <default-mode> : "plan"}` (track current mode from `config_option_update`/`current_mode_update` — adapter already captures `modeConfig`, `adapter.mjs:494`). It's a notification: fire the request, no response needed; emit nothing extra (OMP's own `current_mode_update` will arrive).
- `x.ai/exit_plan_mode` → OMP emits `elicit/create` for plan approval, not this method. Bridge: when in plan mode, translate OMP's plan-approval `elicit/create` into `_x.ai/exit_plan_mode` `{sessionId, toolCallId, planContent}` and map `{outcome:"approved"}` → elicitation accept, `cancelled`/`abandoned` → cancel/decline. Requires recognizing the plan-approval elicitation (message/schema shape) — fragile; alternative is pager-side support for standard `session/elicitation`. Recommend the adapter bridge with a narrow matcher on OMP's known approval schema.
- `x.ai/restore_code` meta on `session/load` → OMP ignores unknown `_meta`; harmless pass-through, no-op.
- `x.ai/recap` → `-32601` (OMP has no recap generator over ACP). Pager gates the feature on `session_recap_available` from initialize meta — ensure the adapter does NOT advertise it.
- `AutoCompact*` notifications: OMP doesn't emit them; the pager's compaction spinner phases simply never appear. Optional: synthesize `auto_compact_started/completed` around a `/compact` prompt turn so the UI shows progress — nice-to-have, mark `_meta` replay-safe.

## Render

- Rewind picker (`views/rewind.rs`, `app/rewind.rs`).
- Plan approval view (`views/plan_approval_view.rs`) — `x.ai/exit_plan_mode`.
- `RenderBlock::System`/`SessionEvent` — compact/recap result lines.
- Mode indicator in status bar — `current_mode_update` (already works via OMP).

## Plan

1. `adapter.mjs`: `case "compact_conversation"` → forward as `session/prompt` `{prompt:[{type:"text",text:"/compact"+(userContext?` ${userContext}`:"")}]}`; translate any result to `{}`.
2. `case "toggle_plan_mode"` (notification, no id) → emit `session/set_mode` with the opposite of tracked `modeConfig.currentValue` (default "build"/first non-plan option).
3. `rewind/points`, `rewind/execute`, `recap` → explicit `-32601` cases with clear messages.
4. Plan-approval bridge (larger piece): in the toClient pump, detect OMP `elicit/create` requests whose schema matches the plan-approval shape; re-emit as `_x.ai/exit_plan_mode` and translate the response. Behind a flag until proven on a live tape.
5. Verify: `/compact` via the pager button produces a real compaction turn; plan-mode toggle flips the status-bar mode.
