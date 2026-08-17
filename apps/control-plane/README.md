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

`PORT` overrides the default 3000. The process itself reads `DATABASE_URL` (a PostgreSQL connection
string, which carries the password; `DATABASE_URL_FILE` reads it from a file instead), plus
`CREDENTIAL_ENC_KEY`, `ENGINE_SHARED_SECRET` and `ENGINE_DB_PASSWORD`.

`POSTGRES_PASSWORD` in [`.env.example`](../../.env.example) is a Compose-level input, not something this
process reads — `docker-compose.yml` uses it to build `DATABASE_URL`. Running the service directly means
supplying `DATABASE_URL` yourself. The root [`README.md`](../../README.md) documents every setting and how
to generate each secret; [`DEPLOY.md`](../../DEPLOY.md) covers the full self-host path.

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
[`e2e/`](../../e2e/README.md), which drives a real browser against a local fake bank and carries a real
one-time passcode back through the relay. By default that relay is in-process, which needs nothing beyond
a model API key. Setting `COMPANION_RELAY=1` instead routes the passcode through a Companion build
installed on an emulator or phone, which is the path a real deployment uses.

## License

AGPL-3.0-or-later, as with the rest of the repository.
