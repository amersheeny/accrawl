# Content review: `OPERATOR_TOKEN_TTL_HOURS` in `README.md` and `.env.example`

- Run: `content-review-20260818-operator-token-lifetime`
- Reviewer: an external model, read-only over the working tree, separate from the pass that wrote the
  text. Two cycles: a first pass over the draft, then a follow-up verifying the revision.
- Scope: the new config-table row and the matching `.env.example` block for a setting that controls
  how long an operator session token stays valid. Read by a self-hoster deciding whether to change a
  security default, sometimes on a machine they do not fully control.
- Final verdict: **APPROVED** (first pass: CHANGES REQUESTED; follow-up: APPROVED, nothing new)

## What the first pass returned

Accuracy was fine — default, bounds and fallback all matched the implementation — but two problems:

1. **No usable recommendation.** A number with a range is not advice. "Shorten it if you sign in from
   a machine you do not control" tells a reader nothing about what to set, and the better counsel is
   not to sign in from such a machine at all; failing that, use the one-hour minimum and revoke every
   session afterwards.
2. **Two wrong inferences a reader would reasonably draw.** That a shorter lifetime makes an
   untrusted machine safe — it does not, it only bounds reuse of a copied token — and that changing
   the value shortens sessions already issued, which it does not: the expiry is baked into the token
   when it is minted.

## What changed

Both files now recommend a specific action rather than a direction, state plainly what shortening the
lifetime does and does not protect against, and say that existing tokens keep their original expiry.
Each points at ending every session as the thing that acts immediately.

## Checked rather than accepted

The reviewer proposed a link to `DEPLOY.md#security-model-what-protects-you`. That anchor exists at
DEPLOY.md line 178, and revoke-all is documented inside that section at line 229 with the exact
command, so the reference resolves and the label matches what the reader will find. The claim that
revoke-all requires the operator password was confirmed against the route, which verifies it before
rotating anything.

The follow-up confirmed both findings resolved, nothing inaccurate against the implementation, the
link correct, and nothing new introduced.
