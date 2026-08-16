# Accrawl

**Self-hostable financial account crawler.** Accrawl logs into your own bank and
brokerage accounts with a headless browser driven by an LLM agent, and retrieves
all supported accounts, transactions, and positions. Account balances are
included in the account records. The normalized result is returned as JSON over
an HTTP API — a credential-based, self-hosted analogue of open-banking
aggregators (Plaid / TrueLayer / Salt Edge) for institutions or data they do not
cover.

- **LLM-driven, not hardcoded.** A Gemini agent navigates each site and extracts
  data; there are no per-bank scraping scripts baked into the engine. Institution
  hints/playbooks are runtime data, not code.
- **Runs anywhere.** A pluggable platform layer runs the same engine with zero cloud
  dependencies locally (`PLATFORM=local`), behind the self-host control plane + Postgres
  (`PLATFORM=postgres`, the docker-compose default), or as a one-shot worker that holds no
  persistence of its own and talks to the control plane through an authenticated broker
  (`PLATFORM=remote`). A deployment can register a platform of its own and select it by name.
- **Real Chrome.** Uses system Google Chrome via Playwright for site compatibility.
- **Occurrence-preserving transaction deltas.** Until a connection completes its first transaction crawl,
  the engine requests every transaction in its 90-day window. Each later crawl compares bank rows one to
  one with the complete stored seven-day window. It treats cosmetic description changes as the same
  transaction, updates pending transactions and newly assigned bank references in place, and preserves
  look-alike transactions as separate occurrences. The model reports genuinely identical rows with an
  explicit `count`; accidental repeated reports are ignored.
- **Resilient exports and long pages.** Excel workbooks are recognized by content even when an
  export has no filename extension, workbook-formatted dates are normalized to ISO dates, and
  bounded page-inspection turns preserve observed data before continuing.

## ⚖️ Positioning & legal

Accrawl is intended for accessing **your own accounts, on your own behalf, with
your own credentials** — personal/self-hosted data access. It is **not** a
hosted third-party aggregation service. In the EU/UK, PSD2's RTS restricts
unidentified third-party impersonation of a customer's online banking; running
this tool for yourself is a different posture from operating a TPP at scale. You
are responsible for complying with your institutions' terms and your local law.

## Quickstart (local)

```bash
cp .env.example .env        # set GEMINI_API_KEY; PLATFORM defaults to local
pnpm install
npm run build
npm start                   # SERVICE_MODE=development → all routes on :8080
```

Start a crawl (credentials are supplied in the request body; `PLATFORM=local`
needs no auth and writes run artifacts to `./runs/<sessionId>/`):

```bash
curl -X POST localhost:8080/crawl -H 'content-type: application/json' -d '{
  "sessionId": "demo-1",
  "loginUrl": "https://example-bank.test/login",
  "username": "me", "password": "secret",
  "requires2fa": false,
  "maxSteps": 40, "timeoutSeconds": 300
}'
```

The response is the normalized `CrawlResponse` (`accounts` / `positions` /
`transactions` / `cost` / `stepLogs`). For 2FA institutions, write the code to
`./runs/<sessionId>/otp.txt` (or set `OTP_<sessionId>`) when prompted.

Under `PLATFORM=postgres` (the orchestrated self-host stack) the contract is
different: `/crawl` replies `202 { accepted: true }` immediately and runs the
crawl in the background — the control-plane reads progress and the final
outcome from the session tables, never from a held HTTP response (which
standard ~5-minute client/proxy header timeouts would kill mid-crawl).
For a device-proxy crawl, that background run waits for the institution's
configured crawl timeout for the paired companion tunnel before failing closed.

## Platform model

| Concern | `PLATFORM=local` (default) | `PLATFORM=postgres` (self-host stack) | `PLATFORM=remote` (one-shot worker) |
|---|---|---|---|
| Session telemetry / results | JSON under `runs/<id>/` | Postgres, least-privilege engine role (staging tables only) | Private authenticated broker; no direct database access |
| Screenshots | `runs/<id>/step-NNN.jpg` | `${SCREENSHOT_DIR}/sessions/<id>/` (mounted volume), or wherever a registered screenshot archive puts them | Immutable upload through the broker; no bucket credentials |
| 2FA codes | `runs/<id>/otp.txt` / `OTP_<id>` env | session-column handshake (control-plane / companion relay writes `sessions.otp`) | Broker-mediated one-time consume |
| Credential delivery | Request body | Control plane decrypts and passes credentials | Returned only after the worker proves which execution it is and presents its one-time claim factor |
| Cloud deps required | **none** (just `GEMINI_API_KEY`) | **none** (just `GEMINI_API_KEY`) | **none in this repository** — the deployment that starts the worker registers how it proves itself |

A deployment can add its own platform with `registerPlatform(name, factory)` before the engine starts;
`PLATFORM` then selects it by name. `postgres` is an `optionalDependency` — a pure-local install can
`pnpm install --no-optional` and never pull it.

`PLATFORM=remote` needs worker credentials registered with `registerRemoteWorkerCredentials()`: which
single execution this process is, a `fetch` carrying its identity, and how to read the one-time claim
factor the control plane left for it. Those are mechanics of whatever started the worker, so they are
supplied rather than built in; the claim protocol and the fence it enforces stay here.

## HTTP API

| Method | Path | Notes |
|---|---|---|
| `GET` | `/` | Health: `{status, service, mode, activeSessions}` |
| `POST` | `/crawl/transaction-history` | Internal control-plane upload for large seven-day transaction histories. Chunks must arrive in order and pass per-chunk and complete-history SHA-256 checks before the crawl starts. |
| `POST` | `/crawl` | Run a crawl. `PLATFORM=local`: synchronous `CrawlResponse`. `PLATFORM=postgres`: immediate `202` ack; outcome lands on the session tables |
| `POST` | `/cancel/:sessionId` | Force-kill a running crawl on this instance |
| `WS` | `/tunnel` | Device-proxy crawl, authenticated with a short-lived session+device-bound HMAC tunnel token. |

`SERVICE_MODE` splits the surface for deployment: `crawl` (the auth-gated `/crawl`,
`/crawl/transaction-history`, and `/cancel`; in the
self-host `PLATFORM=postgres` stack this also serves the companion `/tunnel` WS from the same container),
`tunnel` (the WebSocket alone), or unset/`development` (everything, for local dev).
`PLATFORM=remote` instead runs `dist/job-worker.js` as a one-shot process and
does not expose this HTTP surface.

### Who may call `/crawl` and `/cancel`

Exactly one caller should reach them: the control plane. `ENGINE_INBOUND_AUTH` says how it proves that.
Leave it unset and the engine infers the mode from what else is configured, so an existing deployment
needs no new variable.

| `ENGINE_INBOUND_AUTH` | What the caller presents | Also needs |
|---|---|---|
| `shared-secret` (inferred when `ENGINE_SHARED_SECRET` is set) | `ENGINE_SHARED_SECRET` as the bearer. The docker-compose default: the engine is not published to the host, so this sits behind the internal network. | — |
| `token` (inferred when `CRAWLER_AUDIENCE` is set) | A signed identity token from an issuer both sides trust. | `CRAWLER_AUDIENCE` (this service's URL — mandatory in production, else the engine refuses to start) and `OIDC_ISSUER` (its keys are found through the issuer's discovery document; override with `OIDC_JWKS_URL`). Optionally `ENGINE_ALLOWED_CALLER` to pin the accepted identity. |
| `none` (inferred when neither is set) | Nothing. Local development, or a deployment that authenticates in front of the engine. | Setting it explicitly records that this is deliberate and silences the production warning. |

A deployment whose identities are not OIDC can register its own verifier with
`registerInboundIdentityVerifier()` before the server starts.

## License

[AGPL-3.0-only](../../LICENSE). If you run a modified version as a network service,
the AGPL requires you to offer your users the source of your modifications.
