# Hosted integration document, rewritten as a contract

- Run ID: `content-review-20260814-integration-contract`
- Reviewer: content-strategist pass by the implementing agent. No independent reviewer was available in
  this session; recorded plainly rather than claimed as independent.
- Scope: only the passages in `docs/hosted-cell.md` that described a provider's implementation as though
  it shipped here — the settings table, the container-entrypoint sentence, and the shared-store section.
  Earlier review conclusions for unchanged content carry forward.

The implementations this document described have left the repository. Read against the current tree,
three passages made claims that are now false rather than merely dated, which is the distinction that
decides whether wording is edited or removed.

## Findings

**1. A settings table listing another party's configuration.** Eleven of its rows named a document
store, a job runner, a task queue and a secret service. Those settings are read by whichever deployment
supplies those things, not by this repository, and a reader following the table would have set variables
nothing here reads. The table now lists only what this repository reads, under a sentence saying plainly
where the rest belongs.

**2. `PERSISTENCE_BACKEND` and `ENGINE_DISPATCH_MODE` described as closed lists.** Both were written as
`postgres|firestore` and `http|cloud-run`. Neither is a list any more: one names a registered store and
the other a registered dispatcher, and this repository ships exactly one of each — the ones that need
nothing from anyone. Rewritten to describe selection rather than enumerate options that a deployment,
not this document, decides.

**3. A store section that described one implementation as the contract.** It said what "the Firestore
implementation" covers, named `firestore.rules` and `firestore.indexes.json` by path, and gave a literal
document path as the storage root. Rewritten as requirements on whatever is registered: what it must
cover, that replacing a grant must be serialized, that the connection must be re-checked against its
owner in the same transaction, that the resolved partition must be part of the storage root, and that a
deployment whose store is client-addressable is responsible for denying that access. The requirements
are unchanged; what changed is that they are now stated as requirements rather than as a description of
one thing that happened to satisfy them.

**4. Nouns checked.** `registered store`, `registered dispatcher`, `hosted crawl lifecycle`, `worker
plane`, `deferred callback` match the registration functions the same document tabulates. No synonym was
invented for anything the product already names.

**5. Provenance.** No deployment, project, region or hostname is named anywhere in the changed text.

Decision: **APPROVED**.

## Approved wording

> These are the settings this repository reads. Everything a provider needs — where its store lives,
> which job runner starts a worker, which identities are accepted — is configuration of the deployment
> that supplies that provider, and is read there.

> The request-resolved runtime partition must be part of the storage root, so two catalog partitions
> cannot collide even when owner subjects or resource ids match. A registered store is reached only by
> this service, under its own identity; browsers and phones never read those records directly, and a
> deployment whose store can be addressed by a client is responsible for denying that access.
