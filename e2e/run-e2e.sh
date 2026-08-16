#!/usr/bin/env bash
#
# Real end-to-end validation. Stands up a real Postgres (embedded), the engine + control-plane as
# separate processes, and a fake bank; drives the actual product API; then either the in-process relay or
# the real Companion app on a leased emulator delivers the 2FA SMS. It asserts that the crawl extracted the
# bank's data exactly. See e2e/README.md.
#
# Requires: node >= 26.6 and a model API key in GEMINI_API_KEY.
set -euo pipefail
script_dir="$(cd "$(dirname "$0")" && pwd)"
companion_workspace=""
companion_workspace_parent=""

cleanup_companion_workspace() {
  exit_status=$?
  if [ -z "$companion_workspace" ] || [ ! -d "$companion_workspace" ]; then
    return "$exit_status"
  fi
  if [ "${ACCRAWL_E2E_KEEP_APKS:-0}" = "1" ]; then
    echo "Companion APKs retained at $companion_workspace"
    return "$exit_status"
  fi
  case "$companion_workspace" in
    "$companion_workspace_parent"/accrawl-companion-build.*)
      rm -r -- "$companion_workspace"
      ;;
    *)
      echo "Refusing to clean unexpected Companion workspace: $companion_workspace" >&2
      return 1
      ;;
  esac
  return "$exit_status"
}

trap cleanup_companion_workspace EXIT

# The run uses shared build outputs and a fixed embedded-Postgres directory. Serialize the complete
# workflow so two local invocations cannot delete or rewrite each other's APKs or database files.
if [ -z "${ACCRAWL_E2E_LOCK_HELD:-}" ]; then
  if command -v lockf >/dev/null 2>&1; then
    exec lockf -k /tmp/accrawl-e2e.lock \
      env ACCRAWL_E2E_LOCK_HELD=1 "$script_dir/run-e2e.sh" "$@"
  elif command -v flock >/dev/null 2>&1; then
    exec flock /tmp/accrawl-e2e.lock \
      env ACCRAWL_E2E_LOCK_HELD=1 "$script_dir/run-e2e.sh" "$@"
  else
    echo "E2E requires lockf or flock to serialize its shared build and database state." >&2
    exit 2
  fi
fi

cd "$script_dir/.."

# Track the repository's own declared engine range rather than a looser number of this script's own, so a
# runtime that passes here cannot fail package.json's `engines` later.
required_node="$(node -e 'process.stdout.write(require("./package.json").engines.node.replace(/[^0-9.]/g, ""))' 2>/dev/null || echo '26.7.0')"
if ! node -e '
  const need = process.argv[1].split(".").map(Number);
  const have = process.versions.node.split(".").map(Number);
  for (let i = 0; i < need.length; i++) {
    if ((have[i] ?? 0) > need[i]) process.exit(0);
    if ((have[i] ?? 0) < need[i]) process.exit(1);
  }
  process.exit(0);
' "$required_node" 2>/dev/null; then
  echo "node >= $required_node required on PATH (found $(node -v 2>/dev/null || echo none))." >&2
  echo "e.g. export PATH=\"\$HOME/.nvm/versions/node/v$required_node/bin:\$PATH\"" >&2
  exit 2
fi

# Settings that are stable for a machine live in .env for every other way of running this product, so read
# them from there rather than making the suite the one thing that needs them exported by hand. A gate that
# can only be satisfied by re-exporting values every session is a gate that gets skipped, or that stalls on
# someone hunting for a value they already supplied once. An explicit environment variable still wins.
env_file="$script_dir/../.env"
load_from_env_file() {
  local name="$1" current value
  eval "current=\${$name:-}"
  [ -n "$current" ] && return 0
  [ -f "$env_file" ] || return 0
  value="$(sed -n "s/^${name}=//p" "$env_file" | tail -1 | tr -d '"'"'"'"' )"
  [ -n "$value" ] && export "$name=$value"
  return 0
}

# The model key, the emulator lease wrapper's path, and the push project the Companion registers with are
# all machine-stable. The four push values are only consulted by COMPANION_RELAY runs, which enforce their
# own completeness check — loading them here is what stops that check from being a per-session scavenger hunt.
for _setting in \
  GEMINI_API_KEY \
  EMULATOR_LEASE_SCRIPT \
  COMPANION_PUSH_PROJECT_ID \
  COMPANION_PUSH_CLIENT_APP_ID \
  COMPANION_PUSH_CLIENT_API_KEY \
  COMPANION_PUSH_CLIENT_SENDER_ID
do
  load_from_env_file "$_setting"
done
unset _setting

if [ -z "${GEMINI_API_KEY:-}" ]; then
  echo "GEMINI_API_KEY is not set and is not in .env. Set it before running the end-to-end suite." >&2
  exit 2
fi
export GEMINI_API_KEY

echo "Building workspace…"
pnpm -r build >/tmp/accrawl-e2e-build.log 2>&1 || { echo "build failed:"; tail -20 /tmp/accrawl-e2e-build.log; exit 1; }

if [ -n "${COMPANION_RELAY:-}" ]; then
  : "${EMULATOR_SERIAL:?COMPANION_RELAY requires the serial from the current emulator lease}"
  : "${EMULATOR_LEASE_SCRIPT:?COMPANION_RELAY requires the emulator lease wrapper path}"
  : "${EMU_SESSION:?COMPANION_RELAY requires the active emulator lease session}"
  if [ ! -x "$EMULATOR_LEASE_SCRIPT" ]; then
    echo "EMULATOR_LEASE_SCRIPT is not executable: $EMULATOR_LEASE_SCRIPT" >&2
    exit 2
  fi
  leased_serial="$("$EMULATOR_LEASE_SCRIPT" mine)"
  if [ "$leased_serial" != "$EMULATOR_SERIAL" ]; then
    echo "EMULATOR_SERIAL does not match the current lease ($leased_serial)." >&2
    exit 2
  fi
  emulator_abi="$("$EMULATOR_LEASE_SCRIPT" adb -- shell getprop ro.product.cpu.abi)"
  case "$emulator_abi" in
    x86_64) flutter_target="android-x64" ;;
    arm64-v8a) flutter_target="android-arm64" ;;
    armeabi-v7a) flutter_target="android-arm" ;;
    *)
      echo "Unsupported leased-emulator ABI: ${emulator_abi:-unknown}" >&2
      exit 2
      ;;
  esac
  echo "Building secure and QA companion APKs for ${emulator_abi}…"
  companion_workspace_parent="$(cd "${TMPDIR:-/tmp}" && pwd -P)"
  companion_workspace="$(mktemp -d "$companion_workspace_parent/accrawl-companion-build.XXXXXX")"
  companion_build_root="$PWD"
  cd "$companion_workspace"
  companion_workspace="$PWD"
  cd "$companion_build_root"
  companion_source="$companion_workspace/source"
  mkdir -p "$companion_source"
  rsync -a \
    --exclude=.dart_tool \
    --exclude=build \
    companion/ "$companion_source/"
  build_companion_apks() {
    cd "$companion_source" || return
    flutter pub get || return
    flutter build apk --flavor qa --debug --target-platform "$flutter_target" || return
    cp build/app/outputs/flutter-apk/app-qa-debug.apk "$companion_workspace/app-qa-debug.apk" || return
    flutter clean || return
    flutter pub get || return
    flutter build apk --flavor secure --debug --target-platform "$flutter_target" || return
    cp build/app/outputs/flutter-apk/app-secure-debug.apk "$companion_workspace/app-secure-debug.apk" || return
    flutter clean || return
    cd "$companion_build_root" || return
  }
  build_companion_apks >/tmp/accrawl-e2e-companion-build.log 2>&1 || {
    cd "$companion_build_root"
    echo "companion build failed:"
    tail -40 /tmp/accrawl-e2e-companion-build.log
    exit 1
  }
  export COMPANION_QA_APK="$companion_workspace/app-qa-debug.apk"
  export COMPANION_SECURE_APK="$companion_workspace/app-secure-debug.apk"
fi

echo "Running end-to-end…"
node e2e/run-e2e.mjs
