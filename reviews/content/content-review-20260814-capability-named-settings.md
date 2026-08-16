# Content review: settings named for the capability

- Run: `content-review-20260814-capability-named-settings`
- Reviewer: Claude Opus 5, in a pass separate from the one that authored the change, with the
  content-strategist lens only. The external reviewer used for earlier reviews in this directory is not
  installed on this machine, so this is **not** an independent-model pass and is recorded as what it is.
- Scope: user-facing copy changed in `README.md`, `DEPLOY.md`, `apps/engine/README.md` and
  `docs/hosted-cell.md`.
- Final verdict: **APPROVED**

## What changed

Two settings a self-hoster types into `.env` were renamed, and the documents that tell them to do so had
to follow. One paragraph describing a deploy script was removed because the script was removed.

| Before | After |
|---|---|
| `FIREBASE_PROJECT_ID` | `COMPANION_PUSH_PROJECT_ID` |
| `FIREBASE_SERVICE_ACCOUNT_FILE` | `COMPANION_PUSH_CREDENTIALS_FILE` |
| secret `firebase_service_account` | secret `companion_push_credentials` |

## The names

- **They say what they configure.** A reader scanning `.env` for "the Companion setting" now finds it
  under that word. The old names sorted under a vendor, which is the one thing a reader is *not* looking
  for when their phone is not waking up.
- **They stay accurate when the transport changes.** The value is a project identifier for the platform
  push service; the setting is "where the Companion's wake is sent from". The second sentence survives a
  change of transport, the first does not.
- **Consistent prefix.** `COMPANION_*` already means the Companion in this product's vocabulary
  (`COMPANION_RELAY`, `ACCRAWL_COMPANION_ALLOW_INSECURE_HTTP`), so these join a group rather than
  starting one.
- **"credentials" over "service account".** The file holds a sender identity's key. "Service account" is
  the vendor's word for it; "credentials" is what it is, and matches the surrounding prose.

## The removed paragraph

`apps/engine/README.md` said a deploy script "sets the `token` trio for you". The script is gone, so the
sentence pointed at nothing. What remains — that a deployment whose identities are not OIDC can register
its own verifier — is the part a reader can still act on. The table above it, which explains what each
mode needs, is untouched and still complete without the removed sentence.

## Checked against the rest of the page

The setup steps still tell a self-hoster plainly that they need a push project of their own and cannot
use the one in the published app. That is operational reality rather than vendor vocabulary, and
removing it would leave someone unable to make wake-ups work. It stays.

## The hosted architecture note

One sentence in `docs/hosted-cell.md` said the internal tenant header may be trusted "only when Cloud Run
IAM restricts" who can reach the core. It now says "only when the platform restricts" it. The condition a
reader must satisfy is unchanged — the caller has to be unreachable from outside — and it now reads as the
requirement rather than as one vendor's way of meeting it, which is what an operator on any platform needs
to know.

## The rebuild instruction, removed

All three guides told a self-hoster to rebuild the Companion from source with their own project file,
because the published app was welded to one project. The app now asks the deployment it pairs with, so
that instruction described something that is no longer true and would have sent someone through a build
they do not need. It is replaced by what they must actually do: note three client values and set them.

The sentence that stays is the one about needing a push project at all. That is still true, and a reader
who skips it gets a Companion that never wakes with nothing on screen to explain why.

## The configuration table

The front page lists what a self-hoster sets, and the three new settings were missing from it while
appearing in `.env.example` — the exact drift the repository's own rule about keeping the two in sync
exists to prevent. They are added, described by what they do rather than by whose service they belong
to, and the optional ones say what happens when they are left unset: codes are typed into the console,
which is a working deployment rather than a broken one.

## Verdict

**APPROVED.** No changes requested.
