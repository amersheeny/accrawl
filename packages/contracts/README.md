# `@accrawl/contracts`

`@accrawl/contracts` defines the shared types and validation schemas for data that crosses Accrawl
process boundaries. It defines each crawl request, crawl result, dispatched job, worker claim and
device-tunnel token once, so every producer and consumer compiles against the same shape.

Where a boundary needs validation as well as a type, the Zod schema lives beside the type in the same
module. Not everything here is schema-derived: several types are declared directly and validated at the
specific edges that need it.

Its main consumers are the engine and the control plane. The console imports only the hosted copy
strings and the Gemini model-selection constants, and declares its own interfaces for the API responses
it renders.

## What is in it

| Module | Defines |
| --- | --- |
| `types` | The crawl request and response, and the normalized account, transaction and position shapes an engine produces |
| `schemas` | The Zod schemas that validate a crawl request over the wire, and the transaction-history chunk upload |
| `contract` | The read-side API shapes (`ContractAccount`, `ContractTransaction`, `SyncView`) and the projections from stored rows to them |
| `models` | The Gemini models the engine can use, and the default model |
| `taxonomy` | The account and security classification vocabulary, and the mappers into it |
| `job-payload`, `worker-broker` | What a dispatched crawl job carries, and how a worker claims one |
| `tunnel-token` | The signed capability a Companion device presents to open a device tunnel |
| `identity-assertion` | The identity claims a deployment's identity service supplies |
| `tenant-catalog`, `tenant-host`, `organization` | Multi-tenant catalogue, host resolution and org membership |
| `transaction-history` | The chunked-upload envelope, ordering checks and whole-upload integrity checks |
| `oauth-client` | The "Connect with Accrawl" client, grant and consent shapes |
| `hosted-copy` | Strings a hosted deployment renders, kept out of the apps so they can be reviewed as copy |

The schema for the structured output that Gemini must return is not part of this package; it lives in
the engine at `apps/engine/src/ai/schema.ts`.

Everything is re-exported from the package root; `./models` is additionally exported on its own.

## Build, test, typecheck

```bash
pnpm --filter @accrawl/contracts build      # tsc -> dist/
pnpm --filter @accrawl/contracts test       # vitest
pnpm --filter @accrawl/contracts typecheck  # tsc --noEmit
```

The tests verify that mapped account and security classifications remain within the declared taxonomy;
unknown account types map to `other/other` and unknown security types map to `other` instead of throwing;
transaction-history uploads reject missing, reordered, duplicated or corrupted chunks and digest or
item-count mismatches; identity assertions reject expired or tampered claims and claims signed with a
different secret; and routing contexts under an unexpected field name are rejected rather than ignored.

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
