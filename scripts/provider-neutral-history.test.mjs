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
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { DEPLOYMENT_IDENTIFIERS, PROVIDER_TOKENS, matches } from './provider-neutral-tokens.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
// A replacement ref would let a local substitute stand in for a commit the push still sends as it is.
const GIT = (root) => ['--no-replace-objects', '-C', root];
// A hook exports GIT_DIR and its siblings so that git finds the repository being pushed, and they outrank -C:
// commands on that repository need them, and a command given any other root must drop them or it reads that one.
const LOCAL = new Set(execFileSync('git', ['rev-parse', '--local-env-vars'], { encoding: 'utf8' }).split('\n'));
const FOREIGN_ENV = Object.fromEntries(Object.entries(process.env).filter(([name]) => !LOCAL.has(name)));
const envFor = (root) => (root === ROOT ? process.env : FOREIGN_ENV);

function git(args, root = ROOT) {
  return execFileSync('git', [...GIT(root), ...args], {
    encoding: 'utf8',
    env: envFor(root),
    maxBuffer: 256 * 1024 * 1024,
  });
}

// The pre-push hook sets ACCRAWL_HISTORY_REFS to the commits being pushed, so a push is judged on what
// it publishes rather than on every local branch. Anything but full commit ids fails closed: a stray
// option such as `--all` would silently widen or narrow the scan.
const PUSHED = (process.env.ACCRAWL_HISTORY_REFS ?? '').split(/\s+/u).filter(Boolean);
for (const ref of PUSHED) {
  if (!/^[0-9a-f]{40}$/u.test(ref)) throw new Error(`ACCRAWL_HISTORY_REFS must hold full commit ids, got ${ref}`);
}

// HEAD is listed explicitly because a pull-request checkout is detached and creates no local branch:
// with only branches and tags selected, a run there reads none of the commits it is checking.
const PUBLISHED = PUSHED.length > 0 ? PUSHED : ['--branches', '--tags', 'HEAD'];

/** How many commits are reachable, so the scan can prove it read the history rather than nothing. */
function reachableCommitCount() {
  return Number(git(['rev-list', ...PUBLISHED, '--count']).trim());
}

test('no provider vocabulary or deployment identity in commit messages', () => {
  // Guarded on the COMMIT count, not on the length of a split array. The array form asserted more than
  // ten fields and a two-commit history yields five, so the check failed on a correct repository —
  // which is the kind of failure that gets a gate switched off rather than fixed.
  const commits = reachableCommitCount();
  assert.ok(commits > 0, 'expected to read the history, read nothing');

  const messages = git(['log', ...PUBLISHED, '--format=%H%x00%B%x00'])
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
 * The ids of the blobs the history search reads: every non-empty blob smaller than 32 MiB in the repository,
 * or every such blob the given pushed commits reach.
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
function historyBlobs(root = ROOT, pushed = PUSHED) {
  const check = '--batch-check=%(objectname) %(objecttype) %(objectsize)';
  const listing = pushed.length > 0
    ? execFileSync('git', [...GIT(root), 'cat-file', check], {
      encoding: 'utf8',
      env: envFor(root),
      maxBuffer: 256 * 1024 * 1024,
      input: git(['rev-list', '--objects', ...pushed], root).split('\n').map((line) => line.split(' ')[0]).filter(Boolean).join('\n'),
    })
    : git(['cat-file', '--batch-all-objects', check], root);
  const ids = [];
  for (const line of listing.split('\n')) {
    const [id, type, size] = line.split(' ');
    // Skip what cannot carry text and what is too large to be a source file or a log.
    if (type === 'blob' && Number(size) > 0 && Number(size) < 32 * 1024 * 1024) ids.push(id);
  }
  return ids;
}

function blobText(id, root = ROOT) {
  const bytes = execFileSync('git', [...GIT(root), 'cat-file', 'blob', id], { env: envFor(root), maxBuffer: 256 * 1024 * 1024 });
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

test('the history search reads every non-empty blob under 32 MiB of every commit it judges', () => {
  // A search that returns nothing and a clean history look identical, so the listing is checked against
  // the tree of every commit being judged, which also holds for a small or empty history.
  const listed = new Set(historyBlobs());
  const inTrees = new Set();
  for (const commit of git(['rev-list', ...PUBLISHED]).split('\n').filter(Boolean)) {
    for (const line of git(['ls-tree', '-r', '-l', commit]).split('\n').filter(Boolean)) {
      const [, type, id, size] = line.split(/\s+/u);
      if (type === 'blob' && Number(size) > 0 && Number(size) < 32 * 1024 * 1024) inTrees.add(id);
    }
  }
  const missed = [...inTrees].filter((id) => !listed.has(id));
  assert.deepEqual(missed, [], `the history search skipped ${missed.length} blob(s) of the commits it judges`);
});

test('the history search finds text that only an earlier commit holds', () => {
  // Listing every blob proves nothing if their text is never read, so the search runs where the answer
  // is known: a repository whose only copy of a marker sits in a commit its tip has since removed.
  const fixture = mkdtempSync(join(tmpdir(), 'accrawl-history-'));
  try {
    const env = {
      ...FOREIGN_ENV,
      GIT_AUTHOR_NAME: 'fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    };
    const run = (args, input = '') => execFileSync('git', ['-C', fixture, ...args], { encoding: 'utf8', env, input }).trim();
    run(['init', '-q']);
    const marker = `marker-${randomUUID()}`;
    const blob = run(['hash-object', '-w', '--stdin'], marker);
    const added = run(['commit-tree', '--no-gpg-sign', '-m', 'add', run(['mktree'], `100644 blob ${blob}\tnote.txt\n`)]);
    const removed = run(['commit-tree', '--no-gpg-sign', '-p', added, '-m', 'remove', run(['mktree'])]);

    for (const pushed of [[removed], []]) {
      const found = historyBlobs(fixture, pushed).filter((id) => {
        const text = blobText(id, fixture);
        return text !== null && matches(text, marker);
      });
      assert.deepEqual(found, [blob], `the history search missed the removed marker (pushed: ${pushed.length})`);
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('no author or committer identity in commit metadata', () => {
  // The message and the content were scanned; the trailer that git writes on every single commit was
  // not. A name and address are attached to all of them, and a rewrite that scrubs only messages and
  // blobs leaves that behind on every commit in the repository.
  const people = git([
    'log', ...PUBLISHED, '--format=%an%x00%ae%x00%cn%x00%ce%x00%H%x00',
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
    'log', ...PUBLISHED, '--format=%ae%x00%ce%x00%H%x00',
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
