# Test third-party app — "Connect with Accrawl" (OAuth)

`server.mjs` is a **minimal, dependency-free** example of a third-party app that integrates with Accrawl via
the OAuth 2.0 **authorization-code + PKCE** flow (the "Connect with Accrawl" flow). It exists both as a
runnable example and as the driver for the end-to-end test.

## The flow it implements

1. **`GET /`** — a landing page with a **Connect with Accrawl** button.
2. **`GET /connect`** — generates a PKCE `code_verifier` + S256 `code_challenge` and a CSRF `state`, remembers
   them, and 302-redirects the browser to Accrawl's `GET /oauth/authorize`.
3. The operator approves on Accrawl's consent screen — which is authenticate-first: they sign in with their
   Accrawl password, then pick which connections to share for the requested scopes and approve. Accrawl
   302-redirects back to…
4. **`GET /callback`** — verifies `state`, exchanges the single-use `code` at `POST /oauth/token`
   (`client_secret` + PKCE `code_verifier`) for a scoped **~90-day** access token, then calls
   `GET /api/v1/connections/:id/accounts` with that token and renders what it read.

## Run it standalone

Register a client in Accrawl first (operator-only):

```bash
curl -sX POST http://127.0.0.1:3000/api/oauth-clients \
  -H "authorization: Bearer $OPERATOR_TOKEN" -H 'content-type: application/json' \
  -d '{"name":"Budget Buddy","redirectUris":["http://127.0.0.1:4000/callback"],"allowedScopes":["read:data"]}'
# → { "clientId": "accl_…", "clientSecret": "acls_…" }   (secret shown once)

ACCRAWL_BASE_URL=http://127.0.0.1:3000 \
ACCRAWL_CLIENT_ID=accl_… ACCRAWL_CLIENT_SECRET=acls_… \
ACCRAWL_CONNECTION_ID=<a connection id> PORT=4000 \
node e2e/oauth-consumer/server.mjs
# open http://127.0.0.1:4000 and click "Connect with Accrawl"
```

## Automated end-to-end run

`apps/control-plane/scripts/oauth-e2e.ts` boots a real control-plane (Fastify + pglite-over-socket Postgres),
seeds a connection + accounts, registers a client, launches **this app as a separate process**, and drives the
whole flow (playing browser + operator), asserting the app reads exactly the consented account data:

```bash
cd apps/control-plane && pnpm e2e:oauth
```
