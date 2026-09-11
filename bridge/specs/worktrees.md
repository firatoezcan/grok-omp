# Worktrees

Pager worktree management (`x.ai/git/worktree/*`, welcome "New worktree" flow) vs OMP's isolation-only worktrees.

## Capability

- OMP has **no session-level worktree management**. `src/task/worktree.ts` implements worktrees solely as *subagent isolation* (`IsolationBackend`, `captureBaseline`, `captureDeltaPatch`, `applyNestedPatches` — :39-490): a `task` subagent can run in a throwaway worktree and have its diff applied back. Nothing is exposed over ACP, and there is no "open this session in a worktree" concept.
- `tools/bash-worktree-rewrite.ts` rewrites bash commands for isolation; `tools/gh-pr-checkout.ts` touches worktrees for PR checkout. Neither is a management API.
- The adapter runs on the same machine as the repo — it can execute `git worktree` itself; nothing about worktree ops needs OMP.

## Wire

Pager call sites (`app/worktree_session.rs`, `app/effects/mod.rs:340-470`):

- `x.ai/git/worktree/create_from_worktree_sync` `{sourceWorktreePath, newSessionId, copyMode:"clean"|"dirty", label?, gitRef?}` → `{worktreePath, sourceGitRoot?}` (response unwrapped via `ext_result`: `error` member = failure, `result` or bare = payload; `worktreePath` required, `worktree_session.rs:160-176`). Used by welcome "New worktree" + `Action::NewWorktreeSession`; the pager then issues `session/new` with `cwd=session_cwd` (subdir offset preserved via `sourceGitRoot`).
- `x.ai/git/worktree/resume_session` `{sessionId, sourceCwd, copyMode, worktreeType, restoreCode?, gitRef?}` → `{worktreePath, effectiveCwd?, sessionId?, codeRestored?, restoreSummary?, restoreDegree?, ...}` (`worktree_session.rs:118-204`). Resume-into-worktree path.
- Shell also serves `x.ai/git/worktree/{create,create_from_worktree,remove,apply,list,show,gc,status,salvage,detach,db/{stats,rebuild,path}}` and `x.ai/session/resolve_local_for_worktree_resume` (`xai-grok-shell/src/extensions/worktree.rs:153-240,388`). `CreateWorktreeResponse` is `{status:"creating"|"exists", sessionId, worktreePath, commit?, sourceGitRoot?}` (`xai-grok-workspace-types/src/rpc/worktree.rs:193-216`) — the async `creating` variant spawns a background copy + later notification.
- `x.ai/git/*` (status/diffs/stage/commit/branches/...) — a whole git rail exists (`extensions/git.rs`); the pager's git surfaces use it, but it's beyond the worktree scope.

## Gap

- All `x.ai/git/worktree/*` → `-32601` today. Welcome "New worktree" fails with an RPC error.
- **Recommendation: implement local-git in the adapter**, not honest-empty. Rationale: the operation is pure `git worktree add` + optional dirty-file copy — the adapter has full local fs/git access and needs nothing from OMP. Honest-empty would disable a core pager flow for zero correctness gain. The truthfulness rule is about not fabricating *OMP state*; worktree creation is real local work the adapter can actually perform.
- Minimal set for the welcome flow:
  - `create_from_worktree_sync`: `git -C <sourceGitRoot> worktree add <path> <gitRef|HEAD>`; `copyMode:"dirty"` additionally copies dirty/untracked files (bounded: skip `.git`, node_modules-scale dirs — mirror OMP's `captureUntrackedPatch` size cap idea, `task/worktree.ts:127`). Answer `{worktreePath, sourceGitRoot}`.
  - `resume_session`: create the worktree the same way, then answer `{worktreePath, effectiveCwd, sessionId}` — the pager follows with `session/load`/`session/new` itself. `restoreCode` maps to OMP's checkpoint/rewind tooling only loosely; answer `codeRestored:false` honestly.
  - `worktree/list`: `git worktree list --porcelain` → rows; `worktree/remove`: `git worktree remove`; `worktree/show`, `gc`, `status`, `salvage`, `detach`, `db/*`: `-32601` until a pager surface needs them.
- `x.ai/git/*` status/diff rail: OMP has no ACP git surface; the adapter could shell out to `git` for `status`/`branches`/`current_commit` if the pager's git panel matters — separate spec if wanted.

## Render

- New-worktree dialog (`views/new_worktree_dialog.rs`) + welcome entry — `Action::NewWorktreeSession` → `Effect::CreateWorktreeSession`.
- Worktree rows/badges in the session picker (`worktreeLabel`, `sessionKind:"worktree"`) and dashboard (`is_worktree` on `RosterEntry`).
- Restore summary lines after resume (`code_restored`, `restore_summary` → `TaskResult::WorktreeForked`).

## Plan

1. `adapter.mjs`: add a `worktree` section to `ExtSurface.answerRequest`. Resolve `sourceGitRoot` via `git -C <sourceWorktreePath> rev-parse --show-toplevel`.
2. `create_from_worktree_sync`: pick `<repo-parent>/../<label|newSessionId>` (or `.grok-worktrees/`-style sibling dir — match the shell's convention if one is discoverable, else `<repo>.worktrees/<label>`), `git worktree add`, dirty-copy when `copyMode=="dirty"`, answer `{worktreePath, sourceGitRoot}`.
3. `resume_session`: same creation, then `{worktreePath, effectiveCwd: worktreePath + subdir-offset, sessionId, codeRestored:false}`.
4. `worktree/list` → parse `git worktree list --porcelain`; `worktree/remove` → `git worktree remove --force` only when the pager explicitly asks.
5. Everything else under `x.ai/git/worktree/*` and `x.ai/git/*` → `-32601`.
6. Verify: welcome → New worktree → session opens with `cwd` inside the new worktree; `session/list` rows show `worktreeLabel` when the adapter stamps it (see sessions.md — map `cwd` under a known worktree root to `worktreeLabel`/`sessionKind:"worktree"`).
