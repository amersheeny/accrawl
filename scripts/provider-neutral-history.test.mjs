/**
 * The history a reader can clone must match the tree they check out.
 *
 * Separate from the working-tree check because the two are fixed at different moments: the tree is
 * corrected by editing it, and history only by rewriting it, which is done once at the end rather than
 * continuously. Keeping them in one file would mean the tree property could not be enforced until the
 * rewrite happened — which is to say, not enforced during the whole period it was being established.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { DEPLOYMENT_IDENTIFIERS, PROVIDER_TOKENS, matches } from './provider-neutral-tokens.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function git(args) {
  return execFileSync('git', ['-C', ROOT, ...args], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
}

/** How many commits are reachable, so the scan can prove it read the history rather than nothing. */
function reachableCommitCount() {
  return Number(git(['rev-list', '--branches', '--tags', '--count']).trim());
}

test('no provider vocabulary or deployment identity in commit messages', () => {
  // Guarded on the COMMIT count, not on the length of a split array. The array form asserted more than
  // ten fields and a two-commit history yields five, so the check failed on a correct repository —
  // which is the kind of failure that gets a gate switched off rather than fixed.
  const commits = reachableCommitCount();
  assert.ok(commits > 0, 'expected to read the history, read nothing');

  const messages = git(['log', '--branches', '--tags', '--format=%H%x00%B%x00'])
    .split('\0');

  const findings = [];
  for (let index = 0; index + 1 < messages.length; index += 2) {
    const [commit, message] = [messages[index].trim(), messages[index + 1]];
    for (const token of [...PROVIDER_TOKENS, ...DEPLOYMENT_IDENTIFIERS]) {
      if (matches(message, token)) {
        findings.push(`${commit.slice(0, 12)}: message names ${token}`);
      }
    }
  }
  assert.deepEqual(
    findings,
    [],
    `${findings.length} commit message(s) name a provider or a deployment:\n${findings.join('\n')}`,
  );
});

/**
 * Every blob ever committed, as text, keyed by object id.
 *
 * The history is searched HERE rather than by `git log -S`, because git's pickaxe uses POSIX regular
 * expressions and the identifiers are JavaScript ones. Handing it `identifier.source` was worse than
 * not searching: without `--pickaxe-regex` git took the pattern text literally and matched only the
 * file that defines it, and WITH `--pickaxe-regex` the POSIX engine rejects the lookaheads outright.
 * Measured before this change — literal search: 1 commit, that file; regex search: an error.
 *
 * Reading the blobs and applying the same matcher the working-tree scan uses means one engine, one
 * behaviour, and a shape that cannot mean two different things in two places.
 */
function historyBlobs() {
  const listing = git(['cat-file', '--batch-all-objects', '--batch-check=%(objectname) %(objecttype) %(objectsize)']);
  const ids = [];
  for (const line of listing.split('\n')) {
    const [id, type, size] = line.split(' ');
    // Skip what cannot carry text and what is too large to be a source file or a log.
    if (type === 'blob' && Number(size) > 0 && Number(size) < 32 * 1024 * 1024) ids.push(id);
  }
  return ids;
}

function blobText(id) {
  const bytes = execFileSync('git', ['-C', ROOT, 'cat-file', 'blob', id], { maxBuffer: 256 * 1024 * 1024 });
  if (!bytes.includes(0)) return bytes.toString('utf8');
  if (bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b && bytes[2] === 0x08) {
    try {
      return gunzipSync(bytes).toString('utf8');
    } catch {
      return null;
    }
  }
  return null;
}

test('no deployment identity anywhere in history', () => {
  const findings = [];
  for (const id of historyBlobs()) {
    const text = blobText(id);
    if (text === null) continue;
    for (const identifier of DEPLOYMENT_IDENTIFIERS) {
      if (matches(text, identifier)) findings.push(`blob ${id.slice(0, 12)}: content names ${identifier}`);
    }
  }
  assert.deepEqual(
    findings,
    [],
    `${findings.length} object(s) in history carry one deployment's identity:\n${findings.join('\n')}`,
  );
});

test('the history search actually finds what is there', () => {
  // A search that returns nothing and a repository that is clean look identical, and this check spent
  // its whole life in the first state believing it was in the second. Searching for something certainly
  // present proves the machinery runs; a clean result means nothing without it.
  const ids = historyBlobs();
  assert.ok(ids.length > 50, `expected to read the history's objects, saw ${ids.length}`);
  const hits = ids.filter((id) => {
    const text = blobText(id);
    return text !== null && /"name":\s*"@accrawl\//u.test(text);
  });
  assert.ok(
    hits.length > 0,
    'the history search found nothing for a string that is certainly committed — it is not reading, so '
    + 'a clean result from it means nothing',
  );
});

test('no author or committer identity in commit metadata', () => {
  // The message and the content were scanned; the trailer that git writes on every single commit was
  // not. A name and address are attached to all of them, and a rewrite that scrubs only messages and
  // blobs leaves that behind on every commit in the repository.
  const people = git([
    'log', '--branches', '--tags', '--format=%an%x00%ae%x00%cn%x00%ce%x00%H%x00',
  ]).split('\0');

  const findings = [];
  for (let index = 0; index + 4 < people.length; index += 5) {
    const [authorName, authorEmail, committerName, committerEmail, commit] = people.slice(index, index + 5);
    for (const identifier of DEPLOYMENT_IDENTIFIERS) {
      for (const [what, value] of [
        ['author', `${authorName} <${authorEmail}>`],
        ['committer', `${committerName} <${committerEmail}>`],
      ]) {
        if (matches(value, identifier)) {
          findings.push(`${commit.trim().slice(0, 12)}: ${what} names ${identifier}`);
        }
      }
    }
  }
  assert.deepEqual(
    findings,
    [],
    `${findings.length} commit(s) carry an identity in their metadata:\n${findings.join('\n')}`,
  );
});
