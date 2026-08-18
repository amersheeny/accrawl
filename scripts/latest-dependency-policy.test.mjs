import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  flutterPackagesBehindLatest,
  aggregateDependencyCheckFailures,
  githubAuthorizationHeaders,
  pnpmEntriesBehindLatest,
  rav1eReproducibilityIssues,
  unversionedApkInstallSpecs,
  versionedApkInstallSpecs,
  wolfiPackagePinIssues,
} from './latest-dependency-policy.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('scopes GitHub authentication and rejects malformed tokens without disclosure', () => {
  assert.deepEqual(
    githubAuthorizationHeaders(
      'https://api.github.com/repos/example/project/releases/latest',
      'test-token',
    ),
    { authorization: 'Bearer test-token' },
  );
  assert.deepEqual(
    githubAuthorizationHeaders(
      'https://registry.npmjs.org/example',
      'test-token',
    ),
    {},
  );
  const malformedToken = 'secret-canary\r\nInjected: value';
  assert.throws(
    () => githubAuthorizationHeaders(
      'https://api.github.com/repos/example/project/releases/latest',
      malformedToken,
    ),
    (error) => {
      assert.equal(
        error.message,
        '[dependencies] GITHUB_TOKEN contains unsupported characters.',
      );
      assert.doesNotMatch(error.stack, /secret-canary|Injected/);
      return true;
    },
  );
});

test('reports every dependency check failure from one audit run', () => {
  assert.equal(
    aggregateDependencyCheckFailures([
      { status: 'fulfilled', value: undefined },
      {
        status: 'rejected',
        reason: new Error('[dependencies] package A is stale'),
      },
      {
        status: 'rejected',
        reason: new Error('[dependencies] runtime B is stale'),
      },
    ]),
    '[dependencies] dependency audit found 2 issues:\n'
      + '- package A is stale\n'
      + '- runtime B is stale',
  );
});

test('accepts a current optional dependency when pnpm omits current', () => {
  assert.deepEqual(pnpmEntriesBehindLatest({
    '@google-cloud/kms': {
      dependencyType: 'optionalDependencies',
      latest: '5.7.0',
      wanted: '5.7.0',
    },
  }), []);
});

test('rejects stale installed or wanted dependency versions', () => {
  assert.deepEqual(
    pnpmEntriesBehindLatest({
      installed: {
        current: '1.0.0',
        latest: '2.0.0',
        wanted: '2.0.0',
      },
      unresolved: {
        latest: '3.0.0',
        wanted: '2.0.0',
      },
    }).map(([name]) => name),
    ['installed', 'unresolved'],
  );
});

test('finds package specs that let apk resolve a rolling version', () => {
  assert.deepEqual(
    unversionedApkInstallSpecs(
      'RUN apk add --no-cache xz=5.8.3-r1 \\\n'
        + '    git \\\n'
        + ' && apk add --no-cache nasm=${NASM_VERSION} \\\n'
        + '    pax-utils=anything\n'
        + 'RUN apk --no-cache add fontconfig\n',
    ),
    ['git', 'nasm=${NASM_VERSION}', 'pax-utils=anything', 'fontconfig'],
  );
});

test('parses exact APK package names without substring aliasing', () => {
  assert.deepEqual(
    versionedApkInstallSpecs(
      'RUN apk add --no-cache libnss=3.126-r0 nss=0.0.1-r1 xz=5.8.3-r1\n',
    ),
    [
      { name: 'libnss', version: '3.126-r0' },
      { name: 'nss', version: '0.0.1-r1' },
      { name: 'xz', version: '5.8.3-r1' },
    ],
  );
});

test('Wolfi gate rejects stale, variable, and unlisted package pins', () => {
  const currentVersions = new Map([
    ['git', '2.55.0-r4'],
    ['libnss', '3.126-r0'],
    ['nss', '3.126-r0'],
    ['xz', '5.8.3-r1'],
  ]);
  const issues = wolfiPackagePinIssues(
    'RUN apk add --no-cache libnss=3.126-r0 nss=0.0.1-r1 \\\n'
      + ' && apk add --no-cache xz=${XZ_VERSION} git=2.55.0-r4\n',
    currentVersions,
    ['libnss', 'nss', 'xz'],
  );
  assert.deepEqual(issues, [
    'unversioned apk package specs: xz=${XZ_VERSION}',
    'stale Wolfi package nss=0.0.1-r1; current is nss=3.126-r0',
    'does not install required Wolfi package xz',
    'installs unexpected Wolfi package git',
  ]);
});

test('production engine dependencies are source-defined and immutable', () => {
  const engineDockerfile = readFileSync(
    resolve(root, 'apps/engine/Dockerfile'),
    'utf8',
  );
  assert.deepEqual(unversionedApkInstallSpecs(engineDockerfile), []);
  assert.doesNotMatch(engineDockerfile, /\bcargo\s+(?:update|generate-lockfile)\b/);
  assert.match(
    engineDockerfile,
    /COPY apps\/engine\/rav1e\/Cargo\.lock \/src\/rav1e\/Cargo\.lock/,
  );
  assert.match(engineDockerfile, /\bcargo cinstall --release --locked\b/);
  assert.match(
    engineDockerfile,
    /^ARG RAV1E_CARGO_LOCK_SHA256=[a-f0-9]{64}$/m,
  );
  assert.match(
    readFileSync(resolve(root, 'apps/engine/rav1e/Cargo.lock'), 'utf8'),
    /^name = "pastey"\nversion = "0\.2\.3"$/m,
  );
  assert.deepEqual(rav1eReproducibilityIssues(engineDockerfile), []);
});

test('rav1e reproducibility policy rejects bypasses and shared build state', () => {
  const engineDockerfile = readFileSync(
    resolve(root, 'apps/engine/Dockerfile'),
    'utf8',
  );
  const mutations = [
    engineDockerfile.replace(
      'RUN mkdir /reproducibility-run-b',
      'RUN mkdir /reproducibility-run-a',
    ),
    engineDockerfile.replace(
      'RUN cargo cinstall --release --locked --no-default-features',
      'RUN --mount=type=cache,target=/usr/local/cargo/registry \\\n'
        + '    cargo cinstall --release --locked --no-default-features',
    ),
    engineDockerfile.replace(
      'digest="$(sha256sum "${artifact}"',
      'digest="$(basename "${artifact}"',
    ),
    engineDockerfile.replace(
      'COPY --from=rav1e-reproducibility /rav1e-root/usr/lib/librav1e.so* /usr/lib/',
      'COPY --from=rav1e-build-a /rav1e-root/usr/lib/librav1e.so* /usr/lib/',
    ),
    engineDockerfile.replace(
      'RUN echo "${RAV1E_CARGO_LOCK_SHA256}  /src/rav1e/Cargo.lock" | sha256sum -c -',
      'RUN echo "${RAV1E_CARGO_LOCK_SHA256}  /src/rav1e/Cargo.lock" | sha256sum -c - \\\n'
        + ' && cargo --color never update',
    ),
    engineDockerfile.replace(
      'RUN cargo cinstall --release --locked --no-default-features',
      '# cargo cinstall --release --locked --no-default-features',
    ),
    engineDockerfile.replace(
      '--locked --no-default-features',
      '--locked --manifest-path /tmp/other/Cargo.toml --no-default-features',
    ),
  ];
  for (const mutation of mutations) {
    assert.notDeepEqual(rav1eReproducibilityIssues(mutation), []);
  }
});

test('production Dockerfiles pin one immutable Dockerfile frontend', () => {
  const firstLines = [
    'apps/control-plane/Dockerfile',
    'apps/engine/Dockerfile',
    'infra/Caddy.Dockerfile',
  ].map((file) => readFileSync(resolve(root, file), 'utf8').split(/\r?\n/, 1)[0]);
  assert.equal(new Set(firstLines).size, 1);
  assert.match(
    firstLines[0],
    /^# syntax=docker\/dockerfile:1@sha256:[a-f0-9]{64}$/,
  );
});

test('current Node bootstrap installs global tools into the overlaid runtime', () => {
  const installer = readFileSync(
    resolve(root, 'scripts/install-current-node.sh'),
    'utf8',
  );
  assert.match(
    installer,
    /NPM_CONFIG_PREFIX=\/opt\/node-current\s+\\\n\s+\/opt\/node-current\/bin\/npm install --global/,
  );
});

test('overlaid Node runtimes include the official binary shared-library closure', () => {
  for (const file of [
    'apps/control-plane/Dockerfile',
    'apps/engine/Dockerfile',
  ]) {
    assert.match(
      readFileSync(resolve(root, file), 'utf8'),
      /COPY --from=build \/usr\/lib\/libatomic[.]so[.]1[*] \/usr\/lib\//,
      file,
    );
  }
});

test('production deployments repair fetch-blob to use native DOMException', () => {
  for (const file of [
    'apps/control-plane/Dockerfile',
    'apps/engine/Dockerfile',
  ]) {
    const dockerfile = readFileSync(resolve(root, file), 'utf8');
    assert.match(
      dockerfile,
      /fetch_blob_path=\/out\/node_modules\/\.pnpm\/fetch-blob@3\.2\.0/,
      file,
    );
    assert.match(
      dockerfile,
      /const DOMException = globalThis\.DOMException/,
      file,
    );
    assert.match(
      dockerfile,
      /grep -c "node-domexception"/,
      file,
    );
  }
});

/** A package pub reports as behind, with every safety signal clear unless a test says otherwise. */
function outdatedEntry(overrides = {}) {
  return {
    package: 'code_assets',
    kind: 'transitive',
    isDiscontinued: false,
    isCurrentRetracted: false,
    isCurrentAffectedByAdvisory: false,
    current: { version: '1.2.1' },
    upgradable: { version: '1.2.1' },
    resolvable: { version: '1.2.1' },
    latest: { version: '2.0.0' },
    ...overrides,
  };
}

test('a transitive package no resolution can move is held, not stale', () => {
  const { held, stale } = flutterPackagesBehindLatest({ packages: [outdatedEntry()] });
  assert.deepEqual(stale, []);
  assert.equal(held.length, 1);
  assert.equal(held[0].package, 'code_assets');
});

test('every condition of the upstream-held exemption is load-bearing on its own', () => {
  // Each case flips exactly one signal, so none of them can be carried by the others.
  const cases = [
    ['a direct dependency is ours to move', { kind: 'direct' }],
    ['a dev dependency is ours to move', { kind: 'dev' }],
    ['resolvable reaches latest, so nothing upstream is holding it', { resolvable: { version: '2.0.0' } }],
    ['resolvable is merely newer, so the constraint is not the wall', { resolvable: { version: '1.9.0' } }],
    ['an advisory against the held version ends the argument', { isCurrentAffectedByAdvisory: true }],
    ['a retracted version is never acceptable', { isCurrentRetracted: true }],
    ['a discontinued package is never acceptable', { isDiscontinued: true }],
  ];
  for (const [reason, override] of cases) {
    const { held, stale } = flutterPackagesBehindLatest({ packages: [outdatedEntry(override)] });
    assert.equal(stale.length, 1, `should still fail: ${reason}`);
    assert.equal(held.length, 0, `must not be exempt: ${reason}`);
  }
});

test('a package already at latest is neither held nor stale', () => {
  const current = outdatedEntry({ latest: { version: '1.2.1' } });
  const { held, stale } = flutterPackagesBehindLatest({ packages: [current] });
  assert.deepEqual(held, []);
  assert.deepEqual(stale, []);
});
