/**
 * This repository is the whole product, and it depends on no cloud provider.
 *
 * A deployment that runs crawls somewhere else, keeps its records in a document store, or starts a
 * worker per crawl supplies those things by registering them. None of that machinery belongs here, and
 * the surest way to tell is that no provider's client library is installed.
 *
 * This is a policy test rather than a convention because the failure is silent: one `pnpm add` and a
 * `import` restores the coupling that took a long time to remove, and nothing else would notice.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * Client libraries for a cloud provider's own services. Matched as whole package names or as a scope.
 *
 * `@google/genai` is deliberately absent: it is the model the product uses to read a bank page, which is
 * a product capability rather than infrastructure, and it has no substitute behind a port.
 */
const FORBIDDEN = [
  /^firebase-admin$/,
  /^firebase-tools$/,
  /^firebase$/,
  /^@google-cloud\//,
  /^google-auth-library$/,
  /^google-gax$/,
  /^gcp-metadata$/,
  /^@aws-sdk\//,
  /^aws-sdk$/,
  /^@azure\//,
];

const ALLOWED = new Set(['@google/genai']);

function forbidden(name) {
  return !ALLOWED.has(name) && FORBIDDEN.some((pattern) => pattern.test(name));
}

function walk(directory, visit) {
  for (const entry of readdirSync(directory)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.git') continue;
    const full = path.join(directory, entry);
    if (statSync(full).isDirectory()) walk(full, visit);
    else visit(full);
  }
}

test('no cloud-provider client library is a dependency of this repository', () => {
  const offences = [];
  walk(ROOT, (file) => {
    if (path.basename(file) !== 'package.json') return;
    const manifest = JSON.parse(readFileSync(file, 'utf8'));
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const name of Object.keys(manifest[field] ?? {})) {
        if (forbidden(name)) {
          offences.push(`${path.relative(ROOT, file)} → ${field}.${name}`);
        }
      }
    }
  });
  assert.deepEqual(
    offences,
    [],
    'A deployment supplies its provider through the registration APIs; this repository installs none:\n'
    + offences.join('\n'),
  );
});

test('no source file imports a cloud-provider client library', () => {
  const offences = [];
  // Matches `from 'x'`, `require('x')` and `import('x')` alike.
  const specifier = /(?:from|require|import)\s*\(?\s*['"]([^'"]+)['"]/g;
  walk(path.join(ROOT, 'apps'), (file) => {
    if (!/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(file)) return;
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(specifier)) {
      if (forbidden(match[1])) {
        offences.push(`${path.relative(ROOT, file)} → ${match[1]}`);
      }
    }
  });
  walk(path.join(ROOT, 'packages'), (file) => {
    if (!/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(file)) return;
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(specifier)) {
      if (forbidden(match[1])) {
        offences.push(`${path.relative(ROOT, file)} → ${match[1]}`);
      }
    }
  });
  assert.deepEqual(
    offences,
    [],
    'These imports would put a provider back inside the product:\n' + offences.join('\n'),
  );
});

test('the model client is still allowed, so the policy has not been written too broadly', () => {
  // A policy that forbade everything would pass the two tests above while breaking the product. This
  // pins the one package that must remain installable.
  const engine = JSON.parse(
    readFileSync(path.join(ROOT, 'apps/engine/package.json'), 'utf8'),
  );
  assert.ok(
    engine.dependencies['@google/genai'],
    'the engine reads bank pages with this model client; it is not infrastructure',
  );
  assert.equal(forbidden('@google/genai'), false);
});
