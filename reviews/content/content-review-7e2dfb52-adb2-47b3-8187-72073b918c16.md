# Content-strategist review: the AGPL §13 source offer

- Run: `7e2dfb52-adb2-47b3-8187-72073b918c16`
- Reviewer: codex (gpt-5.6-sol) via `codex exec -s read-only`, an independent pass that did not write the strings.
- Scope: the 2 new user-visible strings added to the web console's sidebar footer to satisfy AGPL-3.0 §13.
- Verdict: 1 approved as written, 1 revised. The revision was applied verbatim.

## Why these strings exist

AGPL-3.0 §13 obliges a program made available over a network to offer its Corresponding Source to
whoever interacts with it. The console is that network interface and previously carried no such offer,
so the link is a licence-compliance requirement rather than a nicety — which is also why its styling
keeps it visible on narrow screens where the build stamp is hidden.

## Full review

1. **Approve — `Source code (AGPL-3.0)`.** Correct register for a sidebar footer sitting beside a
   build stamp. Naming the licence in the label is the point of the link, not decoration.

2. **Revise.** The original said "Accrawl is AGPL-3.0. Read or download the source this console runs
   on." It restated the licence already shown in the label, and scoped the offer to the console when
   the Corresponding Source covers the whole deployment. "Read" is also the wrong verb for a
   repository someone can clone.
   **Better:** `View or download the source code for this Accrawl deployment.`

## Applied

- String 1 shipped unchanged.
- String 2 replaced verbatim with the reviewer's text.
