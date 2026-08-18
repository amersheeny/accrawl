/**
 * A credential in the working tree must never reach a build context.
 *
 * Both server images are built with `COPY . .`, which reads the working tree rather than the index —
 * so a file being gitignored keeps it out of the repository and does nothing at all about Docker. The
 * only thing standing between a signing key and an image layer is `.dockerignore`.
 *
 * This is a policy test rather than a convention because the failure is silent AND easy to reintroduce
 * with a change that looks correct. A pattern written as the bare filename, rather than prefixed with a
 * recursive wildcard, reads like it excludes the file; it matches only the very top of the context and
 * silently lets every nested copy through. That exact mistake was live here: four patterns were rooted
 * while the block above them was recursive, and all three real credential files entered both builds.
 *
 * Nothing here shells out to Docker. The rule is that a newcomer can clone and run the suite with
 * nothing installed but Node, and a test that needs a daemon would quietly skip on the machines that
 * most need it — which is the same silent failure in a different coat.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * What a credential looks like, by SHAPE rather than by vendor filename.
 *
 * Naming the three files that exist today would pass forever while a fourth arrives somewhere new, so
 * the tree is searched for anything of these shapes and every hit must be excluded.
 */
const CREDENTIAL_SHAPES = [
  /^key\.properties$/,
  /-services\.json$/,
  /^service-account\.json$/,
  /service[-_]account.*\.json$/,
  /credentials.*\.json$/,
  /^application_default_credentials\.json$/,
  /\.(jks|keystore|p12|pfx|pem)$/,
  /^id_(rsa|dsa|ecdsa|ed25519)$/,
];

/** Templates are meant to be read: they carry placeholders, never a secret. */
const TEMPLATE = /\.(example|sample|template)$/;

/** Directories that are not part of any build context to begin with. */
const NOT_SEARCHED = new Set(['.git', 'node_modules', 'build', 'dist', '.dart_tool', '.gradle']);

function credentialFiles(dir = ROOT, found = []) {
  for (const entry of readdirSync(dir)) {
    if (NOT_SEARCHED.has(entry)) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      credentialFiles(full, found);
      continue;
    }
    if (TEMPLATE.test(entry)) continue;
    if (CREDENTIAL_SHAPES.some((shape) => shape.test(entry))) {
      found.push(path.relative(ROOT, full));
    }
  }
  return found;
}

// Docker's ignore matching, which is not glob matching. A pattern is matched segment by segment: `*`
// and `?` stay inside one segment and never cross a slash, while a doubled star matches any number of
// segments including none. A pattern without one is therefore anchored at the context root — which is
// the whole point this test exists to defend.
function segmentToRegExp(segment) {
  let out = '';
  for (const character of segment) {
    if (character === '*') out += '[^/]*';
    else if (character === '?') out += '[^/]';
    else out += character.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return out;
}

function patternMatches(pattern, filePath) {
  const parts = pattern.split('/').map((segment) => (segment === '**' ? '**' : segmentToRegExp(segment)));
  let expression = '^';
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part === '**') {
      expression += index === parts.length - 1 ? '.*' : '(?:.*/)?';
      continue;
    }
    expression += part;
    if (index < parts.length - 1) expression += '/';
  }
  // Docker excludes a directory's contents when the directory itself matches.
  expression += '(?:/.*)?$';
  return new RegExp(expression).test(filePath);
}

/** The last pattern to match decides, and a leading `!` re-includes. */
export function isIgnored(patterns, filePath) {
  let ignored = false;
  for (const raw of patterns) {
    const negated = raw.startsWith('!');
    const pattern = negated ? raw.slice(1) : raw;
    if (patternMatches(pattern, filePath)) ignored = !negated;
  }
  return ignored;
}

function dockerignorePatterns() {
  return readFileSync(path.join(ROOT, '.dockerignore'), 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

test('the matcher treats an unrooted pattern as anchored, which is the whole hazard', () => {
  // Guarding the guard: if this ever passes, the test above it proves nothing.
  assert.equal(isIgnored(['key.properties'], 'key.properties'), true);
  assert.equal(isIgnored(['key.properties'], 'companion/android/key.properties'), false);
  assert.equal(isIgnored(['**/key.properties'], 'companion/android/key.properties'), true);
  // The real client-configuration file is matched by shape, and the shape is what is pinned here —
  // naming the vendor would put its name in this repository for no gain.
  assert.equal(isIgnored(['**/*-services.json'], 'companion/android/app/src/qa/client-services.json'), true);
  assert.equal(isIgnored(['**/secrets'], 'a/b/secrets/token.txt'), true);
  assert.equal(isIgnored(['**/*.pem', '!**/public.pem'], 'certs/public.pem'), false);
});

test('every credential-shaped file in the tree is excluded from the build context', () => {
  const patterns = dockerignorePatterns();
  const exposed = credentialFiles().filter((file) => !isIgnored(patterns, file));
  assert.deepEqual(
    exposed,
    [],
    `.dockerignore lets these into the build context, and both server Dockerfiles COPY . . :\n`
      + exposed.map((file) => `  ${file}`).join('\n')
      + '\nPrefix each pattern with a recursive wildcard so it matches at every depth, not just the root.',
  );
});

test('the credential search actually finds the files it is meant to defend', () => {
  // A search that silently matches nothing would make the test above vacuously green.
  const found = credentialFiles();
  assert.ok(
    found.length > 0,
    'no credential-shaped files were found at all — the search is broken, not the tree clean',
  );
});
