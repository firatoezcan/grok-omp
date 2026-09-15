#!/usr/bin/env bash
# Fork-drift gate.
#
# SPEC.md §6 is the contract: our fork may differ from upstream ONLY on the hook
# files listed there, plus paths that are ours outright. This script fails the
# moment that stops being true, so drift shows up as a red CI job instead of a
# surprise during an upstream sync.
#
# Usage:
#   scripts/check-drift.sh              # compare against upstream/main
#   UPSTREAM_REF=upstream/main scripts/check-drift.sh
set -euo pipefail

UPSTREAM_REF="${UPSTREAM_REF:-upstream/main}"
MAX_HOOK_LINES="${MAX_HOOK_LINES:-80}"

# Upstream files we are permitted to modify in place. Keep in sync with SPEC.md §6.
# These are the surgical hooks from the original transport design; they carry the
# line budget below so a hook cannot quietly grow into a rewrite.
HOOK_FILES=(
  crates/codegen/xai-grok-pager/src/acp/mod.rs
  crates/codegen/xai-grok-pager/src/app/startup_failure/render.rs
  crates/codegen/xai-grok-pager/src/app/mod.rs
  crates/codegen/xai-grok-pager/src/app/cli.rs
)

# Upstream files the OMP feature surface modifies in place (SPEC.md §6, table B).
# Name-allowlisted only — no line budget: these carry real feature diffs, not
# surgical hooks. Adding a file here must be mirrored in SPEC.md §6.
PATCH_FILES=(
  .gitignore
  README.md
  crates/codegen/xai-grok-pager/src/acp/meta.rs
  crates/codegen/xai-grok-pager/src/acp/tracker.rs
  crates/codegen/xai-grok-pager/src/app/acp_handler/mod.rs
  crates/codegen/xai-grok-pager/src/app/acp_handler/queue.rs
  crates/codegen/xai-grok-pager/src/app/acp_handler/session_notification.rs
  crates/codegen/xai-grok-pager/src/app/acp_handler/tests/session_routing.rs
  crates/codegen/xai-grok-pager/src/app/actions.rs
  crates/codegen/xai-grok-pager/src/app/agent_view/mod.rs
  crates/codegen/xai-grok-pager/src/app/agent_view/plan.rs
  crates/codegen/xai-grok-pager/src/app/agent_view/queue.rs
  crates/codegen/xai-grok-pager/src/app/agent_view/render.rs
  crates/codegen/xai-grok-pager/src/app/agent_view/session.rs
  crates/codegen/xai-grok-pager/src/app/app_view.rs
  crates/codegen/xai-grok-pager/src/app/app_view_tests.rs
  crates/codegen/xai-grok-pager/src/app/dispatch/dashboard.rs
  crates/codegen/xai-grok-pager/src/app/dispatch/interject.rs
  crates/codegen/xai-grok-pager/src/app/dispatch/mod.rs
  crates/codegen/xai-grok-pager/src/app/dispatch/modes.rs
  crates/codegen/xai-grok-pager/src/app/dispatch/notes.rs
  crates/codegen/xai-grok-pager/src/app/dispatch/prompt.rs
  crates/codegen/xai-grok-pager/src/app/dispatch/queue.rs
  crates/codegen/xai-grok-pager/src/app/dispatch/router.rs
  crates/codegen/xai-grok-pager/src/app/dispatch/session/fork.rs
  crates/codegen/xai-grok-pager/src/app/dispatch/session/lifecycle.rs
  crates/codegen/xai-grok-pager/src/app/dispatch/session/load.rs
  crates/codegen/xai-grok-pager/src/app/dispatch/settings/setters.rs
  crates/codegen/xai-grok-pager/src/app/dispatch/settings/ui.rs
  crates/codegen/xai-grok-pager/src/app/dispatch/task_result.rs
  crates/codegen/xai-grok-pager/src/app/dispatch/tests/mod.rs
  crates/codegen/xai-grok-pager/src/app/dispatch/tests/router.rs
  crates/codegen/xai-grok-pager/src/app/dispatch/tests/settings.rs
  crates/codegen/xai-grok-pager/src/app/dispatch/voice.rs
  crates/codegen/xai-grok-pager/src/app/effects/helpers.rs
  crates/codegen/xai-grok-pager/src/app/effects/mod.rs
  crates/codegen/xai-grok-pager/src/app/effects/session_list.rs
  crates/codegen/xai-grok-pager/src/app/event_loop.rs
  crates/codegen/xai-grok-pager/src/app/modals.rs
  crates/codegen/xai-grok-pager/src/app/status_blocks.rs
  crates/codegen/xai-grok-pager/src/minimal/api.rs
  crates/codegen/xai-grok-pager/src/scrollback/block.rs
  crates/codegen/xai-grok-pager/src/scrollback/blocks/mod.rs
  crates/codegen/xai-grok-pager/src/settings/defs.rs
  crates/codegen/xai-grok-pager/src/settings/mod.rs
  crates/codegen/xai-grok-pager/src/settings/registry.rs
  crates/codegen/xai-grok-pager/src/slash/commands/mod.rs
  crates/codegen/xai-grok-pager/src/slash/mod.rs
  crates/codegen/xai-grok-pager/src/slash/registry.rs
  crates/codegen/xai-grok-pager/src/views/dashboard/peek.rs
  crates/codegen/xai-grok-pager/src/views/modal.rs
  crates/codegen/xai-grok-pager/src/views/prompt_widget/mod.rs
  crates/codegen/xai-grok-pager/src/views/settings_modal/input.rs
  crates/codegen/xai-grok-pager/src/views/settings_modal/mod.rs
  crates/codegen/xai-grok-pager/src/views/settings_modal/render.rs
  crates/codegen/xai-grok-pager/src/views/settings_modal/state.rs
  crates/codegen/xai-grok-pager/src/views/settings_modal/tests.rs
  crates/codegen/xai-grok-pager/tests/registered_features_are_documented.rs
  crates/codegen/xai-grok-pager/tests/settings_e2e.rs
  crates/codegen/xai-grok-shared/src/ui_config.rs
  crates/codegen/xai-grok-shell/src/session/acp_session_impl/session_mode.rs
  crates/codegen/xai-grok-shell/src/session/acp_session_tests/tool_layer_images_bridge_tests.rs
  crates/codegen/xai-grok-shell/src/session/slash_commands.rs
  crates/codegen/xai-grok-shell/src/util/config/persist.rs
  crates/codegen/xai-grok-shell/src/util/config/persist_tests.rs
  crates/codegen/xai-grok-shell/src/util/config/settings_writes.rs
  crates/codegen/xai-grok-tools/src/types/session_mode.rs
)

# Files we own outright even though they sit inside an upstream directory:
# upstream will never create these paths, so they cannot conflict on a merge and
# they do not count against the hook line budget.
OWNED_FILES=(
  crates/codegen/xai-grok-pager/src/acp/external.rs
  crates/codegen/xai-grok-pager/src/app/space_hold.rs
  crates/codegen/xai-grok-pager/src/scrollback/blocks/advisor.rs
  crates/codegen/xai-grok-pager/src/slash/commands/vibe.rs
  crates/codegen/xai-grok-telemetry/src/startup.rs
  docs/GROK-PI.md
)

# Paths that are ours outright. Upstream can never collide with them, so they
# never conflict on a merge and never count against the line budget.
OWNED_PREFIXES=(
  SPEC.md
  scripts/
  config/
  bridge/
  tapes/
  .github/
)

if ! git rev-parse --verify --quiet "$UPSTREAM_REF" >/dev/null; then
  echo "check-drift: '$UPSTREAM_REF' not found." >&2
  echo "  git remote add upstream https://github.com/xai-org/grok-build && git fetch upstream" >&2
  exit 2
fi

is_owned() {
  local p="$1" pre
  for pre in "${OWNED_PREFIXES[@]}"; do [[ "$p" == "$pre"* ]] && return 0; done
  return 1
}

is_hook() {
  local p="$1" f
  for f in "${HOOK_FILES[@]}"; do [[ "$p" == "$f" ]] && return 0; done
  return 1
}

is_owned_file() {
  local p="$1" f
  for f in "${OWNED_FILES[@]}"; do [[ "$p" == "$f" ]] && return 0; done
  return 1
}

is_patch() {
  local p="$1" f
  for f in "${PATCH_FILES[@]}"; do [[ "$p" == "$f" ]] && return 0; done
  return 1
}

status=0

# 1. Name allowlist. Three-dot diff = "what we changed since the merge base",
#    which also catches deletions of upstream files.
while IFS= read -r path; do
  [[ -z "$path" ]] && continue
  is_owned "$path" && continue
  is_hook "$path" && continue
  is_owned_file "$path" && continue
  is_patch "$path" && continue
  echo "DRIFT: '$path' differs from $UPSTREAM_REF and is not in the allowlist (SPEC.md §6)" >&2
  status=1
done < <(git diff --name-only "$UPSTREAM_REF"...HEAD)

# 2. Line budget on the hook files, so a hook cannot quietly grow into a rewrite.
added=0
removed=0
while IFS=$'\t' read -r add del file; do
  [[ -z "${file:-}" ]] && continue
  is_hook "$file" || continue
  [[ "$add" == "-" ]] && continue   # binary
  added=$((added + add))
  removed=$((removed + del))
done < <(git diff --numstat "$UPSTREAM_REF"...HEAD)

if (( added > MAX_HOOK_LINES )); then
  echo "DRIFT: hook files add $added lines; budget is $MAX_HOOK_LINES (SPEC.md §6)" >&2
  status=1
fi

if (( status != 0 )); then
  echo "check-drift: FAILED" >&2
  exit 1
fi

echo "check-drift: OK — hook files +$added/-$removed lines (budget $MAX_HOOK_LINES); owned paths exempt"
