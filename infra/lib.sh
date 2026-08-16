# shellcheck shell=bash
#
# infra/lib.sh — shared helpers for setup.sh and ./accrawl, sourced by both so the two never drift.
#
# Contract / constraints:
#   • SOURCED, never executed. Defines functions + a few globals; runs no side effects on its own.
#   • Must be safe under `set -e` (setup.sh runs `set -euo pipefail`) AND without it (./accrawl does not
#     use `set -e`). So: no bare `cmd1 && cmd2` used as a standalone statement whose failure would exit,
#     and functions consumed via `$( )` always return 0.
#   • Must run under macOS /bin/bash 3.2 as well as modern bash: no `mapfile`/`readarray`, no associative
#     arrays, and no `${var//pattern/}` pattern-substitution over large strings (quadratic → hangs).
#   • All prompts/reads are TTY-aware: when stdin is not a terminal they return the default instead of
#     blocking, so piped/headless invocation never hangs.

# Repo root (dir that contains this lib's parent) + the .env this stack reads/writes. A caller may preset
# ACCRAWL_ROOT; otherwise derive it from this file's location so `./accrawl` works from any cwd.
if [ -z "${ACCRAWL_ROOT:-}" ]; then
  ACCRAWL_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
fi
env_file="${ACCRAWL_ROOT}/.env"

# ── Output helpers ─────────────────────────────────────────────────────────────────────────────────────
# ANSI emphasis only when stdout is a terminal and NO_COLOR is unset, so piped/captured output stays clean.
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_RED="$(printf '\033[1;31m')"; C_YEL="$(printf '\033[1;33m')"; C_GRN="$(printf '\033[1;32m')"
  C_DIM="$(printf '\033[2m')"; C_OFF="$(printf '\033[0m')"
else
  C_RED=""; C_YEL=""; C_GRN=""; C_DIM=""; C_OFF=""
fi
say()  { printf '%s\n' "$*"; }
warn() { printf '%s%s%s\n' "$C_RED" "$*" "$C_OFF"; }          # bold red — destructive / data-loss warnings
note() { printf '%s%s%s\n' "$C_YEL" "$*" "$C_OFF"; }          # yellow — advisory / heads-up
ok()   { printf '%s%s%s\n' "$C_GRN" "$*" "$C_OFF"; }          # green — success
err()  { printf '%sError:%s %s\n' "$C_RED" "$C_OFF" "$*" >&2; }

# Prompt on stderr (so command substitution captures only the answer); $2 = default. TTY-aware: with no
# terminal on stdin, return the default immediately rather than blocking on read.
ask() {
  local p="$1" d="${2:-}" a
  if [ ! -t 0 ]; then printf '%s' "$d"; return 0; fi
  if [ -n "$d" ]; then printf '%s [%s]: ' "$p" "$d" >&2; else printf '%s: ' "$p" >&2; fi
  IFS= read -r a || true
  printf '%s' "${a:-$d}"
}
# Hidden input (no echo). TTY-aware: with no terminal, return empty (headless flows take secrets from files).
ask_secret() {
  local p="$1" a
  if [ ! -t 0 ]; then printf ''; return 0; fi
  printf '%s: ' "$p" >&2
  IFS= read -rs a || true
  printf '\n' >&2
  printf '%s' "$a"
}

# ── .env read / atomic rewrite ─────────────────────────────────────────────────────────────────────────
# Print the value of KEY from .env (everything after the first `=`), empty if the key is absent. The last
# matching line wins, matching how dotenv/compose resolve duplicates. Always returns 0 (safe under `set -e`
# inside `$( )`).
env_get() {
  local key="$1" line
  [ -f "$env_file" ] || return 0
  line="$(grep -E "^${key}=" "$env_file" 2>/dev/null | tail -n1)" || true
  [ -n "$line" ] || return 0
  printf '%s' "${line#*=}"   # strip up to the first `=` (shortest-prefix removal, NOT global substitution)
}

# True (0) iff a line `KEY=…` exists in .env (even if its value is empty).
env_has_key() {
  [ -f "$env_file" ] || return 1
  grep -qE "^$1=" "$env_file" 2>/dev/null
}

# env_set KEY VALUE — set (or add) KEY=VALUE in .env ATOMICALLY. Mirrors setup.sh's write discipline:
# build a 0600 temp in the .env directory, then rename over .env (same filesystem → atomic). Preserves 0600,
# every other line + comment, and collapses any duplicate keys to a single canonical line. A failed write
# leaves the existing .env untouched. Requires .env to already exist (callers guard with require_env).
env_set() {
  local key="$1" val="$2" tmp found=0 line
  if [ ! -f "$env_file" ]; then err "no .env at $env_file"; return 1; fi
  tmp="$(mktemp "${env_file}.tmp.XXXXXX")" || { err "could not create a temp file next to $env_file"; return 1; }
  chmod 600 "$tmp" 2>/dev/null || true
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      "${key}="*)
        if [ "$found" = 0 ]; then printf '%s=%s\n' "$key" "$val" >> "$tmp"; found=1; fi
        ;;
      *) printf '%s\n' "$line" >> "$tmp" ;;
    esac
  done < "$env_file"
  if [ "$found" = 0 ]; then printf '%s=%s\n' "$key" "$val" >> "$tmp"; fi
  if ! mv "$tmp" "$env_file"; then rm -f "$tmp"; err "failed to update $env_file"; return 1; fi
  chmod 600 "$env_file" 2>/dev/null || true
}

# Add KEY=VALUE only if the key line is entirely absent (never clobber an existing value, even an empty one).
env_add_missing() {
  if env_has_key "$1"; then return 0; fi
  env_set "$1" "$2"
}

# ── Config load + URL / mode computation ───────────────────────────────────────────────────────────────
# Populate the runtime config globals from .env, applying the secure-by-default values, and derive the
# Caddy ACME-email directive (empty unless an email is configured — Caddy rejects a bare `email` line, so we
# inject the whole directive or nothing). Call once, after env_file is known.
load_config() {
  ACCRAWL_PORT="$(env_get ACCRAWL_PORT)";        [ -n "$ACCRAWL_PORT" ] || ACCRAWL_PORT=8088
  ACCRAWL_BIND="$(env_get ACCRAWL_BIND)";        [ -n "$ACCRAWL_BIND" ] || ACCRAWL_BIND=127.0.0.1
  ACCRAWL_DOMAIN="$(env_get ACCRAWL_DOMAIN)"
  ACCRAWL_TLS_EMAIL="$(env_get ACCRAWL_TLS_EMAIL)"
  ENGINE_WS_URL="$(env_get ENGINE_WS_URL)"
  # Derived, exported for the compose run (the caddy container reads it as {$ACCRAWL_ACME_GLOBAL}).
  if [ -n "${ACCRAWL_TLS_EMAIL:-}" ]; then
    export ACCRAWL_ACME_GLOBAL="email ${ACCRAWL_TLS_EMAIL}"
  else
    export ACCRAWL_ACME_GLOBAL=""
  fi
}

# True (0) iff domain/TLS mode is configured (ACCRAWL_DOMAIN present). Requires load_config first.
tls_mode() { [ -n "${ACCRAWL_DOMAIN:-}" ]; }

# The URL a human should open. Domain mode → https://domain; local mode → http://localhost[:port].
accrawl_url() {
  if tls_mode; then
    printf 'https://%s' "$ACCRAWL_DOMAIN"
  elif [ "${ACCRAWL_PORT:-8088}" = "80" ]; then
    printf 'http://localhost'
  else
    printf 'http://localhost:%s' "${ACCRAWL_PORT:-8088}"
  fi
}

# The base URL the LOCAL host can actually reach the stack on, for health/version probes. In domain mode
# that is still the public https URL (may be unreachable from this host until DNS/certs are live — callers
# fall back); in local mode it is the published loopback port (bind-agnostic via 127.0.0.1).
probe_url() {
  if tls_mode; then printf 'https://%s' "$ACCRAWL_DOMAIN"
  else printf 'http://127.0.0.1:%s' "${ACCRAWL_PORT:-8088}"; fi
}

# ── docker compose wrapper (mode-aware file selection) ─────────────────────────────────────────────────
# Always uses absolute -f paths AND --project-directory so it works from ANY cwd (compose otherwise resolves
# the default .env + relative build contexts against the current directory — invoking accrawl by absolute
# path from elsewhere would then miss .env and fail secret interpolation). `name: accrawl` in the compose
# file keeps the project (and its volumes) stable. Layers docker-compose.tls.yml when domain mode is set.
dc() {
  if tls_mode; then
    docker compose --project-directory "${ACCRAWL_ROOT}" \
      -f "${ACCRAWL_ROOT}/docker-compose.yml" -f "${ACCRAWL_ROOT}/docker-compose.tls.yml" "$@"
  else
    docker compose --project-directory "${ACCRAWL_ROOT}" \
      -f "${ACCRAWL_ROOT}/docker-compose.yml" "$@"
  fi
}

# ── Preconditions ──────────────────────────────────────────────────────────────────────────────────────
require_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    err "Docker isn't installed. Install Docker Desktop (or Docker Engine), then re-run."; return 1
  fi
  if ! docker compose version >/dev/null 2>&1; then
    err "Docker Compose v2 is required (the 'docker compose' subcommand). Update Docker, then re-run."; return 1
  fi
}

# True (0) iff the Docker daemon is actually reachable. `docker info` contacts the daemon — unlike
# `command -v docker` (binary only) and `docker compose version` (CLI plugin only, prints offline), so this is
# the check that catches "installed but the daemon isn't running" (e.g. colima not started after a reboot).
docker_daemon_up() {
  docker info >/dev/null 2>&1
}

# True (0) iff Docker Desktop is installed (macOS). A named predicate so ensure_docker_daemon reads clearly and
# the runtime-selection logic is unit-testable in isolation.
_has_docker_desktop() {
  [ -d "/Applications/Docker.app" ]
}

# Poll docker_daemon_up up to $1 seconds (default 60), returning 0 as soon as the daemon answers, 1 on timeout.
_wait_docker_daemon() {
  local i=0 n="${1:-60}"
  while [ "$i" -lt "$n" ]; do
    if docker_daemon_up; then ok "✓ Docker runtime is ready."; return 0; fi
    i=$((i + 1)); sleep 1
  done
  return 1
}

# Ensure the Docker daemon is running — starting the detected runtime if it isn't — then wait until it answers.
# A no-op when the daemon is already up. This is why `./accrawl start` works straight after a reboot: nothing
# auto-starts the container runtime on login, so we start it here instead of failing on a raw socket error.
#
# It tries each PRESENT runtime in turn — colima, then Docker Desktop (macOS), then dockerd (Linux/systemd) —
# and RE-CHECKS daemon liveness after each. So a start that fails, or one that brings up a daemon the active
# `docker context` doesn't point at (e.g. colima installed but the active context is Docker Desktop), falls
# through to the next candidate instead of dead-ending on the wrong runtime. Returns 0 once the daemon is
# reachable; 1 with an actionable message if none could bring it up.
ensure_docker_daemon() {
  if docker_daemon_up; then return 0; fi

  local os attempted=0
  os="$(uname -s)"

  # colima — synchronous (`colima start` returns once its daemon is up); a short confirm poll is plenty.
  if command -v colima >/dev/null 2>&1; then
    note "The Docker runtime (colima) isn't running — starting it (the first start can take ~30s)…"
    colima start || true
    attempted=1
    if _wait_docker_daemon 5; then return 0; fi
  fi
  # Docker Desktop — asynchronous: the app boots the daemon in the background, so poll longer.
  if [ "$os" = "Darwin" ] && _has_docker_desktop; then
    note "Starting Docker Desktop…"
    open -a Docker >/dev/null 2>&1 || true
    attempted=1
    if _wait_docker_daemon 60; then return 0; fi
  fi
  # Linux dockerd via systemd — needs root; use sudo when not already root.
  if [ "$os" = "Linux" ] && command -v systemctl >/dev/null 2>&1; then
    note "The Docker daemon isn't running — starting it (systemctl start docker)…"
    if [ "$(id -u)" = 0 ]; then systemctl start docker || true; else sudo systemctl start docker || true; fi
    attempted=1
    if _wait_docker_daemon 30; then return 0; fi
  fi

  if [ "$attempted" = 0 ]; then
    err "The Docker daemon isn't running, and I couldn't find a runtime to start automatically."
    if [ "$os" = "Darwin" ]; then
      say "  Start it, then re-run ./accrawl start:   colima start   (or open Docker Desktop)" >&2
    else
      say "  Start it, then re-run ./accrawl start:   sudo systemctl start docker   (or your Docker runtime)" >&2
    fi
    return 1
  fi
  err "The Docker runtime didn't become ready in time. Check it (e.g. 'colima status' / 'docker info') and re-run."
  return 1
}

# require_docker, plus a guarantee the daemon is actually up (starting it if needed). Every path that RUNS the
# stack uses this (start / restart / update / set-port / set-bind / reset / first-run setup); the read-only and
# teardown paths use plain require_docker + a docker_daemon_up check, so they report "it's down" instead of
# booting a VM just to tell you nothing is running.
require_docker_up() {
  require_docker || return 1
  ensure_docker_daemon || return 1
}
require_env() {
  if [ ! -f "$env_file" ]; then
    err "No configuration found at $env_file."
    say  "Run ./setup.sh first to create it." >&2
    return 1
  fi
}

# ── Validation helpers ─────────────────────────────────────────────────────────────────────────────────
# True (0) iff $1 is an integer in 1..65535.
valid_port() {
  case "$1" in
    ''|*[!0-9]*) return 1 ;;
  esac
  [ "$1" -ge 1 ] 2>/dev/null && [ "$1" -le 65535 ] 2>/dev/null
}

# True (0) iff nothing is currently LISTENing on TCP port $1 on this host. Best-effort: if no probe tool is
# available it returns 0 (unknown → let compose surface any real bind conflict).
port_free() {
  local p="$1"
  if command -v lsof >/dev/null 2>&1; then
    ! lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1
  elif command -v nc >/dev/null 2>&1; then
    ! nc -z 127.0.0.1 "$p" >/dev/null 2>&1
  else
    return 0
  fi
}

# ── Health / version probes ────────────────────────────────────────────────────────────────────────────
# True (0) when the control-plane container reports a healthy Docker healthcheck.
cp_healthy() {
  local cid st
  cid="$(dc ps -q control-plane 2>/dev/null)" || return 1
  [ -n "$cid" ] || return 1
  st="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$cid" 2>/dev/null)" || return 1
  [ "$st" = "healthy" ]
}
# Poll cp_healthy up to $1 attempts (default 90) × 3s.
wait_cp_healthy() {
  local i n="${1:-90}"
  i=0
  while [ "$i" -lt "$n" ]; do
    if cp_healthy; then return 0; fi
    i=$((i + 1)); sleep 3
  done
  return 1
}
# Poll the front door's /api/setup/status up to $2 attempts (default 60) × 2s. $1 = base URL.
wait_reachable() {
  local url="$1" n="${2:-60}" i
  i=0
  while [ "$i" -lt "$n" ]; do
    if curl -fsS -k -o /dev/null "${url}/api/setup/status" 2>/dev/null; then return 0; fi
    i=$((i + 1)); sleep 2
  done
  return 1
}

# Print the version the RUNNING stack reports. Primary source of truth: the control-plane GET /version over
# the front door. Falls back to reading the deployed ACCRAWL_VERSION off the running container (domain-mode
# DNS/cert can block a host HTTP probe). Prints nothing + returns 1 if neither is available.
deployed_version() {
  local v cid
  v="$(curl -fsS -k "$(probe_url)/version" 2>/dev/null | sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')" || true
  if [ -n "$v" ]; then printf '%s' "$v"; return 0; fi
  cid="$(dc ps -q control-plane 2>/dev/null)" || true
  if [ -n "$cid" ]; then
    v="$(docker inspect "$cid" --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null | sed -n 's/^ACCRAWL_VERSION=//p' | head -n1)" || true
    if [ -n "$v" ]; then printf '%s' "$v"; return 0; fi
  fi
  return 1
}

# The working-tree git short SHA (what a fresh build would bake), or "unknown" outside a git checkout.
head_version() {
  git -C "$ACCRAWL_ROOT" rev-parse --short HEAD 2>/dev/null || printf 'unknown'
}
