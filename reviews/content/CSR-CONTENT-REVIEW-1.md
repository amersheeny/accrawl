# Content review: crawl-start failure

Run ID: `CSR-CONTENT-REVIEW-1`

Reviewer: independent Codex CLI session `019fb770-6c5a-7fc3-9193-b242129f341b`

Scope: the operator-facing error shown after the user selects `Crawl now` and
dispatch fails before a worker starts.

Verdict: APPROVED

`We couldn't start this crawl. Try again later.`

“Crawl” matches the operator interface and button label. The message clearly
states the failure, offers a reasonable next action, maintains a neutral tone,
and does not promise that retrying will succeed.
