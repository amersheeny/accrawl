# Accrawl Normalized Data API — contract spec

> **Status: partially implemented.** This contract is the deployment's data API — served at
> `/api/v1`; there is no other read API, and no other public API of any kind. Implemented today:
> `GET /api/v1/connections` (directory), `GET /api/v1/connections/:id/accounts`, `.../transactions`,
> `.../transactions/sync`, and `.../holdings`. The broader resource surface below (institution list,
> per-account and per-security endpoints) remains a **design target** — each such row is marked
> *(planned)* in §2. §15 maps it to the stored data model. The first-party
> [`@accrawl/sdk`](../packages/sdk-ts/README.md) implements every shipped endpoint, and the OpenAPI
> document (`apps/control-plane/src/openapi/spec.ts`) is the authoritative schema.
>
> **The API is read-only, and it is the whole public surface.** Every endpoint is a `GET`. There is no
> way through this API to start a retrieval, watch one, or relay a one-time passcode — nothing that
> touches an institution on the user's behalf. Those acts belong to the person whose accounts these are,
> in their own console (§14), and no API credential of any kind reaches them. This is structural, not a
> convention: the public-API guard refuses a non-read method outright, and the contract's test suite
> fails if a documented endpoint is anything but a `GET`.
>
> **How a third-party app gets a scoped key.** Reads are authenticated with an API key (`acck_…`). An app
> obtains one for a consenting operator through the "Connect with Accrawl" OAuth flow — see
> [spec-oauth.md](./spec-oauth.md); the OAuth access token *is* such a key. `read:data` is the only scope
> a key or an OAuth grant can carry, because reading is all the API does.
>
> **Design stance.** The contract is grounded in what the industry's aggregators publish — see
> the companion [market study](./market-study-aggregator-api-contracts.md). It speaks only in the
> nouns those contracts speak in: institutions, connections, accounts, balances, transactions,
> holdings, securities and liabilities. How Accrawl actually obtains an institution's data is an
> internal concern and does not appear in this contract — exactly as no provider's public API reveals
> its own retrieval mechanism. Accrawl goes one step further than the industry shape here: the
> retrieval *controls* those providers expose (a refresh trigger, a run's status, a 2FA relay) are
> absent too, because Accrawl holds the user's own credentials and driving them is not a third party's
> to do. Freshness is still visible — it travels in the data (`lastSyncedAt`, `asOf`).

---

## 1. Principles

Each principle is drawn from a verified cross-industry finding (referenced as *study §x*).

1. **Retrieval is invisible, and out of reach.** The public contract exposes account data and the
   connection it belongs to, never the mechanism behind it (*study §5*) — and never a control over
   it. Where the industry's contracts stop at hiding the mechanism, Accrawl also withholds the
   levers: no run trigger, no run status, no 2FA relay. Accrawl holds the user's own credentials, so
   driving them is the user's act, not a third party's.
2. **Two-level account taxonomy, pension first-class.** `type` + `subtype`, the dominant
   industry shape; because Accrawl serves pensions and study funds directly, pension is a
   top-level type rather than an investment subtype (*study §2.2*).
3. **Canonical balances, optional raw list.** An `available`/`current`(/`limit`) triple, with an
   optional provider-typed balance list carried alongside (*study §2.3*).
4. **Accrawl mints ids and owns reconciliation without content-based collapse.** A trustworthy,
   row-unique bank reference is the strongest identity evidence. When it is absent or ambiguous,
   Accrawl mints a new observed-occurrence id rather than assuming equal date/amount/description
   values identify one payment. Pending→posted updates require explicit one-to-one evidence
   (*study §2.8*).
5. **Enrichment, investment and liability detail are optional overlays** keyed off account type,
   never required core fields (*study §2.5, §2.6, §2.7*).
6. **Both date-range and change-cursor reads.** Date-range pagination is the universal floor; a
   Plaid-style added/modified/removed cursor is offered for efficient delta sync (*study §2.9*).
7. **Native currency only.** Every monetary value is in its account's own currency; the contract
   never fabricates a converted or cross-currency total (a deliberate non-goal, see §14).

---

## 2. Resource model

```
Institution
   └─ Connection            (one authenticated link to one institution; has a status)
        └─ Account          (type + subtype; native currency)
             ├─ Balance      (available / current / limit; optional typed list)
             ├─ Transaction  (stable id; pending → posted)
             └─ Holding ──▶ Security   (holding references a security by id)
```

Overlays attach to an Account by its type and are absent otherwise:
`CreditCardLiability` (credit accounts), `PensionDetail` (pension accounts).

Read endpoints, all under `/api/v1`, all `GET`. Every one requires the `read:data` scope — the only
scope there is — and a grant for the connection (the directory is filtered to just the connections a
key was granted). The shipped surface is connection-scoped (mirroring the stored records);
per-account and per-security endpoints are a design target. A key is obtained either directly by the
operator or via the [OAuth flow](./spec-oauth.md).

| Method | Path | Returns | Status |
|---|---|---|---|
| GET | `/connections` | directory: `{ id, institutionId, institutionName, institutionType, institutionLogoUrl, status, nickname, lastSyncedAt }[]` (grant-scoped) | **implemented** |
| GET | `/connections/:id/accounts` | Accounts under a connection | **implemented** |
| GET | `/connections/:id/transactions` | Transactions (date-range + offset pagination) | **implemented** |
| GET | `/connections/:id/transactions/sync` | change cursor (added/modified/removed) | **implemented** |
| GET | `/connections/:id/holdings` | Holdings + de-duplicated Securities | **implemented** |
| GET | `/institutions` | list of Institution | *(planned)* |
| GET | `/connections/:id` | one Connection (full detail) | *(planned)* |
| GET | `/accounts/:id` | one Account (balance embedded) | *(planned)* |
| GET | `/securities/:id` | one Security | *(planned)* |

---

## 3. Institution

The catalogue entry for a financial institution. Read-only to consumers.

```jsonc
{
  "id": "string",            // stable slug, e.g. "acme-bank"
  "name": "string",
  "country": "string|null",  // ISO 3166-1 alpha-2
  "logoUrl": "string|null"
}
```

No login URLs, retrieval config, or capability flags are exposed — those are internal.

---

## 4. Connection

One authenticated link between the user and an institution. This is the industry-universal
"item / member / enrollment / consent" object (*study §2.1*).

```jsonc
{
  "id": "uuid",
  "institutionId": "string",             // stable slug — a lookup key, never a label to show a person
  "institutionName": "string",           // what you display
  "institutionType": "bank",             // bank | broker | retirement
  "institutionLogoUrl": "string|null",   // render it; never fetch-and-trust it
  "nickname": "string|null",
  "status": "connected",     // enum, see below
  "lastSyncedAt": "string|null",   // YYYY-MM-DD of the last successful transaction sync (§12.3)
  "nextSyncAt": "string|null",     // ISO 8601; next scheduled sync, if any    (planned)
  "createdAt": "string"                                                     // (planned)
}
```

The institution travels with the connection as **display metadata**, so a consumer never has to show
a slug or guess a name. Only institutions the listed connections already reference are revealed;
there is no way to enumerate the catalogue through this endpoint.

**`status` enum** (retrieval-neutral; the same states every provider converges on):

| Value | Meaning |
|---|---|
| `connecting` | first link in progress, no data yet |
| `connected` | healthy; data current |
| `syncing` | a refresh is running |
| `needs_reauth` | user action required to restore access (e.g. changed credentials) |
| `error` | last sync failed for a non-user reason |
| `disabled` | connection paused/disabled by the user |

Credentials are never part of the contract. Because Accrawl holds the user's own credentials
rather than a third-party consent grant, there is no consent-expiry or reconfirmation field.

---

## 5. Account

```jsonc
{
  "id": "string",            // Accrawl-minted stable id (§11)
  "connectionId": "uuid",
  "type": "depository",      // top-level enum, see below
  "subtype": "current",      // subtype enum scoped to type
  "name": "string",
  "description": "string|null",
  "currency": "string",      // ISO 4217
  "balance": { /* §6 */ },
  "status": "active",        // active | inactive
  "lastSeenAt": "string"     // ISO 8601; last sync in which this account appeared
}
```

### 5.1 Account taxonomy

Two levels: a small `type` enum and a `subtype` enum scoped to each type. Unknown or
unmappable inputs fall to the type's `other` subtype (never dropped).

| `type` | `subtype` values | Covers |
|---|---|---|
| `depository` | `current`, `savings`, `money_market`, `cd`, `other` | bank / current & savings accounts |
| `credit` | `credit_card`, `charge_card`, `other` | credit & charge cards |
| `investment` | `brokerage`, `brokerage_cash`, `managed`, `crypto`, `other` | brokerage / trading accounts |
| `pension` | `pension`, `defined_benefit`, `defined_contribution`, `provident_fund`, `study_fund`, `other` | pensions, provident/retirement, study funds |
| `loan` | `mortgage`, `personal`, `student`, `other` | loans (forward-looking; minimal) |
| `other` | `other` | anything unclassifiable |

Rationale for a first-class `pension` type (rather than an investment subtype, as Plaid/MX/Yodlee
do): Accrawl directly serves pensions, provident funds, and the statutory medium-term study-fund
category several markets define, and Moneyhub and Finicity both model pensions as first-class
types (*study §2.2*).
Grouping study funds under `pension` reflects their long-horizon, retirement-adjacent nature.

### 5.2 Migration from the current `NormalizedAccount.type`

The current 8-value flat enum
(`packages/contracts/src/types.ts`) maps deterministically onto `(type, subtype)`:

| Current `type` | → `type` | → `subtype` |
|---|---|---|
| `current` | `depository` | `current` |
| `savings` | `depository` | `savings` |
| `credit` | `credit` | `credit_card` |
| `investment` | `investment` | `brokerage` |
| `broker_cash` | `investment` | `brokerage_cash` |
| `pension` | `pension` | `pension` |
| `study_fund` | `pension` | `study_fund` |
| `other` | `other` | `other` |

The mapping is lossless and reversible, so it can be applied as a read-time projection over
existing stored records without a data migration.

---

## 6. Balance

Embedded on the Account. A canonical triple in the account's native currency, plus an optional
raw typed list for consumers that need the provider's own balance kinds (*study §2.3*).

```jsonc
{
  "current": 1234.56,        // required; the booked balance
  "available": 1200.00,      // nullable; spendable incl. pending & overdraft/credit
  "limit": null,             // nullable; credit limit or arranged overdraft
  "asOf": "string",          // ISO 8601
  "raw": [                   // optional; provider-typed balances if the institution exposes them
    { "type": "interim_available", "amount": 1200.00 }
  ]
}
```

**Per-type semantics** (documented so consumers never mis-read a credit balance as an asset):

| Account type | `current` | `available` | `limit` |
|---|---|---|---|
| `depository` | funds in the account | spendable (less pending, incl. arranged overdraft) | arranged overdraft, if any |
| `credit` | **amount owed** (positive = debt) | remaining spendable credit | credit limit |
| `investment` / `pension` | total account value | cash available to trade/withdraw | — |
| `loan` | outstanding principal (**owed, positive**) | — | original / credit limit |

**Sign.** Institutions write a debt either way — `-1,234.00` on one site, `1,234.00 to pay` on
the next. Accrawl settles it at extraction rather than leaving the consumer to guess: a `credit`
or `loan` account's `current` is the amount **owed, positive**, and a card in credit (the issuer
owes the customer) is negative. Every other type carries the institution's own sign, so an overdrawn
`depository` account is negative. Nothing downstream re-signs a balance, so the value you read is the
value that was extracted under this rule.

No distinct "ledger" balance field exists: across the industry "ledger" is only a synonym for the
current/posted balance (*study §2.3*).

### 6.1 Monetary representation

Every monetary value in this contract — balances, transaction `amount`, holding `value`/`costBasis`,
liability figures — is a **JSON number in the account's native currency**, paired with an ISO-4217
`currency`. This matches how the industry's aggregators publish money (Plaid, TrueLayer, SnapTrade,
Yodlee, MX all serialize amounts as JSON numbers, not minor-unit integers or decimal strings), so a
consumer written against those providers reads Accrawl's amounts unchanged.

**Why numbers, not minor-unit integers or decimal strings.** JSON numbers are IEEE-754 doubles.
A double represents every integer value up to 2⁵³ exactly, which covers all realistic account and
transaction magnitudes to the cent with no loss; Accrawl **stores and passes values through** (it
does not perform monetary arithmetic or accumulate running sums server-side), so representation
fidelity — not accumulated rounding — is the only concern, and doubles satisfy it. Adopting
minor-unit integers or a decimal type would diverge from every provider this contract is grounded in
for no correctness gain on a read-only, pass-through surface. **Consumer guidance:** if you perform
arithmetic on these amounts (summing, converting), do it in a decimal/rational type on your side and
round only for display — standard practice against any JSON-number money API. Should a future
requirement need exact decimal semantics end-to-end, it would be introduced additively (an optional
minor-unit field), never by breaking the number field consumers already read.

---

## 7. Transaction

```jsonc
{
  "id": "string",                 // Accrawl-minted stable id (§11)
  "accountId": "string|null",     // the owning Account's `id` (the minted id, NOT the provider id) — joins to §5; null if unlinked
  "providerTransactionId": "string|null",  // bank-supplied id, passthrough only
  "bookingDate": "string",        // YYYY-MM-DD
  "amount": -42.50,               // signed, native currency; negative = outflow
  "currency": "string",           // ISO 4217
  "description": "string",
  "merchant": "string|null",
  "status": "posted",             // posted | pending
  "category": {                   // optional enrichment overlay
    "primary": "string",
    "detailed": "string|null"
  },
  "providerCategory": "string|null",  // raw category text as the institution labelled it
  "runningBalance": null          // nullable; balance after this transaction if known
}
```

### 7.1 Amount sign

**Negative = money leaving the account (outflow); positive = money entering (inflow).** This
matches a bank statement and the current stored model. It is the *inverse* of Plaid's convention
(Plaid makes purchases positive) — the contrast is called out because consumers migrating from
Plaid must flip the sign (*study §2.4*).

### 7.2 Status & the pending → posted lifecycle

`status` is `pending` or `posted`. Reconciliation semantics (Accrawl-defined, stronger than most
of the industry — *study §2.4*):

- When a pending transaction later posts and Accrawl has explicit one-to-one evidence (the same
  trustworthy bank reference, or an observed pending row gaining a real bank reference),
  **the id is preserved**; the crawl session's private, session-scoped authoritative stored-row
  mapping resolves the crawler's returned `existingCanonicalId` to the exact immutable stored row
  id. Only `status` and observed changed fields update, and the transaction appears in a sync's
  `modified` set.
- Equal content is not matching evidence. Two transactions can legitimately share account, date,
  amount, currency, merchant, and description. Each surplus or ambiguous observed row remains a
  separate occurrence.
- When Accrawl cannot safely link a pending row to a posted form, it does not delete or overwrite
  either row. The posted occurrence is added independently and the earlier pending record remains
  provisional. This favours preserving financial history over a destructive guess.
- Consumers should treat `pending` rows as provisional (amount and description may change before
  settlement) and key their own storage on `id`.

### 7.3 Category

`category` is an optional two-level enrichment overlay (`primary` + finer `detailed`), following
the industry-dominant shape. `providerCategory` preserves the institution's own raw label
untouched. Neither is required; a transaction with no enrichment simply omits them. The category
enum is Accrawl's own and versioned independently — the study found no provider category taxonomy
that is a stable public standard, so consumers must not assume a fixed set (*study §2.5*).

---

## 8. Holding & Security

The mature investment models all split the position from the instrument's identity
(*study §2.6*); this spec does the same, which also fixes two current gaps — positions today are
not linked to an account and inline their security attributes.

**Holding** (a position in an account):

```jsonc
{
  "id": "string",
  "accountId": "string|null",// the owning Account's `id` (the minted id) — joins to §5; null if unlinked
  "securityId": "string",    // references a Security
  "quantity": 10.5,
  "value": 1575.00,          // market value, native currency
  "price": 150.00,           // nullable; per-unit market price
  "priceAsOf": "string|null",
  "costBasis": null,         // nullable; native currency
  "currency": "string"       // ISO 4217
}
```

**Security** (instrument identity, shared across holdings):

```jsonc
{
  "id": "string",
  "name": "string",
  "isin": "string|null",     // strongest cross-institution identity
  "ticker": "string|null",
  "exchange": "string|null", // MIC or market code, e.g. XLON, TASE
  "securityType": "equity"   // enum, see below
}
```

`securityType` enum: `equity`, `etf`, `mutual_fund`, `bond`, `cash`, `crypto`, `derivative`,
`other` — the common denominator of Plaid's, Akoya's, and Yodlee's security-type enums
(*study §2.6*). Identity precedence: `isin` › `ticker` + `exchange` › provider-internal id (held
in `security.id`). A bare `ticker` **without** an `exchange` is not a stable identity — the same
symbol can denote different instruments across venues — so it falls through to the per-position
provider id rather than risk merging two distinct securities into one.

---

## 9. Credit-card liability overlay

Present only on `credit` accounts; absent otherwise. Every field optional — institutions vary in
what they expose (*study §2.7*).

```jsonc
{
  "aprs": [                          // optional
    { "percentage": 19.9, "type": "purchase" }   // type: purchase | cash | balance_transfer | penalty | other
  ],
  "creditLimit": 5000.00,            // (also surfaced as balance.limit)
  "lastStatementDate": "string|null",     // YYYY-MM-DD
  "lastStatementBalance": null,
  "minimumPaymentAmount": null,
  "nextPaymentDueDate": "string|null"      // YYYY-MM-DD
}
```

This is the convergent field set from Plaid, Finicity, Akoya, MX, and Yodlee.

---

## 10. Pension overlay

Present only on `pension` accounts; every field optional. Structured pension detail is rare in
the industry — Akoya (FDX) is the main model that carries it (`pensionSource` / `contribution` /
`vesting`), while pension appears as a first-class account *type* in Moneyhub and Finicity
(*study §2.2*).

```jsonc
{
  "scheme": "defined_contribution",  // defined_benefit | defined_contribution | provident_fund | study_fund | other
  "employer": "string|null",
  "contributionsToDate": null,       // native currency
  "vestedValue": null                // native currency
}
```

The `scheme` mirrors the account `subtype`; it is repeated here so a consumer reading the overlay
has the DB/DC distinction without re-joining the account.

---

## 11. Identifiers & reconciliation

Consolidated because it is the contract's central guarantee and the industry's central gap
(*study §2.8*).

- **All ids in this contract are Accrawl-minted.** Once stored, an id is stable across syncs.
  A pending→posted transition preserves it only when §7.2's evidence requirement is met.
- **Provider ids are passthrough, never keys.** `providerTransactionId` and a security's
  provider-internal id are carried for traceability; consumers must key on Accrawl's `id`.
- **Transaction id derivation** (the contract behaviour, retrieval-agnostic):
  1. if the institution supplies a reference proven unique to one row, the Accrawl id is a stable
     hash of `(account, provider transaction id)`;
  2. otherwise the crawler mints a UUID for that observed row and storage hashes
     `(account, promotion scope, observed occurrence UUID)`. The promotion scope is the crawl
     session, so an accidental UUID reuse in another crawl cannot merge independent rows.
  Content fields never participate in identity. If a purported bank reference repeats within one
  account, every observed occurrence is retained independently rather than overwritten.
- **Live promotion and stranded-session recovery use the same persisted identity context.** Before
  dispatch, the control-plane supplies every stored transaction occurrence in the full identity
  window—even when that window extends earlier than the extraction cutoff—and privately records its
  immutable stored row id for that crawl session. Each validated staged transaction that is stored
  is durably claimed from its session-scoped occurrence id to the row it produced. Replaying the
  same staged results therefore targets the same row without exposing database ids to the crawler
  or treating financial content as proof of transaction sameness.
- **Holding identity is account-scoped.** A provider position id is keyed together with its owning
  provider account id, because brokers may reuse the same security/lot identifier across accounts.
  Every new holding must identify its owning account.
- **Missing holdings are retained.** A crawl may cover only part of a portfolio; absence from one
  result is not evidence of a sale and does not trigger deletion.
- **Account id** is stable per connection. An account absent from a crawl is retained unchanged:
  partial coverage is not proof that the account closed. `inactive` is reserved for explicit
  lifecycle evidence rather than inferred from omission.
- **Additive fields survive views that omit them.** On an authoritative update, a transaction's prior
  merchant/provider category/category, an account's optional overlays, and a holding's ISIN/exchange/
  security type are retained when the later view does not expose them. Current fields still refresh:
  an omitted account description becomes empty, and omitted holding ticker/cost basis values are cleared.
  Financial content such as date, amount, merchant, or description is never used to decide that two
  records have the same identity.

---

## 12. Pagination & change cursor

### 12.1 Date-range list (the floor)

`GET /api/v1/connections/:id/transactions` accepts `from` / `to` (`YYYY-MM-DD`, inclusive, on
booking date) and `limit` / `offset` for pagination, returning:

```jsonc
{ "items": [ /* Transaction */ ], "hasMore": false, "limit": 50, "offset": 0 }
```

`GET /api/v1/connections/:id/accounts` and `.../holdings` paginate the same way (`limit`/`offset`,
`hasMore`); the holdings response additionally carries the de-duplicated `securities` array (§8).

### 12.2 Change cursor (the delta)

`GET /api/v1/connections/:id/transactions/sync?cursor=…` returns changes since the cursor,
Plaid-style (*study §2.9*):

```jsonc
{
  "added":    [ /* Transaction */ ],
  "modified": [ /* Transaction */ ],   // e.g. pending → posted, category updated
  "removed":  [ "id", "id" ],          // ids only
  "nextCursor": "string",
  "hasMore": false
}
```

The first call omits `cursor` to receive the full history; subsequent calls chain `nextCursor` (an
opaque base64url token). `removed` is always empty in practice: transactions are upsert-only and
never hard-deleted, so a settled pending row surfaces in `modified` (its id preserved), never as a
remove-then-add. Accrawl already computes the added/modified sets during reconciliation, so this
endpoint is a projection of existing work rather than new machinery.

### 12.3 Freshness

There is no refresh endpoint, and no run resource. A consumer does not ask Accrawl to go and fetch:
each connection carries its own schedule, and the person who owns the accounts can also run one on
demand from their console. What a consumer needs is not a trigger but an honest answer to *how
current is this?*, and that travels in the data:

| Signal | Where | Meaning |
|---|---|---|
| `lastSyncedAt` | Connection (§4) | `YYYY-MM-DD` of the last successful transaction sync, or `null` if there has never been one. |
| `asOf` | Balance (§6) | when that balance was observed, if the institution stated it. |
| `status` | Connection (§4) | `needs_reauth` / `error` say the data will stop advancing until the owner acts. |

Show the user the age you actually have rather than implying live data, and when a connection reads
`needs_reauth`, point them at their Accrawl console — that is where it gets fixed.

---

## 13. Webhooks

**Webhooks are an owner feature.** Only the deployment owner registers an endpoint (a consumer
cannot), and they choose where deliveries go — possibly to a consumer they run. They are specified
here because the receiver needs the exact bodies. The `sync.*` events describe retrieval runs and are
part of the owner's surface, not the read contract: a consumer pointed at them should treat them
purely as a hint to re-read §12.2, never as a control channel.

Signature:
`X-Accrawl-Signature: sha256=<hex(hmac_sha256(secret, `${timestamp}.${body}`))>` with
`X-Accrawl-Timestamp` (unix seconds), computed over the raw body. Each body is **flat** and keyed
by `event` (the vocabulary is the convergent industry set, expressed retrieval-neutrally — *study §2.10*):

```jsonc
{
  "event": "transactions.updated",
  "connectionId": "uuid",
  "syncId": "uuid",
  "added": 12, "modified": 1, "removed": 0,
  "occurredAt": "string"
}
```

| `event` | Fires when | Body fields (besides `event`, `connectionId`, `syncId`, `occurredAt`) |
|---|---|---|
| `sync.succeeded` | a refresh completes successfully | `status: "succeeded"` |
| `sync.failed` | a refresh fails | `status: "failed"`, `error?` (a short message) |
| `transactions.updated` | a successful sync changed transactions | `added`, `modified`, `removed` (counts; `removed` always `0`) |
| `connection.status_changed` | a connection's status changes | `from`, `to` (e.g. `connected` → `needs_reauth`) |

Following the industry norm, `transactions.updated` payloads are thin (counts only); the consumer
re-fetches the actual records via §12.2. Verify each delivery with `@accrawl/sdk`'s
`verifyWebhookSignature` + `parseNormalizedWebhookPayload`, or an equivalent HMAC check.

One further event belongs to the [OAuth surface](./spec-oauth.md), not the sync lifecycle, but is
registered and signed the same way: **`grant.revoked`** fires when the operator revokes a connected
app's grant — body `{ event, grantId, clientId?, occurredAt }` (no `connectionId`/`syncId`). A
consumer uses it to learn its access was pulled rather than discovering it on the next `401`.

---

## 14. Non-goals

Explicitly out of scope for this contract, so their absence is a decision, not an omission:

- **FX / converted totals.** All values are native-currency; the contract never converts or sums
  across currencies. Consumers own any conversion (matches the industry norm and Accrawl's
  existing policy).
- **Payments / write access.** Read-only, in the strongest sense: not merely no transfers, payments
  or trades, but no writes at all. The API cannot start a retrieval, answer a two-factor challenge,
  or change a single stored field. Anything that acts on an institution stays with the account owner
  in their own console. This is enforced by the guard on the public API, not left to convention.
- **Balance history / time series.** Not currently stored; a candidate extension, not part of
  this contract yet.
- **Identity / account-holder personal data.** Out of scope.

---

## 15. Relationship to the stored data model

This contract is a **read-time projection** over the records Accrawl already stores —
`NormalizedAccount` / `NormalizedTransaction` / `NormalizedPosition`
(`packages/contracts/src/types.ts`) — reshaped into the provider-style surface below by the pure
projections in `packages/contracts/src/contract.ts`. The stored shape and the contract shape differ
as follows:

| Area | Stored `Normalized*` record | `/api/v1` contract |
|---|---|---|
| Account type | flat 8-value enum | two-level `type` + `subtype` (§5.1, lossless map) |
| Balance | single native `balance` number | `available`/`current`/`limit` triple (§6) |
| Positions | a flat position record | `Holding` (account-linked) + separate `Security` (§8) |
| Liabilities | on the account record | credit-card overlay (§9) |
| Pensions | account type only | first-class type + optional overlay (§5.1, §10) |
| Transactions | `providerCategory` free string | two-level `category` + raw passthrough (§7.3) |
| Change feed | — | change cursor (§12.2) |

The read-side account and balance projections (§5.1 and §6) require no data migration. Transaction
occurrence ids and one-to-one update targets are internal crawl fields and are stripped before the
public record is stored. Private relational tables retain session-scoped authoritative update
targets and occurrence-to-row claims needed for replay-safe promotion; they are not part of the
public API. Position ownership is stored in the existing JSON payload. The
transaction change cursor uses the additive, millisecond-precision `transactions.updated_at` column
(indexed, backfilled from `created_at`) described in §12.2.
