# Sessions: list, resume, fork, search, delete, rename

OMP session persistence vs the pager's session picker, dashboard roster, and session admin methods.

## Capability

- Storage: JSONL session files under a per-cwd dir; `SessionManager.list(cwd)` / `listAll()` return `SessionInfo{path,id,cwd,title?,parentSessionPath?,created,modified,messageCount,size,firstMessage,allMessagesText,status?}` (`src/session/session-listing.ts:26-46`).
- ACP surface (`src/modes/acp/acp-agent.ts`): `session/list` (:714-729, cursor-paged, `SESSION_PAGE_SIZE`), `session/load` (:702), `session/resume` (:731), `unstable_session/fork` (:742-751), `session/close`. Advertised in `agentCapabilities.sessionCapabilities{list,fork,resume,close}` (:657-668).
- `session/list` response rows: `{sessionId, cwd, title?, updatedAt, _meta:{messageCount,size}}` (`#toSessionInfo`, acp-agent.ts:~2280). **No `summary`, `firstPrompt`, `createdAt`, `source`, `modelId`, `branch`, `sessionKind`.**
- Fork: `unstable_forkSession({sessionId, cwd, mcpServers?})` → `{sessionId, configOptions, modes}`; refuses while a prompt is in flight (:1396+).
- Rename/delete exist internally (`SessionManager.setSessionName`, `deleteSessionWithArtifacts`, `session-manager.ts:1496,1857,2594`) but **no ACP method** exposes them.
- Extra OMP ext methods the pager never calls: `_omp/sessions/listAll`, `_omp/projects/list`, `_omp/chats/byCwd` (`acp-agent.ts:1132-1185`).
- On load/resume/fork OMP replays history as `session/update` notifications (`#replaySessionHistory`, :2267+) and emits `session_info_update{title,updatedAt}` at end of turn (:2183-2189).

## Wire

- `x.ai/session/list` — params `{cwd?, limit?, query?, headless?, cursor?, _meta["x.ai/facetFilters"].kind?}`; response `{sessions:[...], _meta["x.ai/partial"]?, _meta["x.ai/listScope"]?}`. Row fields the pager reads (`app/effects/session_list.rs:110-284`): `sessionId|session_id`, `summary`, `firstPrompt|first_prompt`, `updatedAt` (**required for non-chat rows — missing or >30d old drops the row**), `createdAt`, `cwd`, `hostname`, `source` (`"local"|"remote"|"conversation"`), `modelId`, `numMessages`, `lastActiveAt`, `branch`, `worktreeLabel`, `lastTurnSummary`, `lastRecap`, `sessionKind`, `_meta["x.ai/session"].kind=="chat"` marks conversation rows. Rows with empty `summary`+`firstPrompt` are dropped unless `source=="conversation"` (:272-283).
- `x.ai/session/search` `{query, limit, includeContent, headless}` → `{results:[SearchSessionHit{session_id,cwd,summary,updated_at,score,matched_fields,snippet?}], bootstrapping?}` (`effects/mod.rs:4630`; `xai-grok-shell/src/extensions/session_search.rs:64-75`). Pager retries while `bootstrapping` is true.
- `x.ai/session/delete` `{sessionId, cwd, kind?}` → `{success:true}` or `{error}` (`effects/mod.rs:3541`; shell `session_admin.rs:442+`).
- `x.ai/session/rename` `{sessionId, title, cwd?, kind?, resetToAuto?}` → `{success:true}` (`effects/mod.rs:5125`; `session_admin.rs:83-93`). `resetToAuto` requires empty title.
- `x.ai/session/fork` — pager sends `{sourceSessionId, sourceCwd, newCwd, sessionKind:"fork", newSessionId?, sourceWorkspaceDir?}` (`app/session_startup.rs:78-100`) and reads `newSessionId` from the bare body or `result.newSessionId` (`session_startup.rs:146-166`; call at `effects/mod.rs:4717`).
- `x.ai/sessions/list` `{}` → `{sessions:[RosterEntry{session_id,title?,cwd,is_worktree,model_id?,reasoning_effort?,yolo,activity,last_turn_summary?,resident,last_change_unix_ms,origin}]}` — envelope-tolerant decode (`app/roster.rs:60-80`; shell DTO `agent/roster.rs:48-79`). `x.ai/sessions/changed` broadcast `{upserted:[RosterEntry], removed:[sessionId]}` (`acp_handler/settings.rs:402+`).
- `x.ai/session/info` — see usage-cost.md (enveloped `SessionInfoResponse`).

## Gap

Adapter today (`adapter.mjs:827-838`):

- `x.ai/session/list` → forwarded as `session/list`, translate `{sessions: r?.sessions ?? r ?? []}`. **Two live bugs:**
  1. OMP rows lack `summary`/`firstPrompt` → the pager drops every row as "no usable prompt" (session_list.rs:272-283). Translate must map `title→summary` and `title→firstPrompt` (or `_meta.messageCount>0` fallback), `title` is also fine for `lastTurnSummary`-less rows.
  2. Pager params (`query`, `limit`, `headless`, facet filters) are dropped on forward — OMP ignores unknown params, but `query` filtering then happens nowhere: either filter adapter-side on `title`/`firstMessage` (OMP `SessionInfo` has `allMessagesText` only via `listAll` internals — not exposed), or accept unfiltered results.
- `x.ai/session/fork` → forwarded verbatim as `session/fork`. **Param mismatch:** pager sends `sourceSessionId`/`newCwd`; OMP wants `sessionId`/`cwd`. Rewrite params: `{sessionId: p.sourceSessionId, cwd: p.newCwd ?? p.sourceCwd}`; translate OMP's `{sessionId}` → `{newSessionId}`.
- `x.ai/session/search` → `{results:[]}` stub. Could be honest-ish: forward to `session/list` (no query support) then substring-filter `title` adapter-side into `SearchSessionHit` shape. Cheap win for the picker's deep search.
- `x.ai/session/delete` / `x.ai/session/rename` → `-32601` today. OMP has the capability internally but not over ACP; the adapter could shell out to `omp` CLI if a delete/rename subcommand exists, else keep the error (truthful). Do NOT fake `{success:true}`.
- `x.ai/sessions/list` (roster) → `-32601` today. Synthesizable: live session from `this.session` + `session/list` for dormant rows → `RosterEntry{session_id,title,cwd,is_worktree:false,activity:"dormant"|"working",resident,last_change_unix_ms,origin:"local"}`. Feeds the FleetView dashboard.
- `x.ai/sessions/changed` → synthesize on session/new + session/close observations if roster is implemented.

## Render

- Session picker (`views/session_picker.rs`, `session_picker_surface.rs`) — `/resume`, dashboard inactive rows.
- FleetView dashboard (`views/dashboard/`) — `x.ai/sessions/list` + `sessions/changed`.
- `/rename`, `/delete`, fork flow (`app/dispatch/session/modal.rs`, `dispatch/session/fork.rs`).

## Plan

1. `adapter.mjs` `session/list` translate: map each OMP row to `{sessionId, summary: title ?? firstLine, firstPrompt: title, updatedAt, createdAt: updatedAt, cwd, source:"local", numMessages: _meta.messageCount}`; apply `query`/`limit` adapter-side before responding.
2. `session/fork`: add `rewriteParams` `{sessionId: params.sourceSessionId, cwd: params.newCwd ?? params.sourceCwd}` and translate `{sessionId} → {newSessionId}`.
3. `session/search`: forward to `session/list`, filter by `query` against title, emit `SearchSessionHit[]` (`session_id`, `cwd`, `summary`, `updated_at`, `score:1`, `matched_fields:["title"]`).
4. `sessions/list`: synthesize roster from live session + `session/list` result (cache the last list response in `ExtSurface`); emit `sessions/changed` on `session/new` result and process exit.
5. Keep `session/delete`/`session/rename` as `-32601` unless an `omp` CLI verb is confirmed; if added, implement via CLI subprocess, never fake success.
6. Verify: tape with `session/list` response → picker rows visible (summary non-empty, updatedAt present).
