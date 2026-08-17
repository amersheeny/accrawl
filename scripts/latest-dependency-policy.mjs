import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  basename,
  dirname,
  join,
  resolve,
} from 'node:path';

function fail(message) {
  throw new Error(`[dependencies] ${message}`);
}

export function aggregateDependencyCheckFailures(results) {
  const messages = results
    .filter((result) => result.status === 'rejected')
    .map((result) => {
      const message = result.reason instanceof Error
        ? result.reason.message
        : String(result.reason);
      return message.replace(/^\[dependencies\]\s*/u, '');
    });
  if (messages.length === 0) return null;
  return '[dependencies] dependency audit found '
    + `${messages.length} issue${messages.length === 1 ? '' : 's'}:\n`
    + messages.map((message) => `- ${message}`).join('\n');
}

function read(root, file) {
  return readFileSync(resolve(root, file), 'utf8');
}

/**
 * A dependency that does not come from the registry, keyed by how the lockfile resolved it.
 *
 * The package manager can refuse these outright, which is what every repository should do. A repository
 * that composes another one cannot always reach that: a linked workspace package resolves its own
 * dependencies, so a URL the other repository declares directly — under its own policy, with the
 * refusal switched on — arrives here as a subdependency and the switch cannot be used at all.
 *
 * Turning the protection off and writing down why is what that used to mean, and it protects nothing:
 * the next URL to appear arrives just as silently. So a repository in that position names the exact
 * packages it is prepared to accept, and this checks the claim against what is actually installed. A
 * package that appears without being named fails, which is the case the protection existed for.
 */
/**
 * Whether a non-registry resolution is one of this workspace's own packages.
 *
 * A workspace package is a directory in this repository, or in one it composes, that the workspace itself
 * declares — it is the repository's own code by construction, and reading it as an outside source says
 * nothing about supply chain. Which spelling the lockfile uses for those is not stable: deduplicating it
 * rewrites them from one local scheme to another, and that alone once turned this check red on four
 * first-party packages while the deduplication it also demands was what wrote them.
 *
 * The test is the package itself, not the shape of the path: resolve the target and ask whether a package
 * of that name is what lives there. A path pointing anywhere else — a tarball, a checkout outside the
 * workspace — has nothing to answer with and stays in scope, which is the case worth catching.
 */
function isWorkspacePackage(root, name, scheme, target) {
  if (scheme !== 'file' && scheme !== 'link') return false;
  if (!target) return false;
  const manifest = resolve(root, target.replace(/:$/u, ''), 'package.json');
  if (!existsSync(manifest)) return false;
  try {
    return JSON.parse(readFileSync(manifest, 'utf8')).name === name;
  } catch {
    return false;
  }
}

function assertDeclaredExoticSubdeps(root, file, source, declared) {
  if (!source.includes('blockExoticSubdeps: false')) {
    fail(`${file} declares accepted exotic subdependencies but does not record the setting they explain`);
  }
  if (!(declared.reason?.length > 40)) {
    fail(`${file} accepts exotic subdependencies without saying why`);
  }
  const allowed = new Set(declared.packages ?? []);
  if (allowed.size === 0) {
    fail(`${file} accepts exotic subdependencies without naming any`);
  }
  const lockfile = read(root, declared.lockFile ?? 'pnpm-lock.yaml');
  const installed = new Set(
    [...lockfile.matchAll(
      /^ {2}'?((?:@[^/@\s']+\/)?[^@\s']+)@(https?|file|git\+[a-z]+|link):([^'(\s]*)/gmu,
    )]
      .filter(([, name, scheme, target]) => !isWorkspacePackage(root, name, scheme, target))
      .map(([, name]) => name),
  );
  const unnamed = [...installed].filter((name) => !allowed.has(name)).sort();
  if (unnamed.length > 0) {
    fail(
      `${file} accepts ${[...allowed].sort().join(', ')} from outside the registry, but `
      + `${unnamed.join(', ')} arrived that way too`,
    );
  }
  for (const name of [...allowed].sort()) {
    if (!installed.has(name)) {
      fail(`${file} accepts ${name} from outside the registry, but nothing installs it that way`);
    }
  }
}

function execute(root, command, args, acceptedStatuses = [0]) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      CI: 'true',
    },
    maxBuffer: 32 * 1024 * 1024,
  });
  if (!acceptedStatuses.includes(result.status ?? -1)) {
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    fail(`${command} ${args.join(' ')} failed${output ? `:\n${output}` : ''}`);
  }
  return result.stdout.trim();
}

export function githubAuthorizationHeaders(
  url,
  githubToken = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN,
) {
  if (new URL(url).hostname !== 'api.github.com' || !githubToken) return {};
  if (!/^[\x21-\x7E]+$/.test(githubToken)) {
    fail('GITHUB_TOKEN contains unsupported characters.');
  }
  return { authorization: `Bearer ${githubToken}` };
}

async function fetchOk(url, options = {}) {
  let response;
  try {
    response = await fetch(url, {
      ...options,
      headers: {
        'user-agent': 'Accrawl-Dependency-Audit/1.0 (+https://github.com/accrawl/accrawl)',
        ...githubAuthorizationHeaders(url),
        ...options.headers,
      },
    });
  } catch (error) {
    // A network-level failure — DNS, TLS, connection reset — throws before there
    // is a response, so only the HTTP branch below ever named the URL. That left
    // a bare "fetch failed" as the entire audit output, with two dozen candidate
    // hosts and nothing to distinguish them. Name the request and keep the cause.
    fail(
      `${url} could not be fetched: ${error?.cause?.message ?? error?.message ?? error}`,
    );
  }
  if (!response.ok) fail(`${url} returned HTTP ${response.status}`);
  return response;
}

const jsonRequests = new Map();
const textRequests = new Map();

async function fetchJson(url) {
  if (!jsonRequests.has(url)) {
    jsonRequests.set(url, fetchOk(url).then((response) => response.json()));
  }
  return jsonRequests.get(url);
}

async function fetchText(url, options = {}) {
  // The Accept header selects the representation, so two requests to one URL can return different
  // bodies. It belongs in the cache key or the second caller silently gets the first one's response.
  const key = `${url} ${options.headers?.Accept ?? ''}`;
  if (!textRequests.has(key)) {
    textRequests.set(key, fetchOk(url, options).then((response) => response.text()));
  }
  return textRequests.get(key);
}

function numericVersionParts(value) {
  const match = String(value).match(/^v?(\d+(?:\.\d+)*)/);
  if (!match) return [];
  return match[1].split('.').map(Number);
}

function compareVersions(left, right) {
  const a = numericVersionParts(left);
  const b = numericVersionParts(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

function newest(values) {
  return [...values].sort(compareVersions).at(-1);
}

function assertFilesContain(root, files, expected, label) {
  for (const file of files) {
    if (!read(root, file).includes(expected)) {
      fail(`${file} does not reference current ${label}: ${expected}`);
    }
  }
}

function assertFilesExclude(root, files, patterns) {
  for (const file of files) {
    const source = read(root, file);
    for (const pattern of patterns) {
      if (pattern.test(source)) {
        fail(`${file} contains an unversioned or obsolete dependency reference matching ${pattern}`);
      }
    }
  }
}

async function checkPnpm(root, config = {}) {
  const manifest = JSON.parse(read(root, 'package.json'));
  const latestPnpm = (await fetchJson('https://registry.npmjs.org/pnpm/latest')).version;
  const latestNpm = (await fetchJson('https://registry.npmjs.org/npm/latest')).version;
  if (manifest.packageManager !== `pnpm@${latestPnpm}`) {
    fail(`packageManager is ${manifest.packageManager}; registry latest is pnpm@${latestPnpm}`);
  }

  const activePnpm = execute(root, 'pnpm', ['--version']);
  if (activePnpm !== latestPnpm) {
    fail(`active pnpm is ${activePnpm}; registry latest is ${latestPnpm}`);
  }
  const activeNpm = execute(root, 'npm', ['--version']);
  if (activeNpm !== latestNpm) {
    fail(`active npm is ${activeNpm}; registry latest is ${latestNpm}`);
  }

  const outdatedText = execute(
    root,
    'pnpm',
    ['--reporter=silent', 'outdated', '--recursive', '--format', 'json'],
    [0, 1],
  );
  const jsonStart = outdatedText.indexOf('{');
  const outdated = jsonStart >= 0 ? JSON.parse(outdatedText.slice(jsonStart)) : {};
  const behindLatest = pnpmEntriesBehindLatest(outdated);
  if (behindLatest.length > 0) {
    const details = behindLatest
      .map(([name, value]) =>
        `${name}: ${value.current ?? value.wanted ?? 'unresolved'} -> ${value.latest}`)
      .join(', ');
    fail(`workspace packages are behind latest stable: ${details}`);
  }

  // Deduplication is asked for only where it is safe to act on.
  //
  // A workspace that injects its packages and links another repository's is not such a place. There,
  // deduplicating rewrites those links into copies, and a copy is taken when it is installed — before the
  // product it contains has been compiled. The image then builds against a snapshot with no compiler
  // output in it and fails on every type it imports, while this check goes green. That is not
  // hypothetical: it is what happened, and the release build reported it twice before the cause was found
  // by building the image locally.
  //
  // So a repository in that position says so, and keeps the duplicate-detection it can act on: the
  // resolved tree is still audited for outdated and vulnerable packages above and below this line.
  if (config.dedupe !== false) execute(root, 'pnpm', ['dedupe', '--check']);
  execute(root, 'pnpm', ['audit', '--audit-level=moderate']);

  for (const file of config.overrideFiles ?? []) {
    const source = read(root, file);
    for (const setting of [
      'injectWorkspacePackages: true',
      'minimumReleaseAge: 0',
      'trustPolicy: no-downgrade',
      'trustLockfile: false',
      ...(config.exoticSubdeps ? [] : ['blockExoticSubdeps: true']),
      'strictDepBuilds: true',
      'engineStrict: true',
      `nodeVersion: ${await currentNodeRelease()}`,
    ]) {
      if (!source.includes(setting)) fail(`${file} is missing supply-chain setting ${setting}`);
    }
    if (config.exoticSubdeps) assertDeclaredExoticSubdeps(root, file, source, config.exoticSubdeps);
    const block = source.match(/^overrides:\s*\n((?:^[ \t]+.*(?:\n|$))*)/m)?.[1] ?? '';
    for (const match of block.matchAll(/^[ \t]+("?)([^"\n:]+(?:>[^"\n:]+)?)\1:\s*["']?\^?([^"'\s]+)["']?\s*$/gm)) {
      const selector = match[2];
      const name = selector.includes('>') ? selector.split('>').at(-1) : selector;
      if (match[3] === '-') {
        if (!selector.includes('>')) {
          fail(`${file} may only remove a dependency through a parent-specific override`);
        }
        continue;
      }
      const latest = (await fetchJson(
        `https://registry.npmjs.org/${encodeURIComponent(name)}/latest`,
      )).version;
      if (match[3] !== latest) {
        fail(`${file} override ${selector} is ${match[3]}; registry latest is ${latest}`);
      }
    }
  }
}

export function pnpmEntriesBehindLatest(outdated) {
  return Object.entries(outdated).filter(([, value]) => {
    if (!value || typeof value !== 'object') return true;
    if (typeof value.latest !== 'string') return true;
    if (typeof value.wanted !== 'string' || value.wanted !== value.latest) {
      return true;
    }
    return typeof value.current === 'string' && value.current !== value.latest;
  });
}

let currentNodeReleaseRequest;

async function currentNodeRelease() {
  currentNodeReleaseRequest ??= fetchJson('https://nodejs.org/dist/index.json')
    .then((releases) => {
      const stable = releases.find((release) => /^v\d+\.\d+\.\d+$/.test(release.version));
      if (!stable) fail('Node release index did not contain a stable release');
      return stable.version.slice(1);
    });
  return currentNodeReleaseRequest;
}

async function dockerHubTag(repository, tag, namespace = 'library') {
  return fetchJson(
    `https://hub.docker.com/v2/repositories/${encodeURIComponent(namespace)}/${encodeURIComponent(repository)}/tags/${encodeURIComponent(tag)}`,
  );
}

async function dockerHubTags(repository) {
  const data = await fetchJson(
    `https://hub.docker.com/v2/repositories/library/${encodeURIComponent(repository)}/tags?page_size=100&ordering=last_updated`,
  );
  return data.results.map((entry) => entry.name);
}

export async function checkDockerfileFrontend(root, config) {
  const image = await dockerHubTag('dockerfile', '1', 'docker');
  const digest = String(image.digest);
  if (!/^sha256:[a-f0-9]{64}$/.test(digest)) {
    fail('Docker Hub did not return an immutable digest for docker/dockerfile:1');
  }
  const expected = `# syntax=docker/dockerfile:1@${digest}`;
  for (const file of config.files) {
    const firstLine = read(root, file).split(/\r?\n/, 1)[0];
    if (firstLine !== expected) {
      fail(`${file} Dockerfile frontend is ${firstLine}; registry current is ${expected}`);
    }
  }
}

async function chainguardDigest(repository, tag) {
  const scope = `repository:chainguard/${repository}:pull`;
  const credentials = await fetchJson(
    `https://cgr.dev/token?service=cgr.dev&scope=${encodeURIComponent(scope)}`,
  );
  const token = credentials.token ?? credentials.access_token;
  if (!token) {
    fail(`Chainguard registry did not issue a pull token for the ${repository} image`);
  }
  const response = await fetchOk(
    `https://cgr.dev/v2/chainguard/${repository}/manifests/${encodeURIComponent(tag)}`,
    {
      headers: {
        authorization: `Bearer ${token}`,
        accept: [
          'application/vnd.oci.image.index.v1+json',
          'application/vnd.docker.distribution.manifest.list.v2+json',
        ].join(', '),
      },
    },
  );
  const digest = response.headers.get('docker-content-digest');
  if (!digest) {
    fail(`Chainguard ${repository}:${tag} did not return an immutable digest`);
  }
  return digest;
}

async function checkNode(root, config) {
  const version = await currentNodeRelease();
  const configured = read(root, '.nvmrc').trim();
  if (configured !== version) fail(`.nvmrc is ${configured}; current Node is ${version}`);
  if (process.version !== `v${version}`) {
    fail(`dependency gate is running on ${process.version}; run it on current Node v${version}`);
  }

  for (const file of config.packageFiles) {
    const manifest = JSON.parse(read(root, file));
    const expected = `>=${version}`;
    if (manifest.engines?.node !== expected) {
      fail(`${file} engines.node is ${manifest.engines?.node}; expected ${expected}`);
    }
  }

  const latestPnpm = (await fetchJson('https://registry.npmjs.org/pnpm/latest')).version;
  const latestNpm = (await fetchJson('https://registry.npmjs.org/npm/latest')).version;
  const shasums = await fetchText(
    `https://nodejs.org/dist/v${version}/SHASUMS256.txt`,
  );
  const distributionChecksums = new Map([
    ['x64', shasums.match(
      new RegExp(`^([a-f0-9]{64})  node-v${version.replaceAll('.', '[.]')}-linux-x64[.]tar[.]gz$`, 'm'),
    )?.[1]],
    ['arm64', shasums.match(
      new RegExp(`^([a-f0-9]{64})  node-v${version.replaceAll('.', '[.]')}-linux-arm64[.]tar[.]gz$`, 'm'),
    )?.[1]],
  ]);
  if ([...distributionChecksums.values()].some((checksum) => !checksum)) {
    fail(`Node v${version} SHASUMS256.txt did not contain Linux x64 and arm64 archives`);
  }

  if (config.installScript) {
    const installer = read(root, config.installScript);
    for (const expected of [
      `NODE_VERSION=${version}`,
      `NODE_LINUX_X64_SHA256=${distributionChecksums.get('x64')}`,
      `NODE_LINUX_ARM64_SHA256=${distributionChecksums.get('arm64')}`,
      'NPM_CONFIG_PREFIX=/opt/node-current',
      `npm install --global --ignore-scripts npm@${latestNpm} pnpm@${latestPnpm}`,
    ]) {
      if (!installer.includes(expected)) {
        fail(`${config.installScript} does not enforce ${expected}`);
      }
    }
  }

  if (config.officialDockerFiles?.length) {
    const tag = `${version}-slim`;
    const image = await dockerHubTag('node', tag);
    const reference = `node:${tag}@${image.digest}`;
    assertFilesContain(root, config.officialDockerFiles, reference, 'official Node image');
    assertFilesContain(
      root,
      config.officialDockerFiles,
      `npm install --global --ignore-scripts npm@${latestNpm} pnpm@${latestPnpm}`,
      'npm and pnpm installation in the official Node image',
    );
  }

  if (config.chainguardBuildFiles?.length) {
    const digest = await chainguardDigest('node', 'latest-dev');
    assertFilesContain(
      root,
      config.chainguardBuildFiles,
      `cgr.dev/chainguard/node:latest-dev@${digest}`,
      'Chainguard Node build image',
    );
    for (const file of config.chainguardBuildFiles) {
      const source = read(root, file);
      for (const expected of [
        ...(config.installScript ? [
          'scripts/install-current-node.sh /usr/local/bin/install-current-node',
          'RUN /usr/local/bin/install-current-node',
          'ENV PATH=/opt/node-current/bin:$PATH',
        ] : []),
        `test "$(node --version)" = "v${version}"`,
        `test "$(npm --version)" = "${latestNpm}"`,
        ...(config.installScript
          ? [`test "$(pnpm --version)" = "${latestPnpm}"`]
          : [`npm install --global --ignore-scripts pnpm@${latestPnpm}`]),
      ]) {
        if (!source.includes(expected)) fail(`${file} does not enforce ${expected}`);
      }
    }
  }

  if (config.chainguardRuntimeFiles?.length) {
    const digest = await chainguardDigest('node', 'latest');
    assertFilesContain(
      root,
      config.chainguardRuntimeFiles,
      `cgr.dev/chainguard/node:latest@${digest}`,
      'Chainguard Node runtime image',
    );
    assertFilesContain(
      root,
      config.chainguardRuntimeFiles,
      '/usr/bin/busybox rm -f /usr/bin/busybox',
      'production shell removal',
    );
    if (config.installScript) {
      assertFilesContain(
        root,
        config.chainguardRuntimeFiles,
        'COPY --from=build /opt/node-current/bin/node /usr/bin/node',
        'current Node runtime overlay',
      );
      assertFilesContain(
        root,
        config.chainguardRuntimeFiles,
        'COPY --from=build /usr/lib/libatomic.so.1* /usr/lib/',
        'official Node libatomic runtime dependency',
      );
      assertFilesContain(
        root,
        config.chainguardRuntimeFiles,
        `RUN test "$(node --version)" = "v${version}"`,
        'current Node runtime assertion',
      );
    }
  }

  assertFilesExclude(root, config.dockerFiles, [
    /FROM\s+node:(?:latest|\d+|[^@\s]+-slim)\s/i,
    /FROM\s+cgr\.dev\/chainguard\/node:latest(?:-dev)?\s/i,
    /\bcorepack enable\b/,
  ]);
}

async function checkGo(root, config) {
  const releases = await fetchJson('https://go.dev/dl/?mode=json');
  const current = releases.find((release) => release.stable === true);
  const version = current?.version?.match(/^go(\d+\.\d+\.\d+)$/)?.[1];
  if (!version) fail('Go release index did not identify the current stable release');
  const digest = await chainguardDigest('go', 'latest-dev');
  assertFilesContain(
    root,
    config.files,
    `cgr.dev/chainguard/go:latest-dev@${digest}`,
    'Chainguard Go build image',
  );
  assertFilesContain(
    root,
    config.files,
    `test "$(go env GOVERSION)" = "go${version}"`,
    'Go toolchain',
  );
}

async function checkCaddy(root, config) {
  const release = await fetchJson('https://api.github.com/repos/caddyserver/caddy/releases/latest');
  const tag = String(release.tag_name);
  const version = tag.match(/^v(\d+\.\d+\.\d+)$/)?.[1];
  if (!version) fail('Caddy latest release did not contain a stable semantic version');
  const commit = await fetchJson(
    `https://api.github.com/repos/caddyserver/caddy/commits/${encodeURIComponent(tag)}`,
  );
  if (!/^[a-f0-9]{40}$/.test(String(commit.sha))) {
    fail(`Caddy ${tag} did not resolve to a commit`);
  }
  const staticDigest = await chainguardDigest('static', 'latest');
  const govulncheck = await fetchJson('https://proxy.golang.org/golang.org/x/vuln/@latest');
  const govulncheckVersion = String(govulncheck.Version).match(/^v(\d+\.\d+\.\d+)$/)?.[1];
  if (!govulncheckVersion) {
    fail('Go module proxy did not identify the current stable govulncheck release');
  }
  assertFilesContain(root, config.files, `ARG CADDY_VERSION=${version}`, 'Caddy release');
  assertFilesContain(root, config.files, `ARG CADDY_COMMIT=${commit.sha}`, 'Caddy source commit');
  assertFilesContain(
    root,
    config.files,
    `ARG GOVULNCHECK_VERSION=${govulncheckVersion}`,
    'govulncheck release',
  );
  assertFilesContain(
    root,
    config.files,
    `cgr.dev/chainguard/static:latest@${staticDigest}`,
    'Chainguard static runtime image',
  );
  assertFilesContain(
    root,
    config.files,
    'go get -u ./cmd/caddy',
    'current compatible Caddy module graph',
  );
  assertFilesContain(
    root,
    config.files,
    'govulncheck@v${GOVULNCHECK_VERSION}" ./cmd/caddy',
    'source-aware Caddy vulnerability gate',
  );
  assertFilesContain(
    root,
    config.files,
    '-mode=binary /out/caddy',
    'binary-aware Caddy vulnerability gate',
  );
  assertFilesContain(
    root,
    config.files,
    `COPY patches/caddy-v${version}-cel-go-v0.30.patch /tmp/caddy-cel-go.patch`,
    'Caddy compatibility patch for the current CEL API',
  );
  if (config.runtimeFiles) {
    assertFilesContain(
      root,
      config.runtimeFiles,
      "process.env.ACCRAWL_CADDY_IMAGE || 'accrawl-web:local'",
      'locally built hardened Caddy runtime',
    );
    assertFilesExclude(
      root,
      config.runtimeFiles,
      [/(?:^|[\s"'=])caddy:[A-Za-z0-9][^\s'"]*/m],
    );
  }
}

async function checkPublicImages(root, config) {
  const postgresTags = await dockerHubTags('postgres');
  const postgresTag = newest(postgresTags.filter((tag) => /^\d+\.\d+-alpine$/.test(tag)));
  const postgres = await dockerHubTag('postgres', postgresTag);
  const postgresReference = `postgres:${postgresTag}@${postgres.digest}`;
  assertFilesContain(root, config.postgresFiles, postgresReference, 'PostgreSQL image');

  if (config.greenmailFiles) {
    const greenmailTags = await fetchJson(
      'https://hub.docker.com/v2/repositories/greenmail/standalone/tags?page_size=100',
    );
    const greenmailTag = newest(
      greenmailTags.results.map((entry) => entry.name)
        .filter((tag) => /^\d+(?:\.\d+)+$/.test(tag)),
    );
    const greenmail = await dockerHubTag('standalone', greenmailTag, 'greenmail');
    const greenmailReference = `greenmail/standalone:${greenmailTag}@${greenmail.digest}`;
    assertFilesContain(root, config.greenmailFiles, greenmailReference, 'GreenMail image');
  }
}

async function checkChrome(root, config) {
  const response = await fetchOk(
    'https://dl.google.com/linux/chrome/deb/dists/stable/main/binary-amd64/Packages.gz',
  );
  const packages = gunzipSync(Buffer.from(await response.arrayBuffer())).toString('utf8');
  const block = packages.split(/\n\n/).find((entry) => entry.includes('Package: google-chrome-stable'));
  const version = block?.match(/^Version:\s*(\S+)/m)?.[1];
  const digest = block?.match(/^SHA256:\s*([a-f0-9]{64})$/mi)?.[1]?.toLowerCase();
  if (!version || !digest) {
    fail('could not resolve google-chrome-stable and its SHA-256 from the official apt repository');
  }
  assertFilesContain(root, config.files, `ARG GOOGLE_CHROME_VERSION=${version}`, 'Google Chrome');
  assertFilesContain(
    root,
    config.files,
    `ARG GOOGLE_CHROME_SHA256=${digest}`,
    'Google Chrome package checksum',
  );
  assertFilesContain(
    root,
    config.files,
    'https://dl.google.com/linux/chrome/deb/pool/main/g/google-chrome-stable/'
      + 'google-chrome-stable_${GOOGLE_CHROME_VERSION}_amd64.deb',
    'official versioned Google Chrome package URL',
  );
}

async function checkRust(root, config) {
  const channel = await fetchText('https://static.rust-lang.org/dist/channel-rust-stable.toml');
  const rustc = channel.match(
    /^\[pkg\.rustc\]\nversion = "(\d+\.\d+\.\d+) \(([a-f0-9]+) ([0-9-]+)\)"/m,
  );
  const cargo = channel.match(
    /^\[pkg\.cargo\]\nversion = "(\d+\.\d+\.\d+) \(([a-f0-9]+) ([0-9-]+)\)"/m,
  );
  if (!rustc || !cargo) fail('official Rust stable channel did not identify rustc and Cargo');

  const digest = await chainguardDigest('rust', 'latest-dev');
  const cargoC = await fetchJson('https://crates.io/api/v1/crates/cargo-c');
  const cargoCVersion = String(
    cargoC.crate?.max_stable_version ?? cargoC.crate?.max_version,
  );
  if (!/^\d+\.\d+\.\d+\+cargo-\d+\.\d+\.\d+$/.test(cargoCVersion)) {
    fail('crates.io did not identify the current stable cargo-c release');
  }

  assertFilesContain(
    root,
    config.files,
    `cgr.dev/chainguard/rust:latest-dev@${digest}`,
    'Chainguard Rust build image',
  );
  for (const expected of [
    `test "$(rustc --version)" = "rustc ${rustc[1]} (${rustc[2]} ${rustc[3]})"`,
    `test "$(cargo --version)" = "cargo ${rustc[1]} (${cargo[2]} ${cargo[3]})"`,
    `test "$(cargo cinstall --version)" = "cargo-c ${cargoCVersion}"`,
  ]) {
    assertFilesContain(root, config.files, expected, 'Rust toolchain');
  }
}

export async function checkRav1e(root, config) {
  const release = await fetchJson('https://api.github.com/repos/xiph/rav1e/releases/latest');
  const tag = String(release.tag_name);
  const version = tag.match(/^v(\d+\.\d+\.\d+)$/)?.[1];
  if (!version) fail('rav1e latest release did not contain a stable semantic version');
  const commit = await fetchJson(
    `https://api.github.com/repos/xiph/rav1e/commits/${encodeURIComponent(tag)}`,
  );
  if (!/^[a-f0-9]{40}$/.test(String(commit.sha))) {
    fail(`rav1e ${tag} did not resolve to a commit`);
  }
  const sourceDateEpoch = Date.parse(String(commit.commit?.committer?.date)) / 1_000;
  if (!Number.isSafeInteger(sourceDateEpoch) || sourceDateEpoch <= 0) {
    fail(`rav1e ${tag} did not resolve to a valid commit timestamp`);
  }

  const pastey = await fetchJson('https://crates.io/api/v1/crates/pastey');
  const pasteyVersion = pastey.crate?.max_stable_version ?? pastey.crate?.max_version;
  if (!/^\d+\.\d+\.\d+$/.test(String(pasteyVersion))) {
    fail('crates.io did not identify the current stable pastey release');
  }

  // The patch is vendored at config.pasteyPatchFile so the image build needs no network for it. Still
  // compare it against upstream, so a vendored copy cannot quietly drift from the commit it claims to
  // be. Read through the API media type: GitHub's `commit/<sha>.patch` route 404s for this commit
  // even though the commit resolves, which is what broke the build in the first place.
  const patchUrl = `https://api.github.com/repos/xiph/rav1e/commits/${config.pasteyPatchCommit}`;
  const upstreamPatch = await fetchText(patchUrl, {
    headers: { Accept: 'application/vnd.github.v3.patch' },
  });
  const vendoredPatch = read(root, config.pasteyPatchFile);
  const patchDigest = sha256(vendoredPatch);
  if (sha256(upstreamPatch) !== patchDigest) {
    fail(
      `the vendored ${config.pasteyPatchFile} no longer matches upstream commit ${config.pasteyPatchCommit}`,
    );
  }
  const lockSource = read(root, config.lockFile);
  const lockDigest = sha256(lockSource);
  for (const expected of [
    `ARG RAV1E_VERSION=${version}`,
    `ARG RAV1E_COMMIT=${commit.sha}`,
    `ARG RAV1E_SOURCE_DATE_EPOCH=${sourceDateEpoch}`,
    `ARG RAV1E_PASTEY_PATCH_COMMIT=${config.pasteyPatchCommit}`,
    `ARG RAV1E_PASTEY_PATCH_SHA256=${patchDigest}`,
    `ARG RAV1E_CARGO_LOCK_SHA256=${lockDigest}`,
    `sed -i 's/^pastey = "0\\.1\\.0"$/pastey = "${pasteyVersion}"/'`,
    `COPY ${config.lockFile} /src/rav1e/Cargo.lock`,
    'cargo cinstall --release --locked',
    '--no-default-features',
    '--features "asm,threading,capi"',
    '--library-type cdylib',
    'usr/share/accrawl/rav1e/Cargo.lock',
  ]) {
    assertFilesContain(root, config.files, expected, 'current source-built rav1e library');
  }
  assertFilesExclude(root, config.files, [
    /\bcargo\s+update\b/,
    /\bcargo\s+generate-lockfile\b/,
  ]);
  for (const file of config.files) {
    const issues = rav1eReproducibilityIssues(read(root, file));
    if (issues.length > 0) {
      fail(`${file} does not enforce rav1e reproducibility: ${issues.join('; ')}`);
    }
  }

  const rustDigest = await chainguardDigest('rust', 'latest-dev');
  const generatedLockOutput = execute(root, 'docker', [
    'run',
    '--rm',
    '--user',
    '0',
    '--platform',
    'linux/amd64',
    // Same reason the image build stopped fetching it: the upstream `commit/<sha>.patch` route 404s,
    // and a check that reaches for a URL which can disappear fails for a reason unrelated to what it
    // is checking. The digest assertion below still proves the mounted file is the right patch.
    '--volume',
    `${resolve(root, config.pasteyPatchFile)}:/tmp/pastey.patch:ro`,
    '--env',
    `RAV1E_TAG=${tag}`,
    '--env',
    `RAV1E_COMMIT=${commit.sha}`,
    '--env',
    `PASTEY_PATCH_COMMIT=${config.pasteyPatchCommit}`,
    '--env',
    `PASTEY_PATCH_SHA256=${patchDigest}`,
    '--env',
    `PASTEY_VERSION=${pasteyVersion}`,
    '--entrypoint',
    '/bin/sh',
    `cgr.dev/chainguard/rust:latest-dev@${rustDigest}`,
    '-ec',
    [
      'git clone --quiet --branch "$RAV1E_TAG" --depth 1 '
        + 'https://github.com/xiph/rav1e.git /tmp/rav1e',
      'test "$(git -C /tmp/rav1e rev-parse HEAD)" = "$RAV1E_COMMIT"',
      'echo "${PASTEY_PATCH_SHA256}  /tmp/pastey.patch" | sha256sum -c -',
      'git -C /tmp/rav1e apply --check /tmp/pastey.patch',
      'git -C /tmp/rav1e apply /tmp/pastey.patch',
      'grep -Fx \'pastey = "0.1.0"\' /tmp/rav1e/Cargo.toml',
      'sed -i "s/^pastey = \\"0\\\\.1\\\\.0\\"$/pastey = \\"${PASTEY_VERSION}\\"/" '
        + '/tmp/rav1e/Cargo.toml',
      'grep -Fx "pastey = \\"${PASTEY_VERSION}\\"" /tmp/rav1e/Cargo.toml',
      'cd /tmp/rav1e',
      'mv Cargo.lock Cargo.lock.upstream',
      'cargo generate-lockfile >/dev/null',
      'sha256sum Cargo.lock',
    ].join(' && '),
  ]);
  const generatedLockDigest = generatedLockOutput.match(
    /(?:^|\n)([a-f0-9]{64})\s+Cargo\.lock(?:\n|$)/,
  )?.[1];
  if (generatedLockDigest !== lockDigest) {
    fail(
      `${config.lockFile} is not the current compatible graph for patched rav1e ${tag}; `
        + `expected ${generatedLockDigest ?? 'an unresolved digest'}`,
    );
  }
}

function escapedRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function dockerfileStage(dockerfile, name) {
  const header = new RegExp(
    `^FROM\\s+\\S+(?:\\s+AS\\s+${escapedRegExp(name)})\\s*$`,
    'im',
  );
  const match = header.exec(dockerfile);
  if (!match) return '';
  const start = match.index + match[0].length;
  const nextStage = /^FROM\s+\S+(?:\s+AS\s+\S+)?\s*$/im;
  const next = nextStage.exec(dockerfile.slice(start));
  return dockerfile.slice(start, next ? start + next.index : undefined);
}

function dockerfileInstructions(stage) {
  return stage
    .replace(/\\\r?\n[ \t]*/g, ' ')
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/[ \t]+/g, ' '))
    .filter((line) => line !== '' && !line.startsWith('#'));
}

function countMatches(value, pattern) {
  return [...value.matchAll(pattern)].length;
}

export function rav1eReproducibilityIssues(dockerfile) {
  const issues = [];
  for (const setting of [
    'ENV SOURCE_DATE_EPOCH=${RAV1E_SOURCE_DATE_EPOCH}',
    'ENV TZ=UTC',
    'ENV LANG=C',
    'ENV LC_ALL=C',
    'ENV CARGO_BUILD_JOBS=1',
    'ENV CARGO_INCREMENTAL=0',
    'ENV ZERO_AR_DATE=1',
  ]) {
    if (!dockerfile.includes(setting)) issues.push(`missing deterministic setting ${setting}`);
  }

  const executableDockerfile = dockerfile
    .replace(/^[ \t]*#.*$/gm, '')
    .replace(/\\\r?\n[ \t]*/g, ' ');
  if (/\bcargo\b[^;&|\r\n]*\b(?:update|generate-lockfile)\b/.test(executableDockerfile)) {
    issues.push('rav1e build mutates its checked Cargo.lock');
  }

  const sourceInstructions = dockerfileInstructions(
    dockerfileStage(dockerfile, 'rav1e-source'),
  );
  const sourceTail = sourceInstructions.slice(-3);
  if (
    sourceTail.length !== 3
    || !/^ARG RAV1E_CARGO_LOCK_SHA256=[a-f0-9]{64}$/.test(sourceTail[0])
    || sourceTail[1] !== 'COPY apps/engine/rav1e/Cargo.lock /src/rav1e/Cargo.lock'
    || sourceTail[2] !== 'RUN echo "${RAV1E_CARGO_LOCK_SHA256} '
      + '/src/rav1e/Cargo.lock" | sha256sum -c -'
  ) {
    issues.push('rav1e-source does not end with exact Cargo.lock copy and verification');
  }

  const buildStages = ['rav1e-build-a', 'rav1e-build-b'];
  for (const [index, name] of buildStages.entries()) {
    const stage = dockerfileStage(dockerfile, name);
    if (!stage) {
      issues.push(`missing ${name} stage`);
      continue;
    }
    const suffix = index === 0 ? 'a' : 'b';
    const instructions = dockerfileInstructions(stage);
    const install = instructions[3] ?? '';
    const exactInstall = new RegExp(
      '^RUN cargo cinstall --release --locked --no-default-features '
        + '--features "asm,threading,capi" --library-type cdylib --prefix /usr '
        + '--destdir /rav1e-root && mkdir -p /rav1e-root/usr/share/accrawl/rav1e '
        + '&& cp Cargo\\.lock /rav1e-root/usr/share/accrawl/rav1e/Cargo\\.lock '
        + '&& test -f /rav1e-root/usr/lib/librav1e\\.so\\.\\d+\\.\\d+\\.\\d+$',
    );
    if (
      instructions.length !== 4
      || instructions[0] !== 'COPY --from=rav1e-source /src/rav1e /src/rav1e'
      || instructions[1] !== 'WORKDIR /src/rav1e'
      || instructions[2] !== `RUN mkdir /reproducibility-run-${suffix}`
      || !exactInstall.test(install)
    ) {
      issues.push(`${name} must contain only its independent locked build and install`);
    }
  }
  if (
    countMatches(dockerfile, /\bcargo cinstall --release --locked\b/g)
    !== buildStages.length
  ) {
    issues.push('the Dockerfile must contain exactly two locked rav1e builds');
  }

  const verification = dockerfileStage(dockerfile, 'rav1e-reproducibility');
  if (!verification) {
    issues.push('missing rav1e-reproducibility stage');
  } else {
    for (const expected of [
      'COPY --from=rav1e-build-a /rav1e-root /rav1e-root',
      'COPY --from=rav1e-build-b /rav1e-root /rav1e-comparison-root',
      "mode=\"$(stat -c '%a' \"${artifact}\")\"",
      "owner=\"$(stat -c '%u:%g' \"${artifact}\")\"",
      'readlink "${artifact}"',
      "size=\"$(stat -c '%s' \"${artifact}\")\"",
      'digest="$(sha256sum "${artifact}"',
      'artifact_manifest /rav1e-root /tmp/rav1e-build-a.manifest',
      'artifact_manifest /rav1e-comparison-root /tmp/rav1e-build-b.manifest',
      'if [ "${digest_a}" != "${digest_b}" ]; then',
      'exit 1',
    ]) {
      if (!verification.includes(expected)) {
        issues.push(`rav1e-reproducibility is missing ${expected}`);
      }
    }
  }

  const runtime = dockerfileStage(dockerfile, 'chrome-runtime');
  for (const expected of [
    'COPY --from=rav1e-reproducibility /rav1e-root/usr/lib/librav1e.so* /usr/lib/',
    'COPY --from=rav1e-reproducibility /rav1e-root/usr/share/accrawl/rav1e ',
  ]) {
    if (!runtime.includes(expected)) {
      issues.push(`chrome-runtime bypasses the verified output: missing ${expected.trim()}`);
    }
  }
  return issues;
}

function tarTextEntry(archive, requestedName) {
  const tar = gunzipSync(archive);
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((value) => value === 0)) break;
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const sizeText = header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim();
    const size = Number.parseInt(sizeText || '0', 8);
    if (!Number.isSafeInteger(size) || size < 0) {
      fail(`Wolfi package index has an invalid tar size for ${name}`);
    }
    const dataOffset = offset + 512;
    if (name === requestedName) {
      return tar.subarray(dataOffset, dataOffset + size).toString('utf8');
    }
    offset = dataOffset + Math.ceil(size / 512) * 512;
  }
  fail(`Wolfi package index does not contain ${requestedName}`);
}

function apkInstallPackageTokens(dockerfile) {
  const executableDockerfile = dockerfile
    .replace(/^[ \t]*#.*$/gm, '')
    .replace(/\\\r?\n[ \t]*/g, ' ');
  const packages = [];
  for (const match of executableDockerfile.matchAll(
    /\bapk\b[^;&|\r\n]*?\badd\b([^;&|\r\n]*)/g,
  )) {
    const tokens = match[1].trim().split(/\s+/).filter(Boolean);
    for (const token of tokens) {
      if (token.startsWith('-')) continue;
      packages.push(token);
    }
  }
  return packages;
}

export function unversionedApkInstallSpecs(dockerfile) {
  return apkInstallPackageTokens(dockerfile).filter(
    (token) => !/^[a-z0-9][a-z0-9+_.-]*=\d[a-z0-9+_.~-]*-r\d+$/i.test(token),
  );
}

export function versionedApkInstallSpecs(dockerfile) {
  const specs = [];
  for (const token of apkInstallPackageTokens(dockerfile)) {
    const parsed = token.match(/^([a-z0-9][a-z0-9+_.-]*)=(\d[a-z0-9+_.~-]*-r\d+)$/i);
    if (parsed) specs.push({ name: parsed[1], version: parsed[2] });
  }
  return specs;
}

export function wolfiPackagePinIssues(
  dockerfile,
  currentVersions,
  requiredPackages = [],
) {
  const issues = [];
  const unversioned = unversionedApkInstallSpecs(dockerfile);
  if (unversioned.length > 0) {
    issues.push(`unversioned apk package specs: ${unversioned.join(', ')}`);
  }
  const installedSpecs = versionedApkInstallSpecs(dockerfile);
  for (const { name, version } of installedSpecs) {
    const currentVersion = currentVersions.get(name);
    if (!currentVersion) {
      issues.push(`Wolfi package index does not contain ${name}`);
    } else if (version !== currentVersion) {
      issues.push(`stale Wolfi package ${name}=${version}; current is ${name}=${currentVersion}`);
    }
  }
  const installedNames = new Set(installedSpecs.map(({ name }) => name));
  for (const name of requiredPackages) {
    if (!installedNames.has(name)) issues.push(`does not install required Wolfi package ${name}`);
  }
  const requiredNames = new Set(requiredPackages);
  for (const name of installedNames) {
    if (!requiredNames.has(name)) issues.push(`installs unexpected Wolfi package ${name}`);
  }
  return issues;
}

export async function checkWolfiPackages(root, config) {
  const response = await fetchOk(
    `https://apk.cgr.dev/chainguard/${encodeURIComponent(config.architecture)}/APKINDEX.tar.gz`,
  );
  const index = tarTextEntry(Buffer.from(await response.arrayBuffer()), 'APKINDEX');
  const versionsByPackage = new Map();
  for (const record of index.split(/\n\n+/)) {
    const name = record.match(/^P:(.+)$/m)?.[1];
    const version = record.match(/^V:(.+)$/m)?.[1];
    if (!name || !version) continue;
    if (!versionsByPackage.has(name)) versionsByPackage.set(name, []);
    versionsByPackage.get(name).push(version);
  }
  const currentVersions = new Map(
    [...versionsByPackage].map(([name, versions]) => [name, versions.at(-1)]),
  );

  for (const group of config.groups) {
    const dockerfile = read(root, group.file);
    const issues = wolfiPackagePinIssues(dockerfile, currentVersions, group.packages);
    if (issues.length > 0) {
      fail(`${group.file} has invalid Wolfi package pins: ${issues.join('; ')}`);
    }
  }
}

async function checkPython(root, config) {
  const release = await fetchJson('https://www.python.org/api/v2/downloads/release/?is_published=true');
  const stableVersions = release
    .map((entry) => entry.name?.match(/^Python (\d+\.\d+\.\d+)$/)?.[1])
    .filter(Boolean);
  const latestPython = newest(stableVersions);
  if (!latestPython) fail('could not resolve latest stable Python release');
  const configuredPython = read(root, config.versionFile).trim();
  if (configuredPython !== latestPython) {
    fail(`${config.versionFile} is ${configuredPython}; latest Python is ${latestPython}`);
  }

  const hatchling = (await fetchJson('https://pypi.org/pypi/hatchling/json')).info.version;
  const pyproject = read(root, config.pyproject);
  if (!pyproject.includes(`hatchling==${hatchling}`)) {
    fail(`${config.pyproject} does not pin current hatchling ${hatchling}`);
  }
}

async function checkFlutter(root, config) {
  const flutterRoot = resolve(root, dirname(config.pubspec));
  const releases = await fetchJson(
    'https://storage.googleapis.com/flutter_infra_release/releases/releases_macos.json',
  );
  const stableHash = releases.current_release.stable;
  const stable = releases.releases.find((release) => release.hash === stableHash);
  if (!stable?.version) fail('Flutter release index did not identify the stable release');

  const machine = JSON.parse(execute(flutterRoot, 'flutter', ['--version', '--machine']));
  if (machine.frameworkVersion !== stable.version) {
    fail(`active Flutter is ${machine.frameworkVersion}; stable is ${stable.version}`);
  }

  const outdated = JSON.parse(execute(flutterRoot, 'flutter', ['pub', 'outdated', '--json']));
  const stale = outdated.packages.filter((entry) => entry.current?.version !== entry.latest?.version);
  if (stale.length > 0) {
    fail(`Flutter packages are behind latest stable: ${stale.map(
      (entry) => `${entry.package}: ${entry.current.version} -> ${entry.latest.version}`,
    ).join(', ')}`);
  }

  const pubspec = read(root, config.pubspec);
  for (const dependency of config.vendorOverrides ?? []) {
    const metadata = await fetchJson(
      `https://pub.dev/api/packages/${encodeURIComponent(dependency.name)}`,
    );
    const latestVersion = metadata.latest?.version;
    if (typeof latestVersion !== 'string' || !latestVersion) {
      fail(`pub.dev did not identify the latest ${dependency.name} release`);
    }
    const vendorManifest = read(root, dependency.manifest);
    const vendorVersion = vendorManifest.match(/^version:\s*["']?([^"'\s]+)["']?\s*$/m)?.[1];
    if (vendorVersion !== latestVersion) {
      fail(
        `${dependency.manifest} is ${vendorVersion ?? 'missing a version'}; `
          + `latest ${dependency.name} is ${latestVersion}`,
      );
    }
    if (!pubspec.includes(`path: ${dependency.overridePath}`)) {
      fail(`${config.pubspec} does not override ${dependency.name} from ${dependency.overridePath}`);
    }
  }
  const graph = JSON.parse(execute(flutterRoot, 'flutter', ['pub', 'deps', '--json']));
  const packageByName = new Map(graph.packages.map((entry) => [entry.name, entry]));
  const app = packageByName.get(graph.root);
  for (const name of [
    ...(app?.directDependencies ?? []),
    ...(app?.devDependencies ?? []),
  ]) {
    const dependency = packageByName.get(name);
    if (dependency?.source === 'hosted' && !pubspec.includes(`${name}: ^${dependency.version}`)) {
      fail(`${config.pubspec} does not declare current ${name} ${dependency.version}`);
    }
  }
  const dartVersion = machine.dartSdkVersion.split(' ')[0].split('-')[0];
  if (!pubspec.includes(`sdk: ">=${dartVersion} <4.0.0"`)) {
    fail(`${config.pubspec} does not require current Dart ${dartVersion}`);
  }
  if (!pubspec.includes(`flutter: ">=${stable.version}"`)) {
    fail(`${config.pubspec} does not require current Flutter ${stable.version}`);
  }
}

async function latestMavenStable(metadataUrl) {
  const xml = await (await fetchOk(metadataUrl)).text();
  const versions = [...xml.matchAll(/<version>([^<]+)<\/version>/g)]
    .map((match) => match[1])
    .filter((version) => /^\d+(?:\.\d+)*$/.test(version));
  const value = newest(versions);
  if (!value) fail(`${metadataUrl} had no stable version`);
  return value;
}

async function checkAndroid(root, config) {
  const currentGradle = await fetchJson('https://services.gradle.org/versions/current');
  assertFilesContain(
    root,
    [config.wrapper],
    `gradle-${currentGradle.version}-all.zip`,
    'Gradle distribution',
  );

  if (config.builtInKotlin) {
    assertFilesContain(
      root,
      [config.builtInKotlin.properties],
      'android.builtInKotlin=true',
      'AGP 9 built-in Kotlin mode',
    );
    // Every way a project can apply Kotlin for itself, which is what built-in mode replaces. Naming the
    // artifact is deliberately not one of them: with built-in Kotlin on, a classpath entry for that
    // coordinate raises the version the build tool supplies, which is the vendor's documented way to sit
    // above a framework's minimum without giving the mode up. Forbidding the coordinate outright forbade
    // that too, and the only route left was the opt-out this check exists to prevent.
    assertFilesExclude(
      root,
      config.builtInKotlin.buildFiles,
      [
        /id\s*\(\s*["']org\.jetbrains\.kotlin\.android["']/,
        /apply\s+plugin\s*:\s*["'](?:kotlin-android|org\.jetbrains\.kotlin\.android)["']/,
        /\bkotlin\s*\(\s*["']android["']\s*\)/,
      ],
    );
  }

  for (const dependency of config.maven) {
    const version = await latestMavenStable(dependency.metadata);
    assertFilesContain(root, dependency.files, dependency.reference(version), dependency.name);
  }
}

async function checkJava(root, config) {
  const releases = await fetchJson('https://api.adoptium.net/v3/info/available_releases');
  const feature = releases.most_recent_feature_release;
  if (!Number.isInteger(feature)) fail('Adoptium did not identify the current Java feature release');
  const assets = await fetchJson(
    `https://api.adoptium.net/v3/assets/latest/${feature}/hotspot?architecture=aarch64&heap_size=normal&image_type=jdk&os=mac`,
  );
  const version = assets[0]?.version?.openjdk_version?.split('+')[0];
  if (!version) fail('Adoptium did not identify the current stable OpenJDK version');
  const configured = read(root, config.versionFile).trim();
  if (configured !== version) {
    fail(`${config.versionFile} is ${configured}; current OpenJDK is ${version}`);
  }
  const active = execute(root, 'java', ['--version'], [0]);
  const detected = active.match(/^(?:openjdk|java)\s+([0-9.]+)/m)?.[1]
    ?? active.match(/version "([^"]+)"/)?.[1];
  if (detected !== version) {
    fail(`active Java is ${detected ?? 'unknown'}; current OpenJDK is ${version}`);
  }
}

async function checkTerraform(root, config) {
  const terraform = await fetchJson('https://checkpoint-api.hashicorp.com/v1/check/terraform');
  const terraformVersion = terraform.current_version;
  assertFilesContain(
    root,
    config.versionFiles,
    `required_version = "${terraformVersion}"`,
    'Terraform CLI',
  );

  for (const provider of config.providers) {
    const metadata = await fetchJson(
      `https://registry.terraform.io/v1/providers/${provider.namespace}/${provider.name}`,
    );
    assertFilesContain(
      root,
      provider.files,
      `version = "${metadata.version}"`,
      `${provider.namespace}/${provider.name} provider`,
    );
  }
}

async function checkCloudSqlProxy(root, config) {
  const release = await fetchJson(
    'https://api.github.com/repos/GoogleCloudPlatform/cloud-sql-proxy/releases/latest',
  );
  const version = String(release.tag_name).replace(/^v/, '');
  const manifest = await fetchOk(
    `https://gcr.io/v2/cloud-sql-connectors/cloud-sql-proxy/manifests/${version}`,
    {
      headers: {
        accept: [
          'application/vnd.oci.image.index.v1+json',
          'application/vnd.docker.distribution.manifest.list.v2+json',
        ].join(', '),
      },
    },
  );
  const digest = manifest.headers.get('docker-content-digest');
  if (!digest) fail('Cloud SQL Proxy registry response did not include a digest');
  const reference = `gcr.io/cloud-sql-connectors/cloud-sql-proxy:${version}@${digest}`;
  assertFilesContain(root, config.files, reference, 'Cloud SQL Proxy image');
}

async function checkCloudSqlPostgres(root, config) {
  const sources = [
    'https://docs.cloud.google.com/sql/docs/postgres/db-versions?hl=en',
    'https://cloud.google.com/sql/docs/postgres/db-versions?hl=en',
  ];
  const results = await Promise.allSettled(sources.map(async (url) => {
    const html = await (await fetchOk(url)).text();
    return html.match(/PostgreSQL\s+(\d+)\s+\(default\)/i)?.[1] ?? null;
  }));
  const versions = new Set(results.flatMap((result) =>
    result.status === 'fulfilled' && result.value ? [result.value] : []));
  if (versions.size === 0) {
    fail('Cloud SQL version policy did not identify the default PostgreSQL major');
  }
  if (versions.size > 1) {
    fail(`official Cloud SQL version pages disagree: ${[...versions].join(', ')}`);
  }
  const [version] = versions;
  assertFilesContain(root, config.files, `database_version    = "POSTGRES_${version}"`, 'Cloud SQL PostgreSQL');
}

function osvAssetName() {
  const operatingSystem = {
    darwin: 'darwin',
    linux: 'linux',
    win32: 'windows',
  }[process.platform];
  const architecture = {
    arm64: 'arm64',
    x64: 'amd64',
  }[process.arch];
  if (!operatingSystem || !architecture) {
    fail(`OSV-Scanner has no configured binary for ${process.platform}/${process.arch}`);
  }
  return `osv-scanner_${operatingSystem}_${architecture}${process.platform === 'win32' ? '.exe' : ''}`;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function checkOsv(root, config) {
  const release = await fetchJson(
    'https://api.github.com/repos/google/osv-scanner/releases/latest',
  );
  if (release.tag_name !== config.version) {
    fail(`OSV-Scanner policy is ${config.version}; current release is ${release.tag_name}`);
  }

  const binaryName = osvAssetName();
  const binaryAsset = release.assets.find((asset) => asset.name === binaryName);
  const checksumAsset = release.assets.find((asset) => asset.name === 'osv-scanner_SHA256SUMS');
  if (!binaryAsset?.browser_download_url || !checksumAsset?.browser_download_url) {
    fail(`OSV-Scanner ${config.version} does not publish ${binaryName} and its checksum manifest`);
  }

  const checksums = await (await fetchOk(checksumAsset.browser_download_url)).text();
  const expectedHash = checksums
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .find((parts) => parts.at(-1) === binaryName)?.[0];
  if (!expectedHash || !/^[a-f0-9]{64}$/i.test(expectedHash)) {
    fail(`OSV-Scanner checksum manifest does not contain ${binaryName}`);
  }

  const cacheDirectory = join(tmpdir(), 'accrawl-dependency-tools', config.version);
  const binaryPath = join(cacheDirectory, binaryName);
  mkdirSync(cacheDirectory, { recursive: true, mode: 0o700 });
  let binary = existsSync(binaryPath) ? readFileSync(binaryPath) : undefined;
  if (!binary || sha256(binary) !== expectedHash.toLowerCase()) {
    binary = Buffer.from(await (await fetchOk(binaryAsset.browser_download_url)).arrayBuffer());
    if (sha256(binary) !== expectedHash.toLowerCase()) {
      fail(`downloaded OSV-Scanner ${binaryName} failed its published SHA-256 checksum`);
    }
    writeFileSync(binaryPath, binary, { mode: 0o700 });
  }
  if (process.platform !== 'win32') chmodSync(binaryPath, 0o700);

  execute(root, binaryPath, ['scan', 'source', '--recursive', root]);
  console.log(
    `[dependencies] OSV-Scanner ${config.version} (${expectedHash.toLowerCase()}) source scan is clean`,
  );
}

export async function runLatestDependencyPolicy(root, config) {
  const checks = [
    checkPnpm(root, config.pnpm),
    checkNode(root, config.node),
  ];
  if (config.publicImages) checks.push(checkPublicImages(root, config.publicImages));
  if (config.dockerfileFrontend) {
    checks.push(checkDockerfileFrontend(root, config.dockerfileFrontend));
  }
  if (config.chrome) checks.push(checkChrome(root, config.chrome));
  if (config.rust) checks.push(checkRust(root, config.rust));
  if (config.rav1e) checks.push(checkRav1e(root, config.rav1e));
  if (config.wolfi) checks.push(checkWolfiPackages(root, config.wolfi));
  if (config.go) checks.push(checkGo(root, config.go));
  if (config.caddy) checks.push(checkCaddy(root, config.caddy));
  if (config.python) checks.push(checkPython(root, config.python));
  if (config.flutter) checks.push(checkFlutter(root, config.flutter));
  if (config.android) checks.push(checkAndroid(root, config.android));
  if (config.java) checks.push(checkJava(root, config.java));
  if (config.terraform) checks.push(checkTerraform(root, config.terraform));
  if (config.cloudSqlProxy) checks.push(checkCloudSqlProxy(root, config.cloudSqlProxy));
  if (config.cloudSqlPostgres) checks.push(checkCloudSqlPostgres(root, config.cloudSqlPostgres));
  if (config.osv) checks.push(checkOsv(root, config.osv));
  const results = await Promise.allSettled(checks);
  const failure = aggregateDependencyCheckFailures(results);
  if (failure) throw new Error(failure);
  console.log(
    `[dependencies] ${basename(root)} uses current stable dependency releases; `
      + 'pnpm audit reports no known moderate-or-higher JavaScript vulnerabilities',
  );
}
