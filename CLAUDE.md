# Accrawl — agent instructions

Accrawl is a **self-hostable, open-source** financial-account aggregator (TypeScript monorepo: `apps/engine`,
`apps/control-plane`, `apps/web`, `packages/contracts`). Because it is public-facing OSS, its docs are part
of the product.

## CRITICAL: repository boundary — ALL product logic lives here; wrappers integrate only

**What lives HERE (the open-source product):** every piece of functionality — crawl orchestration and
lifecycle, scheduling and retry policy, transaction identity, storage semantics and data invariants, prompts
and schemas, OTP handling, device pairing, authorization behavior, API routes, the web console, the Companion
app, and the self-host deploy scripts — expressed against storage-/provider-agnostic interfaces (ports), with
complete local implementations (PostgreSQL + local filesystem) so the product is whole on its own.

**What lives in a closed/hosted wrapper repository (never here):** implementations of this repo's ports
against a cloud provider — hosted document store, job-runner dispatch, queue-based reconciler wake, cloud
screenshot bucket, cloud identity attestation, managed-secret resolution; composition entrypoints that
register those implementations through this repo's published registration APIs and boot the UNMODIFIED apps;
and hosted business surfaces that are not the product — edge/gateway routing, marketing/portal/billing, cloud
infrastructure definitions, image build and deploy pipelines.

**This repository names capabilities, never providers.** Not in a dependency, not in a type, not in a
configuration value, not in a comment, not in a document, not in a commit message, and not anywhere in the
history someone can clone. A document store, a job runner, a queue, an identity service — that is how the
product refers to what a deployment supplies, because the product genuinely does not know which one it is.

The authoritative list of what that forbids is **`scripts/provider-neutral-policy.test.mjs`**, not this
paragraph. Prose cannot be run, and a rule that is only written down is a rule that gets read narrowly
under deadline — which is exactly how a much weaker rule ("no provider SDK in `package.json`") once stood
here while dozens of files still named one vendor's database in their types and comments, and a passing
check was reported as a clean repository. Every exception lives in that file, scoped to the files that may
carry it, with its reason written beside it. Two exist today: the model client, and the platform push
transport that has no identity outside its vendor. **A deployment's own identifiers — project names, ids,
numbers, hostnames — are never excepted anywhere.**

Never:
- add a provider's client library to any `package.json`, in `dependencies`, `optionalDependencies` or
  `devDependencies`; a repo policy test fails when one appears;
- add provider imports or provider-shaped config keys to this repository — a setting is named for the
  capability it configures, and only the module that implements that capability knows the transport;
- move, copy, or reimplement product logic into a wrapper — when a wrapper needs a behavior change, the
  behavior changes HERE, storage-agnostically, and the wrapper only adapts it;
- design a port so thin or so provider-shaped that decision-making leaks into the wrapper — retry
  classification, locking and fencing policy, promotion rules, schedule arming, and data invariants are logic
  and stay here;
- reference any private wrapper repository, its deployment identifiers, project names, or admin hostnames in
  code, comments, docs, or **commit messages** — private tooling scans this repo's entire history for such
  markers and blocks publication on a hit.

**Local installability is a release gate.** A newcomer with Docker and a model API key must be able to install
and run the complete product on one machine using only the simple documented deploy scripts — `./setup.sh`,
then `./accrawl start` — with **100% of storage local** (PostgreSQL + local filesystem volumes): no cloud
account, no cloud credential, no cloud SDK, no emulator, no wrapper repo. Any change that adds a cloud
requirement to installing, building, testing (the default suite), or running this path is a defect, no matter
what it enables elsewhere.

## CRITICAL: Keep EVERY doc (`.md`) current as you work — in the SAME change, never "later"

Every Markdown doc in this repo is part of the product. Treat docs as code: **update the relevant doc(s) in
the same change** that alters anything they describe. A stale doc is a defect — the same as a failing test.
Don't finish a change leaving a doc describing the old reality; if you build/rename/move/remove something a
doc mentions, fix that doc before you're done.

The docs and what each must track:
- **`README.md`** — the front door: what it is, status, monorepo layout, quick-start, the config table (in
  sync with `.env.example`), dependencies/trust posture, security, license, roadmap.
- **`DEPLOY.md`** — the full self-host walkthrough: compose services, ports, prerequisites (incl. arch /
  Rosetta), first-run setup + first-crawl steps, secrets handling, the companion/tunnel options.
- **`apps/*/README.md`, `companion/README.md`, `e2e/README.md`** — each component's own build/run/validate steps.
- **`CLAUDE.md`** — these rules.

Update the matching doc(s) whenever you change any of:
- the monorepo layout or which components exist — an app moving *planned → built* MUST be reflected; never
  leave a built component labelled "planned," never list one that doesn't exist;
- how to run/deploy/build (compose, ports, commands, arch requirements, the dev workflow);
- required configuration (env vars / secrets — keep config tables in sync with `.env.example`);
- runtime dependencies or the data-flow/trust posture;
- the validation status, or the **feature set** — a new feature must be documented where users find it.

Every doc must meet these bars:
- **Accurate, not aspirational.** Every claim is verifiable against the current tree. Before editing, check
  the actual files (`apps/*`, `companion/`, `docker-compose.yml`, `.env.example`, `package.json`) — never
  write from memory or the build plan.
- **Honest status.** State what is built/tested/actually-run vs. not. NEVER call the project "validated" or
  "production-ready" beyond what was genuinely executed end-to-end.
- **No broken or phantom references.** Every internal link resolves; don't reference a file (e.g.
  `SECURITY.md`) as if it exists when it doesn't — create it or mark it planned.
- **No provenance leaks.** Accrawl reads as wholly original first-party code — no reference, anywhere (code,
  comments, or any doc), to any project it was derived from.

When in doubt whether a change affects a doc, it does — re-read that doc and reconcile it.

## CRITICAL: outcome validation requires a frozen, reproducible E2E evidence matrix

Tests of layers are necessary evidence, but they are never evidence that a user outcome works end to end.
Before changing code, derive a scenario matrix from every acceptance criterion, changed authorization branch,
actor, server-issued capability, ownership boundary, and state transition. Give every row a stable scenario
ID. An independent review must confirm that the matrix covers the change before execution. After implementation,
a second independent coverage review must bind every acceptance criterion, final diff, changed route, guard,
backend, actor, capability, and state transition to the final matrix, commit, and artifact digests. Any later
code, configuration, artifact, or matrix change invalidates that review. A row may be marked `N/A` only with
evidence, a written rationale, and reviewer approval; neither the implementer nor an agent may silently omit a
row or declare its own matrix exhaustive.

Every subsequent review is incremental. After review findings are resolved, the next reviewer must inspect only
the changes made since the immediately preceding review and their interactions with the already-reviewed material.
The reviewer must not reopen unchanged material or introduce findings against content that was already reviewed
and did not change. Unchanged review conclusions carry forward, and the ordered review chain collectively covers
the current complete matrix or change-set. Apply the same delta-only scope when later code, configuration,
artifact, or matrix changes invalidate a review: review those later changes and their affected interactions, not
the entire unchanged body again.

Create separate rows for every affected production-supported external surface: the real frontend, raw public API,
each supported SDK, Companion, the real user edge, the administrative portal, and each platform's deployed
transport. One surface cannot stand in for another; every unaffected surface needs an independently reviewed
`N/A` row. Direct route/handler invocation, database manipulation, or a layer-test harness cannot be the primary
path. In particular, do not substitute direct API calls for creation, editing, publication, connection setup,
sign-in-domain verification, capability changes, crawl initiation, or any other affected frontend interaction.
APIs, database queries, logs, and traces may corroborate the result and must be used for assertions that pixels
cannot prove.

Build the matrix as the cross-product of production architecture, engine platform, persistence topology, and
external surface: self-hosted and hosted architectures; every registered persistence backend; every
registered engine platform, which for this repository alone means `PLATFORM=local`, `PLATFORM=postgres` and
`PLATFORM=remote`, plus any a deployment registers; and every surface listed above. Run every affected supported combination. Every unsupported or unaffected combination
requires an independently reviewed `N/A` row with architectural evidence; combinations cannot disappear by
omission or be covered by testing each dimension separately. Include each combination's real engine/worker
dispatch, staging, and canonical-promotion path. Test the complete packaged production topology, not plain source
processes standing in for containers or managed services. Use the real control-plane, engine, authentication and
authorization checks, persistence backend, and production implementation. The runtime configuration must match
production except for recorded local endpoints, single-run test secrets, and the deterministic external
institution. That fake institution is permitted and preferred because it supplies an exact data oracle; mocks or
debug bypasses that replace an Accrawl service, authorization decision, capability transition, crawl stage, or
persistence boundary are forbidden. Test-only authorization headers, directly signed identity assertions, direct
identity/storage edits, cached crawl output, seed data standing in for a tested action, and reused resources cannot
pass a row.

“Production code” means the exact release artifacts and production topology; it is not permission to write test
accounts or application records into production data. Run every mutable hosted row in a dedicated isolated
project whose identity, storage, job-runner, worker, transport and security configuration is proven equivalent
to production. Deploy those exact tested digests without rebuilding. After deployment, perform non-mutating
production artifact/configuration/health checks and only the read-only outcome checks that existing authorized
production data permits. A complete mutable post-deployment matrix requires separate explicit authorization to
create and later remove production test users and records; never infer that authorization from “test production
code,” “deploy,” or “verify the deployment.”

Every crawl row must:

- enter and initiate the crawl through the single production external surface named by that row and prove the
  terminal state belongs to that new crawl/session;
- for every institution-to-crawl workflow, create fresh institution and connection resources and verify the
  sign-in domain through the real frontend under the recorded authenticated identity and tenant;
- prove ingestion and canonical promotion finished without partial failures, skipped stages, or stale records;
- compare a schema-normalized, deep-equality oracle of the complete record sets for every entity supported by
  the requested scope against staged engine output, canonical storage, API responses, and rendered financial
  data. Assert every field, relationship, owner, count (including explicit zero counts), and the absence of
  unexpected or stale rows. Substring, approximate-value, presence-only, non-empty-result, and terminal-badge
  checks cannot pass.

Cross-user rows require distinct authenticated identities, immutable subject IDs, clean browser sessions, and
the server-issued capabilities captured in the evidence. Every baseline identity and capability, including
`data-owner` and `platform-admin`, must originate through the real user edge or administrative portal, with
issuance evidence; a harness may not sign a production-shaped assertion itself. Authorization must be checked
through both the UI and direct backend requests, including guessed resource IDs, private and published resources,
unpublished copies, forbidden mutations, stale sessions, and access after a capability is removed. A
capability-change row must use the supported production entitlement and assertion-issuance flow on the same
subject, refresh the active session or token, and then repeat the checks in both the refreshed existing session
and a newly authenticated session. Directly signing a stronger assertion or editing storage is not a promotion
flow. If the product has no supported path for a required transition, the row fails and the release is blocked.
Capability removal is mandatory whenever a changed authorization decision depends on that capability.

Institution catalogue, ownership, publication, connection, or crawl-entry changes must include at least these
fresh-resource rows:

1. An identity holding only `data-owner` creates a private institution, edits it, connects it, verifies its
   domain, completes a crawl, and sees the exact resulting data; another `data-owner` cannot discover, read, use,
   mutate, or delete that private institution by UI or direct request.
2. The same subject is authenticated through its production user-edge `data-owner` session and administrative-
   portal `platform-admin` session. Through the real frontend surfaces, it creates a private institution in the
   administrative context, proves the source remains private, then uses its user context to create and verify its
   own connection and complete the exact-data crawl without any denial caused by its catalogue entitlement.
3. The `platform-admin` session finds and manages another identity's private institution, publishes an
   independent copy, and proves the source and copy have different immutable IDs. A different `data-owner` sees
   the published copy, cannot mutate or delete it, creates a connection from it, and completes the exact-data
   crawl.
4. The same subject is exercised before and after supported promotion to catalogue-management entitlement. The
   pre-promotion user-edge and administrative-portal sessions prove catalogue-wide management and publication
   are unavailable. Promotion must change the real portal entitlement and assertion issuance. Refreshed and
   newly authenticated post-promotion sessions prove catalogue management is available through the
   administrative portal while the subject's `data-owner` workflow remains available through the user edge;
   together they complete create, publish, connect, and crawl.
5. The promoted subject is exercised through supported entitlement removal. Existing and newly authenticated
   administrative sessions must lose catalogue-wide mutation/publication access, while user-edge sessions
   retain access appropriate to `data-owner`.

Before execution, enumerate the material rendered checkpoints for every row, including initial/empty, owned
private, another user's private-management view, published read-only, confirmation, success, denial/error,
connection/domain verification, active crawl, terminal crawl, and resulting financial-data states as applicable.
For every checkpoint, predeclare the expected visual assertions and record pass/fail review. Capture the actual
built UI and tie every screenshot to its scenario ID, timestamp, actor subject, resource and crawl/session IDs,
artifact digest, viewport/device, theme, and application state. Any omitted checkpoint needs the same reviewed
`N/A` evidence as a matrix row. Screenshots are required corroborating evidence for rendering and interaction
state; they never prove backend authorization or data correctness on their own.

Store one frozen evidence bundle for the run containing the reviewed matrix, immutable commit and artifact
digests, environment and production-configuration fingerprint, actor subject IDs and server-issued capabilities,
tenant, commands, raw logs/traces, resource and crawl/session IDs, timestamps, exact expected/actual assertions,
automated row-level pass/fail output, and the screenshot files themselves. The bundle must let an independent
person reproduce every row and match every assertion and screenshot to the same artifact and crawl. Preserve raw
output; do not replace it with a prose summary. After the bundle is complete, generate a SHA-256 manifest covering
every evidence file. The independent reviewer must produce an identified attestation bound to the matrix,
final-diff, artifact, configuration, and evidence-manifest digest. Content-address every evidence file, manifest,
reviewer attestation, and final envelope/root. Upload the complete closure together to storage that is both
content-addressed and retention-protected/append-only, then verify every uploaded digest before accepting the
review. A replaceable or deletable local bundle beside its digest is insufficient. Apply this protection equally
to pre-deployment and post-deployment bundles. Any later change invalidates the review and requires a new bundle,
manifest, and review.

The words **“I validated”**, **“validated”**, **“fully validated”**, **“done”**, **“ready”**,
**“production-ready”**, **“ready to deploy”**, or any equivalent outcome-completion claim are forbidden until
every applicable matrix row is green and the evidence bundle has passed independent review. Before then, name
evidence only at its actual level (for example, unit tests, integration tests, API checks, or rendered-screen
inspection) and state that outcome validation is incomplete. An `e2e` filename or test label does not change
the evidence level. Any missing, failed, flaky, or unreviewed row is a `# ⚠️ BLOCKER`, not a footnote.

Maintain a complete artifact inventory covering every participating server, frontend, raw API contract, SDK,
Companion build, transport, migration, and infrastructure artifact. Map each artifact's immutable digest to the
matrix rows that exercised it, their evidence, its deployment target, and the running digest verification.
Deployment must promote that exact complete artifact set without rebuilding, then verify every running digest.
Before deployment, freeze and review the production row matrix. After deployment, run the complete non-mutating
deployment-closure matrix against the deployed digests: running artifact/configuration identity, health, routing,
authentication enforcement, existing authorized read paths, SDK/package installation identity, Companion package
and signing identity, and every production state that can be observed without creating or changing a production
record. Preserve and independently review a second evidence bundle. The complete mutable outcome matrix—including
every externally entered workflow, actor, capability transition, authorization denial, crawl oracle, and visual
checkpoint—must already have passed against the same digests in the production-equivalent isolated project. Repeat
that mutable matrix in production only with separate explicit authorization for its production-data writes and
cleanup. A hand-picked smoke subset cannot replace either the isolated mutable matrix or the non-mutating
post-deployment matrix. Do not claim the deployment or outcome complete until both required bundles are green and
independently reviewed.

## CRITICAL: crawl-logic work requires the real local companion E2E

Any task that changes crawl behavior is incomplete until the full local emulator E2E passes. This includes
changes to crawl orchestration, scheduling, storage/promotion, transaction identity, prompts or schemas,
browser/agent behavior, OTP handling, device tunnels, and crawl-facing contracts.

The required gate is the real server-and-client path:

```bash
EMU_SESSION="<stable-session-id>" \
EMULATOR_SERIAL="<leased-emulator-serial>" \
COMPANION_RELAY=1 e2e/run-e2e.sh
```

**This gate takes no input from a human, and asking for any is a defect.** Everything it needs is
already on the machine, and the run resolves it:

- `GEMINI_API_KEY` and `EMULATOR_LEASE_SCRIPT` come from `.env` when not exported.
- The four Companion push settings are read out of the Android client configuration in the Companion
  build tree — the same file the app's own build consumes — matching the entry whose application id
  belongs to the flavor this run installs. The relay run has to build the app, so that configuration
  is necessarily present.
- Node must satisfy `package.json` `engines`; the default interpreter on `PATH` may be older, and the
  run refuses rather than half-working.

Before ever reporting this gate blocked on a missing credential, look for the **file the component
that consumes it actually reads** — not just for an environment variable of that name. A value absent
from `.env` and from `git grep` is routinely present in an untracked, gitignored config that the build
already depends on. Reporting it as needing the user's input, when a previous run in the same session
already succeeded, is the failure this paragraph exists to prevent.

Use a visible emulator assigned to the current session; never assume or hardcode a serial. Every ADB action
must go through the lease wrapper so ownership is checked at the point of use. The run must start the real
control-plane and engine, drive the Playwright crawl against the local fake bank, deliver its random OTP as
an emulator SMS, have the installed Companion app relay it through the device-authenticated endpoint, and
pass the canonical account/transaction ground-truth assertions. Unit tests, mocked relay tests, an in-process
OTP relay, or a server-only E2E do not substitute for this gate.

If the emulator, API key, network, or another dependency prevents this exact run, do not call the task done
and do not silently downgrade validation. Keep resolving it, or stop with a prominent blocker naming the
failed prerequisite and the concrete action needed to unblock it.

## CRITICAL: finish every change with a commit; push only when authorized

Never leave task changes uncommitted. Commit every in-scope change directly to `master`, preserving unrelated
shared-tree work by staging only the files changed for the task. Push to `origin/master` only after the user
explicitly authorizes push or deployment and every applicable validation gate is green. An authorization to
deploy includes the necessary push; do not ask again. If an authorized push is rejected or unavailable,
continue resolving it or report a prominent blocker with the exact failure.
