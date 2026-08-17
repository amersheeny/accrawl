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

test('no personal mailbox in commit metadata', () => {
  // The check above scans for DEPLOYMENT identifiers. It does not notice a real personal mailbox,
  // which is a different leak and the one that actually reaches every clone: publishing this project
  // scrubbed the author and committer on every existing commit, and nothing then stopped the next
  // commit from putting a real name and address straight back.
  //
  // The rule is a SHAPE, deliberately — writing the scrubbed address into a tracked file to match on
  // would publish the very thing being scrubbed. GitHub's own privacy addresses end in
  // `users.noreply.github.com`, so requiring a no-reply mailbox states the property directly: no
  // commit in this repository publishes a mailbox that reaches a person.
  //
  // A contributor who wants their own address in the history is a deliberate decision to take then,
  // by relaxing this test with the reason written beside it — not something to discover after the
  // fact from a published clone.
  //
  // Exactly two forms are accepted, and the shape has to be anchored to them. Searching anywhere in
  // the address for "noreply" accepts a routable mailbox that merely contains it — a personal address
  // like <name>.noreply.<name>@<provider>, or any domain someone prefixed "noreply." — which is the
  // leak this exists to stop.
  const NO_REPLY = /^(?:no-?reply|do-?not-?reply)@|@(?:[^@]*\.)?users\.noreply\.github\.com$/iu;

  const people = git([
    'log', '--branches', '--tags', '--format=%ae%x00%ce%x00%H%x00',
  ]).split('\0');

  const findings = [];
  for (let index = 0; index + 2 < people.length; index += 3) {
    const [authorEmail, committerEmail, commit] = people.slice(index, index + 3);
    for (const [what, email] of [['author', authorEmail], ['committer', committerEmail]]) {
      if (email && !NO_REPLY.test(email)) {
        // Report the domain only: naming the mailbox here would put it in the log of a public repo.
        findings.push(`${commit.trim().slice(0, 12)}: ${what} uses a routable mailbox`);
      }
    }
  }
  assert.deepEqual(
    findings,
    [],
    `${findings.length} commit(s) publish a mailbox that reaches a person:\n${findings.join('\n')}`,
  );
});

test('the mailbox shape accepts only genuinely unroutable addresses', () => {
  // The shape above is the whole protection, so it is asserted directly. Every "false" here is an
  // address a person actually receives mail at; an earlier substring form accepted the last three.
  const NO_REPLY = /^(?:no-?reply|do-?not-?reply)@|@(?:[^@]*\.)?users\.noreply\.github\.com$/iu;
  for (const [address, accepted] of [
    ['accrawl@users.noreply.github.com', true],
    ['1234+user@users.noreply.github.com', true],
    ['noreply@example.org', true],
    ['no-reply@example.org', true],
    ['donotreply@example.org', true],
    ['someone@example.com', false],
    ['a.person@example.org', false],
    ['a.noreply.person@example.org', false],
    ['someone@noreply.example.com', false],
    ['someone@notnoreply.example.com', false],
    ['someone@users.noreply.github.com.example.com', false],
  ]) {
    assert.equal(NO_REPLY.test(address), accepted, `${address} should be ${accepted ? 'accepted' : 'rejected'}`);
  }
});
