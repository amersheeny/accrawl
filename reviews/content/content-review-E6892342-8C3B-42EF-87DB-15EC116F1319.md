# OAuth client-authentication content review

- Run ID: `content-review-E6892342-8C3B-42EF-87DB-15EC116F1319`
- Reviewer lens: content strategist
- Surface: OAuth client authentication and authorization error responses
- Scope: newly added response-path occurrences in
  `apps/control-plane/src/routes/oauth.ts`

## Review

- `invalid_client` is the OAuth protocol error identifier for rejected client
  authentication. Retaining the exact identifier keeps the response
  interoperable with OAuth clients.
- `invalid_request` is the OAuth protocol error identifier for a request that
  lacks the request-bound consent proof. Retaining the exact identifier keeps
  the authorization response interoperable.
- `client authentication required` is intentionally shared by the missing,
  malformed, and ambiguous authentication paths. It tells an OAuth client what
  class of correction is required without disclosing whether a client ID
  exists or which credential component failed.

These strings were already present on other OAuth response paths. This review
approves only the two new occurrences of `invalid_client`, the two matching new
occurrences of `client authentication required`, and the one new occurrence of
`invalid_request`.

## Verdict

All three exact strings and the scoped occurrence counts above are
**APPROVED**.
