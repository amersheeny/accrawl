# Accrawl

**Self-hostable, open-source financial-account aggregation.** Accrawl logs into your own bank and
brokerage accounts with a headless browser driven by an LLM agent, and serves your **accounts, balances,
positions, and transactions** as normalized JSON over a clean API — a credential-based, self-hosted
analogue of TrueLayer / Plaid / SnapTrade.

Accrawl Companion is an optional Android app. It shows accounts, balances, and transactions for the
connections you select, relays your bank's SMS one-time codes to your self-hosted Accrawl console, and can
route selected crawls through the phone's network. Financial access is protected by the phone's screen
lock. Financial data is kept in memory, remains available during active use and brief interruptions, and
is cleared after five minutes of inactivity. All production financial traffic requires HTTPS.

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](./LICENSE)

> ⚖️ **Intended for accessing _your own_ accounts, on your own behalf, with your own credentials**
> (personal / self-hosted data access) — not a hosted third-party aggregation service. See
> [Security & responsible use](#security--responsible-use). AGPL-3.0.

## Status

**Active development.** The engine, control-plane, web console, and the Android companion app are built,
with comprehensive unit + integration tests and cross-model code review. The full self-host stack runs
end-to-end — a `docker compose up` crawl completes through the whole pipeline (validated under Rosetta on
Apple Silicon; see [DEPLOY.md](./DEPLOY.md)). The external-consumer surface is built too: a normalized data
API, HMAC webhooks, an OpenAPI schema, first-party TypeScript + Python SDKs, and the **"Connect with Accrawl"
OAuth flow** third-party apps use to obtain scoped, revocable access. Still open: a 100%-accuracy validation
against a **real bank**, and the broader [Roadmap](#roadmap) items (the planned per-resource data-API
endpoints).

## What it does

```
Operator ─► Web console ──REST + SSE──► Control-plane API ──HTTP──► Engine (Playwright + real Chrome + Gemini)
(browser)   (React SPA)                 (Fastify + Postgres)        │  logs into the bank, extracts data,
                                          • institutions/connections │  writes staged results back to Postgres
                                          • encrypted credentials    │
                                          • crawl orchestration      ▼
                                          • per-connection scheduler  the bank's own site (your session)
                                          • sessions + live SSE
                                          • normalized data API
```

- **Credentials never leave your deployment** except to the bank itself. They're encrypted at rest
  (AES-256-GCM envelope) and only decrypted in-process to drive a login.
- The crawl agent is **designed for read-only access**. A domain-pinned egress guard restricts where
  browser traffic can go. After login, a write gate checks each `POST`/`PUT`/`PATCH`/`DELETE` and
  refuses it unless a request-metadata classifier identifies it as a data read. Because the decision
  uses the request rather than button text, it does not depend on the site's language or script and
  also covers icon-only and unlabelled controls. See
  [Write gate](DEPLOY.md#security-model-what-protects-you) for what it does and does not cover.
- Transaction reconciliation preserves the exact stored row for evidence-backed pending-to-posted
  updates and when replaying stranded staged results after a control-plane interruption. Equal date,
  amount, merchant, or description values are never treated as proof that two observed transactions
  are the same.
- **2FA** can be entered **manually** in the Accrawl console's live session monitor, or **auto-relayed** by
  Companion (it forwards the bank's SMS for server-side code extraction). An optional device-proxy tunnel routes
  the crawl through the phone's residential IP for banks that block datacenter logins.
- **Crawl schedules are configurable per connection** as manual only, daily, weekly, or monthly. Automatic
  crawls follow the selected IANA time zone and begin only after you confirm the sign-in domain. The
  Connections page’s **Next crawl attempt** is the authoritative due time, including any retry backoff.
- **The Android companion can securely view selected financial data.** Pairing grants access only to
  selected connections. Financial access is bound to the phone's screen lock; API responses remain in memory
  during active use and brief interruptions, then are cleared after five minutes of inactivity. Production
  financial requests require HTTPS.
- **Third-party apps can read your data with your consent** via the **"Connect with Accrawl"** OAuth flow
  (Authorization-Code + PKCE): the app sends you to Accrawl's consent screen, you sign in and pick exactly
  which connections to share, and it receives a scoped, ~90-day, revocable token for the normalized data API
  — never your Accrawl password or bank credentials. You register apps and revoke their access over the
  operator API (`/api/oauth-clients`, `/api/grants`); a dedicated console screen for it is not built yet.
  See [docs/spec-oauth.md](./docs/spec-oauth.md).

## Monorepo layout

pnpm workspaces + Turborepo.

```
apps/
  engine/         # crawl worker: Playwright + real Chrome + Gemini, behind a pluggable platform layer
  control-plane/  # Fastify + Postgres API: institutions/connections/credentials, orchestration,
                  #   per-connection cron scheduler, sessions + SSE, the normalized data API + webhooks,
                  #   and the "Connect with Accrawl" OAuth authorization server (clients, consent, grants)
  web/            # React (Vite) operator console: institutions, connections, live session monitor
companion/        # Android (Flutter + native Kotlin): selected financial data, SMS-OTP relay, device proxy
packages/
  contracts/      # @accrawl/contracts — shared types + Zod schemas (the engine⇄API⇄UI contract)
  sdk-ts/         # @accrawl/sdk — first-party TypeScript client (data API, webhooks, OAuth helper)
  sdk-py/         # accrawl — first-party Python client (data API, webhooks, OAuth helper)
e2e/
  oauth-consumer/ # a runnable, dependency-free demo third-party app for the "Connect with Accrawl" flow
```

## Design & reference docs

- **[Market study — aggregator API contracts](./docs/market-study-aggregator-api-contracts.md)** —
  how the industry (Plaid, TrueLayer, SnapTrade, Yodlee, MX, Finicity, Akoya, GoCardless, Salt
  Edge, Yapily, Teller, Moneyhub, Flanks) models accounts, balances, transactions, holdings, and
  liabilities in their public API contracts, with the common-denominator field sets per resource.
- **[Normalized Data API — contract spec](./docs/spec-data-api.md)** *(partially implemented)* —
  the crawl-free, provider-style read contract grounded in that study, covering bank/current,
  savings, credit-card, brokerage, and pension accounts. Its core ships at `/api/v1`
  (the connection directory, accounts/transactions/holdings, a transaction change cursor, refresh +
  sync status, and webhooks); the broader resource endpoints remain a design target. The first-party
  [`@accrawl/sdk`](./packages/sdk-ts/README.md) client implements the shipped endpoints.
- **[OAuth — "Connect with Accrawl"](./docs/spec-oauth.md)** *(implemented)* — the Authorization-Code
  + PKCE flow a third-party app uses to obtain a scoped, revocable token for the data API, with the
  operator as resource owner. Client registration, consent, token/refresh/revoke/introspect, grant
  management, and SDK helpers in both languages.
- **[Hosted cell integration](./docs/hosted-cell.md)** — provider-neutral runtime routing, request-bound
  identity assertions, configurable database/secret partitions, and short-lived workers started per
  crawl. A hosted operator can use one shared document-store data partition for many individual users and
  recipient organisations; a recipient organisation is an application-level tenant, not necessarily an
  infrastructure partition. Crawl capacity comes from short-lived worker executions rather than compute
  reserved for each user. The existing self-hosted mode remains the default.

## Quick start (self-host with Docker)

Requires Docker + Docker Compose v2, and a Google **Gemini API key** (the crawl LLM —
https://aistudio.google.com/apikey). The Docker daemon needn't already be running — `./setup.sh` and
`./accrawl start` start your runtime (colima / Docker Desktop / Linux `docker` service) if it's stopped,
so it works straight after a reboot.

```bash
git clone https://github.com/amersheeny/accrawl.git && cd accrawl
./setup.sh          # guided wizard (or: pnpm setup)
```

`setup.sh` generates the secrets (`POSTGRES_PASSWORD`, `ENGINE_DB_PASSWORD`, `ENGINE_SHARED_SECRET`,
`CREDENTIAL_ENC_KEY`), prompts for the Gemini key + an operator password, asks how you want it served (port,
localhost vs LAN, local HTTP vs a public HTTPS domain), writes `.env`, then builds and starts the stack and
seeds your login. When it finishes, open the printed URL (**http://localhost:8088** by default) and sign in.
The operator password is stored only as an argon2id hash, never in a file.

<details><summary>Prefer to configure it by hand?</summary>

```bash
cp .env.example .env
# fill in .env — generate the random secrets:
#   POSTGRES_PASSWORD / ENGINE_DB_PASSWORD : openssl rand -hex 24
#   ENGINE_SHARED_SECRET                   : openssl rand -hex 32
#   CREDENTIAL_ENC_KEY                     : openssl rand -hex 32   (exactly 64 hex chars)
#   GEMINI_API_KEY                         : from Google AI Studio
./accrawl start          # builds the images (always) and starts the stack
```

Then open **http://localhost:8088** and **create the operator password** on the first-run screen (stored
only as an argon2id hash).
</details>

The stack is four services behind one Caddy front door: `postgres`, `engine` (not host-published; reached
only by the control-plane), `control-plane`, `caddy` (serves the SPA + proxies the API/SSE). By default the
console is published on **http://localhost:8088** — bound to **localhost only** (`127.0.0.1`), so it is not
reachable from other machines until you opt in (`./accrawl set-bind 0.0.0.0`, or a public domain — see
below). The engine runs on **linux/amd64** (real `google-chrome-stable`); on Apple Silicon it must run under
**Rosetta** (not QEMU, which can't run Chrome's sandbox) — see [DEPLOY.md](./DEPLOY.md).

### Running & configuring — the `./accrawl` command

`./accrawl` manages the running stack (it reads `.env`, so every URL and message reflects your actual
port/bind/domain, and it always rebuilds so nothing goes stale):

```bash
./accrawl start            # build (always) + start; prints the URL
./accrawl status           # containers, reachability, and a deployed-vs-source version check (STALE warning)
./accrawl stop             # stop, keeping your data volume
./accrawl update           # rebuild + recreate to pick up new code (git pull && ./accrawl update)
./accrawl logs [svc] [-f]  # tail logs (default --tail=100)
./accrawl open             # open the console in your browser
```

- **Port / bind.** `./accrawl set-port 9000` moves the host port (validated, checked free; offers to fix
  `ENGINE_WS_URL` if it embedded the old port). `./accrawl set-bind 0.0.0.0` opens it to your LAN (default
  `127.0.0.1` = localhost only). Both atomically rewrite `.env` (preserving `0600` and every other line)
  and recreate the stack. The internal container port never changes; only the host publish side does.
- **Public domain + HTTPS.** Set `ACCRAWL_DOMAIN` (via `setup.sh`, or in `.env`) and `./accrawl`/`setup.sh`
  automatically switch to serving that domain on `:80/:443` with a real Let's Encrypt certificate (Caddy
  ACME), persisting certs across restarts. Point the domain's DNS at the host and open 80+443.
- **Version / staleness.** Every build bakes in the git short SHA; the control-plane serves it at
  `GET /version` and the console footer shows it. `./accrawl status` compares the running build to your
  working tree and tells you to `./accrawl update` if it's stale.
- **Start automatically.** `./accrawl install-service` generates a systemd service that starts Accrawl when
  Linux boots or a launchd agent that starts it when you sign in to macOS; `--enable` installs and activates
  it. Scheduled crawls run only while the stack is available. If it was offline at the scheduled time,
  Accrawl recovers the overdue crawl when the stack next starts. `./accrawl uninstall-service` reverses the
  installation.
- **Companion Android app.** On your Android phone, open the Accrawl console, go to **Companion**, and select
  **Download for Android**. If the console is open on another device, scan the download QR with your phone
  instead. Both options serve the app from the console's own domain — no third-party store, and nothing
  leaves your deployment. A self-host serves whatever it publishes: build the app with `./accrawl companion
  build`, put it somewhere your deployment can reach, and set `COMPANION_APK_UPSTREAM` and
  `COMPANION_APK_PATH` (see `.env.example`). Until those are set the route is not served at all, rather
  than handing anyone a copy this deployment did not build. Open the downloaded
  APK and follow Android's prompts; if asked, allow your
  browser to install apps from this source. Then return to **Companion** in the console and select **Create
  pairing request**. Developers can build from source instead with `./accrawl companion build` or build and
  install on a connected phone with `./accrawl companion install` (`--device <serial>` when several phones are
  attached). Use `./accrawl companion devices` to list connected phones.
- **Headless / scripted.** `setup.sh` runs with no prompts when `--yes` (or `ACCRAWL_ASSUME_YES=1`) is set
  and inputs come from the environment — `GEMINI_API_KEY`, `ACCRAWL_PORT`, `ACCRAWL_BIND` (or `--lan`),
  `ACCRAWL_DOMAIN`/`ACCRAWL_TLS_EMAIL`, and the admin password from `ACCRAWL_ADMIN_PASSWORD_FILE` (a file
  path — never a plain env var, so it can't leak via `/proc/environ`). The destructive DB reset is gated
  behind a separate explicit `--reset-db` (never implied by `--yes`). See [DEPLOY.md](./DEPLOY.md).

See **[DEPLOY.md](./DEPLOY.md)** for the full walkthrough (first crawl, the anti-phishing verify-domain
step, TLS/remote access, and the validation procedure).

### Required configuration

| Variable | Purpose |
|---|---|
| `POSTGRES_PASSWORD` | Postgres superuser password (control-plane's privileged role) |
| `ENGINE_DB_PASSWORD` | Least-privilege engine DB role — can touch only telemetry/staging, never credentials |
| `ENGINE_SHARED_SECRET` | Bearer the control-plane sends the engine (the engine isn't host-published) |
| `CREDENTIAL_ENC_KEY` | AES-256-GCM master key for credential encryption at rest (64 hex chars; set once) |
| `GEMINI_API_KEY` | Google Gemini API key — the crawl LLM (**required**) |
| `REQUEST_VET_MODEL` | Model the write gate uses to classify each uncached `POST`/`PUT`/`PATCH`/`DELETE` after login as a data read or a write (optional; defaults to `gemini-2.5-flash-lite`). If the model cannot be reached or does not return a verdict, that request is refused |
| `CHROMIUM_DISABLE_SANDBOX` | Set to `1` when the runtime blocks `clone(CLONE_NEWUSER)`, which Chromium's sandbox requires. The bundled Compose stack sets this because its default seccomp profile blocks that syscall. When unset, Chromium's sandbox remains enabled. See [Security model](DEPLOY.md#security-model-what-protects-you) |
| `COMPANION_PUSH_PROJECT_ID` | The push project this deployment sends Companion wake-ups through (optional; unset means codes are typed into the console) |
| `COMPANION_PUSH_CREDENTIALS_FILE` | In-container path to that project's sender key, mounted read-only |
| `COMPANION_PUSH_CLIENT_APP_ID`, `COMPANION_PUSH_CLIENT_API_KEY`, `COMPANION_PUSH_CLIENT_SENDER_ID` | Handed to a paired Companion so it registers with this deployment's project. These three and `COMPANION_PUSH_PROJECT_ID` are answered together — all four or none |

The **operator password is not an env var** — you set it on first launch (first-run setup) and it's stored
as an argon2id hash. `ENGINE_SHARED_SECRET`, `CREDENTIAL_ENC_KEY` and the Companion sender key take the
`_FILE` convention (`<NAME>_FILE` → a mounted file path) so they can live outside the repo; the database
passwords and the model key are read from the environment. See `docker-compose.yml` and `DEPLOY.md`.

## Local development (without Docker)

```bash
pnpm install
pnpm build       # turbo: contracts → engine/control-plane/web
pnpm test        # each package's unit + integration tests (pglite-backed; no external services)
pnpm typecheck
```

To run the stack from source you need a local **Postgres** (the queue/scheduler is Postgres-native, so
SQLite is not an option), then, with the env vars from the table above exported:

```bash
pnpm --filter @accrawl/control-plane dev     # Fastify on :3000 (DATABASE_URL -> your Postgres)
pnpm --filter @accrawl/engine dev            # engine on :8080 (PLATFORM=postgres, ENGINE_DATABASE_URL)
pnpm --filter @accrawl/web dev               # Vite on :5173, proxies /api to :3000
```

The **engine alone** also runs standalone with just a `GEMINI_API_KEY` (`PLATFORM=local`: filesystem
artifacts, file-based OTP, no Postgres) — see [`apps/engine/README.md`](apps/engine/README.md).

## Dependencies & data flow

- **Google Gemini API is required** — the crawl agent is LLM-driven and Gemini-based (`@google/genai`,
  needs `GEMINI_API_KEY`). This is the one external service the self-host stack always calls out to. Page
  content and extracted data are sent to Gemini to function; state this plainly to your users.
- **The core self-hosted stack does not require Firebase or GCP infrastructure; event-driven Companion
  wake-up does.** Docker Compose uses PostgreSQL and `ENGINE_SHARED_SECRET`. A self-hosted control plane and the
  Companion paired with it must use the same push project, but the published app carries none of its own:
  it asks the deployment it pairs with which project to register with, so there is no need to rebuild it.
  Configure `COMPANION_PUSH_PROJECT_ID`, mount the sender key read-only, set `COMPANION_PUSH_CREDENTIALS_FILE`
  to its in-container path, and supply the three client values as described in [`DEPLOY.md`](DEPLOY.md). When a crawl needs OTP relay or a device-proxy tunnel, the control
  plane requests a high-priority, data-only FCM wake-up. After pairing, Accrawl Companion registers its
  Firebase Cloud Messaging (FCM) registration token through the paired-device API. It refreshes the
  registration when Firebase delivers a replacement through `onNewToken` and whenever the app opens. The
  token is only a delivery address for data-only wake-ups; it does not authorize a crawl or start a service.
  Accrawl Companion starts a service only after the paired-device API confirms that the requested session is
  still active. FCM carries session-routing metadata only. It does not carry tunnel credentials, SMS
  messages or codes, or financial data. For event-driven OTP wake-ups outside Docker Compose, the engine
  also requires `CONTROL_PLANE_INTERNAL_ORIGIN`; Docker Compose sets it automatically. A hosted
  deployment supplies its own document store, screenshot archive, deferred-callback queue, crawl
  dispatch, and the means by which its workers prove themselves; none of those is required to run
  Accrawl yourself.

## Security & responsible use

Accrawl handles bank credentials and runs an LLM agent inside your authenticated bank session. Before you
deploy or contribute, understand:

- Use it for **your own accounts** under the PSD2 / personal-data-access posture above.
- The engine container runs **non-root with dropped capabilities**; the engine is never published to the
  host. A worker that runs against the database uses an exact column allowlist and a per-crawl
  row-level-security capability. A worker that runs elsewhere has no database or screenshot-store access
  at all and exchanges session data only through the authenticated broker, after proving which single
  execution it is. Neither worker receives the durable store of encrypted connection credentials.
- `:8088` is plain HTTP for local use — front it with TLS (a real domain on `:443`, or upstream TLS)
  before exposing it on a network.
- Security reports go through GitHub private vulnerability reporting — see [SECURITY.md](./SECURITY.md). Until
  then, report security issues privately to the maintainer rather than via a public issue.

## Roadmap

Built: engine · control-plane · web console · docker-compose deploy · the Android companion (selected
financial data + SMS-OTP relay + device-proxy tunnel) · the normalized data API · HMAC webhooks · OpenAPI schema · first-party
TypeScript + Python SDKs · the "Connect with Accrawl" OAuth flow (clients, consent, grants, refresh/revoke) ·
email/IMAP OTP tier · private user institution recipes plus workspace-published copies · community
institution-config import + LLM malice-scan gate. Not yet done: a
100%-accuracy validation against a **real bank** · the planned per-resource data-API endpoints
(institution/account/security detail — see [spec-data-api §2](./docs/spec-data-api.md)) · a formal
[SECURITY.md](./SECURITY.md).

## License

[AGPL-3.0-only](./LICENSE).
