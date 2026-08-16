/**
 * This repository names capabilities, not providers.
 *
 * A deployment that keeps its records in a document store, starts a worker per crawl, or wakes a phone
 * supplies those things by registering them. The product does not know which one it is talking to, and
 * the surest way to tell is that no provider's vocabulary appears here at all — not in a type, not in a
 * configuration value, not in a comment, not in a document, and not in the history a reader can clone.
 *
 * This exists because the previous check tested only whether a provider's client library was installed.
 * That is a much narrower question than the one that matters, it passed while fifty-four files still
 * named one provider's database, and a passing check was reported as a clean repository.
 *
 * Exceptions are allowed, each scoped to the files that may carry it and each with its reason written
 * down. An exception is a path plus a token — permission to mention one thing in one place — so it
 * cannot quietly widen: a reference to something else, in the same file, still fails.
 *
 * They fall into four kinds, and nothing else qualifies: the model client; the platform push transport
 * and the documents telling someone how to set it up; checks and tests that must name what they forbid
 * or prove excluded; and records — a review quoting the name it replaced, a compatibility window, or
 * third-party source carried as its author published it.
 *
 * A deployment's own identifiers are never excepted anywhere.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { gunzipSync, gzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  DEPLOYMENT_IDENTIFIERS,
  EXCEPTIONS,
  NOT_PROSE,
  PROVIDER_TOKENS,
  excepted,
  matches,
} from './provider-neutral-tokens.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function git(args) {
  return execFileSync('git', ['-C', ROOT, ...args], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
}

function trackedFiles() {
  return git(['ls-files', '-z']).split('\0').filter(Boolean);
}

/**
 * File types whose bytes carry no readable text, so the scan cannot search them and says so rather
 * than pretending. Everything here is an image, a font, or third-party source carried as published.
 * Anything binary that is NOT listed fails the scan — being unreadable is not a way to be exempt.
 */
const OPAQUE_BINARY_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'ico', 'icns', 'webp', 'bmp',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'jar', 'keystore', 'jks', 'p12', 'pdf', 'so', 'dylib', 'dll', 'wasm',
]);

function extensionOf(relativePath) {
  const base = relativePath.split('/').pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

/** True when the bytes are a gzip member (magic 1f 8b, deflate method 08). */
function looksGzipped(bytes) {
  return bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b && bytes[2] === 0x08;
}

/**
 * A file's text, or null when it is a declared-opaque binary.
 *
 * Compressed files are DECOMPRESSED and searched. The previous version returned null for anything
 * containing a zero byte, which meant a tracked `.gz` was skipped in silence — and one held 425 copies
 * of a machine hostname while this scan reported the repository clean. A scan that cannot see a file
 * must say which file, not return nothing found.
 */
function textOf(relativePath) {
  const absolute = path.resolve(ROOT, relativePath);
  try {
    if (!statSync(absolute).isFile()) return null;
  } catch {
    return null;
  }
  const bytes = readFileSync(absolute);
  if (!bytes.includes(0)) return bytes.toString('utf8');
  if (looksGzipped(bytes)) {
    try {
      return gunzipSync(bytes).toString('utf8');
    } catch {
      return null; // reported by the unreadable-binary assertion below
    }
  }
  return null;
}

/** Tracked files the scan could not read, so it can name them instead of skipping them. */
function unreadableBinaries(files) {
  const unreadable = [];
  for (const file of files) {
    if (textOf(file) !== null) continue;
    if (OPAQUE_BINARY_EXTENSIONS.has(extensionOf(file))) continue;
    unreadable.push(file);
  }
  return unreadable;
}

test('no provider vocabulary in the working tree', () => {
  const files = trackedFiles();
  // A scan that reads nothing must fail rather than report nothing found. This is the assertion the
  // previous check was missing: an empty result and a clean repository looked identical.
  assert.ok(files.length > 100, `expected to scan the repository, saw ${files.length} files`);

  const findings = [];
  for (const file of files) {
    if (NOT_PROSE.has(file)) continue;
    const text = textOf(file);
    if (text === null) continue;
    for (const token of PROVIDER_TOKENS) {
      if (matches(text, token) && !excepted(file, token)) {
        findings.push(`${file}: names ${JSON.stringify(token)}`);
      }
    }
  }
  assert.deepEqual(
    findings,
    [],
    `${findings.length} file(s) name a provider:\n${findings.join('\n')}`,
  );
});

test('no deployment identity anywhere in the working tree', () => {
  const findings = [];
  for (const file of trackedFiles()) {
    // Deliberately NOT the exemption the check above uses. That one exists because the machinery has to
    // spell out the provider words it hunts for, which is true and harmless. It is not true of an
    // identity: nothing here needs to write one down, and the files that were skipped for the first
    // reason were being skipped for the second as well. Two of them were sitting in one of those files,
    // named in the sentence explaining that they belonged in the private repository instead.
    //
    // Only what no human wrote is skipped here.
    if (file === 'pnpm-lock.yaml') continue;
    const text = textOf(file);
    if (text === null) continue;
    for (const identifier of DEPLOYMENT_IDENTIFIERS) {
      if (matches(text, identifier)) {
        findings.push(`${file}: names ${identifier}`);
      }
    }
  }
  assert.deepEqual(
    findings,
    [],
    `${findings.length} file(s) name one deployment:\n${findings.join('\n')}`,
  );
});

test('the scan can read every tracked file it does not declare opaque', () => {
  const unreadable = unreadableBinaries(trackedFiles());
  assert.deepEqual(
    unreadable,
    [],
    'the scan cannot read these tracked files, so it cannot say they are clean. Decompress them, remove '
    + `them, or add the type to OPAQUE_BINARY_EXTENSIONS with a reason:\n${unreadable.join('\n')}`,
  );
});

test('the scan reads INSIDE a compressed file', () => {
  // The hole this closes was not theoretical: a tracked .gz held 425 copies of a machine hostname and
  // was skipped in silence. Planting a provider name inside a gzip member proves the scan decompresses
  // rather than trusting that it does.
  const planted = gunzipSync(gzipSync(Buffer.from('a log line naming firebase\n', 'utf8'))).toString('utf8');
  assert.match(planted, /firebase/);

  // Written to the OS temp directory, not into the repository: node_modules does not exist in a fresh
  // clone, and a check that only runs where the author already installed is the exact failure this file
  // is about. Caught by cloning and running it.
  const archive = path.join(mkdtempSync(path.join(tmpdir(), 'accrawl-neutral-')), 'selfcheck.gz');
  writeFileSync(archive, gzipSync(Buffer.from('deployment log: firebase project\n', 'utf8')));
  try {
    const text = textOf(path.relative(ROOT, archive));
    assert.ok(text !== null, 'a gzip member must be readable by the scan, not skipped as binary');
    assert.ok(
      PROVIDER_TOKENS.some((token) => matches(text, token)),
      'a provider name planted inside a compressed file must be visible to the scan',
    );
  } finally {
    rmSync(path.dirname(archive), { force: true, recursive: true });
  }
});

test('every exception names the reason it exists', () => {
  for (const exception of EXCEPTIONS) {
    assert.ok(exception.reason?.length > 20, `exception for ${exception.token} states no reason`);
    assert.ok(exception.paths?.length > 0, `exception for ${exception.token} names no files`);
    for (const identifier of DEPLOYMENT_IDENTIFIERS) {
      assert.ok(
        !matches(exception.token, identifier),
        `a deployment's identity may never be excepted: ${exception.token}`,
      );
    }
  }
});
