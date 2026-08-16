# Engine transaction-history content review

- Run ID: `content-review-20260803-engine-transaction-history`
- Reviewer: independent content strategist
- Scope: only the transaction-delta capability wording, the internal transaction-history upload route,
  and the corresponding `SERVICE_MODE=crawl` route list in `apps/engine/README.md`. Earlier review
  conclusions for unchanged content carry forward.

The review checked the wording against the implemented first-crawl and later-crawl windows, one-to-one
transaction matching, occurrence counts, pending and bank-reference updates, ordered chunk assembly,
SHA-256 integrity checks, and crawl-route registration. It also checked Accrawl terminology and public-repo
provenance hygiene. Decision: **APPROVED**.

Approved capability wording:

> - **Occurrence-preserving transaction deltas.** Until a connection completes its first transaction crawl,
>   the engine requests every transaction in its 90-day window. Each later crawl compares bank rows one to
>   one with the complete stored seven-day window. It treats cosmetic description changes as the same
>   transaction, updates pending transactions and newly assigned bank references in place, and preserves
>   look-alike transactions as separate occurrences. The model reports genuinely identical rows with an
>   explicit `count`; accidental repeated reports are ignored.

Approved endpoint wording:

> Internal control-plane upload for large seven-day transaction histories. Chunks must arrive in order and
> pass per-chunk and complete-history SHA-256 checks before the crawl starts.

The deployment-surface paragraph now names `/crawl/transaction-history` alongside the other authenticated
routes registered by `SERVICE_MODE=crawl`.
