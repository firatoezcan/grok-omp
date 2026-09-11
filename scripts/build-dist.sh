#!/usr/bin/env bash
# Build the dist/ bundle that ~/.local/bin/grok-pi execs:
#
#   dist/grok-pi         launcher        (bun build --compile bridge/grok-pi.mjs)
#   dist/grok-pi-agent   ACP adapter     (bun build --compile bridge/adapter.mjs)
#   dist/grok-pi-stt     local STT shim  (bun build --compile bridge/stt-shim.mjs)
#   dist/grok-pi-pager   the TUI         (cargo build -p xai-grok-pager-bin --release)
#   dist/config.toml     seeded pager config (config/config.toml)
#
# macOS gotcha this script exists for: overwriting a signed Mach-O IN PLACE
# leaves the kernel's per-vnode code-signature cache stale. The next exec is
# SIGKILLed ("load code signature error 2", EXC_CRASH / Code Signature Invalid)
# before main() runs — `grok-pi` appears to produce no output at all. Every
# artifact is therefore built to a temp name, ad-hoc re-signed, and installed
# with mv so the destination always gets a fresh inode.
#
# Usage:
#   scripts/build-dist.sh            # build + install everything
#   scripts/build-dist.sh --bun-only # skip the cargo pager build
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST="$ROOT/dist"
mkdir -p "$DIST"

BUN_ONLY=0
[[ "${1:-}" == "--bun-only" ]] && BUN_ONLY=1

# install_signed <src> <dest-name>: copy to temp, ad-hoc re-sign, atomic mv.
install_signed() {
  local src="$1" name="$2"
  local tmp="$DIST/.$name.tmp"
  cp "$src" "$tmp"
  codesign --force --sign - "$tmp" >/dev/null 2>&1
  mv -f "$tmp" "$DIST/$name"
  echo "installed $name"
}

bun_compile() {
  local entry="$1" name="$2"
  local tmp="$DIST/.$name.tmp"
  bun build --compile "$ROOT/$entry" --outfile "$tmp" >/dev/null
  codesign --force --sign - "$tmp" >/dev/null 2>&1
  mv -f "$tmp" "$DIST/$name"
  echo "installed $name"
}

if [[ "$BUN_ONLY" == 0 ]]; then
  (cd "$ROOT" && cargo build -p xai-grok-pager-bin --release)
  install_signed "$ROOT/target/release/xai-grok-pager" grok-pi-pager
fi

bun_compile bridge/grok-pi.mjs grok-pi
bun_compile bridge/adapter.mjs grok-pi-agent
bun_compile bridge/stt-shim.mjs grok-pi-stt

# config.toml is not signed; still install via temp+mv for consistency.
cp "$ROOT/config/config.toml" "$DIST/.config.toml.tmp"
mv -f "$DIST/.config.toml.tmp" "$DIST/config.toml"
echo "installed config.toml"
