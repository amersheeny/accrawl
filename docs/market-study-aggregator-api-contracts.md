# Market study — financial-account aggregation API contracts

> **What this is.** A comparative study of the *public* API contracts that the major
> financial-data aggregators expose — the data models their documentation describes, not how
> they obtain the data. It exists to ground Accrawl's own normalized read-side contract (see
> [`spec-data-api.md`](./spec-data-api.md)) in what the industry actually does.
>
> **Scope.** Data-model / contract shapes only: resources, account-type taxonomies, balance and
> transaction fields, holdings/securities, liabilities, pension representation, identifier and
> reconciliation conventions, pagination/sync, and webhook event vocabularies. It deliberately
> ignores authentication flows, link/connect UX, pricing, and coverage.
>
> **Method & honesty.** Every provider claim below was extracted from the provider's own current
> public documentation and then independently re-verified against the live pages. The material
> was fetched and verified on **2026-07-04**. Provider docs change (Plaid's category taxonomy
> file, for example, was edited the day before verification); treat specific enum lists as
> "true as of that date," not frozen. Where a provider's docs are silent on something (id
> stability, pending→posted matching), that silence is reported as a finding, not filled in from
> assumption. A handful of providers publish their reference only as JavaScript single-page apps
> that cannot be fetched as text (Mastercard/Finicity, parts of Akoya); for those, the study
> relies on the provider's published OpenAPI specification, noted per section.

Providers covered (13): **Plaid**, **TrueLayer**, **SnapTrade**, **Mastercard Open Banking
(Finicity)**, **Envestnet Yodlee**, **MX**, **Akoya**, **GoCardless Bank Account Data**,
**Salt Edge**, **Yapily**, **Teller**, **Moneyhub**, **Flanks**.

---

## 1. The two contract families

Everything in the market descends from one of two lineages, and the split explains almost every
downstream difference in field shapes.

### Proprietary-normalized

The aggregator invents its own canonical model and maps every institution onto it. Fixed,
named balance fields; rich multi-level account and category taxonomies; the aggregator mints its
own identifiers; change is delivered by aggregator-defined webhooks. This is the US-aggregator
and brokerage-aggregator style: **Plaid, MX, Yodlee, Mastercard/Finicity, SnapTrade, Teller,
Moneyhub, Salt Edge, Flanks**.

### Standards-derived

The contract is a thin normalization over an external banking standard, so it inherits that
standard's shapes — typed balance *lists* keyed by an enum, near-universally-optional
transaction fields, and (crucially) the standard's *absence* of identifier-stability guarantees.
Two standards appear:

- **Berlin Group NextGenPSD2 / ISO 20022** (European open banking): **GoCardless**, **Yapily**,
  and TrueLayer's transaction/balance shapes.
- **FDX — Financial Data Exchange** (US open banking): **Akoya**; Plaid also publishes an
  FDX-shaped surface (Core Exchange) alongside its proprietary API.

The practical upshot for anyone building a normalized model: the proprietary family shows you
the *target* shape to aim for, and the standards-derived family shows you the *floor* of what
you can rely on being present. A robust normalized contract has to accept the floor and produce
the target.

---

## 2. Dimension-by-dimension comparison

### 2.1 Connection / item model

Every provider has some object standing between "the user" and "an account" that represents one
authenticated link to one institution. Only the name and the amount of exposed metadata differ.

| Provider | Connection object | Institution object | Notable |
|---|---|---|---|
| Plaid | **Item** (`item_id`) | `institution_id` | Item = one login at one institution |
| TrueLayer | **Connection** (an access token; `credentials_id`) | `provider.provider_id` | No REST item resource; consent ≤ 90 days |
| SnapTrade | **Connection** / "brokerage authorization" (UUID) | `brokerage` | User → Connection → Account; `userId` must be partner-unique and immutable |
| Finicity | **institutionLoginId** (int64, stamped on accounts) | institution | Customer → institution login → account; no standalone connection resource |
| Yodlee | **providerAccount** (`id`, long) | **provider** (`id`, long) | Three-level provider → providerAccount → account |
| MX | **member** (`member_guid`) | **institution** (`institution_code`) | "Members represent the connection between an end user and a financial institution" |
| Akoya | OAuth consent (no persistent resource) | "data provider" (`providerId` path segment only) | Institution directory is a separate Management API |
| GoCardless | **requisition** / end-user agreement | institution | Berlin Group / PSD2 consent model |
| Salt Edge | **Connection** (`connection_id`) | **Provider** (`code`) | "One or more Accounts can be associated with any Connection" |
| Yapily | **consent** | **institution** (`id`) | The consent *is* the connection unit |
| Teller | **enrollment** (`enrollment_id`) | **institution** (`id`) | One access token per enrollment; surfaces only as `enrollment_id` + in webhooks |
| Moneyhub | **connection** (`id` = `"bankId:uuid"`) | provider (bankId) | Connection id stable across refresh & reconsent |
| Flanks | **credentials** (`credentials_token`) / "connection" | **entity** (`id`) | Explicitly *not* mapped to a person |

**Common denominator:** a connection carries a stable-per-connection id, a reference to its
institution, and a status. The status vocabularies converge on the same handful of states —
healthy, syncing/in-progress, needs-reauthentication, error, disabled — under many different
names (Plaid `ITEM_LOGIN_REQUIRED`, TrueLayer `authorization_required`, MX's 23-value
`connection_status`, Salt Edge `active|inactive|disabled`).

### 2.2 Account-type taxonomies

This is where the models diverge most, and it is the single most important input to Accrawl's
spec. Three structural patterns exist.

**(a) Two-level `type` + `subtype`** — a small top-level enum plus a large subtype enum. The
dominant shape among full-scope aggregators.

| Provider | Top-level `type` | Subtype breadth | Pensions |
|---|---|---|---|
| Plaid | `depository, credit, loan, investment, other` (+ legacy `brokerage`) | one flat ~75-value `subtype` | subtypes of `investment` (`401k, ira, roth, pension, sipp, rrsp`, …) |
| MX | 13: `CHECKING, SAVINGS, LOAN, CREDIT_CARD, INVESTMENT, LINE_OF_CREDIT, MORTGAGE, PROPERTY, CASH, INSURANCE, PREPAID, CHECKING_LINE_OF_CREDIT, ANY` | per-type subtype enums (INVESTMENT alone has ~90) | `INVESTMENT` + subtype (`PENSION, PLAN_401_K, DEFINED_BENEFIT_PLAN, REGISTERED_PENSION_PLAN`, …) |
| Teller | `depository, credit` | depository: `checking, savings, money_market, certificate_of_deposit, treasury, sweep`; credit: `credit_card` | not representable |

**(b) Container + per-container type** — Yodlee's shape: a `container` axis
(`bank, creditCard, investment, insurance, loan, otherAssets, otherLiabilities, realEstate,
reward`) and a `accountType` enum scoped to each container (e.g. bank →
`CHECKING, SAVINGS, CD, IRA, MONEY_MARKET, …`; investment → ~115 values including every
retirement flavour). Pensions live as investment `accountType`s, not a separate container.

**(c) Single flat enum** — one list covering everything.

| Provider | The enum |
|---|---|
| Finicity | ~36 flat values: `checking, savings, cd, moneyMarket, creditCard, lineOfCredit, investment, ira, 401k, roth, 403b, 529plan, brokerageAccount, pension, hsa, mortgage, loan, studentLoan, …` — **pensions and every retirement flavour are first-class top-level types** |
| Salt Edge | 13 natures: `account, bonus, card, checking, credit, credit_card, debit_card, ewallet, insurance, investment, loan, mortgage, savings` — no pension value |
| Yapily | 24 `accountType` values (`CURRENT, SAVINGS, CREDIT_CARD, CHARGE_CARD, PREPAID_CARD, LOAN, MORTGAGE, MONEY_MARKET, CASH_TRADING, …`) + separate `usageType` (`PERSONAL/BUSINESS`) — no pension/brokerage value |
| Moneyhub | 14 colon-namespaced values: `cash:current, savings, card, investment, loan, mortgage:repayment, mortgage:interestOnly, pension, pension:definedBenefit, pension:definedContribution, asset, properties:residential, properties:buyToLet, crypto` |

**(d) Resource-split / discriminated union** — the type *is* which resource tree or wrapper the
account appears under.

| Provider | Split |
|---|---|
| TrueLayer | `/accounts` (4 deposit `account_type`s: `TRANSACTION, SAVINGS, BUSINESS_TRANSACTION, BUSINESS_SAVINGS`) vs a separate `/cards` tree (`card_type`, `card_network`); no investment/loan/pension types at all |
| Akoya (FDX) | wrapper key per account: `depositAccount, loanAccount, locAccount, investmentAccount, insuranceAccount, annuityAccount`; `accountType` inside is a *free string* ("CHECKING, SAVINGS, 401K, etc.") |
| Flanks | separate entities: cash `Account` (`cashAccount, safekeepingAccount, …`), investment `Portfolio`/`Investment` (type codes incl. `PP` Pension Plan), `Liability`, `Card` |
| SnapTrade | 3-value `account_category`: `INVESTMENT, DEPOSIT, LOC`; everything finer only in a free-form `raw_type` string |

**Pension representation is the sharpest taxonomy finding.** Only **Moneyhub** (three explicit
`pension*` values distinguishing defined-benefit from defined-contribution) and **Finicity**
(flat `pension` + every named retirement plan) treat pensions as a first-class account type.
Plaid, MX, and Yodlee bury them as investment subtypes. TrueLayer, Salt Edge, Yapily, and
Teller cannot represent a pension at all. Akoya routes 401k/IRA through `investmentAccount` and
attaches pension-specific structures (`pensionSource[]`, `contribution[]`, `vesting[]`,
`planId`, `employerName`) in its Investments product.

### 2.3 Balance models

Two shapes, matching the two families.

**Fixed named fields (proprietary family).** A small set of purpose-named amounts:

| Provider | Core balance fields |
|---|---|
| Plaid | `available`, `current`, `limit` (per-type semantics; no ledger field) |
| TrueLayer | account: `current`, `available`, `overdraft`; card: `current`, `available`, `credit_limit`, `last_statement_balance`, `payment_due`, `payment_due_date` |
| Teller | `ledger` and `available` (strings; at least one always present; no `current`) |
| MX | `balance`, `available_balance`, `available_credit`, `credit_limit`, `cash_balance`, `total_account_value`, `statement_balance`, … |
| Finicity | `balance` (cleared) + type-conditional `availableBalanceAmount` / `currentBalance`; premium live-balance adds `clearedBalance` ("also referred as posted, current, ledger balance") |
| Yodlee | `balance`, `availableBalance`, `currentBalance`, `runningBalance`, `availableCredit`, `availableCash` + container-specific fields |
| SnapTrade | per-currency array: `cash`, `buying_power`; plus account `balance.total` |
| Salt Edge | scalar `account.balance` + untyped `extra` (`available_amount`, `credit_limit`, `closing_balance`, `opening_balance`, free-form `balance_type`) |
| Flanks | single `balance` per entity (+ `availableBalance`, `limit` on liabilities/cards) |

**Typed balance list (standards-derived family).** An array of `{amount, currency, type}` keyed
by an ISO-20022-derived enum; the "headline" number is derived by a documented priority order.

| Provider | Balance-type enum | Headline derivation |
|---|---|---|
| GoCardless | 14 values: `closingBooked, closingAvailable, expected, forwardAvailable, interimAvailable, interimBooked, openingBooked, previouslyClosedBooked, information, …` | consumer's choice |
| Yapily | `CLOSING_AVAILABLE, CLOSING_BOOKED, EXPECTED, FORWARD_AVAILABLE, INTERIM_AVAILABLE, INTERIM_BOOKED, OPENING_*, PREVIOUSLY_CLOSED_BOOKED, AUTHORISED, OTHER, UNKNOWN` | documented priority `INTERIM_BOOKED > OPENING_BOOKED > CLOSING_BOOKED > EXPECTED > INTERIM_AVAILABLE > …` |
| Moneyhub | 13 values (`InterimBooked, ClosingBooked, Expected, InterimAvailable, …`) mapped to OB v4 codes (`ITBD, CLBD, XPCD, ITAV`) | headline `balance` object + BETA `additionalBalances[]` |
| Akoya (FDX) | per-account-type named fields (`availableBalance, currentBalance` for deposits; `principalBalance, availableCredit` for LOC) + investment `balanceList[]` name/value | — |

The two families reconcile cleanly: `interimAvailable`/`INTERIM_AVAILABLE` ≈ "available",
`interimBooked`/`CLOSING_BOOKED` ≈ "current". A normalized contract can present a canonical
available/current pair and *optionally* carry the raw typed list.

Notably, **no provider exposes a distinct "ledger" balance as a fourth first-class field** —
"ledger" appears only as a synonym (Teller's `ledger` = the total/posted balance; Finicity notes
`clearedBalance` is "also referred as posted balance, current balance, ledger balance").

### 2.4 Transaction models & the pending→posted lifecycle

**Common field core (present, under various names, everywhere):** a transaction id, a signed or
sign-plus-direction amount, a currency, a booking/posted date, a description, and a pending/booked
status. Beyond that core, optional fields (merchant, category, running balance, counterparty,
value date) vary widely.

Sign conventions are a genuine trap — they are *not* consistent across the industry:

| Provider | Sign convention |
|---|---|
| Plaid | **positive = money out** (inverse of a bank statement); debit-card purchase is `+`, direct deposit is `−` |
| Finicity | positive = deposit, negative = withdrawal/debit |
| SnapTrade | positive amount = cash gained, negative = cash spent |
| Teller | "signed amount … as a string" (statement-style) |
| TrueLayer | account txns: positive = money in; **card txns: positive = outflow** (inconsistent within the same API) |
| Yodlee / MX / Salt Edge | unsigned `amount` + explicit `baseType`/`type` = `DEBIT`/`CREDIT` |
| GoCardless / Yapily | signed amount + ISO bank-transaction-code |

The **pending→posted lifecycle** is where id stability lives or dies, and the industry has no
single answer:

| Provider | Pending model | On settlement |
|---|---|---|
| Plaid | boolean `pending` + `pending_transaction_id` on the posted row | pending row **removed**, new posted row with a **new id** back-referencing the pending one; matching may fail |
| MX | `status` `PENDING`/`POSTED` | may keep same GUID if matched, **but** commonly the pending row is deleted and replaced with a new-GUID posted row; all pending deleted after 14 days |
| Teller | `status` `posted`/`pending` | "stable transaction IDs … occasionally … created as a new record with a new ID" when it can't be matched |
| Salt Edge | separate `pending=true` query | **pending txns removed on every connect/refresh**; may reappear with a different id or not at all — "do not depend on pending transactions having a consistent ID" |
| Moneyhub | `status` `posted`/`pending` | if matched, id unchanged (`updatedTransactions`); if not, id changes (`deletedTransactions`+`newTransactions`) |
| Finicity | `status` `active`/`pending`/`shadow` | no documented transition/id-continuity semantics |
| Akoya (FDX) | `status` `PENDING/MEMO/POSTED/AUTHORIZATION` | SHOULD-level rule: "same id for pending and posted; different id for reversed; `referenceTransactionId` for reversals" |
| Yodlee | `status` `POSTED/PENDING/SCHEDULED/…` | **silent** on id continuity across the transition |
| SnapTrade / Flanks | **no pending state on transactions** | pending exists only on Orders (SnapTrade) or not at all (Flanks) |
| TrueLayer | separate `/transactions/pending` endpoint, no status field | ids change pending→settled; docs recommend *overwriting* cached txns, not merging |
| GoCardless | separate booked/pending arrays | no matching guarantee |

### 2.5 Enrichment / categorization taxonomies

| Provider | Taxonomy shape | Size |
|---|---|---|
| Plaid | `personal_finance_category {primary, detailed, confidence_level}` — two-level, `detailed` prefixed by `primary`; versioned (v1/v2) | 16 primary / 104 detailed |
| MX | hierarchical categories via `category` + `top_level_category` (parent_guid tree) | ~119 |
| Finicity | `categorization {normalizedPayeeName, category, bestRepresentation, city/state/country, confidenceScore}` | ~119 Mint-style strings |
| Yodlee | `categoryType` (6) + `highLevelCategory` (21) + `category` + premium `detailCategory` (626) | multi-level |
| Salt Edge | two fixed trees (`personal`, `business`) + `categorization_confidence` 0–1 | ~18 top-level personal |
| TrueLayer | `transaction_category` (17-value flow enum) + `transaction_classification` (two-level `[category, subcategory]`, UK/IE/FR only) | 19 classification categories |
| Yapily | Data Plus: `tier1 - tier2 - tier3` split by credit/debit + consumer/business (from April 2026) | multi-level |
| Moneyhub | `categoryId` (`std:`/`cus:` prefixed) + category groups + counterparty enrichment | grouped |
| Teller | flat `details.category` enum | ~30 |
| Akoya | passthrough only (MCC/SIC preferred); **no enrichment taxonomy** | — |
| SnapTrade / Flanks | trading-ledger `type` codes only; no merchant/category enrichment | — |

The recurring pattern is **two-level (primary/detailed) plus a raw passthrough and a confidence
score**. Plaid's is the cleanest exemplar. Nobody's taxonomy is a stable public standard — Plaid
versions its and edits the file frequently — so a normalized contract should treat category as an
*optional overlay* with its own enum plus a raw passthrough field, never a required key.

### 2.6 Investments — holdings & securities

The mature investment models all **separate the holding (a position in an account) from the
security (the instrument's identity)**:

| Provider | Holding key | Security identity | Security-type enum |
|---|---|---|---|
| Plaid | `(account_id, security_id)`, no own id | separate resource: `security_id, isin, cusip, sedol, ticker_symbol, market_identifier_code` | 9: `cash, cryptocurrency, derivative, equity, etf, fixed income, loan, mutual fund, other` |
| SnapTrade | position → `UniversalSymbol` | `symbol, raw_symbol, exchange{mic_code}, figi_code, figi_instrument` | 14 codes: `cs, et, oef, cef, bnd, ps, crypto, ad, …` |
| Akoya (FDX) | `holdingId` + security-detail `oneOf` wrapper | `securityId, securityIdType {CUSIP\|ISIN\|SEDOL\|SICC\|VALOR\|WKN}` | `STOCK, BOND, MUTUALFUND, CD, ANNUITY, OPTION, OTHER` |
| Yodlee | holding child of account | inline `cusipNumber, isin, sedol, symbol` | ~39: `COMMON_STOCK, ETF, MUTUAL_FUND, CORPORATE_BOND, …` |
| MX | holding child of account | inline `symbol` (no separate securities resource) | `holding_type`: `EQUITY, ETF, MUTUAL_FUND, FIXED_INCOME, OPTIONS, …` |
| Finicity | `position[]` embedded on account | inline `symbol, securityId, securityIdType` | inline `securityType, invSecurityType, assetClass` |
| Flanks | `Investment` position | inline `isin, cusip, symbol` (no separate security entity) | type codes (`ETF, FI, C, CFD, …`) + `PP` pension |
| Moneyhub | `HoldingsValuation.items[]` | `codes[] {code, type ISIN\|SEDOL\|MEX}` + `holdings-with-matches` ISIN enrichment | via matches |

Common holding fields: quantity/units, market price, market value, cost basis (all in the
security's native currency), plus optional per-lot tax-lot arrays and equity-comp vesting fields.
**ISIN is the strongest cross-provider security identity;** ticker + exchange (MIC) is the
fallback; provider-internal ids are last resort. TrueLayer, Teller, Salt Edge, and Yapily have
**no** holdings model at all.

### 2.7 Liabilities — credit-card & loan detail

| Provider | Where liability detail lives | Credit-card fields |
|---|---|---|
| Plaid | dedicated Liabilities product, scoped to `credit+credit card`, `credit+paypal`, `loan+student`, `loan+mortgage` | `aprs[] {apr_percentage, apr_type∈4, balance_subject_to_apr, interest_charge_amount}`, `last_statement_issue_date`, `last_statement_balance`, `minimum_payment_amount`, `next_payment_due_date` |
| Finicity | `CustomerAccountDetail` (type-conditional) | `interestRate`, `creditMaxAmount`, `paymentMinAmount`, `paymentDueDate`, `statementCloseBalance`, `statementCloseDate`, `pastDueAmount`, … + rich mortgage/student-loan blocks |
| Akoya (FDX) | `locBalance` | `purchasesApr`, `advancesApr`, `creditLine`, `minimumPaymentAmount`, `nextPaymentDate`, `lastStmtBalance`, `lastStmtDate` |
| MX | on the account object | `apr`, `calculated_apr`, `credit_limit`, `minimum_payment`, `payment_due_at`, `statement_balance` |
| Yodlee | container-specific fields | `apr`, `totalCreditLine`, `minimumAmountDue`, `amountDue`, `dueDate` |
| TrueLayer | on the card balance | `credit_limit`, `last_statement_balance`, `last_statement_date`, `payment_due`, `payment_due_date` — **no APR** |
| Moneyhub | account `details` | `APR`, `creditLimit` (+ loan/mortgage `monthlyRepayment`, `endDate`, `interestType`) |
| Salt Edge | account `extra` | `credit_limit`, `minimum_payment`, `next_payment_date`, `interest_rate`, `statement_cut_date` |
| SnapTrade / Teller / Yapily / Flanks | essentially none | LOC/credit-card exists as an account type but carries no APR/statement/due-date detail |

The convergent shape for a credit-card liability overlay: an APR list, a credit limit, a last
statement (date + balance), a minimum payment, and a next-payment due date. Plaid, Finicity,
Akoya, MX, and Yodlee all carry effectively that set.

### 2.8 Identifier & reconciliation conventions

The single most important cross-industry finding: **no provider guarantees a permanently stable
identifier unconditionally.**

| Provider | Account id | Transaction id |
|---|---|---|
| Plaid | conditionally stable — changes if reconciliation fails or the item is re-linked; cross-item `persistent_account_id` only at Chase/PNC/US Bank | changes pending→posted (new id + back-ref) |
| TrueLayer | no stability claim | `transaction_id` "may change between requests"; stable `normalised_provider_transaction_id` only when the bank supplies a provider id (~70% of connections, never for Amex) |
| SnapTrade | UUID, no stability claim on reconnect; `institution_account_id` is the only field flagged "stable" | explicitly "can change if the transaction is deleted and re-added" |
| Finicity | `accountNumberDisplay` recommended for identity | `uniqueTransactionId` "globally unique, derived from accountId + transactionId"; no transition semantics |
| Yodlee | uniqueness stated, stability **not** | unique only as `id + container`; silent on the pending→posted transition |
| MX | `guid` unique, immutability **not** stated | commonly changes pending→posted |
| Akoya (FDX) | "long-term persistent identity … unique to the owning institution" (SHOULD-level) | "long-term persistent (unique to account)"; SHOULD be same pending/posted |
| GoCardless | — | bank `transactionId` + GoCardless `internalTransactionId`, **neither** with a stability guarantee (a status incident confirmed `internalTransactionId` can change) |
| Salt Edge | Salt-Edge-assigned numeric string | pending ids explicitly non-stable |
| Yapily | "unique," no persistence guarantee | falls back to a **hash** of `account + institution + credit/debit + date + amount + description` when the bank supplies no id |
| Teller | no stability guarantee | "stable … occasionally new id" |
| Moneyhub | uuid, no cross-reauth guarantee; cross-connection key is `providerAccountId` | changes when a pending row can't be matched to its posted form |
| Flanks | deterministic `_id` from `credentials_token` + refValores/ISIN, no explicit guarantee | `_id` "unique identification of the operation," no lifecycle |

**The industry's own answer is that the aggregator must mint and maintain its own ids.** A
bank-supplied, row-unique reference is strong evidence. Some providers publish content-hash
fallbacks, but that technique cannot prove identity: two genuine payments may share every hashed
content field. Accrawl therefore mints an id per observed ambiguous occurrence and performs
pending→posted updates only with explicit one-to-one evidence.

### 2.9 Pagination & sync

**Cursor-based delta sync — one added/modified/removed change feed against an opaque cursor — is
essentially Plaid-only.** Everyone else uses date-range windows and/or offset or id-cursor
pagination.

| Provider | Pagination | Sync / delta |
|---|---|---|
| Plaid | `/transactions/sync` cursor (added/modified/removed + `next_cursor` + `has_more`); cursor valid ≥ 1 year. Investments paginate offset-style (no cursor) | true delta sync |
| Salt Edge | ascending-id cursor (`from_id` / `next_id`) | incremental via `from_id` |
| Teller | id-cursor backward (`from_id`, `count`) + date range | — |
| Yodlee | Link-header `next` cursor + `skip`/`top` | `DATA_UPDATES` → `GET /dataExtracts/userData` |
| Akoya (FDX) | link-based offset (`links.next.href`, "do not change the link") + `startTime`/`endTime` | re-query date ranges (no delta endpoint) |
| MX | offset page numbers (`page`, `records_per_page`) + `from_date`/`updated_at` filters | `from_updated_at` change-based pulls |
| Finicity | offset (`start`, `limit`) + `fromDate`/`toDate` (epoch) | poll or async refresh |
| SnapTrade | offset/limit + date range | daily cache; BETA `transactions/sync` (queue, not a cursor feed) |
| Moneyhub | limit/offset + HATEOAS links; `startDateModified`/`endDateModified` | webhooks as the change feed |
| Yapily | offset (`limit`/`offset`); real-time cursor in private beta | pull on demand |
| TrueLayer | **none** — `from`/`to` date range only (v1); v3 adds `next_cursor` | no delta |
| GoCardless | date range | booked/pending arrays |
| Flanks | **none** (unbounded arrays; `query` filter only) | daily batch, snapshot-from-cache |

### 2.10 Webhook / event vocabularies

| Provider | Data-change events | Connection/lifecycle events |
|---|---|---|
| Plaid | `SYNC_UPDATES_AVAILABLE`, `DEFAULT_UPDATE`, `HISTORICAL_UPDATE`, `INVESTMENTS_TRANSACTIONS`, `HOLDINGS` | `ITEM` errors, `PENDING_EXPIRATION`, etc. |
| SnapTrade | `ACCOUNT_TRANSACTIONS_UPDATED`, `ACCOUNT_HOLDINGS_UPDATED`, `TRADE_UPDATE`, `NEW_ACCOUNT_AVAILABLE` | `CONNECTION_ADDED/BROKEN/FIXED/FAILED`, `USER_*` (16 total) |
| MX | `AGGREGATION`, `BALANCE`, `transactions` (created/updated/deleted), `initial_data_ready` | `CONNECTION_STATUS/CHANGED` |
| Yodlee | `REFRESH`, `DATA_UPDATES`, `AUTO_REFRESH_UPDATES`, `LATEST_BALANCE_UPDATES` | consent events |
| Teller | `transactions.processed` | `enrollment.disconnected` (9 reasons) |
| Moneyhub | `newTransactions`, `updatedTransactions`, `deletedTransactions`, `syncCompleted`, `postConnectionEnrichmentCompleted` | `reauthReminder`, `refreshReminder` |
| Finicity | TxPush `account`/`transaction` events | OBWMS partner webhooks (deprecated, replaced 2026) |
| Salt Edge | `success`, `notify` (per-stage) | `failure`, `destroy`, `consent status`, `provider changes` |
| TrueLayer | **none for data change** | async-task completion + `provider_healthy/unhealthy` |
| Akoya (FDX) | **none** for transactions/balances | `CONSENT_UPDATED/REVOKED`, `MAINTENANCE` only |
| Yapily | payment events only documented | — |
| Flanks | **none** — polling only | — |

The convergent event set worth modelling: **sync completed / failed**, **transactions changed**
(with added/updated/deleted signal), and **connection status changed** (especially
needs-reauthentication). Change payloads are typically thin — an id list you re-fetch (Moneyhub,
Yodlee), not the full records.

---

## 3. Common-denominator field sets

The verified minimum each resource needs to exist across the industry, plus the useful union that
the richer models converge on. This is the direct input to Accrawl's spec.

**Account**
- *Minimum:* stable id · type (+ subtype) · currency · name/display name.
- *Union:* institution/connection ref · account-number identifiers (masked) · status ·
  personal/business flag · asset-vs-liability flag.

**Balance**
- *Minimum:* amount + currency, plus **either** an `available`/`current` pair **or** a
  typed balance list.
- *Union:* `limit` (credit limit / overdraft) · `as-of` timestamp · the raw typed list.

**Transaction**
- *Minimum:* id · signed amount + currency · booking/posted date · description ·
  pending/posted status.
- *Union:* merchant · category (two-level + raw + confidence) · provider transaction id ·
  running balance · counterparty · value date · account ref.

**Holding**
- *Minimum:* account ref · security ref · quantity · market value (native).
- *Union:* market price + as-of · cost basis · tax lots · vesting fields.

**Security**
- *Minimum:* an identity — ISIN, or ticker + exchange, or provider-internal code · a
  security-type · name.
- *Union:* CUSIP/SEDOL · MIC · option/fixed-income sub-structures.

**Credit-card liability (overlay)**
- APR(s) · credit limit · last statement (date + balance) · minimum payment ·
  next-payment due date.

**Pension (overlay)**
- defined-benefit vs defined-contribution distinction · employer · contributions · vested value.
  (First-class only in Moneyhub/Finicity; structured detail in Akoya.)

---

## 4. Per-provider summaries

Each entry states the model's defining shape and its most load-bearing enums, drawn from the
provider's current public docs (fetched/verified 2026-07-04). Source domains are listed per
entry.

### Plaid
Proprietary-normalized reference model. **Item** → accounts. Two-level account taxonomy
(`depository/credit/loan/investment/other` × ~75 flat subtypes; pensions as investment subtypes).
Balances `available/current/limit`. `/transactions/sync` cursor delta (added/modified/removed);
pending→posted removes the pending row and adds a new-id posted row with `pending_transaction_id`.
Amount sign inverted (positive = outflow). `personal_finance_category` (16 primary/104 detailed,
versioned). Investments split holdings `(account_id, security_id)` from a securities resource
(ISIN/CUSIP/ticker/MIC + 9-type enum). Liabilities scoped to 4 type/subtype pairs with a full
credit-card APR/statement field set. Account ids conditionally stable → mint your own.
*Source: plaid.com/docs.*

### TrueLayer
UK/EU open banking, Berlin-Group-shaped transactions. No REST connection resource (the access
token is the connection). **Accounts and cards are separate resource trees**; only 4 deposit
`account_type`s, no investment/loan/pension types. Single balance object (`current`, `available`,
`overdraft`; cards add `credit_limit`, statement/payment fields — no APR). `transaction_id` is
explicitly unstable; `normalised_provider_transaction_id` is the stable-but-optional id.
Date-range pull only (v1), no delta, no data-change webhooks. No holdings model.
*Source: docs.truelayer.com; support.truelayer.com.*

### SnapTrade
Brokerage aggregation. User → Connection ("brokerage authorization") → Account, with
balances/positions/orders/activities as separate resources. 3-value `account_category`
(`INVESTMENT/DEPOSIT/LOC`) + free-form `raw_type`; pensions get no dedicated type. Balances are a
per-currency `{cash, buying_power}` array. **No pending state on transactions** (pending lives on
Orders); transaction id explicitly "can change." Rich `UniversalSymbol` (ticker, MIC, FIGI) and a
unified positions model with tax lots. Offset pagination; 16 webhook events. No liabilities detail.
*Source: docs.snaptrade.com.*

### Mastercard Open Banking (Finicity)
US aggregation. Customer → institution login (`institutionLoginId`) → account. **Flat ~36-value
account `type`** with pensions and every retirement plan as first-class values. `balance` +
type-conditional `availableBalanceAmount`/`currentBalance`; premium live balance adds cleared/
posted/ledger. Transaction `status` `active/pending/shadow`; `uniqueTransactionId` derived from
account+transaction id. `categorization` with `normalizedPayeeName` + confidence. Embedded
`position[]` holdings; deep credit-card/mortgage/student-loan liability blocks. Offset pagination;
TxPush + OBWMS webhooks (OBWMS deprecated, replaced during 2026). *Source: developer.mastercard.com;
Mastercard/open-banking-us-openapi (docs portal is a JS SPA; extracted from the published OpenAPI).*

### Envestnet Yodlee
Container-based model. provider → providerAccount → account. **`container` axis** (`bank,
creditCard, investment, insurance, loan, …`) × per-container `accountType` (investment alone has
~115 values, absorbing all retirement types). Many named balance fields per container.
Transactions carry `baseType` `DEBIT/CREDIT` + `status` `POSTED/PENDING/SCHEDULED`; id unique only
`id + container`; silent on pending→posted continuity. Multi-level categorization (6/21/626).
Holdings with `securityType` (~39). Link-header cursor + `DATA_UPDATES` webhook → data-extract pull.
*Source: developer.yodlee.com.*

### MX (Platform API)
Proprietary. institution → user → **member** (connection) → account → transaction. 13 top-level
account `type`s × per-type `subtype` (INVESTMENT holds ~90 incl. pensions/retirement). Many named
balance fields with a `feed_*` / `*_set_by` provenance scheme. Transaction `status` `PENDING/POSTED`
— GUID **commonly changes** across settlement; hierarchical categories (~119). Holdings with a
14-value `holding_type` (security attrs embedded, no separate securities resource). Liability detail
on the account (`apr`, `calculated_apr`, `credit_limit`, `minimum_payment`, `payment_due_at`).
Offset pagination; aggregation/balance/connection-status/transactions webhooks. *Source: docs.mx.com.*

### Akoya (FDX)
FDX-standard model, no persistent connection resource (OAuth consent per provider). Account is a
**discriminated union** (`depositAccount/loanAccount/locAccount/investmentAccount/insuranceAccount/
annuityAccount`); `accountType` inside is a free string. Type-specific named balances; `balanceType`
enum is `ASSET/LIABILITY` (not opening/closing). Transaction `status` `PENDING/MEMO/POSTED/
AUTHORIZATION`; transaction id SHOULD be same pending/posted, different for reversals
(`referenceTransactionId`). Passthrough categorization (MCC/SIC). Rich Investments product with
holdings/securities, `pensionSource[]`/`contribution[]`/`vesting[]` for retirement. Credit cards as
`locAccount` with full `locBalance` APR/statement fields. Link-offset pagination; notifications are
consent/maintenance only (no data-change events). *Source: docs.akoya.com (extracted from the
embedded "Akoya APIs v3.0.0" OpenAPI, updated 02/23/2026).*

### GoCardless Bank Account Data
Berlin Group / ISO 20022 exemplar. **Typed balance list** (14-value `balanceType`:
`interimAvailable, interimBooked, closingBooked, expected, …`). Transactions carry only
`transactionAmount` as mandatory; bank `transactionId` + GoCardless `internalTransactionId`, **both
without stability guarantees**; booked/pending arrays; an `additionalDataStructured` umbrella for
out-of-spec fields. No holdings/liabilities detail. The clearest illustration that the
standards-derived floor guarantees almost nothing beyond amount+currency.
*Source: developer.gocardless.com/bank-account-data.*

### Salt Edge (v6)
Proprietary EU/global. Customer → Connection → Account → Transaction. **Flat 13-value `nature`**
(`checking, savings, card, credit_card, investment, loan, mortgage, …`) — no pension value. Scalar
`balance` + untyped `extra` (available/credit_limit/closing/opening; free-form `balance_type`).
Transaction `status` `posted/pending` with a `duplicated` flag and explicit dedup tooling
(`unduplication_strategy`); **pending txns are wiped on every refresh** and may reappear with a new
id. Two fixed category trees + confidence. Investment/liability data only via untyped `extra` keys;
no holdings resource. **Ascending-id cursor** (`from_id`) pagination; success/failure/notify
callbacks. *Source: docs.saltedge.com/v6.*

### Yapily
Open-banking gateway; the **consent** is the connection. 24-value `accountType` +
`usageType PERSONAL/BUSINESS` — no pension/brokerage value. **Typed balance list**
(`INTERIM_BOOKED > OPENING_BOOKED > …` priority derives the headline). Transaction `status`
`BOOKED/PENDING`; when the bank supplies no id, Yapily **hashes** account+institution+direction+
date+amount+description. Data Plus categorization (`tier1-tier2-tier3`). No holdings/liabilities
model (credit capacity only via `creditLines[]` on balances). Offset pagination (real-time cursor
in beta); documented webhooks are payment-only. *Source: docs.yapily.com.*

### Teller
Minimal US bank API. **enrollment** (connection) → account. Two-level type: `depository`/`credit`
× 7 subtypes; **no investment/loan/pension types**. Balances `ledger` + `available` (strings).
Transaction `status` `posted/pending` + `details.category` (~30) + `counterparty`; "stable
transaction IDs … occasionally new id" when a pending row can't be matched. Id-cursor backward
pagination; webhooks `transactions.processed` + `enrollment.disconnected` (9 reasons). No holdings,
no liabilities detail. *Source: teller.io/docs.*

### Moneyhub
UK aggregation with genuine pension support. Identity service (users/connections) + data API.
**Colon-namespaced flat type** with three first-class pension values
(`pension`, `pension:definedBenefit`, `pension:definedContribution`) alongside `cash:current`,
`card`, `investment`, `mortgage:*`, `crypto`. One embedded `balance` object (ISO-20022 `type`) +
BETA `additionalBalances[]` + back-filled balance history. Transaction `status` `posted/pending`;
id unchanged only when matched, else replaced. Holdings with ISIN/SEDOL codes + ISIN-match
enrichment. Liability detail (`APR`, `creditLimit`, loan/mortgage terms) in account `details`.
limit/offset pagination; rich webhook change-feed (`newTransactions`/`updatedTransactions`/
`syncCompleted`, deliver-once). *Source: docs.moneyhubenterprise.com; moneyhub.github.io/api-docs.*

### Flanks
Wealth aggregation, credential-centric (not person-mapped). Separate top-level entities:
cash **Account**, investment **Portfolio** → **Investment** (position), **Liability**, **Card**,
**Holders**/Identity. Pensions typed `PP` (Pension Plan) at portfolio and investment level.
Numeric `type` code systems (account 100–137, `flanks_category` 200–221, investment 1–90).
Single `balance` per entity; **no transaction status/lifecycle** anywhere. Inline security ids
(ISIN/CUSIP/symbol), no separate securities entity. **No webhooks** (redirect + poll); **no
aggregation pagination** (unbounded arrays); snapshot-from-cache with `updated_at_timestamp`.
*Source: docs.flanks.io.*

---

## 5. What this implies for Accrawl's contract

1. **Speak in the industry's nouns, not the retrieval mechanism.** Every provider's public
   contract is institutions, connections, accounts, balances, transactions, holdings, securities,
   liabilities — plus connection status, refresh/sync, and webhooks. None exposes *how* the data
   is obtained. Accrawl's spec must do the same.
2. **Two-level account taxonomy, with pension first-class.** The dominant shape is `type` +
   `subtype`. Accrawl serves pensions and study funds directly, so — following Moneyhub and
   Finicity — pension should be a first-class top-level type, not buried under investment.
3. **Balances: a canonical available/current(+limit) pair, optional raw typed list.** The two
   families reconcile onto this; no distinct "ledger" field is needed.
4. **Mint your own stable ids; define your own pending→posted reconciliation.** No provider
   guarantees stable ids, and several publish exactly the bank-id-then-content-hash fallback that
   makes stable ids possible. This is where a normalized model can be *stronger* than the market.
5. **Enrichment, investment, and liability detail are optional overlays** keyed off account type —
   never required core fields.
6. **Offer both date-range pagination and a Plaid-style change cursor.** Date-range is the
   universal floor; the added/modified/removed cursor is the best-in-class shape and cheap to
   offer once reconciliation already computes change sets.
