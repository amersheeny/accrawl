# Content-strategist review: ending every operator session

- Run: `8cf57e56-1c1d-4d29-99fa-009edafc3aef`
- Reviewer: codex (gpt-5.6-sol) via `codex exec -s read-only`, an independent pass that did not write the passage.
- Scope: the one bullet added to DEPLOY.md's security model when session revocation shipped.
- Verdict: REVISED, and the revision was applied verbatim. APPROVED as revised.

## What the reviewer changed and why it is better

The original leaned on "stateless token", which is the implementation's word rather than the reader's,
and buried the thing the reader most needs to know. Three concrete improvements:

1. **The jargon is gone.** "A signed login token in the browser's local storage" says what it is
   without requiring the reader to know what statelessness implies.
2. **The consequence is stated.** "Every console session must then sign in again." The original left
   the reader to infer that revoking would sign THEM out, which is the first question anyone would ask
   before running it.
3. **"Which is the intent" is replaced.** That phrasing reads as an excuse for a side effect. The
   revision states the behaviour plainly and lets the following sentence carry the reason.

APPROVED.
