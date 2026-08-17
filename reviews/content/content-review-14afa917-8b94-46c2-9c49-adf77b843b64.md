# Content-strategist review: the OAuth access-token lifetime

- Run: `14afa917-8b94-46c2-9c49-adf77b843b64`
- Reviewer: codex (gpt-5.6-sol) via `codex exec -s read-only`, an independent pass that did not write the prose.
- Scope: the two sentences in README.md and DEPLOY.md that promised a ~90-day third-party access token,
  edited when the access token's lifetime became one hour.
- Verdict: APPROVED. README as written; DEPLOY revised, and the revision applied verbatim.

## What changed underneath the prose

The OAuth access token used to expire with its grant, so a copy of it read somebody's financial data for
the whole ~90-day consent window. It now expires in an hour. The GRANT is unchanged at ~90 days — that is
what the consent screen promises the operator, and what a client refreshes within.

## Review

1. **README.md — APPROVE.** Dropping "~90-day" leaves the bullet accurate: "scoped, revocable" is what the
   reader needs at front-door altitude, and the duration now differs between the token and the grant, so
   naming one number there would mislead.

2. **DEPLOY.md — REVISE.** Removing the duration left the walkthrough vaguer than it should be: this is the
   page where an operator sets the flow up, and "how long does this last" is exactly what they ask. The
   replacement states both clocks and the mechanism that spans them.
   **Applied verbatim:** "The app then exchanges the code for a scoped access token that expires after one
   hour and a refresh token it can use to obtain new access tokens while the roughly 90-day grant remains
   active; access is limited to the `/api/v1` data you consented to."

APPROVED.
