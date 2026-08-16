#!/usr/bin/env bash
#
# Accrawl setup wizard — bootstraps a self-host deployment from nothing:
#   • generates the infrastructure secrets (Postgres / engine / credential-encryption key)
#   • prompts for the Gemini API key and (optionally) the sign-in password
#   • configures networking: host port, LAN vs localhost bind, and local-HTTP vs public-domain/HTTPS
#   • writes .env (chmod 600, atomically)
#   • optionally builds + starts the stack (mode-aware) and sets the sign-in password
#
# Re-run any time. Interactive usage:  ./setup.sh   (or: pnpm setup)
#
# Non-interactive / headless (CI, provisioning) — no prompts fire when --yes (or ACCRAWL_ASSUME_YES=1) is
# set and the required inputs are supplied via env:
#   ACCRAWL_ASSUME_YES=1 GEMINI_API_KEY=… ACCRAWL_PORT=8088 ACCRAWL_BIND=127.0.0.1 \
#   ACCRAWL_ADMIN_PASSWORD_FILE=/path/to/pw  ./setup.sh --yes
# Flags: --yes/-y (assume yes), --lan (bind 0.0.0.0), --reset-db (permit the DESTRUCTIVE db reset — NEVER
# implied by --yes), --help. The admin password is read ONLY from ACCRAWL_ADMIN_PASSWORD_FILE (a path),
# never a plain env var or argv, so it can't leak via `ps` / /proc/environ.
set -euo pipefail

cd "$(dirname "$0")"
ACCRAWL_ROOT="$(pwd -P)"
# Shared helpers (output/color, ask/ask_secret, .env read+atomic rewrite, URL + compose-mode computation).
# shellcheck source=infra/lib.sh
. "${ACCRAWL_ROOT}/infra/lib.sh"

# ── Flags / headless inputs ────────────────────────────────────────────────────────────────────────────
ASSUME_YES=0; LAN_FLAG=0; RESET_DB=0
if [ "${ACCRAWL_ASSUME_YES:-}" = "1" ]; then ASSUME_YES=1; fi
for arg in "$@"; do
  case "$arg" in
    -y|--yes)   ASSUME_YES=1 ;;
    --lan)      LAN_FLAG=1 ;;
    --reset-db) RESET_DB=1 ;;
    -h|--help)
      say "Usage: ./setup.sh [--yes] [--lan] [--reset-db]"
      say "  --yes/-y     assume 'yes' to prompts; take inputs from env (headless). Does NOT imply --reset-db."
      say "  --lan        bind to 0.0.0.0 (LAN access) instead of localhost."
      say "  --reset-db   permit the DESTRUCTIVE database reset when keys/DB mismatch (never implied by --yes)."
      say "Env (headless): GEMINI_API_KEY, ACCRAWL_PORT, ACCRAWL_BIND, ACCRAWL_DOMAIN, ACCRAWL_TLS_EMAIL,"
      say "                ACCRAWL_ADMIN_PASSWORD_FILE (path to the password — never a plain env var)."
      exit 0 ;;
    *) err "unknown option: $arg  (see ./setup.sh --help)"; exit 2 ;;
  esac
done
# Interactive iff we have a real terminal AND weren't told to assume-yes. Headless never calls ask().
INTERACTIVE=1
if [ "$ASSUME_YES" = 1 ] || [ ! -t 0 ]; then INTERACTIVE=0; fi

# Setup-specific helpers (kept here, not in the shared lib) ───────────────────────────────────────────────
# Dump the app's recent logs (indented, to stderr) — the real error when it won't come up.
dump_cp_logs() { dc logs --tail=40 --no-color control-plane 2>&1 | sed 's/^/    /' >&2 || true; }
gen() { openssl rand -hex "$1"; }
# Emit {"password": <stdin>} as valid JSON. The password is read from STDIN (never argv/env, so it can't
# leak via `ps` / /proc/cmdline) and encoded by a real JSON encoder so any character is handled correctly.
# Returns non-zero if no encoder exists, so the caller defers to the browser rather than POSTing garbage.
json_body() {
  if command -v jq >/dev/null 2>&1; then
    jq -Rsc '{password: .}'
  elif command -v python3 >/dev/null 2>&1; then
    python3 -c 'import json,sys; sys.stdout.write(json.dumps({"password": sys.stdin.read()}))'
  elif command -v node >/dev/null 2>&1; then
    node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>process.stdout.write(JSON.stringify({password:d})))'
  else
    return 1
  fi
}

# Seed the operator password on first-run setup by POSTing to the control-plane FROM INSIDE its container
# (localhost:3000) — mode-agnostic (works in domain mode where the host can't reach the public URL) and it
# needs no TLS/DNS. The password is piped over the exec's STDIN, so it never appears in any process's argv.
seed_password() {
  local pw="$1" st code
  st="$(dc exec -T control-plane node -e 'fetch("http://localhost:3000/api/setup/status").then(r=>r.json()).then(j=>{process.stdout.write(j.initialized?"init":"new")}).catch(()=>{process.stdout.write("err")}).finally(()=>process.exit(0))' 2>/dev/null || true)"
  case "$st" in
    *init*) say "Accrawl is already set up — keeping your existing password."; return 0 ;;
  esac
  # The setup code is read inside the container from the same environment the server reads it from, so it
  # is never an argument here and never reaches this host's process list.
  code="$(printf '%s' "$pw" | dc exec -T control-plane node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{fetch("http://localhost:3000/api/setup",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({password:d,setupCode:process.env.SETUP_CLAIM_TOKEN})}).then(r=>{process.stdout.write(String(r.status))}).catch(()=>{process.stdout.write("000")}).finally(()=>process.exit(0))})' 2>/dev/null || true)"
  case "$code" in
    201) ok "✓ Password set — you're ready to sign in." ;;
    409) say "Accrawl is already set up — keeping your existing password." ;;
    403) say "Couldn't set your password automatically: this deployment's setup code didn't reach it."
         say "Your setup code is in ${env_file} as SETUP_CLAIM_TOKEN. Enter it with your password at ${URL}" ;;
    *)   say "Couldn't set your password automatically (status ${code:-unknown}). Set it in your browser at ${URL}" ;;
  esac
}

command -v openssl >/dev/null 2>&1 || { err "openssl is required to generate your keys. Please install it and run this again."; exit 1; }

say "──────────────────────────────────────────────"
say "  Welcome to Accrawl"
say "──────────────────────────────────────────────"
say "This gets Accrawl running on your machine. Everything is created locally."
say ""

# ── Keep or regenerate config ──────────────────────────────────────────────────────────────────────────
# An existing config is kept unless you choose to replace it — but either way we continue to the start step,
# so re-running just to launch works. Headless never clobbers an existing .env (secrets would be lost).
regenerate=1
if [ -f .env ]; then
  if [ "$INTERACTIVE" = 1 ]; then
    say "You already have a configuration here:"
    say "  $env_file"
    case "$(ask "Replace it and generate fresh keys? (y/N)" "N")" in
      [yY]*) regenerate=1 ;;
      *) chmod 600 .env 2>/dev/null || true
         say "Keeping it — we'll start Accrawl with your existing configuration."
         regenerate=0 ;;
    esac
  else
    chmod 600 .env 2>/dev/null || true
    say "Existing configuration found at $env_file — keeping it (headless)."
    regenerate=0
  fi
fi

# Regenerating keys, but a database from a previous setup already exists? Postgres only applies the password
# when the database is first created, so fresh keys can't take effect without resetting it. Offer that here
# (before we change anything). Headless: gated behind --reset-db (NEVER implied by --yes).
if [ "$regenerate" = 1 ] && command -v docker >/dev/null 2>&1 \
   && docker volume ls -q 2>/dev/null | grep -qxE 'accrawl_pgdata|accrawl_pgdata18'; then
  say ""
  warn "⚠  WARNING: a database from a previous setup already exists and still uses the old keys."
  warn "   Resetting it to apply the new keys will PERMANENTLY DELETE every account, transaction, and"
  warn "   anything else Accrawl has stored. This cannot be undone."
  do_reset=0
  if [ "$INTERACTIVE" = 1 ]; then
    case "$(ask "${C_RED}Reset the database and DELETE all its data? (y/N)${C_OFF}" "N")" in
      [yY]*) do_reset=1 ;;
    esac
  elif [ "$RESET_DB" = 1 ]; then
    do_reset=1
  fi
  if [ "$do_reset" = 1 ]; then
    docker compose down -v >/dev/null 2>&1 || true; say "Old database reset."
  else
    err "New keys can't be used with the existing database."
    if [ "$INTERACTIVE" = 1 ]; then
      err "Re-run and choose to keep your existing configuration, or reset it yourself:  ./accrawl reset"
    else
      err "Re-run with --reset-db to DELETE it and start fresh (destructive), or keep your existing .env."
    fi
    exit 1
  fi
fi

# ── Gather network configuration (regenerate path only; keep-path respects the existing .env) ───────────
# Sets globals: PORT BIND DOMAIN TLS_EMAIL WS_URL.
gather_network_config() {
  DOMAIN=""; TLS_EMAIL=""; WS_URL=""
  if [ "$INTERACTIVE" = 1 ]; then
    while :; do
      PORT="$(ask "Which port should the console listen on?" "${ACCRAWL_PORT:-8088}")"
      if valid_port "$PORT"; then break; fi
      say "  Please enter a whole number between 1 and 65535."
    done
    case "$(ask "Allow access from other devices on your network? (y/N)" "N")" in
      [yY]*) BIND="0.0.0.0" ;;
      *)     BIND="127.0.0.1" ;;
    esac
    say ""
    say "Is this a local install, or served on a public domain with HTTPS?"
    case "$(ask "Type 'local' or 'domain'" "local")" in
      [dD]*)
        while [ -z "$DOMAIN" ]; do DOMAIN="$(ask "Public domain (e.g. accrawl.example.com)")"; done
        TLS_EMAIL="$(ask "ACME account email for Let's Encrypt notices (optional, press Enter to skip)" "")"
        note "Domain mode needs ${DOMAIN}'s DNS pointed at THIS host and ports 80+443 reachable from the internet."
        case "$(ask "Also set ENGINE_WS_URL=wss://${DOMAIN}/tunnel for the device proxy? (y/N)" "N")" in
          [yY]*) WS_URL="wss://${DOMAIN}/tunnel" ;;
        esac ;;
      *) : ;;  # local mode
    esac
  else
    PORT="${ACCRAWL_PORT:-8088}"
    if ! valid_port "$PORT"; then err "ACCRAWL_PORT='${PORT}' is not a valid port (1–65535)."; exit 2; fi
    if [ "$LAN_FLAG" = 1 ]; then BIND="0.0.0.0"; else BIND="${ACCRAWL_BIND:-127.0.0.1}"; fi
    case "$BIND" in
      127.0.0.1|0.0.0.0) ;;
      *) err "ACCRAWL_BIND must be 127.0.0.1 or 0.0.0.0 (got '${BIND}')."; exit 2 ;;
    esac
    DOMAIN="${ACCRAWL_DOMAIN:-}"
    TLS_EMAIL="${ACCRAWL_TLS_EMAIL:-}"
    if [ -n "$DOMAIN" ]; then WS_URL="${ENGINE_WS_URL:-}"; fi
  fi
}

if [ "$regenerate" = 1 ]; then   # ── generate secrets + write .env ──
  gather_network_config

  # 1) Gemini API key — the crawl LLM (required to run any crawl).
  if [ "$INTERACTIVE" = 1 ]; then
    say ""
    say "Accrawl reads your accounts using Google's Gemini AI, so you'll need an API key."
    say "Create one for free at https://aistudio.google.com/apikey"
    GEMINI_API_KEY="$(ask "Paste your Gemini API key")"
    while [ -z "$GEMINI_API_KEY" ]; do GEMINI_API_KEY="$(ask "A Gemini API key is required — paste it here")"; done
  else
    GEMINI_API_KEY="${GEMINI_API_KEY:-}"
    if [ -z "$GEMINI_API_KEY" ]; then err "GEMINI_API_KEY is required in headless mode (set it in the environment)."; exit 2; fi
  fi

  # 2) Sign-in password. Interactive: prompt (hidden). Headless: ONLY from ACCRAWL_ADMIN_PASSWORD_FILE
  #    (a path) — never a plain env var / argv. Absent → skip (set it in the browser on first launch).
  ADMIN_PW=""
  if [ "$INTERACTIVE" = 1 ]; then
    say ""
    say "Next, choose a password to sign in to Accrawl."
    say "You can leave it blank and set one in your browser on first launch instead."
    while :; do
      p1="$(ask_secret "Password (at least 8 characters, or blank to skip)")"
      [ -z "$p1" ] && { ADMIN_PW=""; break; }
      if [ "${#p1}" -lt 8 ]; then say "  That's too short — please use at least 8 characters."; continue; fi
      p2="$(ask_secret "Confirm your password")"
      if [ "$p1" = "$p2" ]; then ADMIN_PW="$p1"; break; else say "  Those didn't match — let's try again."; fi
    done
  elif [ -n "${ACCRAWL_ADMIN_PASSWORD_FILE:-}" ]; then
    if [ ! -r "$ACCRAWL_ADMIN_PASSWORD_FILE" ]; then err "ACCRAWL_ADMIN_PASSWORD_FILE ('$ACCRAWL_ADMIN_PASSWORD_FILE') is not a readable file."; exit 2; fi
    ADMIN_PW="$(cat "$ACCRAWL_ADMIN_PASSWORD_FILE")"   # $(…) strips the file's trailing newline
    if [ -n "$ADMIN_PW" ] && [ "${#ADMIN_PW}" -lt 8 ]; then err "The password in ACCRAWL_ADMIN_PASSWORD_FILE must be at least 8 characters."; exit 2; fi
  fi

  # 3) Generate the infrastructure secrets.
  POSTGRES_PASSWORD="$(gen 24)"
  ENGINE_DB_PASSWORD="$(gen 24)"
  ENGINE_SHARED_SECRET="$(gen 32)"
  CREDENTIAL_ENC_KEY="$(gen 32)"   # 64 hex chars = 32 bytes (AES-256-GCM master key)
  # Proves whoever sets the first password installed this. Until that password exists the deployment
  # belongs to nobody, and it has to be reachable to obtain a certificate — so without this, a stranger
  # who arrives first takes it permanently and the person who installed it is told it is already set up.
  SETUP_CLAIM_TOKEN="$(gen 32)"

  # 4) Write .env ATOMICALLY: build a 0600 temp in the repo dir, then rename over .env. Avoids a perms
  #    window (overwriting an existing 0644 .env would expose the new secrets until chmod) and leaves the
  #    existing .env intact on a failed/partial write.
  env_tmp="$(mktemp "$(pwd)/.env.tmp.XXXXXX")"   # mktemp creates it 0600; we chmod 600 explicitly too
  trap 'rm -f "$env_tmp"' EXIT
  chmod 600 "$env_tmp"
  cat > "$env_tmp" <<EOF
# Generated by setup.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ). Secrets — do NOT commit (this file is gitignored).
# Re-run ./setup.sh to regenerate.
POSTGRES_PASSWORD=$POSTGRES_PASSWORD
ENGINE_DB_PASSWORD=$ENGINE_DB_PASSWORD
ENGINE_SHARED_SECRET=$ENGINE_SHARED_SECRET
CREDENTIAL_ENC_KEY=$CREDENTIAL_ENC_KEY
SETUP_CLAIM_TOKEN=$SETUP_CLAIM_TOKEN
GEMINI_API_KEY=$GEMINI_API_KEY

# Networking — HOST publish side only (the internal container port stays 8088). See .env.example for
# details. Manage these later with ./accrawl set-port / set-bind.
ACCRAWL_PORT=$PORT
ACCRAWL_BIND=$BIND
EOF
  if [ -n "$DOMAIN" ]; then
    printf 'ACCRAWL_DOMAIN=%s\n' "$DOMAIN" >> "$env_tmp"
    printf 'ACCRAWL_TLS_EMAIL=%s\n' "$TLS_EMAIL" >> "$env_tmp"
  fi
  if [ -n "$WS_URL" ]; then printf 'ENGINE_WS_URL=%s\n' "$WS_URL" >> "$env_tmp"; fi
  mv "$env_tmp" .env
  trap - EXIT
  say ""
  say "✓ Saved your configuration to $env_file (kept private on your machine)."
else
  ADMIN_PW=""   # kept an existing .env: don't prompt for / change the password
  # Back-compat: .env files predating the networking keys keep working — add safe defaults, never clobber.
  env_add_missing ACCRAWL_PORT 8088
  env_add_missing ACCRAWL_BIND 127.0.0.1
  say ""
  say "Using your existing configuration."
fi

# Load the effective config (single source of truth) so every URL, message, and compose invocation matches.
load_config
URL="$(accrawl_url)"

# ── Optionally build + start the stack ─────────────────────────────────────────────────────────────────
if [ "$INTERACTIVE" = 1 ]; then
  say ""
  case "$(ask "Start Accrawl now? (Y/n)" "Y")" in
    [nN]*)
      say ""
      say "No problem. When you're ready, start Accrawl with:"
      say "  ./accrawl start"
      say "then open ${URL} in your browser."
      [ -n "$ADMIN_PW" ] && say "Your password will be applied the first time the stack starts."
      exit 0 ;;
  esac
fi

if ! require_docker_up; then
  err "Once Docker is installed and running, run:  ./accrawl start"
  exit 1
fi

export ACCRAWL_VERSION; ACCRAWL_VERSION="$(head_version)"
say ""
say "Starting Accrawl ($(if tls_mode; then printf 'domain mode — %s' "$ACCRAWL_DOMAIN"; else printf 'local mode — port %s' "$ACCRAWL_PORT"; fi)) — the first build can take a few minutes…"
if ! dc up -d --build; then
  err "Accrawl didn't start. Here's what went wrong:"
  dump_cp_logs
  if dc logs --no-color control-plane 2>/dev/null | grep -qi 'password authentication failed'; then
    say ""
    warn "⚠  WARNING: a leftover database from an earlier setup exists and its password no longer matches."
    warn "   Resetting it will PERMANENTLY DELETE every account, transaction, and anything else stored."
    do_reset=0
    if [ "$INTERACTIVE" = 1 ]; then
      case "$(ask "${C_RED}Reset the database and DELETE all its data to start fresh? (y/N)${C_OFF}" "N")" in
        [yY]*) do_reset=1 ;;
      esac
    elif [ "$RESET_DB" = 1 ]; then
      do_reset=1
    fi
    if [ "$do_reset" = 1 ]; then
      docker compose down -v >/dev/null 2>&1 || true
      say "Database reset. Run ./setup.sh again to finish starting Accrawl."
    elif [ "$INTERACTIVE" = 1 ]; then
      err "Left as-is. Reset it yourself later with:  ./accrawl reset"
    else
      err "A leftover database is blocking startup. Re-run with --reset-db to DELETE it (destructive)."
    fi
  else
    err "Once you've fixed the issue above, run ./setup.sh again.  (Full logs: ./accrawl logs)"
  fi
  exit 1
fi

# ── Wait for readiness, then set the password (if given) ────────────────────────────────────────────────
say "Waiting for Accrawl to be ready…"
if ! wait_cp_healthy 90; then
  err "Accrawl is taking longer than expected to start. Here's the latest from the logs:"
  dump_cp_logs
  err "Once you've fixed the issue above, run ./setup.sh again.  (Full logs: ./accrawl logs)"
  exit 1
fi
# Local mode: also confirm the front door on the configured port (proves Caddy + the host port mapping).
if ! tls_mode; then
  if ! wait_reachable "$(probe_url)" 30; then
    note "Control-plane is healthy but the front door on port ${ACCRAWL_PORT} isn't answering yet — give it a moment."
  fi
fi

if [ -n "$ADMIN_PW" ]; then
  seed_password "$ADMIN_PW"
else
  say "Open ${URL} in your browser to finish — you'll choose your password there."
  # The screen asks for this before it will set a password, so it has to be readable here. It is
  # also in .env; printing it saves the reader opening a file they were never told about.
  say ""
  say "Your setup code: ${SETUP_CLAIM_TOKEN}"
  say "Enter it with your password. It confirms the deployment is yours before anyone else claims it."
fi

say ""
ok "✓ Accrawl is running (build ${ACCRAWL_VERSION}). Open ${URL} in your browser."
if tls_mode; then
  note "Domain mode: ${URL} is reachable once ${ACCRAWL_DOMAIN}'s DNS points at this host and ports 80+443 are open."
fi
