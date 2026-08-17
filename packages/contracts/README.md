# `@accrawl/contracts`

The shared vocabulary between the three processes that make up Accrawl. The engine, the control plane
and the operator console each hold their own copy of the same idea — an account, a transaction, a crawl
session — and this package is the single definition all three compile against, so a change to the shape
of the data breaks the build rather than surfacing later as a silently dropped field.

Types and their Zod schemas live together here on purpose: the schema is what validates data crossing a
process boundary, and the type is inferred from it, so the two cannot drift apart.

## What is in it

| Module | Defines |
| --- | --- |
| `types`, `models` | The core entities: institutions, connections, accounts, transactions, sessions |
| `schemas` | Zod schemas for those entities, including the structured output the crawl model must return |
| `taxonomy` | The account and transaction classification vocabulary |
| `contract` | The engine ⇄ control-plane request/response envelopes |
| `job-payload`, `worker-broker` | What a dispatched crawl job carries, and how a worker claims one |
| `tunnel-token` | The signed capability a Companion device presents to open a device tunnel |
| `identity-assertion` | The identity claims a deployment's identity service supplies |
| `tenant-catalog`, `tenant-host`, `organization` | Multi-tenant catalogue, host resolution and org membership |
| `transaction-history` | The chunked-upload envelope and its integrity fence |
| `oauth-client` | The "Connect with Accrawl" client, grant and consent shapes |
| `hosted-copy` | Strings a hosted deployment renders, kept out of the apps so they can be reviewed as copy |

Everything is re-exported from the package root; `./models` is additionally exported on its own for
consumers that want only the entities.

## Build, test, typecheck

```bash
pnpm --filter @accrawl/contracts build      # tsc -> dist/
pnpm --filter @accrawl/contracts test       # vitest
pnpm --filter @accrawl/contracts typecheck  # tsc --noEmit
```

The tests here are the contract's own guarantees rather than incidental coverage: that a schema rejects
the malformed payloads a real crawl produces, that the taxonomy is exhaustive, that a transaction-history
upload cannot be completed without its exact manifest, and that an identity assertion missing a required
claim is refused.

This package has no runtime dependencies on the apps, and nothing here reaches the network or the
filesystem. It builds and tests on its own with no database, no browser and no model API key.

## Changing a contract

A change here is a change to every consumer at once. Build the dependent packages before assuming a
change is additive — `pnpm build` at the repository root — because a field the engine now emits is a
field the control plane must be able to store and the console must be able to render.

## License

AGPL-3.0-or-later, as with the rest of the repository.
