#!/usr/bin/env bash
# Upstream sync ritual (SPEC.md §5.3).
#
# Upstream history is a series of squashed monorepo snapshots ("Synced from
# monorepo"), so this is a plain merge plus the drift gate. If our delta is
# healthy the merge is a no-op or a one-line re-resolution.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$here"

git fetch upstream main

echo "== incoming =="
git log --oneline "HEAD..upstream/main" | head -20
echo "   (SOURCE_REV currently: $(cat SOURCE_REV 2>/dev/null || echo '?'))"

echo "== merge =="
git merge --no-edit upstream/main

echo "== drift =="
bash scripts/check-drift.sh

echo "== compile =="
cargo check -p xai-grok-pager-bin

echo
echo "sync-upstream: done."
echo "  next: scripts/run-omp-grok.sh        # boot check (SPEC.md §8.4)"
