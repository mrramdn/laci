#!/usr/bin/env bash
# Give each suite its own driver and private D-Bus via the caller's dbus-run-session.
set -euo pipefail
laci_smoke_binary=${1:?native binary required}
laci_smoke_mode=${2:?onboarding, watcher, modular or full required}
: "${LACI_HOME:?isolated fixture required}"
export XDG_DATA_HOME="$LACI_HOME/.local/share"
export LACI_EDITOR=true LACI_FILES=true LACI_TERMINAL=true
unset LACI_ONBOARDING_ONLY LACI_WATCHER_ONLY LACI_KEYBOARD_ONLY LACI_MODULAR_ONLY
case "$laci_smoke_mode" in
  onboarding) export LACI_ONBOARDING_ONLY=1 ;;
  watcher) export LACI_WATCHER_ONLY=1 ;;
  modular) export LACI_MODULAR_ONLY=1 ;;
  full) ;;
  *) printf 'Unknown native suite: %s\n' "$laci_smoke_mode" >&2; exit 2 ;;
esac
laci_smoke_log=$(mktemp "${TMPDIR:-/tmp}/laci-driver.${laci_smoke_mode}.XXXXXX.log")
laci_smoke_driver=
laci_smoke_cleanup() {
  local laci_smoke_status=$1
  if [ -n "$laci_smoke_driver" ]; then
    kill "$laci_smoke_driver" 2>/dev/null || true
    wait "$laci_smoke_driver" 2>/dev/null || true
  fi
  if [ "$laci_smoke_status" -ne 0 ]; then
    cat "$laci_smoke_log" >&2
  fi
  rm -f "$laci_smoke_log"
}
trap 'laci_smoke_cleanup $?' EXIT
tauri-driver > "$laci_smoke_log" 2>&1 &
laci_smoke_driver=$!
node scripts/desktop-smoke.mjs "$laci_smoke_binary"
