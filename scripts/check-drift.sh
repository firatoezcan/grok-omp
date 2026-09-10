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
MAX_HOOK_LINES="${MAX_HOOK_LINES:-40}"

# Upstream files we are permitted to modify in place. Keep in sync with SPEC.md §6.
HOOK_FILES=(
  crates/codegen/xai-grok-pager/src/acp/mod.rs
  crates/codegen/xai-grok-telemetry/src/startup.rs
  crates/codegen/xai-grok-pager/src/app/startup_failure/render.rs
  crates/codegen/xai-grok-pager/src/app/mod.rs
  crates/codegen/xai-grok-pager/src/app/cli.rs
)

# Paths that are ours outright. Upstream can never collide with them, so they
# never conflict on a merge and never count against the line budget.
OWNED_PREFIXES=(
  SPEC.md
  scripts/
  config/
  bridge/
  tapes/
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

status=0

# 1. Name allowlist. Three-dot diff = "what we changed since the merge base",
#    which also catches deletions of upstream files.
while IFS= read -r path; do
  [[ -z "$path" ]] && continue
  is_owned "$path" && continue
  is_hook "$path" && continue
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
