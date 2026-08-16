import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const runner = readFileSync(
  new URL('../e2e/run-e2e.sh', import.meta.url),
  'utf8',
);
const harness = readFileSync(
  new URL('../e2e/run-e2e.mjs', import.meta.url),
  'utf8',
);

test('companion E2E isolates and removes its Android build workspace', () => {
  assert.match(runner, /companion_workspace_parent=.*pwd -P/);
  assert.match(runner, /mktemp -d .*accrawl-companion-build/);
  assert.match(runner, /rsync -a/);
  assert.match(runner, /--exclude=\.dart_tool/);
  assert.match(runner, /--exclude=build/);
  assert.match(runner, /rm -r -- "\$companion_workspace"/);
  assert.doesNotMatch(runner, /cd companion\s*&&\s*flutter build/);
});

test('companion E2E builds one flavor at a time and passes retained APKs explicitly', () => {
  const qaBuild = runner.indexOf('flutter build apk --flavor qa');
  const firstClean = runner.indexOf('flutter clean', qaBuild);
  const secureBuild = runner.indexOf(
    'flutter build apk --flavor secure',
    firstClean,
  );
  const secondClean = runner.indexOf('flutter clean', secureBuild);

  assert.ok(qaBuild >= 0);
  assert.ok(firstClean > qaBuild);
  assert.ok(secureBuild > firstClean);
  assert.ok(secondClean > secureBuild);
  assert.match(runner, /export COMPANION_QA_APK=/);
  assert.match(runner, /export COMPANION_SECURE_APK=/);
  assert.match(harness, /process\.env\.COMPANION_QA_APK \|\| path\.join/);
  assert.match(harness, /process\.env\.COMPANION_SECURE_APK \|\| path\.join/);
});
