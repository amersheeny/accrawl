# Accrawl end-to-end validation

A **real** end-to-end run — the closest thing to a live bank without one. It proves the whole pipeline,
including the 2FA/OTP handshake, works when the services are actually assembled and running.

## What it does

1. Starts a **real PostgreSQL** (`embedded-postgres`, no Docker) and applies the control-plane migrations.
2. Spawns the **engine** (`PLATFORM=postgres`) and the **control-plane** as **separate processes** sharing
   that database, plus a **fake bank** website (`fake-bank.mjs`: login → SMS 2FA → an accounts/transactions
   dashboard with known data).
3. Drives the actual product HTTP API: operator login → create institution → create connection (credentials
   are encrypted) → verify the login domain (anti-phishing gate) → `POST /api/connections/:id/crawl`.
4. The engine logs into the fake bank with **Playwright + the Gemini agent**, reaches the 2FA page, and blocks
   on the code. A **simulated SMS relay** (`run-e2e.mjs`) watches the shared DB; when the engine requests the
   OTP it captures the SMS body the bank "sent" and submits it via the real
   `POST /api/sessions/:id/otp` route. The control plane extracts the code with the configured LLM; the
   engine reads it, enters it, and extracts the data.
5. Asserts the canonical `accounts`/`transactions` match the bank's ground truth **exactly**, and that the
   session actually passed `waiting_for_otp → logging_in → completed` with the OTP consumed.

The OTP is a **random** code per run, so a pass proves the engine read and entered the actually-sent code.

## Run

```bash
export PATH="$HOME/.nvm/versions/node/v26.6.0/bin:$PATH"   # node >= 26.6
e2e/run-e2e.sh
```

A model API key is required (the engine is an LLM agent): set `GEMINI_API_KEY`. Because it makes real LLM
calls and launches Chrome, this is an **opt-in** validation, not
part of `pnpm test`. The host-resolver override (`EXTRA_CHROMIUM_ARGS`) points the bank's domain at loopback,
so no `/etc/hosts` change is needed.

## Companion relay mode (real phone-relay path)

By default the OTP is relayed in-process. `COMPANION_RELAY=1` instead routes it through the **real Accrawl
Companion app on an Android emulator** — proving the full phone-relay path, not a stub:

**You do not supply the push settings.** The Companion carries no push project of its own — it asks
this run's control plane, which must answer all four values or none. The run reads them straight out
of the Android client configuration already present in the Companion build tree, selecting the entry
whose application id matches the flavor this run installs. Building the app for a relay run requires
that configuration anyway, so on any machine where this gate can run, the values are already there.

Nothing to copy, and nothing to remember. Override only if that file lives elsewhere:

| Setting | When you need it |
| --- | --- |
| `COMPANION_PUSH_CLIENT_CONFIG` | Path to the Android client configuration, when it is not in the build tree |
| `COMPANION_PUSH_PROJECT_ID`, `COMPANION_PUSH_CLIENT_APP_ID`, `COMPANION_PUSH_CLIENT_API_KEY`, `COMPANION_PUSH_CLIENT_SENDER_ID` | Only to point a run at a different project than the build's |

The run **asserts the app registered for push before the crawl starts**, so invented values fail
fast — they must belong to a real project.

`GEMINI_API_KEY` and `EMULATOR_LEASE_SCRIPT` are read from `.env` (untracked) when not exported, like
every other way of running this product. So a relay run needs only what is genuinely per-session:

```bash
export EMU_SESSION="<stable-session-id>"
export EMULATOR_SERIAL="$("$(sed -n 's/^EMULATOR_LEASE_SCRIPT=//p' .env)" claim)"
COMPANION_RELAY=1 e2e/run-e2e.sh
```

The emulator must be visible. Every ADB action is routed through the lease wrapper, which verifies ownership
before touching the device. The runner serializes the complete workflow because its Android build and
embedded-database paths are shared. Companion APKs are built one flavor at a time in an isolated temporary
workspace, and that workspace is removed after the run so multi-gigabyte Flutter outputs do not remain in
the repository. Set `ACCRAWL_E2E_KEEP_APKS=1` only when the two debug APKs are needed for diagnosis; the
runner prints their temporary directory when it retains them. It serves the built React console, uses the
real Institutions and Connections forms to add the fake bank, save its credentials, and confirm its sign-in
domain, then creates the exact-connection pairing request in the Devices page. It sets an Android screen-lock
PIN on the emulator and completes the real five-minute phone claim → code comparison in both rendered
clients → console approval → Accrawl device-credential flow bound to that Android screen lock, all against
the same server and PostgreSQL database.

Before the crawl, the harness completes the Android screen-lock prompt once during pairing, confirms that
the authenticated session opens the empty Accounts and Transactions states without another prompt, and
captures both rendered states. During the crawl, `sms-to-emulator.mjs` injects the bank's OTP SMS through the
emulator console once the session is awaiting a code; the native companion service captures it and submits
it on its device-authenticated channel.

After the crawl, if the five-minute inactivity period expired during the crawl, the harness unlocks the
Accrawl financial credential again. It then verifies the real account names, balances, and transactions in
both the web Accounts page and Android accessibility semantics; confirms that the web page has finished
loading; and captures the rendered web page and the Android light, dark, amount-private, and large-text
states. It briefly backgrounds and resumes the app to confirm that the session remains unlocked, then leaves
the app inactive for five minutes to confirm that financial data is cleared and a new unlock is required.
It then initiates self-revocation in the Companion app and checks PostgreSQL to confirm that both linked
Accrawl device credentials are revoked. It also installs the secure build and verifies that its Android
window has screenshot blocking enabled. Both relay modes also assert the same canonical PostgreSQL ground
truth and OTP-leak protections.

## Not covered here

A run against a **real bank** with your own credentials, through the full `docker compose up` stack, remains
the final manual gate (this harness runs the services as plain processes against an embedded Postgres). The
emulator companion mode above covers the SMS-transport path end to end.
