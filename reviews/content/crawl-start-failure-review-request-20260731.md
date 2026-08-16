# Crawl-start failure copy review request

Run ID: `CSR-CONTENT-REVIEW-1`

Act only as an independent senior product content strategist.

Review this proposed operator-facing web error exactly:

`We couldn't start this crawl. Try again later.`

Context:

- The user clicked a button labelled `Crawl now`.
- Dispatch failed before any worker began.
- Accrawl uses `crawl` for the signed-in user/operator interface.
- Accrawl uses `refresh` only for the external Provider API abstraction.
- The current leaked UI copy says
  `We couldn't start this refresh. Try again later.`

Assess noun accuracy, clarity, actionability, tone, and whether the message makes
unsupported promises.

Return exactly one of:

- `APPROVED`, followed by the exact approved string and a concise rationale; or
- `REJECTED`, followed by one replacement exact string and a concise rationale.

Do not inspect or comment on unrelated copy or code. Do not make edits.
