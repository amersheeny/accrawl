# accrawl (Python)

Official Python client for the [Accrawl](../../README.md) **Data API** — a self-hosted, credential-scraping account aggregator. Run the **"Connect with Accrawl" OAuth flow** to obtain a scoped token, then read the **normalized data contract**: accounts with a two-level taxonomy + balance triple, holdings + securities, and a transaction change cursor. **Zero dependencies** (Python standard library only).

The API reads data Accrawl has **already retrieved**, and does nothing else — every call is a `GET`. Starting a retrieval, following one, and relaying a one-time passcode belong to the person whose accounts these are, in their own Accrawl console, so this client has no method for them. Connections refresh on their own schedule; `last_synced_at` on a connection and `as_of` on a balance tell you how current the data is.

## Install

```sh
pip install accrawl
```

## Usage

```python
import os
from accrawl import AccrawlClient

accrawl = AccrawlClient(
    base_url="https://accrawl.example.com",  # your deployment's front door
    api_key=os.environ["ACCRAWL_API_KEY"],   # a scoped key: acck_…
)

# 1. Discover what this credential may read. Each entry names its institution, so you never have to
#    show a slug: id, institution_id, institution_name, institution_type, institution_logo_url,
#    status, nickname, last_synced_at.
connections = accrawl.list_connections()
connection_id = connections[0].id

# 2. Read. The data API (v1) is a provider-style, retrieval-neutral contract: accounts carry a
#    two-level `type`+`subtype` and a current/available/limit balance triple, investments split into
#    holdings + de-duplicated securities, and transactions expose a change cursor.
#    Each page's `items` ARE the records (the id is inline — there is no {id, data} wrapper).
accounts = accrawl.list_accounts(connection_id)
for acct in accounts.items:
    print(acct.name, acct.type, acct.subtype, acct.balance.current, acct.currency)

txns = accrawl.list_transactions(connection_id, from_="2026-01-01", to="2026-06-30", limit=100)
holdings = accrawl.list_holdings(connection_id)  # .holdings + .securities
```

### Incremental sync

```python
# Walk the transaction change cursor until has_more is False
cursor = None
while True:
    page = accrawl.sync_transactions(connection_id, cursor=cursor)
    #   page.added / page.modified — ContractTransaction records; page.removed — ids
    cursor = page.next_cursor
    if not page.has_more:
        break
```

### Freshness

There is no refresh call. Read the age you actually have and show it honestly:

```python
for c in accrawl.list_connections():
    c.last_synced_at   # 'YYYY-MM-DD' of the last successful transaction sync, or None
    c.status           # 'needs_reauth' → the owner must fix it in their Accrawl console
```

A credential carries the `read:data` **scope** — the only one there is — and **connection grants**; a call it isn't authorized for raises `AccrawlApiError` with `.status` 401 (bad key) or 403 (missing scope/grant).

```python
from accrawl import AccrawlApiError
try:
    accrawl.list_accounts(connection_id)
except AccrawlApiError as e:
    if e.status == 403:
        ...  # not granted
```

## Connect with Accrawl (OAuth)

`AccrawlOAuthClient` runs the server side of the "Connect with Accrawl" Authorization-Code + PKCE flow, so your app can obtain a scoped token for a consenting operator's data without ever seeing their Accrawl password. PKCE (S256) is generated for you and is mandatory. See [docs/spec-oauth.md](../../docs/spec-oauth.md).

```python
import os
from accrawl import AccrawlOAuthClient, AccrawlClient

oauth = AccrawlOAuthClient(
    base_url="https://accrawl.example.com",
    client_id=os.environ["ACCRAWL_CLIENT_ID"],
    client_secret=os.environ["ACCRAWL_CLIENT_SECRET"],  # omit for a public (PKCE-only) client
    redirect_uri="https://app.example.com/callback",
)

# 1. Start the flow: redirect the browser to `url`. Persist `state` + `code_verifier` on the user's session.
started = oauth.start_authorization(scope="read:data")
#   started.url, started.state, started.code_verifier

# 2. On your /callback: verify `state` matches, then exchange the single-use code.
tokens = oauth.exchange_code(code=code, code_verifier=started.code_verifier)
#   {"access_token": "acck_…", "refresh_token": "acrt_…", "expires_in": ..., "scope": ..., "token_type": ...}

# 3. The access token IS an Accrawl API key — read the consented data with it.
api = AccrawlClient(base_url="https://accrawl.example.com", api_key=tokens["access_token"])
accounts = api.list_accounts(connection_id)

# 4. Rotate near expiry (reuse of a consumed refresh token revokes the whole grant); revoke on disconnect.
rotated = oauth.refresh(tokens["refresh_token"])
oauth.revoke(rotated["refresh_token"], token_type_hint="refresh_token")
```

The token and its grant share a ~90-day window; a refresh rotates the pair within that window, it never extends it. A non-2xx raises `AccrawlApiError` carrying the OAuth `error`/`error_description`.

## Webhooks

Subscribe to `crawl.completed` / `crawl.failed` to avoid polling. Verify each delivery against the **raw** request body before trusting it:

```python
from accrawl import verify_webhook_signature, parse_webhook_payload

ok = verify_webhook_signature(
    secret=os.environ["ACCRAWL_WEBHOOK_SECRET"],
    raw_body=raw_body,                                # exactly as received
    signature=request.headers["X-Accrawl-Signature"],
    timestamp=request.headers["X-Accrawl-Timestamp"],
    tolerance_seconds=300,                            # optional replay window
)
if not ok:
    return 400

payload = parse_webhook_payload(raw_body)  # typed CrawlWebhookPayload
```

The normalized contract also emits `sync.succeeded` / `sync.failed` / `transactions.updated` / `connection.status_changed` (and `grant.revoked` for OAuth) with the **same** signing scheme; `verify_webhook_signature` is event-agnostic, so it verifies those too — decode the body with `json.loads` after verifying.

## Development

```sh
python3 -m unittest discover -s tests -t .
```

## License

AGPL-3.0-only.
