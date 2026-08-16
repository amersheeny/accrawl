# @accrawl/sdk

Official TypeScript client for the [Accrawl](../../README.md) **Data API** — a self-hosted, credential-scraping account aggregator. Run the **"Connect with Accrawl" OAuth flow** to obtain a scoped token, then read the **normalized data contract**: accounts with a two-level taxonomy + balance triple, holdings + securities, and a transaction change cursor. **Zero runtime dependencies** (uses the global `fetch`; `node:crypto` for webhook verification + PKCE).

The API reads data Accrawl has **already retrieved**, and does nothing else — every call is a `GET`. Starting a retrieval, following one, and relaying a one-time passcode belong to the person whose accounts these are, in their own Accrawl console, so this client has no method for them. Connections refresh on their own schedule; `lastSyncedAt` on a connection and `asOf` on a balance tell you how current the data is.

## Install

```sh
npm install @accrawl/sdk
```

## Usage

```ts
import { AccrawlClient } from '@accrawl/sdk';

const accrawl = new AccrawlClient({
  baseUrl: 'https://accrawl.example.com', // your deployment's front door
  apiKey: process.env.ACCRAWL_API_KEY!,   // a scoped key: acck_…
});

// 1. Discover what this credential may read. Each entry names its institution, so you never have
//    to show a slug: { id, institutionId, institutionName, institutionType, institutionLogoUrl,
//    status, nickname, lastSyncedAt }.
const { items: connections } = await accrawl.listConnections();
const connectionId = connections[0].id;

// 2. Read. The data API (v1) is a provider-style, retrieval-neutral contract: accounts carry a
//    two-level `type`+`subtype` and a current/available/limit balance triple, investments split
//    into holdings + de-duplicated securities, and transactions expose a Plaid-style change cursor.
const { items: accounts } = await accrawl.listAccounts(connectionId);
const { items: txns } = await accrawl.listTransactions(connectionId, { from: '2026-01-01', to: '2026-06-30', limit: 100 });
const { holdings, securities } = await accrawl.listHoldings(connectionId);
```

### Incremental sync

```ts
// Walk the transaction change cursor until hasMore is false
let cursor: string | undefined;
do {
  const page = await accrawl.syncTransactions(connectionId, { cursor });
  //   page.added / page.modified — ContractTransaction[]; page.removed — id[]
  cursor = page.nextCursor;
  if (!page.hasMore) break;
} while (true);
```

### Freshness

There is no refresh call. Read the age you actually have and show it honestly:

```ts
const { items } = await accrawl.listConnections();
for (const c of items) {
  c.lastSyncedAt;            // 'YYYY-MM-DD' of the last successful transaction sync, or null
  c.status;                  // 'needs_reauth' → the owner must fix it in their Accrawl console
}
```

A credential carries the `read:data` **scope** — the only one there is — and **connection grants**; a call it isn't authorized for throws `AccrawlApiError` with `status` 401 (bad key) or 403 (missing scope/grant).

```ts
import { AccrawlApiError } from '@accrawl/sdk';
try {
  await accrawl.listAccounts(connectionId);
} catch (e) {
  if (e instanceof AccrawlApiError && e.status === 403) { /* not granted */ }
}
```

## Connect with Accrawl (OAuth)

`AccrawlOAuthClient` runs the server side of the "Connect with Accrawl" Authorization-Code + PKCE flow, so your app can obtain a scoped token for a consenting operator's data without ever seeing their Accrawl password. PKCE (S256) is generated for you and is mandatory. See [docs/spec-oauth.md](../../docs/spec-oauth.md).

```ts
import { AccrawlOAuthClient, AccrawlClient } from '@accrawl/sdk';

const oauth = new AccrawlOAuthClient({
  baseUrl: 'https://accrawl.example.com',
  clientId: process.env.ACCRAWL_CLIENT_ID!,
  clientSecret: process.env.ACCRAWL_CLIENT_SECRET!, // omit for a public (PKCE-only) client
  redirectUri: 'https://app.example.com/callback',
});

// 1. Start the flow: redirect the browser to `url`. Persist `state` + `codeVerifier` on the user's session.
const { url, state, codeVerifier } = oauth.startAuthorization({ scope: 'read:data' });

// 2. On your /callback: verify `state` matches, then exchange the single-use code.
const tokens = await oauth.exchangeCode({ code, codeVerifier });
//   { access_token: 'acck_…', refresh_token: 'acrt_…', expires_in, scope, token_type }

// 3. The access token IS an Accrawl API key — read the consented data with it.
const api = new AccrawlClient({ baseUrl: 'https://accrawl.example.com', apiKey: tokens.access_token });
const { items: accounts } = await api.listAccounts(connectionId);

// 4. Rotate near expiry (reuse of a consumed refresh token revokes the whole grant); revoke on disconnect.
const rotated = await oauth.refresh({ refreshToken: tokens.refresh_token });
await oauth.revoke({ token: rotated.refresh_token, tokenTypeHint: 'refresh_token' });
```

The token and its grant share a ~90-day window; a refresh rotates the pair within that window, it never extends it. Errors surface as `AccrawlApiError` carrying the OAuth `error`/`error_description`.

## Webhooks

Two families are delivered with the **same** signing scheme and headers: the legacy crawl outcomes (`crawl.completed` / `crawl.failed`) and the normalized contract events (`sync.succeeded`, `sync.failed`, `transactions.updated`, `connection.status_changed`). Verify each delivery against the **raw** request body before trusting it — `verifyWebhookSignature` is event-agnostic:

```ts
import { verifyWebhookSignature, parseWebhookPayload, parseNormalizedWebhookPayload } from '@accrawl/sdk';

// rawBody = the exact bytes you received (do not re-serialize)
const ok = verifyWebhookSignature({
  secret: process.env.ACCRAWL_WEBHOOK_SECRET!,
  rawBody,
  signature: req.headers['x-accrawl-signature'],
  timestamp: req.headers['x-accrawl-timestamp'],
  toleranceSeconds: 300, // optional replay window
});
if (!ok) return res.status(400).end();

// Legacy crawl webhooks:
const crawl = parseWebhookPayload(rawBody); // typed CrawlWebhookPayload

// Normalized contract webhooks (discriminated on `event`):
const evt = parseNormalizedWebhookPayload(rawBody);
if (evt.event === 'transactions.updated') { /* evt.added / evt.modified */ }
```

## License

AGPL-3.0-only.
