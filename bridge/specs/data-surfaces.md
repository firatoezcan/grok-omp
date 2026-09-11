# Data surfaces: prompt history, share, memory, scheduled tasks, announcements, follow-ups

Miscellaneous pager data surfaces and what OMP can truthfully back them with.

## Capability

- **Prompt history**: `src/session/history-storage.ts` — `HistoryStorage` keeps per-cwd prompt history (`HistoryEntry`, :7). No ACP method exposes it; the TUI reads it directly.
- **Session share/export**: `session/session-dump-format.ts`, `session-handoff.ts`, foreign-session import/export exist; no ACP share method, no remote share service.
- **Memory**: `session/session-memory.ts` (`SessionMemory` host) + `hindsight/` — internal; no flush/rewrite ACP methods.
- **Scheduled tasks / cron**: none. No scheduler in OMP (`main.ts` has no cron subcommand; only `scheduleMarketplaceAutoUpdate` for plugins).
- **Follow-up suggestions / announcements / recap**: none — these are shell/server-side features.

## Wire

- `x.ai/prompt_history` `{cwd, sessionId?, filterSessionId?}` → `{prompts:[string]}` most-recent-first (`xai-grok-shell/src/extensions/prompt_history.rs:22-50`; pager `effects/mod.rs:1709+`, decodes `result.prompts` or bare `prompts`). Powers up-arrow/Ctrl+R history.
- `x.ai/share_session` `{sessionId,...}` → shared-URL payload (`extensions/share.rs:22-80`; gated on xAI auth + `sharing_enabled` remote setting).
- `x.ai/memory/flush` `{session_id}` → `{flushed:bool}`; `x.ai/memory/rewrite` `{sessionId, rawText, contextSummary}` → `{rewritten}` (`extensions/memory.rs:42-95`; pager `effects/mod.rs:4172`).
- `x.ai/scheduler/delete` `{sessionId, taskId}` → `{taskId, deleted}` (`extensions/task.rs:404-420`; pager `effects/mod.rs:~1820`).
- Notifications: `SessionUpdate::ScheduledTaskCreated{task_id,prompt,human_schedule,next_fire_at}`, `ScheduledTaskFired{+subagent_id?}`, `ScheduledTaskDeleted{task_id,reason}` (`notification.rs:814-835`; handlers `acp_handler/mod.rs:593-595`).
- `x.ai/announcements/update` `{gen, announcements:[RemoteAnnouncement]}` — merges into the pager's announcement rotation (`acp_handler/settings.rs:421-475`).
- `x.ai/follow_ups` `{response_id, suggestions:[{label}], promptId?, _meta?}` — suggestion chips under the last answer (`acp_handler/follow_ups.rs:17-60`).
- `x.ai/recap` — see session-control.md.

## Gap

- `x.ai/prompt_history` → currently `{prompts:[]}` (`adapter.mjs:808-809`). OMP's `HistoryStorage` is on disk under the OMP home dir — the adapter CAN read it directly (same machine): locate OMP's per-cwd history file and return real prompts. If the file layout isn't stable, keep the empty stub; never fabricate.
- `x.ai/share_session` → `-32601` (no share backend; the shell's version uploads to xAI — meaningless for OMP).
- `x.ai/memory/flush`/`rewrite` → `-32601`. OMP's memory is internal; no wire path.
- `x.ai/scheduler/delete` + `scheduled_task_*` → `-32601` / never emitted. OMP has no scheduler; correct.
- `x.ai/announcements/update` → OMP never sends; pager tolerates absence (announcements just stay local/config-driven).
- `x.ai/follow_ups` → OMP never sends; chips simply don't appear. Could synthesize later from OMP's `suggest` machinery — not worth it.

## Render

- History overlay (`views/history_search.rs`) + up-arrow recall — `x.ai/prompt_history`.
- Memory modal (`views/memory_modal.rs`) — flush/rewrite.
- Announcement banner (`views/announcements.rs`).
- Follow-up chips under agent messages.
- Scheduled-task rows in the tasks pane.

## Plan

1. `adapter.mjs` `prompt_history`: replace the stub with a read of OMP's history storage for `params.cwd` (find the exact file via `history-storage.ts`); fall back to `{prompts:[]}` on any error. Honor `filterSessionId` only if the file carries session ids — else ignore it.
2. Add explicit `-32601` cases for `share_session`, `memory/flush`, `memory/rewrite`, `scheduler/delete` with messages naming the missing OMP surface.
3. No notification synthesis — all five notification types stay absent by design.
4. Verify: `x.ai/prompt_history` against a cwd with real OMP history returns non-empty `prompts`.
