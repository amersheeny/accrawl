# Contributing

Thanks for looking. Accrawl drives real logins to real financial accounts, so the bar here is a
little unusual: a change that merely works is not yet finished.

Found a security problem? Don't open an issue — see [SECURITY.md](./SECURITY.md).

## Getting it running

You need Docker, Node matching the `engines` field in `package.json`, pnpm, and a model API key.

```bash
git clone https://github.com/amersheeny/accrawl.git && cd accrawl
pnpm install
cp .env.example .env       # then set GEMINI_API_KEY
pnpm test
```

`./setup.sh` followed by `./accrawl start` brings up the whole self-hosted stack; [DEPLOY.md](./DEPLOY.md)
walks through it, including the first crawl.

The default test suite needs no cloud account, no cloud credential and no emulator. If a change of
yours makes that untrue, it is a defect regardless of what it enables — see the local-installability
rule in [CLAUDE.md](./CLAUDE.md).

## What a change has to clear

- **`pnpm test`.** Unit and integration tests, plus the repository policy checks: dependency
  freshness, provider neutrality, the frozen parity contract, and the reviewed-copy gate.
- **The end-to-end suite, for anything touching crawl behaviour.** `e2e/run-e2e.sh` stands up the real
  control-plane, engine and console against a local fake bank and asserts the extracted accounts and
  transactions exactly. Crawl orchestration, scheduling, storage and promotion, transaction identity,
  prompts and schemas, browser and agent behaviour, OTP handling and device tunnels all count.
  [e2e/README.md](./e2e/README.md) covers the relay mode that drives the real Companion app.
- **Docs in the same change.** Every Markdown file here is part of the product. If you alter something
  a doc describes, the doc moves with it — a stale doc is treated as a failing test.

## Two rules that surprise people

**User-visible strings need a content review before they ship.** Writing a string and approving it are
different jobs, and the repository enforces that mechanically: `pnpm copy:check` fails on any label,
button, error, toast or empty state that no review has passed, and the approval has to name the review
that produced it. Existing transcripts live in `reviews/content/`.

**This repository names capabilities, never providers.** A deployment supplies a document store, a job
runner, a queue or a push transport by registering an implementation; the product does not know which
one it is talking to. No vendor's name belongs in a dependency, a type, a config key, a comment, a
document or a commit message. `scripts/provider-neutral-policy.test.mjs` is the authority on this, and
it is far stricter than it sounds — read it before adding an integration.

## Style

Match the surrounding code: its naming, its idiom, and its comment density. Comments here explain *why*
a thing is the way it is, especially where the obvious approach was tried and failed — that context is
the most valuable thing in the file, so please keep writing it.

Commits go to `master`. Write a message that says what changed and why the previous behaviour was
wrong; several in this history are worth copying as examples.

## Scope

Accrawl is for accessing **your own** accounts, on your own behalf, with your own credentials. Changes
that push it toward operating as a third-party aggregation service for other people's accounts are out
of scope, and the AGPL-3.0 licence and the note at the top of the README are deliberate.
