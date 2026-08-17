# Accrawl control plane

The stateful half of Accrawl: a Fastify + PostgreSQL service that owns institutions, connections and
encrypted credentials, decides when a crawl should run, dispatches it to an engine, receives the result,
promotes it to canonical storage, and serves the normalized data out again over an API, webhooks and the
"Connect with Accrawl" OAuth authorization server.

The engine does the crawling and holds no long-lived state. Everything that must survive a crawl —
scheduling, identity, ownership, the data itself — lives here.

## Running it

```bash
pnpm --filter @accrawl/control-plane dev     # tsx watch, port 3000
pnpm --filter @accrawl/control-plane build   # tsc -> dist/
pnpm --filter @accrawl/control-plane start   # node dist/index.js
```

`PORT` overrides the default 3000. The service needs a PostgreSQL database and the secrets listed in the
repository's [`.env.example`](../../.env.example) — at minimum `POSTGRES_PASSWORD`, `ENGINE_DB_PASSWORD`,
`ENGINE_SHARED_SECRET` and `CREDENTIAL_ENC_KEY`. The root [`README.md`](../../README.md) documents every
setting and how to generate each secret; [`DEPLOY.md`](../../DEPLOY.md) covers the full self-host path.

Most people should not run this directly — `./setup.sh` then `./accrawl start` at the repository root
brings up Postgres, the control plane, the engine and the console together.

## Database

```bash
pnpm --filter @accrawl/control-plane db:generate      # drizzle-kit: emit a migration from schema changes
pnpm --filter @accrawl/control-plane db:migrate       # apply pending migrations
pnpm --filter @accrawl/control-plane db:grant-engine  # grant the engine role its narrow privileges
```

`db:grant-engine` is not optional in a deployment where the engine reaches the database directly. The
engine gets its own role with only the privileges a crawl needs; it is never the owner.

## What the routes cover

`institutions`, `connections`, `accounts`, `data` and `sessions` are the operator-facing surface.
`crawl`, `worker-broker`, `internal-engine-wake` and `hosted-crawl-lifecycle` are how work reaches an
engine and how its result comes back. `auth`, `setup` and `devices` handle operator sign-in, first-run
claim and Companion device pairing. `email-otp` and `companion` carry one-time passcodes in from email
and from a paired phone. `oauth`, `oauth-clients` and `oauth-grants` are the authorization server;
`webhooks` and `organization-shares` deliver data outward. `openapi` and `version` describe the service.

## Tests

```bash
pnpm --filter @accrawl/control-plane test
```

Two suites run in sequence. The first is the parallel unit and integration suite against an embedded
PostgreSQL — it exercises real SQL, real migrations and the real authorization checks, not mocks. The
second is a single Docker-backed test that proves the email-OTP watcher's real IMAP read path against a
live greenmail server; it runs after the parallel suite so the JVM does not contend with the test
workers.

**Without a container runtime the greenmail test reports as skipped and the suite still passes.** It is
reported as skipped, never as a pass — if you need it to run, start Docker, or set `DOCKER_BIN` when your
runtime is not on `PATH`.

```bash
pnpm --filter @accrawl/control-plane typecheck
pnpm --filter @accrawl/control-plane e2e:oauth   # drives the OAuth authorization-code flow end to end
```

Layer tests are not outcome validation. The crawl path is proven by the repository's end-to-end suite in
[`e2e/`](../../e2e/README.md), which drives a real browser against a local fake bank and relays a real
one-time passcode through a Companion build on a device.

## License

AGPL-3.0-or-later, as with the rest of the repository.
