# `@accrawl/contracts`

The shared vocabulary for what crosses a process boundary in Accrawl. A crawl request travels from the
control plane to an engine, a result travels back, a worker claims a job, a device opens a tunnel — each
of those is defined once here, so both ends compile against the same shape instead of two hand-written
copies that drift.

Where a boundary needs validation as well as a type, the Zod schema lives beside the type in the same
module. Not everything here is schema-derived: several types are declared directly and validated at the
specific edges that need it.

Its main consumers are the engine and the control plane. The console imports only the hosted copy strings
and the crawl-model constants, and declares its own interfaces for the API responses it renders.

## What is in it

| Module | Defines |
| --- | --- |
| `types` | The crawl request and response, and the normalized account, transaction and position shapes an engine produces |
| `schemas` | The Zod schemas that validate a crawl request over the wire, and the transaction-history chunk upload |
| `contract` | The read-side API shapes (`ContractAccount`, `ContractTransaction`, `SyncView`) and the projections from stored rows to them |
| `models` | The selectable crawl models and the default |
| `taxonomy` | The account and security classification vocabulary, and the mappers into it |
| `job-payload`, `worker-broker` | What a dispatched crawl job carries, and how a worker claims one |
| `tunnel-token` | The signed capability a Companion device presents to open a device tunnel |
| `identity-assertion` | The identity claims a deployment's identity service supplies |
| `tenant-catalog`, `tenant-host`, `organization` | Multi-tenant catalogue, host resolution and org membership |
| `transaction-history` | The chunked-upload envelope and its integrity fence |
| `oauth-client` | The "Connect with Accrawl" client, grant and consent shapes |
| `hosted-copy` | Strings a hosted deployment renders, kept out of the apps so they can be reviewed as copy |

The structured output the crawl model itself must return is not here — it belongs to the engine, at
`apps/engine/src/ai/schema.ts`.

Everything is re-exported from the package root; `./models` is additionally exported on its own.

## Build, test, typecheck

```bash
pnpm --filter @accrawl/contracts build      # tsc -> dist/
pnpm --filter @accrawl/contracts test       # vitest
pnpm --filter @accrawl/contracts typecheck  # tsc --noEmit
```

The tests here are the contract's own guarantees rather than incidental coverage: that every mapped
account and security classification is a member of the declared taxonomy, and that unknown input
degrades instead of throwing; that a transaction-history upload rejects missing, reordered, duplicated or
corrupted chunks and any digest or item-count mismatch; that an identity assertion is refused when
expired, tampered with, or signed under a different secret; and that a routing context sent under any
other field name is rejected rather than quietly ignored.

This package has no runtime dependencies on the apps, and nothing here reaches the network or the
filesystem. It builds and tests on its own with no database, no browser and no model API key.

## Changing a contract

A change here reaches every consumer that imports the module you touched. Build the workspace before
assuming a change is additive — `pnpm build` at the repository root — because a field the engine now
emits is a field the control plane must be able to store.

The console is the exception worth knowing about: it declares its own interfaces for the API responses it
renders rather than importing them, so a change to a read-side shape here will **not** break its build.
Check `apps/web/src/api.ts` by hand when you change one.

## License

AGPL-3.0-only, as with the rest of the repository.
