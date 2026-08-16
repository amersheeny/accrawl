# Content review: what a Companion is told when a deployment sends no wake-ups

- Run: `content-review-20260814-push-not-configured`
- Reviewer: Claude Opus 5, in a pass separate from the one that authored the string, with the
  content-strategist lens only. The external reviewer used for earlier reviews in this directory is not
  installed on this machine, so this is **not** an independent-model pass and is recorded as what it is.
- Scope: one new string in `apps/control-plane/src/routes/devices.ts`.
- Final verdict: **APPROVED**

## The string

> this deployment does not send Companion wake-ups

Returned with HTTP 404 and the code `push_not_configured` when a paired Companion asks which push project
to register with, and the deployment has none configured.

## Who reads it

Not a person on a screen. It is read by the Companion, which logs it, and by whoever is looking at that
log or calling the API directly while working out why a phone is not waking up. So it is judged as
developer-facing copy: the bar is that it is unambiguous and points at the right cause.

## Assessment

- **It states a fact about the deployment, not a fault.** A deployment with no push configuration is a
  working deployment — the code is typed into the console instead. "Not configured", "missing" or
  "unavailable" would all imply something is broken and send a reader looking for a defect.
- **It names what is absent specifically.** "Companion wake-ups" is the feature a reader is trying to
  make work. "Push is not configured" would be vaguer, and "push" is not a word this product uses with
  users.
- **It matches the machine-readable code.** `push_not_configured` is the code the app branches on; the
  sentence says the same thing in words. A reader who sees only one of the two is not misled by it.
- **It says nothing about how to fix it.** Deliberate: the fix is four settings on the server, and this
  is returned to a phone that cannot act on them. The install guide is where the instruction belongs, and
  it is there.

Reads as this product's voice: plain, specific, no apology, no exclamation.

## Verdict

**APPROVED.** No changes requested.
