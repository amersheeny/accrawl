#!/usr/bin/env node
/**
 * Refuse a commit that would put a provider's vocabulary — or worse, a deployment's own identity —
 * into this repository.
 *
 * This reads the INDEX, not the working tree. That distinction is the whole point: the tests ask
 * whether the repository is clean, which is a question about what is already committed. This asks
 * whether the thing about to be committed is clean, which is the only moment the answer can still
 * prevent anything.
 *
 * Written after exactly that gap was demonstrated: a `.gitignore` rule was removed on the mistaken
 * reasoning that the build no longer needed the file it covered, `git add -A` then staged two real
 * project configurations, and nothing objected. The check that eventually caught it ran a minute later,
 * against a commit that already existed.
 *
 * Deployment identifiers are refused unconditionally. Provider vocabulary is refused unless the file is
 * one of the places recorded as allowed to carry it, with its reason, in provider-neutral-tokens.mjs.
 */
import { execFileSync } from 'node:child_process';
import {
  DEPLOYMENT_IDENTIFIERS,
  NOT_PROSE,
  PROVIDER_TOKENS,
  excepted,
  matches,
} from './provider-neutral-tokens.mjs';

function git(args, encoding = 'utf8') {
  return execFileSync('git', args, { encoding, maxBuffer: 256 * 1024 * 1024 });
}

/** Paths staged for this commit, excluding ones being deleted. */
function stagedPaths() {
  return git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'])
    .split('\0')
    .filter(Boolean);
}

/** The staged content of one path — what would be committed, not what is on disk. */
function stagedText(path) {
  const bytes = git(['show', `:${path}`], 'buffer');
  return bytes.includes(0) ? null : bytes.toString('utf8');
}

const findings = [];
for (const path of stagedPaths()) {
  let text;
  try {
    text = stagedText(path);
  } catch {
    continue; // unreadable from the index (a submodule, say) — nothing to scan
  }
  if (text === null) continue;

  // The machinery that looks for these has to spell them out, and the lockfile is not written by
  // hand. Nothing else is skipped — this is the same short list the tree scan uses, and it is not a
  // place to put a file that merely happens to be awkward.
  if (NOT_PROSE.has(path)) continue;

  // For every other file: no exception exists, or can be added, for these. A reader who clones this
  // must not learn which project runs the hosted service.
  for (const identifier of DEPLOYMENT_IDENTIFIERS) {
    if (matches(text, identifier)) {
      findings.push(`${path}: names a deployment's own identity (${identifier})`);
    }
  }
  for (const token of PROVIDER_TOKENS) {
    if (matches(text, token) && !excepted(path, token)) {
      findings.push(`${path}: names ${JSON.stringify(token)}`);
    }
  }
}

if (findings.length > 0) {
  process.stderr.write(
    `\nThis commit would put ${findings.length} thing(s) into the repository that must not be in it:\n\n`
    + findings.map((finding) => `  ${finding}\n`).join('')
    + '\nA provider name belongs here only in a place recorded as allowed to carry it, with the reason,\n'
    + 'in scripts/provider-neutral-tokens.mjs. A deployment\'s own identity belongs here nowhere at all —\n'
    + 'if one is listed above, unstage the file rather than looking for a way to permit it.\n\n',
  );
  process.exit(1);
}
