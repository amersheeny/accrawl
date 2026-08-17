# Accrawl operator console

The React (Vite) console an operator actually uses: add an institution, connect an account, watch a crawl
run live, and read the data that came back. It is a static bundle talking to the control plane's API —
it holds no credentials of its own and makes no decisions the server does not also enforce.

## Running it

```bash
pnpm --filter @accrawl/web dev       # vite dev server
pnpm --filter @accrawl/web build     # tsc -b --noEmit && vite build -> dist/
pnpm --filter @accrawl/web preview   # serve the built bundle
```

The dev server proxies `/api`, `/health` and `/version` to `http://localhost:3000`, so run the control
plane alongside it. `ACCRAWL_API_TARGET` points the proxy elsewhere — for example at a container, or at
a control plane on another port. `COMPANION_APK_UPSTREAM` proxies the Companion download route when you
are testing the pairing flow's APK hand-off.

In a self-hosted deployment this bundle is served by the front door rather than by Vite; see
[`DEPLOY.md`](../../DEPLOY.md).

## Tests

```bash
pnpm --filter @accrawl/web test        # copy review gate, then vitest
pnpm --filter @accrawl/web typecheck
```

`vitest` covers the API client's session handling — sign-out against both a self-hosted token and a
hosted cookie, restoring a hosted session without mistaking an SPA fallback for one, and preserving a
server error code so a screen can select the right reviewed copy; the crawl-schedule editor's round-trip
between a cron expression and the fields an operator sees, including leaving an unsupported existing cron
alone; and a contrast check over the design tokens, which fails when faint normal-sized text stops being
readable on the lightest dark surface.

None of these prove what a screen looks like. Layout collapse, overflow, wrapping and contrast appear
only in rendered pixels, so a visual change is reviewed against real screenshots of the running console,
not against these tests.

## The copy gate

User-visible strings do not ship unreviewed. `pnpm --filter @accrawl/web copy:check` — which `test` runs
first — verifies every user-visible string in this app against the manifests in
[`reviews/content/`](../../reviews/content): `reviewed-copy.json` records each string's review status,
`reviewed-source-copy.json` grants specific occurrences in source, and `user-visible-baseline.json`
anchors what the gate considered user-visible when the baseline was taken.

A new or edited string fails the gate until it has been through a content review and the manifest records
which review produced the verdict. That last part is the point: an approval that cannot name the review
behind it is exactly what the gate exists to catch.

The `*-copy.ts` modules hold those strings in one place per feature — institutions, connections, crawls,
schedules, sharing, status and the Companion — so the words can be reviewed as words rather than hunted
through JSX.

## License

AGPL-3.0-or-later, as with the rest of the repository.
