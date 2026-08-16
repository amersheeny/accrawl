# Content-strategist review

- Run: `content-review-20260804-read-only-api`
- Surfaces: the OpenAPI schema an integrating developer reads, and the auth-guard error messages the
  control plane returns over HTTP (the operator console renders several of them verbatim to a person).
- Trigger: the public API became read-only. Retrieval controls — starting a crawl, following a session,
  submitting a one-time passcode — left the API entirely, and `read:data` became the only scope. The
  connection directory also began carrying its institution’s name, type and logo for display.

An independent content strategist reviewed every string below against the code, with no stake in the
wording, checking accuracy against the implementation, clarity for the reader who actually sees it,
consistency with the product nouns, and internal vocabulary leaking to an external audience.

## OpenAPI schema descriptions

- `api.title`: `Accrawl Data API`

- `api.security`: `A scoped Accrawl credential: a manually issued API key or an OAuth access token, both sent as `Authorization: Bearer acck_…`. Missing/invalid → 401; valid but lacking `read:data` → 403; valid but not granted the connection → 403.`

- `api.connectionSummary`: `One entry in the connection directory: the institution it links to (name, type and logo, ready to display), the connection’s status and nickname, and the day it last synced.`

- `api.institutionId`: `Stable slug — a lookup key, never a label to show a person.`

- `api.institutionName`: `The institution’s display name.`

- `api.institutionLogoUrl`: `Institution logo URL, or null. Third-party content: Accrawl checks only that it is a well-formed URL. Use it as an image source; do not fetch it server-side or treat what it returns as trusted.`

- `api.lastSyncedAt`: `The UTC day (YYYY-MM-DD) this connection last synced successfully, or null if none has. Use it to show your users how current the data is.`

- `api.balanceAsOf`: `When the institution said this balance was observed. Absent when it did not say.`

- `api.connectionsList`: `The connections this credential may read: only the ones it was granted.`

- `api.connectionsEndpoint`: `The connections this credential may read: only the ones it was granted. Each entry carries the connection id, its institution’s name, type and logo, the status, the nickname, and the day it last synced. Requires read:data.`

The `info.description` prose was revised in the same pass: it now uses CommonMark paragraphs instead of
one dense block, drops the shouting caps that OpenAPI viewers render literally, says an OAuth access
token is also an `acck_` bearer, and standardises on **refresh** as the name of the act (retiring the
invented word "retrieval") while keeping **crawl** internal.

## Auth-guard messages

These were brought into review as a batch: the copy gate did not scan the guard file until this change,
so its messages had never been reviewed even though the console renders them to people.

- `auth.readOnly`: `the public API is read-only`

- `auth.signIn`: `Sign in to continue.`

- `auth.dataOwner`: `This account can’t open financial data. Sign in with the account that owns these connections.`

- `auth.platformAdmin`: `Only a platform administrator can do this. Sign in with a platform administrator account or ask one for help.`

- `auth.signInOrApiKey`: `Sign in to continue, or authenticate with a valid API key.`

- `auth.signInOrDevice`: `Sign in to continue, or authenticate with a paired companion device.`

- `auth.apiKeyRequired`: `api key required`

- `auth.authRequired`: `authentication required`

- `auth.deviceTokenRequired`: `device token required`

- `auth.apiKeyInvalid`: `invalid or revoked api key`

- `auth.deviceTokenInvalid`: `invalid or revoked device token`

- `auth.missingScope`: `missing required scope: ${…}`

- `auth.organizationAdmin`: `Only an organisation administrator can do this. Sign in with an organisation administrator account or ask one for help.`

- `auth.selectOrganization`: `Select a recipient organisation before continuing.`

- `auth.hostedSetting`: `this setting is managed by the hosted service`

## Findings the review raised, and how they were resolved

1. **The capitalisation split ran the wrong way.** The polished full sentences were the ones no human
   sees raw (the hosted portal discards the core error and substitutes its own copy), while several
   lowercase fragments are exactly what the console renders to a person. The fix was by reachability,
   not uniformity: strings that reach a console became complete, actionable sentences; strings that only
   reach a program or a log stayed lowercase fragments, which is conventional for an HTTP error body.
2. **"Operator" is meaningless to a hosted user** seeing the same 401 in the same console, so the
   sign-in messages no longer use it.
3. **"Crawl-free projection", "grant-scoped" and "operator" leaked internal vocabulary** into schema
   descriptions an integrator reads. Each was replaced with what the field actually contains.
4. **"Render it, never fetch-and-trust it" was self-contradictory** — rendering an image source is
   fetching it. The logo description now states what Accrawl actually validates (a well-formed URL, and
   nothing else) and what the consumer should therefore do.
5. **`lastSyncedAt` is a UTC day, not a timestamp** — it is stamped from a UTC ISO date. A date with no
   zone is ambiguous to anyone computing staleness, so the description now says so.
6. **`asOf` had no description at all**, which dead-ended the freshness guidance pointing readers at it.
   It now says when the field is absent.
7. **One same-class site outside the batch**: the console hard-codes an `authentication required`
   fallback when a 401 body is not JSON. It renders to a person and duplicated a server fragment, so it
   was changed to match the server string it stands in for.

## Reviewed artifact

`DEPLOY.md` — the OAuth registration walkthrough listed `read:data`, `write:crawl` and `write:otp` as the
`allowedScopes` ceiling an operator may register. Two of those no longer exist, so the line now reads
"`read:data` — the only scope there is; the API reads and nothing else". No other prose in the document
changed. The reviewer confirmed the replacement is accurate against `PUBLIC_API_SCOPES` and consistent with
the scope wording on every other surface: **APPROVED**.

## Verdict

Every string above is accurate against the implementation, addressed to the reader who actually sees it,
and consistent with the product’s nouns.

`READY`
