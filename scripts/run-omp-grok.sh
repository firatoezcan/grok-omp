#!/usr/bin/env bash
# Launcher for the fork with the zero-diff x.ai neutralization (SPEC.md §8.1).
#
# Nothing here patches source. Every switch is either config or environment, so
# it stays out of the fork's merge surface entirely.
#
# Usage:
#   scripts/run-omp-grok.sh                      # release build, embedded agent (upstream)
#   scripts/run-omp-grok.sh --agent-command "omp acp"   # OMP as the brain (SPEC.md §4, Stage 3)
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Isolated config/session/cache home, so this never touches a real ~/.grok install.
export GROK_HOME="${GROK_HOME:-$HOME/.local/share/grok-omp}"
mkdir -p "$GROK_HOME"
if [[ ! -f "$GROK_HOME/config.toml" ]]; then
  install -m 600 "$here/config/config.toml" "$GROK_HOME/config.toml"
  echo "run-omp-grok: seeded $GROK_HOME/config.toml" >&2
fi

# Belt and braces: the leader child (if ever spawned) re-reads the environment,
# and these also cover code paths that predate the config keys.
export GROK_DISABLE_AUTOUPDATER=1
export GROK_TELEMETRY_ENABLED=false
export DISABLE_TELEMETRY=1
export GROK_TELEMETRY_TRACE_UPLOAD=false
export GROK_FEEDBACK_ENABLED=false
unset SENTRY_DSN GROK_EXTERNAL_OTEL || true

binary="${GROK_PAGER_BINARY:-$here/target/release/xai-grok-pager}"
if [[ ! -x "$binary" ]]; then
  echo "run-omp-grok: no binary at $binary" >&2
  echo "  build it:  cargo build -p xai-grok-pager-bin --release" >&2
  exit 1
fi

# --no-leader: never auto-spawn the leader process (a second phone-home process).
exec "$binary" --no-leader "$@"
