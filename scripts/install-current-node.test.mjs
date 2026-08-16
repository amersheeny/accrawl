import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

/**
 * install-current-node installs pinned package managers and then asserts the
 * versions it got. The install line and the assertion are a matched pair, and
 * nothing checked that they agree.
 *
 * They stopped agreeing: the install moved to pnpm@11.21.0 while the assertion
 * still demanded 11.20.0, so the script installed the right version, refused
 * it, and exited 1. Every Cloud Build image failed at that step, and the
 * dependency audit did not catch it because it validates the install line only.
 *
 * Nothing else catches this either — the script runs inside the container
 * build, so no unit test, typecheck or lint executes it. A release is where it
 * surfaces, which is the most expensive place to find it.
 */
const script = readFileSync(
  new URL('./install-current-node.sh', import.meta.url),
  'utf8',
);

/** `npm@12.0.2 pnpm@11.21.0` → {npm: '12.0.2', pnpm: '11.21.0'} */
function installedVersions() {
  const line = script
    .split('\n')
    .find((l) => l.includes('npm install --global'));
  assert.ok(line, 'the script must install its package managers globally');
  return Object.fromEntries(
    [...line.matchAll(/\b(npm|pnpm)@(\d+\.\d+\.\d+)/g)].map((m) => [m[1], m[2]]),
  );
}

/** `test "$(… /npm --version)" = "12.0.2"` → {npm: '12.0.2'} */
function assertedVersions() {
  return Object.fromEntries(
    [...script.matchAll(/\/(npm|pnpm) --version\)" = "(\d+\.\d+\.\d+)"/g)].map(
      (m) => [m[1], m[2]],
    ),
  );
}

test('every package manager it installs is the one it then asserts', () => {
  const installed = installedVersions();
  const asserted = assertedVersions();

  // Both managers must be pinned and both must be checked; dropping either
  // side would make this test pass by having nothing to compare.
  assert.deepEqual(Object.keys(installed).sort(), ['npm', 'pnpm']);
  assert.deepEqual(Object.keys(asserted).sort(), ['npm', 'pnpm']);

  for (const name of ['npm', 'pnpm']) {
    assert.equal(
      asserted[name],
      installed[name],
      `${name}: installs ${installed[name]} but asserts ${asserted[name]} — ` +
        'the container build fails at this step when they disagree',
    );
  }
});

test('node is asserted against the same variable it installs', () => {
  // Node avoids the drift entirely by asserting the variable rather than a
  // literal. Keep it that way.
  assert.match(script, /test "\$\(.*\/node --version\)" = "v\$\{NODE_VERSION\}"/);
});
