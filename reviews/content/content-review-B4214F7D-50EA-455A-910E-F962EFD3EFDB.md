# Hosted crawl and refresh copy review

- Run ID: `content-review-B4214F7D-50EA-455A-910E-F962EFD3EFDB`
- Reviewer lens: independent content strategist
- Surface: hosted refresh and crawl errors, Accrawl Companion progress, and
  Firestore worker completion

## Product nouns checked

The existing product uses:

- “refresh” for the external data API;
- “crawl” for the operator-facing web flow;
- “connection” and “institution” for saved financial-provider access; and
- “Accrawl Companion” for the phone app.

The reviewed copy preserves those nouns. In particular, “Accrawl Companion”
replaces the implementation label “OTP relay app,” and “one-time code”
replaces the unexplained acronym “OTP” in new progress copy.

## Approved exact copy

- `This refresh can update account balances only.`
- `This refresh found too many accounts to save. Contact support before trying again.`
- `A refresh is already running for this connection.`
- `A crawl is already running for this connection.`
- `This API key cannot access this connection.`
- `Connection not found.`
- `This refresh can no longer start because its session has ended.`
- `We couldn't start this refresh. Try again later.`
- `We couldn't complete this refresh. Try again later.`
- `This crawl was stopped.`
- `Waiting for Accrawl Companion to connect…`
- `Entering the one-time code…`
- `This institution is unavailable. Contact support before trying again.`
- `This connection’s sign-in details are unavailable. Contact support before trying again.`
- `This connection must be enabled and signed in before the crawl can start.`
- `This institution’s login domain hasn’t been verified, so the crawl can’t start.`
- `The saved login address doesn’t match this institution’s domain.`
- `The crawl can’t start until its safety check passes.`
- `Accrawl isn’t configured to route crawls through a phone’s network.`
- `The crawl didn’t finish within the allowed time.`

All twenty strings are approved exactly as written.

## Rejected or constrained copy

- “We couldn't start this refresh” is not accurate after a worker has begun;
  the distinct “couldn't complete” message is required for runtime failures.
- “OTP relay app” and raw millisecond/session-ID timeout messages expose
  implementation language instead of telling the user what happened.
- Arbitrary Cloud Run, broker, browser, model, or exception text is
  internal-only. It must remain in protected diagnostics and must not be copied
  into a session error or connection `safeErrorMessage`.
