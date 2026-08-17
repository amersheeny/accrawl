/**
 * The validation harnesses must fail closed.
 *
 * Two policies are guarded here, both of which regressed once and neither of which any other test
 * would notice, because the failure mode is a suite reporting SUCCESS:
 *
 *   1. `e2e/run-e2e.sh` must never exit 0 without reaching its final command. It did: a failed
 *      `${VAR:?...}` expansion aborts bash BEFORE `$?` becomes non-zero, so the EXIT trap read the
 *      last COMPLETED command's status — the workspace build — and reported a refusal to start as a
 *      pass. The fix depends on a bash subtlety (below), so the shape of the handler is asserted
 *      directly; a well-meaning revert to `return` would silently reopen the hole.
 *
 *   2. The Docker-backed IMAP test must skip only when there is no container runtime at all. A
 *      runtime that is installed but unusable has to fail, or a machine that was supposed to run the
 *      integration test can quietly stop running it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Run a tiny script under bash and return its exit status. */
function statusOf(body) {
  const dir = mkdtempSync(join(tmpdir(), 'accrawl-failclosed-'));
  const file = join(dir, 's.sh');
  writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(file, 0o755);
  return spawnSync(file, { stdio: 'ignore' }).status;
}

test('bash ignores a `return` from an EXIT trap, so only `exit` can change the status', () => {
  // This is WHY the handler below must use `exit`. If a future bash changed this, the assertion
  // fails and whoever sees it can relax the rule deliberately rather than by accident.
  assert.equal(statusOf('f(){ return 1; }\ntrap f EXIT\nexit 0'), 0, 'return from an EXIT trap should be ignored');
  assert.equal(statusOf('f(){ exit 1; }\ntrap f EXIT\nexit 0'), 1, 'exit from an EXIT trap should win');
});

test('the end-to-end harness leaves its EXIT trap no way to report a false success', () => {
  const src = readFileSync(join(ROOT, 'e2e/run-e2e.sh'), 'utf8');

  const handler = src.match(/cleanup_companion_workspace\(\) \{([\s\S]*?)\n\}/u);
  assert.ok(handler, 'the EXIT trap handler must still be named cleanup_companion_workspace');
  assert.match(src, /trap cleanup_companion_workspace EXIT/u, 'the handler must still be installed on EXIT');

  assert.doesNotMatch(
    handler[1],
    /^\s*return\b/mu,
    'the EXIT handler must use `exit`, never `return`: bash keeps the status that entered the trap',
  );

  // The completion marker is the whole guard: it must start false, and become true only after the
  // suite's final command has returned.
  assert.match(src, /^run_reached_end=0$/mu, 'run_reached_end must be initialised to 0 (also required by set -u)');
  const lines = src.split('\n');
  const marker = lines.findIndex((l) => l.trim() === 'run_reached_end=1');
  assert.notEqual(marker, -1, 'run_reached_end must be set somewhere');
  assert.equal(
    lines.filter((l) => l.trim() === 'run_reached_end=1').length,
    1,
    'exactly one place may declare the run complete',
  );
  assert.match(
    lines[marker - 1],
    /^node e2e\/run-e2e\.mjs$/u,
    'the run may only be declared complete immediately after the suite command returns',
  );
  assert.equal(marker, lines.length - 2, 'nothing may run after the completion marker');

  assert.match(
    handler[1],
    /run_reached_end.*-eq 0.*\n.*\n.*exit_status=1/u,
    'the handler must convert a zero status into a failure when the run never reached the end',
  );
});

test('the container-backed IMAP test skips without a runtime and fails on a broken one', () => {
  const cwd = join(ROOT, 'apps/control-plane');
  const args = ['vitest', 'run', '--config', 'vitest.greenmail.config.mts'];

  // No `docker` on PATH at all — execFileSync raises ENOENT, which is the only skippable case.
  const withoutRuntime = spawnSync('npx', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, DOCKER_BIN: 'accrawl-no-such-runtime' },
  });
  assert.equal(withoutRuntime.status, 0, `absent runtime should pass with a skip:\n${withoutRuntime.stdout}`);
  assert.match(
    `${withoutRuntime.stdout}${withoutRuntime.stderr}`,
    /1 skipped/u,
    'the test must be REPORTED as skipped, never silently pass',
  );

  // A runtime that exists but refuses. `false` is present on every supported platform.
  const brokenRuntime = spawnSync('npx', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, DOCKER_BIN: 'false' },
  });
  assert.notEqual(brokenRuntime.status, 0, 'an unusable runtime must fail rather than skip');
  assert.match(
    `${brokenRuntime.stdout}${brokenRuntime.stderr}`,
    /installed but not usable/u,
    'the failure must say the runtime is installed but unusable',
  );
});

test('the harness refuses a relay run that cannot reach its emulator, and says so', () => {
  // Trips before the workspace build, so this stays fast.
  const r = spawnSync(join(ROOT, 'e2e/run-e2e.sh'), {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, COMPANION_RELAY: '1', GEMINI_API_KEY: '', PATH: process.env.PATH },
  });
  assert.notEqual(r.status, 0, 'a run that cannot start must not report success');
});
