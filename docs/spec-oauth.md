# Accrawl OAuth — "Connect with Accrawl"

> **Status: implemented.** The Authorization-Code + PKCE flow, client registration, the consent
> screen, token/refresh/revoke/introspect, grant management, and the `grant.revoked` webhook all ship
> in the control-plane (`apps/control-plane/src/routes/oauth.ts`, `oauth-clients.ts`, `oauth-grants.ts`).
> First-party OAuth helpers ship in both SDKs (`AccrawlOAuthClient` in
> [`@accrawl/sdk`](../packages/sdk-ts/README.md) and [`accrawl`](../packages/sdk-py/README.md)), and a
> runnable third-party demo app lives in [`e2e/oauth-consumer/`](../e2e/oauth-consumer/README.md).

This is the flow a **third-party app** uses to read Accrawl data approved by an individual user. The user
clicks *Connect with Accrawl* in the third-party app, Accrawl opens its consent screen, the user signs in and
picks exactly which connections to share, and the app receives a scoped, time-boxed access token. It never sees the user's
Accrawl password or bank credentials.

The data the token then reads is the crawl-free [Normalized Data API](./spec-data-api.md); OAuth is only how
an app *obtains* a scoped key for it.

---

## 1. Roles

Accrawl is a **single-operator, self-hosted** deployment, so the OAuth roles map slightly differently from a
multi-tenant provider:

| OAuth role | Who |
|---|---|
| Authorization Server + Resource Server | the Accrawl deployment (control-plane) |
| Resource owner | the **operator** (the person who self-hosts and owns the data) |
| Client | a registered third-party app |

Because the operator *is* the resource owner, consent is confirmed with the **operator password** (a fresh
authorization at approval time), not a separate end-user account system.

---

## 2. The flow

```
 Third-party app                 Operator's browser              Accrawl control-plane
 ───────────────                 ──────────────────              ─────────────────────
 "Connect with Accrawl"  ──302──► GET /oauth/authorize ─────────► validate client_id + EXACT redirect_uri
   (client builds the URL,                                        render SIGN-IN page (scopes only — NOT
    generates PKCE + state)       operator enters Accrawl          the connection list)
                                  password  ────────────────POST─► POST /oauth/authorize/decision  (step 1)
                                                                   verify password → render connection picker
                                  ◄──────── connection picker + short-lived consent ticket ────────
                                  operator ticks connections,
                                  approves  ────────────────POST─► POST /oauth/authorize/decision  (step 2)
                                                                   verify ticket → mint single-use code
                                  ◄──────── 302 redirect_uri?code&state ──────────
 GET /callback?code&state
   (verify state)
 POST /oauth/token  ────────────────────────────────────────────► exchange code + PKCE verifier (+secret)
   grant_type=authorization_code                                  → { access_token, refresh_token,
                                                                       expires_in, scope }  + create grant
 GET /api/v1/connections/:id/accounts  (Authorization: Bearer acck_…)  ─► the Normalized Data API
```

1. **Authorize** — `GET /oauth/authorize` with `response_type=code`, `client_id`, `redirect_uri`, `scope`,
   `state`, `code_challenge`, `code_challenge_method=S256`. Accrawl validates the client and the **exact**
   redirect_uri, then renders a **sign-in** page naming the app + requested scopes. It does **not** list the
   operator's connections — that inventory is private and is never shown before the operator authenticates
   (anyone who knows a registered `client_id` + `redirect_uri` can reach this endpoint).
2. **Consent (two steps, one password)** — consent is authenticate-first, both steps posting to
   `POST /oauth/authorize/decision`:
   - **Step 1 — sign in.** The operator submits their Accrawl password. On success Accrawl renders the
     connection **picker**, carrying a short-lived (~10 min), request-bound **consent ticket** that proves the
     password check happened. A wrong password re-renders sign-in; it never reveals connections.
   - **Step 2 — approve.** The operator ticks which connections to share and approves. Choosing **All current
     connections** stores the IDs of all connections available at the time of authorisation; it does not
     include connections added later. To share a connection added later, the user must authorise again. The
     request carries the ticket back (no password re-entry). Accrawl verifies the ticket is valid for **this
     exact request**, mints a single-use **authorization code**, and 302-redirects to
     `redirect_uri?code&state`.

   **Deny** at either step redirects with `error=access_denied` — cancelling never requires a password.
3. **Token** — the app's server exchanges the code at `POST /oauth/token`
   (`grant_type=authorization_code`, `code`, `redirect_uri`, `code_verifier`, client auth) for
   `{ access_token, token_type, expires_in, refresh_token, scope }`.
4. **Use** — the access token uses the same scope and connection-grant checks as an operator-minted key,
   and reads the Normalized Data API (`/api/v1`). Every crawl-side route — run trigger, session status,
   crawl history, extracted records, step timeline, screenshots, OTP submission — is closed to it, as it is
   to any API key.
5. **Refresh / revoke** — the app rotates the pair at `/oauth/token`
   (`grant_type=refresh_token`) and drops access at `/oauth/revoke`.

---

## 3. Client registration

Each third-party app must be registered before it can run the flow. Hosted
organisation administrators register apps in their organisation dashboard. The
dashboard calls tenant-scoped endpoints and never accepts an organisation id
from the registration form. Self-hosted operators retain the deployment-wide
operator endpoints. Both surfaces use the same shared registration contract
and OAuth registry in `apps/control-plane/src/routes/oauth-clients.ts`.

| Method | Path | Body / result |
|---|---|---|
| POST | `/api/oauth-clients` | `{ name, redirectUris[], allowedScopes[], isPublic? }` → `{ id, clientId, clientSecret }` |
| GET | `/api/oauth-clients` | `{ clients: [...] }` — never the secret or its hash |
| DELETE | `/api/oauth-clients/:id` | `204` — permanently disables the client, excludes it from active listings, prevents recreation with the same idempotency key, and makes all authorization codes, grants, access tokens, and refresh tokens issued for it unusable |
| POST | `/api/organizations/:organizationId/oauth-clients` | Organisation-admin registration; the route id must match the signed administrator capability |
| GET | `/api/organizations/:organizationId/oauth-clients` | Lists only that organisation's active clients |
| DELETE | `/api/organizations/:organizationId/oauth-clients/:id` | Disables only a client owned by that organisation and invalidates its credentials |

- **`clientId`** is `accl_…`; **`clientSecret`** is `acls_…`, shown during the idempotent creation attempt and stored only as a
  hash. A **public** client (`isPublic: true`, e.g. a native or installed app) has no secret — it is bound to the
  flow by PKCE alone. A **confidential** client (default) authenticates the token exchange with its secret.
- **`redirectUris`** is an allowlist of 1–10 unique entries. Each must be an absolute **HTTPS** URL, or an
  HTTP loopback URI on `localhost`, `127.0.0.1` or `[::1]`, with no user information or fragment. The complete
  value is matched exactly at authorization time except that a native loopback URI's port may vary; token
  exchange then matches the exact URI bound into the authorization code. Custom URI schemes are not supported.
- **`allowedScopes`** is the ceiling consent can never exceed, drawn from the closed API scope set (§5).
- Hosted client records carry the recipient organisation id. List and disable
  operations apply that id in the storage query as well as the authorization
  check, so guessing another tenant's internal client id cannot cross the
  tenant boundary.

---

## 4. Endpoints

All under the deployment's front door. The token/revoke/introspect endpoints accept
`application/x-www-form-urlencoded` and authenticate the client via HTTP Basic (`client_secret_basic`) or
body params (`client_secret_post`); a public client presents only its `client_id`.

| Method | Path | Purpose | Auth |
|---|---|---|---|
| GET | `/oauth/authorize` | render the sign-in step (or a safe error / redirect) — no connections shown | — (operator authenticates at decision) |
| POST | `/oauth/authorize/decision` | step 1: password → picker + ticket; step 2: ticket → mint code | operator password (step 1) + consent ticket (step 2) |
| POST | `/oauth/token` | `authorization_code` or `refresh_token` grant → tokens | client |
| POST | `/oauth/revoke` | RFC 7009 revocation | client |
| POST | `/oauth/introspect` | RFC 7662 introspection | client |
| GET | `/api/grants` | operator's "connected apps" list | operator |
| DELETE | `/api/grants/:id` | revoke a grant (kills its tokens) | operator |

### Token response (`/oauth/token`)

```jsonc
{
  "access_token": "acck_…",   // an Accrawl API key, usable directly on /api/v1
  "token_type": "Bearer",
  "expires_in": 3600,          // the ACCESS token's own clock — refresh before it runs out
  "refresh_token": "acrt_…",
  "scope": "read:data"         // space-delimited granted scopes
}
```

Errors follow RFC 6749 §5.2: `{ "error": "...", "error_description": "..." }` with a 4xx status
(`invalid_request`, `invalid_grant`, `invalid_client`, `invalid_scope`, `unsupported_grant_type`).

---

## 5. Scopes

The same closed set as operator-minted API keys — there is **no** superuser scope. Consent can only narrow
within the client's registered `allowedScopes`.

| Scope | Grants | Consent-screen label |
|---|---|---|
| `read:data` | read accounts / balances / transactions / holdings | "Read your accounts, balances, transactions and holdings" |

`read:data` is the entire set, for both OAuth grants and operator-minted keys: the API only reads
(see [spec-data-api](./spec-data-api.md)). A registration naming any other scope is rejected.

Every issued token is **also** scoped to the explicit set of connection IDs the
operator selected. Choosing **All current connections** stores the IDs of all
connections available at the time of authorisation; it does not include
connections added later. To share a connection added later, the user must
authorise again. Requests for a connection outside the stored grant return
`403`, just as they do for a manual API key.

**There are no write scopes, by design** — the API is read-only in the strongest sense: no payment
initiation, transfers or trades, and no retrieval controls either (no refresh trigger, no run status, no
one-time-passcode relay). Acting on an institution is the account owner's, in their own console (see
[spec-data-api §14](./spec-data-api.md#14-non-goals)).

---

## 6. Grants & token lifetime

A **grant** is the standing consent for one client — its scopes, its connections, and a **~90-day expiry**
(the operator's "3-month" clock). Every token is bounded by it: **a refresh rotates the pair within that
window, it never extends it.** When the grant expires (or is revoked), every token under it stops working.

The access token expires **far sooner than the grant — one hour**. It is a bearer credential for somebody's
financial data, so a copy lifted from a log, a proxy or a client's storage must go stale quickly; giving it
the grant's clock meant a leaked token read that data for a quarter of a year, and left the rotation below
with nothing to do. Refreshing is therefore a normal part of using this API, not an edge case, and both
first-party SDKs implement it.

- **Access token** — an `api_keys` row (`acck_…`) with a `grant_id`, valid for one hour and never past the
  grant. Deleting/revoking the grant also cascades to it, so revocation is immediate rather than waiting
  even for that hour.
- **Refresh token** — `acrt_…`, single-use with **rotation + reuse detection**: each refresh consumes the
  presented token and issues a new one. Replaying an already-consumed refresh token is treated as theft and
  **revokes the entire grant** (both tokens), per OAuth 2.1 / RFC 9700.
- **Connected-apps management** — the operator sees every grant at `GET /api/grants` (which app, which
  scopes + connections, granted-at, expiry, status) and revokes one with `DELETE /api/grants/:id`.

---

## 7. Security properties

- **PKCE S256 is mandatory for every client** — public and confidential — per OAuth 2.1 / RFC 9700. An
  authorize request without a `code_challenge` is rejected; only S256 is accepted (never `plain`).
- **Registered redirect_uri match** against the allowlist, permitting only the OAuth 2.1 native-loopback
  port exception at authorization and requiring the code-bound URI exactly at exchange; never inferred.
- **Authorization codes** are stored only as a hash, expire in **5 minutes**, and are **atomically
  single-use** (a replay is `invalid_grant`).
- **Fresh authorization at consent** — approval requires the operator password every time, so a drive-by
  authorize can't grant access from an already-open browser session.
- **Authenticate-first consent** — `GET /oauth/authorize` is reachable by anyone who knows a registered
  `client_id` + `redirect_uri`, so it reveals **nothing** about the operator's connections. The connection
  picker is shown only after the password check (step 1). Proof of that check is carried to approval (step 2)
  by a short-lived **consent ticket**: HMAC-signed with the operator credential's signing secret and bound to
  the exact request (client + redirect + scope + PKCE challenge), so it can't be replayed onto a different
  authorize request and — unlike an operator session token — grants nothing beyond completing this one consent.
- **Scope clamping** — requested scopes are intersected with both the client's `allowedScopes` and the
  closed API scope set; anything else is `invalid_scope`.
- **Confidential-client secrets** are compared in constant time and stored only hashed.
- **Introspection is owner-scoped** — `/oauth/introspect` reveals a token as active only to the client whose
  grant issued it. **Revocation gives no token-existence oracle** — `/oauth/revoke` always returns `200`.
- **`grant.revoked` webhook** — when the operator revokes a grant, Accrawl fires a `grant.revoked` webhook
  (naming the `grantId` and the app's `clientId`) so a consumer learns its access is gone rather than only
  discovering it on the next `401`. Fire-and-forget; a receiver never gates the revoke.

---

## 8. Using the SDK helpers

Both first-party SDKs ship a server-side OAuth helper that generates PKCE, builds the authorize URL, and
handles the token/refresh/revoke calls. TypeScript:

```ts
import { AccrawlOAuthClient } from '@accrawl/sdk';

const oauth = new AccrawlOAuthClient({
  baseUrl: 'https://accrawl.example.com',
  clientId: process.env.ACCRAWL_CLIENT_ID!,
  clientSecret: process.env.ACCRAWL_CLIENT_SECRET!, // omit for a public client
  redirectUri: 'https://app.example.com/callback',
});

// 1. Start: redirect the browser to `url`; persist `state` + `codeVerifier` on the user's session.
const { url, state, codeVerifier } = oauth.startAuthorization({ scope: 'read:data' });

// 2. On the callback: verify `state`, then exchange the code.
const tokens = await oauth.exchangeCode({ code, codeVerifier });

// 3. The access token IS an Accrawl API key — read the consented data.
import { AccrawlClient } from '@accrawl/sdk';
const api = new AccrawlClient({ baseUrl: 'https://accrawl.example.com', apiKey: tokens.access_token });

// 4. Later: rotate, or disconnect.
const rotated = await oauth.refresh({ refreshToken: tokens.refresh_token });
await oauth.revoke({ token: rotated.refresh_token, tokenTypeHint: 'refresh_token' });
```

Python (`accrawl.AccrawlOAuthClient`) mirrors this API (`start_authorization`, `exchange_code`, `refresh`,
`revoke`). See the [Python SDK README](../packages/sdk-py/README.md). A complete, dependency-free consumer
app is in [`e2e/oauth-consumer/`](../e2e/oauth-consumer/README.md).

---

## 9. Relationship to the rest of Accrawl

- **What the token reads:** the [Normalized Data API](./spec-data-api.md) (`/api/v1`). OAuth is orthogonal to
  that contract — it only mints the scoped key.
- **Operator-minted keys still exist:** the operator can mint API keys directly (no OAuth) for their own
  scripts; OAuth is specifically for granting *other apps* scoped, revocable, time-boxed access.
- **The crawl surface stays internal, and unreachable:** a third-party app never sees crawl/session
  vocabulary — and cannot act on it either. Triggering a run, watching one, and relaying a one-time
  passcode are the account owner's, through their console or their own paired companion. An OAuth token
  is refused on every one of those routes.
