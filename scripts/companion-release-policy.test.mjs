import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const gradle = readFileSync('companion/android/app/build.gradle.kts', 'utf8');
const manifest = readFileSync(
  'companion/android/app/src/main/AndroidManifest.xml',
  'utf8',
);
const downloadCopy = readFileSync('apps/web/src/companion-copy.ts', 'utf8');

test('release APKs require and package the exact public source revision', () => {
  assert.match(gradle, /environmentVariable\("ACCRAWL_VERSION"\)/);
  assert.match(gradle, /\^\[0-9a-f\]\{40\}\$/);
  assert.match(gradle, /releaseRequested && accrawlSourceRevision == "dev"/);
  assert.match(
    manifest,
    /android:name="app\.accrawl\.source_revision"\s+android:value="\$\{sourceRevision\}"/,
  );
});

test('the web UI keeps the stable Companion APK download on its own origin', () => {
  assert.match(
    downloadCopy,
    /['"]\/downloads\/companion\.apk['"]/,
  );
  assert.doesNotMatch(downloadCopy, /storage\.googleapis\.com/);
});
