# Deploying Accrawl (self-host)

Accrawl runs as four containers behind one front door: **Postgres**, the **engine** (Playwright + real
Chrome + Gemini), the **control-plane** (API + scheduler), and **Caddy** (serves the web console and
proxies the API/SSE). One published port, **http://localhost:8088** by default — bound to **localhost only**
(`127.0.0.1`), so it is not reachable from other machines until you opt in (`./accrawl set-bind 0.0.0.0`, or
a public HTTPS domain — see *Running & configuring* and *Remote access / TLS*).

## Prerequisites
- Docker + Docker Compose v2. The daemon does **not** need to be running before you start: `./setup.sh` and
  `./accrawl start` detect a stopped runtime and start it for you (colima or Docker Desktop on macOS, the
  systemd `docker` service on Linux), then wait until it's ready — so a cold boot "just works". Auto-start
  reuses your **existing** runtime profile, so any settings you configured (e.g. Rosetta, below) are
  preserved; it never reconfigures it.
- **Architecture:** the engine image is **linux/amd64** (it installs real `google-chrome-stable`, which
  was amd64-only on Linux); compose pins `platform: linux/amd64` for you. On an amd64 host it runs natively.
  On **Apple Silicon** the engine must run under **Rosetta**, not QEMU — QEMU cannot run Chrome's
  multiprocess/sandbox model (it dies with `qemu: unknown option 'type=utility'` + a fatal GPU-process
  crash). Use Docker Desktop with *"Use Rosetta for x86/amd64 emulation"* enabled, or
  `colima start --vz-rosetta` (verified: an end-to-end crawl through the full stack passes under Rosetta,
  slower than native). Plain QEMU emulation will fail the crawl.
- A Google **Gemini API key** (the crawl LLM): https://aistudio.google.com/apikey

## Quick start

The guided way — `./setup.sh` (or `pnpm setup`) generates the secrets, prompts for the Gemini key + an
operator password, asks how to serve it (port; localhost vs LAN; local HTTP vs a public HTTPS domain),
writes `.env`, then builds + starts the stack and seeds your login:
```bash
./setup.sh
```
When it finishes, open the printed URL (**http://localhost:8088** by default) and sign in.

Or configure it by hand:
```bash
cp .env.example .env
# Fill in .env. Generate the random secrets:
#   POSTGRES_PASSWORD / ENGINE_DB_PASSWORD : openssl rand -hex 24
#   ENGINE_SHARED_SECRET                   : openssl rand -hex 32
#   CREDENTIAL_ENC_KEY                     : openssl rand -hex 32   (exactly 64 hex chars)
#   GEMINI_API_KEY                         : from Google AI Studio
# Networking is OPTIONAL (defaults: port 8088, bind 127.0.0.1, local HTTP). There is NO admin password in
# .env — you create it on first launch (first-run setup, below).

./accrawl start                        # builds the images (always) and starts the stack
./accrawl logs control-plane -f        # watch: migrations + engine-role grants + "listening"
```
Then open **http://localhost:8088**. On first launch the console shows a **setup screen** — create the
operator password there (stored only as an argon2id hash, never in a file). After that, you sign in with it.

## Running & configuring (the `./accrawl` command)
`./accrawl` manages the running stack. It reads `.env` (so every URL/message reflects your actual
port/bind/domain), auto-selects the right compose files (plain vs. domain/TLS), and **always rebuilds** on
start so no service ever goes stale.

```bash
./accrawl start            # build (always) + start; waits for health; prints the URL
./accrawl status           # containers, reachability, and deployed-vs-source version (STALE check)
./accrawl stop             # stop, keeping the data volume
./accrawl restart          # rebuild + recreate
./accrawl update           # alias for restart — pick up new code:  git pull && ./accrawl update
./accrawl logs [svc] [-f]  # tail logs (default --tail=100)
./accrawl open             # open the console in your browser
```

**Port & bind.** Only the HOST publish side varies; the internal container port is always 8088.
- `./accrawl set-port <n>` — validates the port (1–65535, warns if <1024), checks it is free, atomically
  rewrites `.env` (preserving `0600` + every other line/comment), offers to fix `ENGINE_WS_URL` if it
  embedded the old port, and recreates the stack.
- `./accrawl set-bind <127.0.0.1|0.0.0.0>` — `127.0.0.1` (default) is localhost-only; `0.0.0.0` opens it to
  your LAN. **Existing LAN users:** the default changed to localhost-only — set `ACCRAWL_BIND=0.0.0.0` (or
  run `./accrawl set-bind 0.0.0.0`) to keep network reachability.

**Version / staleness.** Every build bakes in the git short SHA; the control-plane serves it at
`GET /version` (unauthenticated — it reveals only the SHA) and the console footer shows it. `./accrawl
status` fetches the running build and compares it to your working tree, warning you to `./accrawl update`
when a deployment is stale (a rebuilt-but-not-restarted or source-ahead-of-deployed situation).

## Start at boot
`./accrawl install-service` detects your OS and generates a boot service:
- **Linux (systemd):** writes `infra/accrawl.service` and prints the exact `sudo cp … && sudo systemctl
  enable --now accrawl` commands (installing to `/etc/systemd/system` needs root). `install-service
  --enable` runs them via sudo for you (it never sudo's silently).
- **macOS (launchd):** writes `~/Library/LaunchAgents/app.accrawl.plist` (`RunAtLoad`) and prints
  `launchctl load -w …`; `--enable` loads it now.

`./accrawl uninstall-service [--enable]` reverses it.

Scheduled crawls run only while the Accrawl stack is available. If the host or service is offline at the
scheduled time, the durable scheduler recovers the overdue crawl when the stack next starts; it cannot run at
the original wall-clock time while the deployment is offline. Use `install-service --enable` to start
Accrawl automatically when Linux boots or when you sign in to macOS.

## Non-interactive / headless (CI, provisioning)
`setup.sh` runs with **no prompts** when `--yes` (or `ACCRAWL_ASSUME_YES=1`) is set and the inputs come from
the environment:

```bash
ACCRAWL_ASSUME_YES=1 \
GEMINI_API_KEY=AIza… \
ACCRAWL_PORT=8088 ACCRAWL_BIND=127.0.0.1 \
ACCRAWL_ADMIN_PASSWORD_FILE=/run/secrets/accrawl_admin_pw \
  ./setup.sh --yes
```
- `--lan` is shorthand for `ACCRAWL_BIND=0.0.0.0`; set `ACCRAWL_DOMAIN` (+ optional `ACCRAWL_TLS_EMAIL`) for
  domain/TLS mode.
- The admin password is read **only** from `ACCRAWL_ADMIN_PASSWORD_FILE` (a file path) — never a plain env
  var or argv, so it can't leak via `ps` / `/proc/environ`. Omit it to set the password in the browser.
- The **destructive database reset** (needed only when regenerated keys don't match an existing DB volume)
  is gated behind a separate explicit **`--reset-db`** — it is *never* implied by `--yes`. Without it, a
  mismatch fails loudly instead of deleting data.
- `./accrawl reset --yes` skips the delete-everything confirmation for automation; without `--yes` (and with
  no TTY) it aborts rather than delete.

**Keeping secrets out of git:** `.env` is gitignored, which is enough for local use. For stricter handling
of the sensitive keys (`CREDENTIAL_ENC_KEY`, `ENGINE_SHARED_SECRET`), keep them in files **outside the
repo** (e.g. `~/.accrawl/secrets/`) and point Accrawl at them with the `_FILE` convention — see the
commented `secrets:` block in `docker-compose.yml`. A file-mounted secret never appears in `docker inspect`
or `/proc/<pid>/environ`, and can't be `git add`-ed by accident.

The control-plane entrypoint applies database migrations and ensures the least-privilege `accrawl_engine`
role + grants **before** it starts serving, so a healthy control-plane means the schema is ready.

## First crawl (the end-to-end walkthrough)
1. **Institutions → Add**: enter a name, the bank’s real **login URL**, and a type. Accrawl derives the
   internal identifier and login domain (eTLD+1). Every institution you add starts as private to you,
   including when you can manage the catalogue. You can use, edit, or delete your private institution. A
   catalogue manager can see and manage every private institution and can publish a separate workspace-wide
   copy. Published copies are visible to everyone signed in to the workspace and are read-only for everyone
   except a catalogue manager. The Institutions list distinguishes published institutions from private
   institutions.
2. **Connections → Add**: pick the institution, enter the bank **username + password** (encrypted at rest
   immediately), then choose manual only, daily, weekly, or monthly crawling. Automatic crawls follow the
   IANA time zone selected in the form, not the server’s time zone. You can change the schedule later with
   **Edit schedule**.
3. **Confirm the sign-in domain** (anti-phishing): select **Confirm domain** on the connection and re-enter
   the expected sign-in domain. Manual and automatic crawls are blocked until it is confirmed, binding the
   credentials to a domain you approved.
4. **Crawl now**: the button enables once verified. The live **session monitor** streams each step over
   SSE; if the bank asks for a 2FA code, the session shows `otp_requested` — type the code and submit.
5. When the run completes, the extracted **accounts / transactions / positions** are validated and stored.

For automatic crawls, the connection row shows both the recurrence and **Next crawl attempt**. **Next crawl
attempt** is the authoritative due time and may differ from the nominal recurrence while Accrawl applies
retry backoff. Automatic crawling begins only after the sign-in domain is confirmed.

## Third-party access — "Connect with Accrawl" (optional)
Other apps can read your data **with your consent**, without ever seeing your Accrawl password or bank
credentials, through the OAuth Authorization-Code + PKCE flow. You (the operator) are the resource owner, so
you register each app and approve access at a consent screen. Full spec + SDK usage:
[docs/spec-oauth.md](./docs/spec-oauth.md).

1. **Register the app** — hosted organisation administrators use the **Apps** section
   in their organisation dashboard. Self-hosted operators use
   `POST /api/oauth-clients` with the app's `name`, its
   `redirectUris` (1–10 unique absolute HTTPS URIs, or HTTP loopback URIs for local development), and the `allowedScopes` ceiling
   (`read:data` — the only scope there is; the API reads and nothing else). The response returns a `clientId` (`accl_…`)
   and, for a confidential app, a `clientSecret` (`acls_…`) **shown once** — hand both to the app. Set
   `isPublic: true` for a native or installed app (PKCE only, no secret). Browser-only apps are not supported.
2. **Connect** — the app links to `GET /oauth/authorize`. Accrawl shows a consent screen naming the app and
   its requested scopes; you sign in with your Accrawl password, then choose which connections to share—or
   select **All current connections**—and approve. **All current connections** includes only connections
   available at the time of authorisation. To share a connection added later, you must authorise again. The
   app then exchanges the code for a scoped, revocable access token that reads only
   the `/api/v1` data you consented to.
3. **Manage connected apps** — `GET /api/grants` lists every app that holds access (scopes, connections,
   expiry, status); `DELETE /api/grants/:id` revokes one immediately (its access + refresh tokens die at
   once, and a `grant.revoked` webhook fires). Deleting a client (`DELETE /api/oauth-clients/:id`)
   permanently disables it. The client is excluded from active listings and cannot be recreated with the
   same idempotency key. All authorization codes, grants, access tokens, and refresh tokens issued for the
   client become unusable.

A complete, dependency-free demo third-party app ("Budget Buddy") is in
[`e2e/oauth-consumer/`](e2e/oauth-consumer/README.md) — run it against your local stack to see the whole
flow end-to-end.

## Security model (what protects you)
- **Engine is reachable only by the control-plane — with one deliberate exception.** Its `/crawl` and
  `/cancel` endpoints are never host-published; only the control-plane reaches them on the internal Docker
  network, with `ENGINE_SHARED_SECRET`. The single externally-reachable engine endpoint is the device-proxy
  `/tunnel` WebSocket (via the Caddy `/tunnel` route), and only because the companion phone — which is off
  the Docker network — must connect to it. It is not an open door: every `/tunnel` upgrade is authenticated
  by a control-plane-issued, session-bound HMAC tunnel token (short TTL) plus a single-use database claim,
  and it only bridges a crawl the control-plane already authorized and parked. If you never use
  `useDeviceProxy`, no phone connects and the route is simply never exercised.
- **Least-privilege engine DB role** — the engine connects as `accrawl_engine`, granted access to ONLY
  session telemetry + staging tables. It cannot read your credentials, API keys, or financial data; a
  compromised browser-agent is not a data-plane compromise.
- **Egress guard** — the browser is domain-pinned to the bank's eTLD+1 (+ any declared CDN domains); all
  other navigation, sub-resource, service-worker, and WebSocket traffic is aborted, so data can't be
  beaconed off-domain.
- **Write gate** — after login, the gate intercepts every `POST`/`PUT`/`PATCH`/`DELETE` at the same
  request interception point as the egress guard. These methods remain allowed during login because
  authentication may require submitting credentials or an OTP. Once the agent reports login complete,
  the gate allows a request only when the request classifier identifies it as a data read; requests
  classified as writes, and requests for which no verdict is available, are refused. The refusal is
  reported to the model so it can continue extracting data. If the agent reports that
  re-authentication has started, the gate permits these methods again until the next login completes.

  Because the gate reads the request and not a button, it is unaffected by the site's language or
  script, by an icon-only control, or by a confirm button that just says "OK" — none of which a
  keyword list can handle at any size. A portal that legitimately POSTs to *fetch* data (postback
  portals paginate that way) is not broken by this: an unrecognised state-changing request is
  classified read-or-write from its method, path and parameter names alone — never page content —
  and the verdict is cached per endpoint, so the cost is roughly one small model call per endpoint
  per crawl. Nothing here is per-institution configuration; there is no list for an operator to write.

  Not covered: a `GET` that changes state, since `GET` is the read path. Set `REQUEST_VET_MODEL` to
  choose the classifier model (default `gemini-2.5-flash-lite`); with no model reachable the gate
  still works and simply refuses every state-changing request after login.
- **Browser hardening, and one downgrade stated plainly.** Chromium's site isolation remains enabled,
  keeping cross-site frames — such as ads, widgets, or injected iframes — out of the bank site's
  renderer process. Chromium's sandbox is also enabled by default in the engine. The bundled Compose
  stack sets `CHROMIUM_DISABLE_SANDBOX=1` because its default seccomp profile blocks
  `clone(CLONE_NEWUSER)`, preventing Chromium from starting with the sandbox enabled. Measured, not
  assumed — the call fails with `EPERM` under the default profile even with no other hardening, and
  succeeds once the filter is removed even alongside `cap_drop: ALL`, `no-new-privileges` and a
  non-root user.

  What that leaves is container isolation: non-root, every Linux capability dropped, no privilege
  escalation. That bounds what a renderer escape reaches on the **host**; it does not bound what it
  reaches inside the container. Regaining the sandbox means removing the syscall filter, which trades
  one boundary for another, so it is not done for you. Running the engine outside a container (as the
  test suite does) keeps the sandbox on.
- **Ending every session.** The console stores a signed login token in the browser's local storage. It
  expires after seven days, and the server keeps no session record for it, so an individual token
  cannot be revoked if it is copied. To invalidate every current console token, send
  `POST /api/auth/revoke-all` with your operator password. This rotates the token-signing secret,
  invalidating all existing tokens—including the one used for the request. Every console session must
  then sign in again. Requiring the operator password prevents someone with only a stolen token from
  signing everyone out.

  ```bash
  curl -sS -X POST http://localhost:8088/api/auth/revoke-all \
    -H 'content-type: application/json' -d '{"password":"<your operator password>"}'
  ```
- **The LLM is inside the trust boundary by design** — page content + extracted data go to Google (Gemini)
  to function. That is the one place financial data leaves your host; there is no third-party exfil beyond it.

## Remote access / TLS
The default `:8088` is plain HTTP bound to localhost, intended for local use. **Never** send credential/API
traffic over plain HTTP across a network. Two ways to go beyond localhost:

- **LAN (plain HTTP):** `./accrawl set-bind 0.0.0.0` publishes the port on all interfaces. Only do this on a
  trusted network — it is still unencrypted.
- **Public domain with automatic HTTPS (recommended):** set `ACCRAWL_DOMAIN` (and optionally
  `ACCRAWL_TLS_EMAIL`) — via `./setup.sh`'s "local or domain?" prompt, or directly in `.env`. `./accrawl`
  and `setup.sh` then automatically layer `docker-compose.tls.yml`, so Caddy serves that hostname on
  `:80/:443` with a real Let's Encrypt certificate (ACME, HTTP-01 / TLS-ALPN) instead of plain `:8088`, and
  persists the issued certificates in a named volume so they survive restarts. Requirements: the domain's
  DNS `A`/`AAAA` record must point at **this** host, and ports **80 and 443** must be reachable from the
  internet (ACME validates over them). In domain mode, `./accrawl status`/`open` use `https://<domain>`, and
  if you use the device proxy set `ENGINE_WS_URL=wss://<domain>/tunnel`.

Terminating TLS on an upstream proxy instead is also fine — leave `ACCRAWL_DOMAIN` empty, keep the plain
`:8088` (or a `set-port`) mapping, and point your proxy at it.

## Validating a deployment
1. **Deterministic first:** point an institution at a controlled static test page and confirm a crawl
   completes end-to-end and the staged → canonical store path runs clean.
2. **The accuracy bar:** crawl a **real bank** end-to-end (with manual 2FA) and confirm every account,
   transaction, and position — name, value, and count — matches the bank exactly. Anything missing or wrong
   is a failure to investigate at the source, never excused as model nondeterminism.

## Non-Docker dev path
`pnpm install` at the repo root, run a local Postgres, then `pnpm --filter @accrawl/control-plane dev`,
`pnpm --filter @accrawl/engine dev` (with installed Chrome), and `pnpm --filter @accrawl/web dev`. The web
dev server proxies `/api` to the control-plane on `:3000`.

`CONTROL_PLANE_INTERNAL_ORIGIN` is the engine-visible origin of the control plane used for OTP wake
requests. Docker Compose sets it automatically to `http://control-plane:3000`. For event-driven OTP wake-ups
in a non-Docker deployment, set it on the engine to the control-plane origin reachable from that process,
such as `http://localhost:3000`. The engine authenticates the internal request with
`ENGINE_SHARED_SECRET` and sends only the session ID. The control plane reloads the live session before
sending FCM to paired phones authorized for that connection.

Event-driven Companion wake-up requires the control plane and Companion build to use the same Firebase
project. For a self-hosted deployment:

1. Register an Android app with application ID `app.accrawl.accrawl_companion` in your Firebase project.
2. Note its Android client values — application id, API key, sender id — from the project's Android app
   configuration. You do **not** rebuild Companion: the published app carries no project of its own and
   registers with whichever one the deployment it pairs with tells it to use.
3. Enable the FCM HTTP v1 API. Create a dedicated service account with a custom role containing only
   `cloudmessaging.messages.create`.
4. Keep its JSON key outside the repository and set these values in `.env`:

```dotenv
COMPANION_PUSH_PROJECT_ID=your-push-project-id
COMPANION_PUSH_CREDENTIALS_FILE=/run/secrets/companion_push_credentials

# Handed to a paired Companion so it registers with your project. All four or none — a partial set lets
# the app register somewhere this server cannot reach, which looks like a phone that never wakes.
COMPANION_PUSH_CLIENT_APP_ID=1:000000000000:android:0000000000000000
COMPANION_PUSH_CLIENT_API_KEY=your-android-api-key
COMPANION_PUSH_CLIENT_SENDER_ID=000000000000
```

5. Mount the key read-only with a `docker-compose.override.yml` file:

```yaml
services:
  control-plane:
    secrets:
      - companion_push_credentials

secrets:
  companion_push_credentials:
    file: ${ACCRAWL_SECRETS_DIR:-./secrets}/companion-push-credentials.json
```

The sender key is a server credential: never add it to the repository or the Companion APK. The Android
client configuration is a separate file; both must identify the same push project.

## Optional: the Android companion

The companion ([`companion/`](companion/)) shows accounts, balances, and transactions for selected
connections, can relay bank SMS codes, and can route selected crawls through the phone's network.

1. If your deployment publishes a signed release, open **Companion** in the Accrawl console and select
   **Download for Android**. If the console is open on another device, scan the download QR with your phone
   instead. Both options download the APK through the console's own domain. For a deployment with event-driven
   background wake-up, build Companion from source with your Firebase configuration instead: connect the
   phone with USB debugging enabled and run **`./accrawl companion install`** (`--device <serial>` when
   several devices are attached). Open the installed APK and follow Android's prompts; if asked, allow your
   browser to install apps from this source.
2. Back on the **Companion** page in the Accrawl console, name the phone, select its exact connections, and
   create a five-minute pairing request.
3. Open Accrawl Companion and scan the pairing QR, or enter the HTTPS console address and `acpair_…` code. Compare the
   six-digit verification code shown on both devices and approve it in the Accrawl console. Complete the phone's
   screen-lock prompt. After a phone is paired, Accrawl Companion asks for SMS access and notification access,
   then asks Android to turn off battery optimization for the app.

After pairing, Accrawl Companion registers its Firebase Cloud Messaging (FCM) registration token through the
paired-device API. It refreshes the registration when Firebase delivers a replacement through `onNewToken`
and whenever the app opens. The control plane uses the token only to address data-only wake-ups to that phone.
The token does not authorize a crawl or start a service; Accrawl Companion starts a service only after the
paired-device API confirms that the requested session is still active.

4. Unlock **Accounts** or **Transactions** with the phone's screen lock. Financial responses are kept in
   memory, remain available during active use and brief interruptions, and are cleared after five minutes
   of inactivity. Production financial traffic requires HTTPS.
5. When a crawl reaches `waiting_for_otp`, the phone forwards the bank's SMS automatically. It relays the
   **message** only when the sender matches the bank's expected SMS sender. The Accrawl console extracts the
   code, so the phone does not try to parse or guess it. If the sender does not match or no supported code is
   found, the session stays waiting and you enter the code manually in the Accrawl console.

Pairing alone does not start a foreground service. When no crawl session is active, no foreground-service
notification is shown. A data-only FCM wake-up, or one-shot recovery when the app opens or resumes, causes
Companion to check the paired-device API. It starts a foreground service only if the API confirms that the
exact crawl session is still active.

While at least one live OTP-relay or device-proxy session is active, the only session notification is the
foreground-service notification Android requires. OTP-relay and device-proxy outcomes and errors appear in
Companion's **Activity** section, not as separate notifications.

The relay is owner- and connection-scoped, sender-bound, request-epoch de-duplicated, and revocable from the
Companion page. The QR contains only the Accrawl console address and the short-lived request secret. The
phone claims the request, and the Accrawl console and Companion display the same six-digit comparison code.
After the operator approves the match, Companion receives the relay credential and financial credential in
a one-time response. Play Store policy restricts arbitrary SMS read, so the official signed APK is distributed
directly for sideloading rather than through Google Play. See
[`companion/README.md`](companion/README.md) for the security model and on-device steps.

## Optional: the device-proxy tunnel (residential exit IP) — Android only
Some banks block logins from datacenter IP ranges (where your server lives). The same companion app can
relay the crawl's browser traffic through the phone, so the bank sees the phone's **residential** IP instead
of the server's. It reuses the paired device — no separate setup beyond enabling it:

1. **Expose the tunnel endpoint.** Set `ENGINE_WS_URL` in `.env` to this deployment's externally-reachable
   WebSocket address — the Caddy `/tunnel` route in front of the engine, e.g. `wss://your-host:8088/tunnel`
   (`ws://…` only for plain local HTTP). The phone connects here. Leave it empty and the device proxy stays
   off. (TLS strongly recommended — see *Remote access / TLS*.)
2. **Flag the institution.** Set `useDeviceProxy` on the institution that needs it (Institutions → edit).
3. **Grant the connection while pairing the phone** (Companion, as above). A phone without that exact
   connection grant cannot see or claim its tunnel.
4. **Crawl.** A `useDeviceProxy` crawl does NOT run the browser immediately — it **parks** and waits for the
   phone. Accrawl requests a data-only FCM wake-up. Companion checks the exact session through the
   paired-device API, retrieves tunnel credentials only if the session remains live, connects to `/tunnel`,
   and relays. The browser's egress now exits from the phone. The engine waits for the institution's
   configured crawl timeout. If no paired device is online by then, the crawl **fails closed**: it never
   silently falls back to the server IP, which would defeat the purpose and can trip the bank's block.

Security: each tunnel connection is authenticated by a control-plane-issued, session-bound HMAC token (short
TTL) plus a single-use database claim; the engine only bridges a crawl it already authorized and parked, and
`/tunnel` is the sole externally-reachable engine endpoint (`/crawl`/`/cancel` stay internal). The phone
relays raw bytes only — it never sees your credentials (those are decrypted inside the engine).
