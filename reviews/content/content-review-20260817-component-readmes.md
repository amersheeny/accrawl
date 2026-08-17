# Content review: the three new component READMEs and the root layout links

- Run: `content-review-20260817-component-readmes`
- Reviewer: an external model, run read-only over the working tree, with the content-strategist lens
  only. A separate correctness pass had already reviewed the same files and its findings were applied
  before this one ran, so this review judged the words alone — audience, the product's own nouns,
  clarity, tone against the existing component READMEs, and structure.
- Scope:
  - `README.md` — only the newly added component-links block under "## Monorepo layout"
  - `apps/control-plane/README.md` (new)
  - `apps/web/README.md` (new)
  - `packages/contracts/README.md` (new)
- Final verdict: **APPROVED** (first pass: REVISE, with ten verbatim replacements; all ten applied)

## Why these documents needed a review at all

Three components had no README in a repository whose own rules require each to carry build, run and
validate steps. The documents were written to fill that gap, which means every word in them is new
copy that no reviewer had seen. Authoring a string is not approving it.

## What the review returned

`REVISE`, with ten findings. Grouped by what they were actually about:

**Overstated or unearned claims.**

- "Each component documents its own build, run and validate steps" promised all three activities from
  every linked document, when some are libraries with no distinct run step. Now "Build, run and
  validation guidance by component:".
- "which is the path a real deployment uses", said of the Companion relay, implied every real
  deployment uses Companion and excluded the manual and email relay paths. Now the sentence names what
  the option validates instead of asserting what deployments do.
- "makes no decision the server does not also enforce" was an imprecise security assurance. Now: "the
  control plane independently authorizes and validates its requests."

**Wrong or ambiguous product nouns.**

- "connect an account" invented a synonym for creating a connection — and gets the model wrong, since
  one connection can return several accounts.
- "crawl model" is ambiguous between the model that performs a crawl and a data model of a crawl. All
  three occurrences now say Gemini, which is what they meant.
- "the server" abandoned the established noun; it is the control plane.
- "integrity fence" was internal metaphor. Now "ordering checks and whole-upload integrity checks".

**Structure and framing.**

- The control-plane README gave standalone commands and configuration detail before mentioning that
  most readers want `./setup.sh` and `./accrawl start`. That guidance moved to the top of "Running it".
- "The stateful half of Accrawl" implied a two-part product, ignoring the console and the Companion.
- "It is not credential-free" opened on a negative without saying which credentials were meant —
  operator authentication or bank credentials. The replacement distinguishes them.
- "rather than incidental coverage" commented on the tests instead of saying what they check, and
  "unknown input degrades" never said what it degrades *to*.

## Verification of the factual claims the new wording introduced

The replacement copy asserts two concrete fallback values. Both were checked against the built package
rather than against the tests that describe them: `mapAccountType('zzz')` returns
`{type: 'other', subtype: 'other'}` and `mapSecurityType('zzz')` returns `'other'`.

Naming Gemini is permitted here — it is the model client, and the provider-neutrality gate carries no
token for it. `scripts/provider-neutral-policy.test.mjs` passes with the new wording.

## Assessment

The findings were about the documents making themselves sound more authoritative than they were: a
promise of three activities, a claim about what "real deployments" do, a security assurance stated as
an absolute. Each replacement narrows a claim to what the reader can rely on. That is the right
direction for a front door that a stranger reads before deciding to trust the project.

All ten replacements were applied verbatim.

**VERDICT: APPROVED**
