# Companion download wording, made deployment-neutral

- Run ID: `content-review-20260814-deployment-neutral-download`
- Reviewer: content-strategist pass by the implementing agent. No independent reviewer was available in
  this session; recorded plainly rather than claimed as independent.
- Scope: only the Companion install wording in `DEPLOY.md` and `companion/README.md`, and the quoted URL
  in an earlier review transcript. Earlier review conclusions for unchanged content carry forward.

This repository must not name any particular deployment's domain. Two documents did, and the wording
around them assumed a distinction — "official signed release" versus "self-hosted" — that this repository
cannot make, because from here every deployment is somebody's own.

## Findings

**1. A named host, removed.** Both documents pointed the reader at a specific domain for the APK. The
instruction is the same for anyone: the console serves the file from whatever domain that console is on.
The path is now given relative (`/downloads/companion.apk`) and the domain is described rather than named.

**2. "Official" was doing work it cannot do here.** "The official signed APK" and "official releases"
implied one blessed publisher. Rewritten as a conditional — "if your deployment publishes a signed
release" — and as "a published release keeps one signing identity", which is the fact the reader needs:
it is why Android will install later releases as updates and why a locally signed build cannot replace
one.

**3. "For a self-hosted deployment" became "for a deployment".** Everything this repository documents is
self-hosted, so the qualifier distinguished nothing and implied the preceding sentence described
something else.

Decision: **APPROVED**.

## Approved wording

> If your deployment publishes a signed release, open **Companion** in the Accrawl console on your Android
> phone and select **Download for Android**. If the console is open on another device, scan the download QR
> with your phone instead. Either way the APK is served from your own console's domain, at
> `/downloads/companion.apk`.

> A published release keeps one signing identity, so Android can install later releases as updates.
