import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const runner = readFileSync(
  new URL('../e2e/run-e2e.sh', import.meta.url),
  'utf8',
);
const build = readFileSync(
  new URL('../e2e/build-companion-apks.sh', import.meta.url),
  'utf8',
);
const harness = readFileSync(
  new URL('../e2e/run-e2e.mjs', import.meta.url),
  'utf8',
);

test('companion E2E builds outside the repository and removes its APK workspace', () => {
  assert.match(runner, /companion_workspace_parent=.*pwd -P/);
  assert.match(runner, /mktemp -d .*accrawl-companion-build/);
  assert.match(runner, /rm -r -- "\$companion_workspace"/);
  assert.match(runner, /build-companion-apks\.sh" "\$flutter_target" "\$companion_workspace"/);
  assert.match(build, /source_copy="\$\{XDG_CACHE_HOME:-\$HOME\/\.cache\}\/accrawl\/e2e-companion-source"/);
  assert.match(build, /rsync -a --no-times --checksum --delete --exclude=\.dart_tool --exclude=build --exclude=\.gradle "\$companion\/" "\$source_copy\/"/);
  assert.match(build, /lock="\$source_copy\.lock"/);
  assert.match(build, /exec lockf -k "\$lock"/);
  assert.doesNotMatch(runner, /cd companion\s*&&\s*flutter build/);
  assert.doesNotMatch(build, /cd "\$companion"/);
});

test('companion E2E builds one flavor after the other and passes the APKs explicitly', () => {
  const qaBuild = build.indexOf('flutter build apk --flavor qa');
  const qaCopy = build.indexOf('app-qa-debug.apk "$out/app-qa-debug.apk"', qaBuild);
  const secureBuild = build.indexOf('flutter build apk --flavor secure', qaCopy);
  const secureCopy = build.indexOf('app-secure-debug.apk "$out/app-secure-debug.apk"', secureBuild);

  assert.ok(qaBuild >= 0);
  assert.ok(qaCopy > qaBuild);
  assert.ok(secureBuild > qaCopy);
  assert.ok(secureCopy > secureBuild);
  assert.match(runner, /export COMPANION_QA_APK=/);
  assert.match(runner, /export COMPANION_SECURE_APK=/);
  assert.match(harness, /process\.env\.COMPANION_QA_APK \|\| path\.join/);
  assert.match(harness, /process\.env\.COMPANION_SECURE_APK \|\| path\.join/);
});
