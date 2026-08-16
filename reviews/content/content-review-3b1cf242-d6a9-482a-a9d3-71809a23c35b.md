# Content-strategist review: write gate, request-vet model, browser hardening

- Run: `3b1cf242-d6a9-482a-a9d3-71809a23c35b`
- Reviewer: codex (gpt-5.6-sol) via `codex exec -s read-only`, an independent pass that did not write the prose.
- Scope: the 5 passages added to README.md and DEPLOY.md while the write gate, the currency set, the
  Chromium sandbox switch and the console CSP landed. Also covers apps/engine/README.md, whose install
  command changed in the same period.
- Verdict: APPROVED after revision. All 5 revisions were applied verbatim.

## Why every passage was revised

The reviewer did not find style problems. It found that the prose overstated what the write gate does.

Four of the five said, in one form or another, that every state-changing request is refused after
login. That is what the gate does on its own, but it is not what the product does: an unrecognised
request is CLASSIFIED, and one identified as a data read is allowed — which is the only reason portals
that post back to paginate keep working. A reader following the original text would have expected a
crawl against such a site to fail, and would have had no way to understand why it did not.

The revisions say what actually happens, including the deny-biased case that matters most: a request
for which no verdict is available is refused.

## Applied verbatim

1. **README.md, "what it does" bullet.** Now: the gate "checks each POST/PUT/PATCH/DELETE and refuses
   it unless a request-metadata classifier identifies it as a data read", and covers "icon-only and
   unlabelled controls" — which is more concrete than the original's "whether the control had any text
   at all".

2. **README.md, `REQUEST_VET_MODEL`.** Now names what is classified ("each uncached
   POST/PUT/PATCH/DELETE after login") and states the failure behaviour precisely: "If the model cannot
   be reached or does not return a verdict, that request is refused." The original implied the whole
   gate degrades to blanket refusal, which is wrong.

3. **README.md, `CHROMIUM_DISABLE_SANDBOX`.** Now "when the runtime blocks `clone(CLONE_NEWUSER)`,
   which Chromium's sandbox requires", attributing the block to the runtime's default seccomp profile
   rather than to "the container runtime" generally.

4. **DEPLOY.md, write gate.** Rewritten around the classifier, and it states the re-authentication
   condition as the agent REPORTING that re-authentication started, which is what the code keys on.

5. **DEPLOY.md, browser hardening.** "cross-site frames … out of the bank site's renderer process" is
   the accurate description of what site isolation gives. The measured seccomp evidence beneath it was
   not under review and is retained.

APPROVED.
