import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REVIEWED_STATUS_COPY } from '../src/status-copy';
import { REVIEWED_SHARING_COPY } from '../src/sharing-copy';
import { REVIEWED_INSTITUTION_COPY } from '../src/institution-copy';
import { COMPANION_COPY } from '../src/companion-copy';
import { SCHEDULE_COPY } from '../src/schedule-copy';
import { HOSTED_COPY } from '../../../packages/contracts/src/hosted-copy';
import { CONTROL_PLANE_INSTITUTION_COPY } from '../../control-plane/src/institution-copy';
import {
  copyHash,
  countCopy,
  directFlutterCopyLiterals,
  extractDartCopyConstants,
  extractKotlinCopyConstants,
  extractUserVisibleCopy,
  packCopy,
  unreviewedCopy,
} from './copy-review-lib';

interface ReviewEntry {
  text: string;
  sha256: string;
  review: {
    runId: string;
    transcript: string;
  };
}

interface ArtifactReviewEntry {
  sha256: string;
  review: {
    runId: string;
    transcript: string;
  };
}

interface CopyBaseline {
  sourceRevision: string;
  /**
   * Per-source-file, sorted 32-byte SHA-256 digests. Digests are repeated for
   * duplicate occurrences before being concatenated and base64 encoded.
   */
  files: Record<string, string>;
  /**
   * The same extraction re-run with the CURRENT extractor, frozen at the same revision. Copy the
   * better extractor newly sees, that was already present then, stays baseline copy rather than being
   * re-gated. Recorded here because recomputing it needed a commit that publication does not keep.
   */
  improvedFiles: Record<string, string>;
}

interface ReviewedOccurrence {
  count: number;
  file: string;
}

interface SourceReviewEntry extends ReviewEntry {
  occurrences: ReviewedOccurrence[];
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const manifestPath = path.join(root, 'reviews', 'content', 'reviewed-copy.json');
const sourceManifestPath = path.join(root, 'reviews', 'content', 'reviewed-source-copy.json');
const baselinePath = path.join(root, 'reviews', 'content', 'user-visible-baseline.json');
const companionManifestPath = path.join(root, 'reviews', 'content', 'reviewed-companion-copy.json');
const artifactManifestPath = path.join(root, 'reviews', 'content', 'reviewed-artifacts.json');
const manifest = JSON.parse(
  readFileSync(manifestPath, 'utf8'),
) as Record<string, ReviewEntry>;
const sourceManifest = JSON.parse(
  readFileSync(sourceManifestPath, 'utf8'),
) as Record<string, SourceReviewEntry>;
const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as CopyBaseline;
const companionManifest = JSON.parse(
  readFileSync(companionManifestPath, 'utf8'),
) as Record<string, ReviewEntry>;
const artifactManifest = JSON.parse(
  readFileSync(artifactManifestPath, 'utf8'),
) as Record<string, ArtifactReviewEntry>;
const copy: Record<string, string> = {
  ...REVIEWED_STATUS_COPY,
  ...Object.fromEntries(
    Object.entries(HOSTED_COPY).map(([key, value]) => [
      `hosted.${key}`,
      value,
    ]),
  ),
  ...Object.fromEntries(
    Object.entries(REVIEWED_SHARING_COPY).map(([key, value]) => [
      `sharing.${key}`,
      value,
    ]),
  ),
  ...Object.fromEntries(
    Object.entries(REVIEWED_INSTITUTION_COPY).map(([key, value]) => [
      `institution.${key}`,
      value,
    ]),
  ),
  ...Object.fromEntries(
    Object.entries(CONTROL_PLANE_INSTITUTION_COPY).map(([key, value]) => [
      `controlPlaneInstitution.${key}`,
      value,
    ]),
  ),
  ...Object.fromEntries(
    Object.entries(SCHEDULE_COPY).map(([key, value]) => [
      `schedule.${key}`,
      value,
    ]),
  ),
};
const errors: string[] = [];
const REVIEWED_ARTIFACT_FILES = [
  'DEPLOY.md',
  'README.md',
  'apps/control-plane/README.md',
  'apps/engine/README.md',
  'apps/web/README.md',
  'companion/README.md',
  'docs/hosted-cell.md',
  'packages/contracts/README.md',
];
// Provenance only: the revision the frozen baseline was taken and verified from. It is recorded so the
// artifact can be traced, and is deliberately NOT resolved against the repository — see the baseline
// block below for why depending on it broke every clone.
const BASELINE_SOURCE_REVISION = '0cecb39631fd0d6ada52c0cb4ae3ea323e196d20';
const DEDICATED_COPY_FILES = new Set([
  'apps/web/src/companion-copy.ts',
  'apps/web/src/institution-copy.ts',
  'apps/web/src/sharing-copy.ts',
  'apps/web/src/schedule-copy.ts',
  'apps/web/src/status-copy.ts',
]);

const validateReview = (key: string, reviewed: ReviewEntry, expectedText?: string): void => {
  const hash = copyHash(reviewed.text);
  if (
    (expectedText !== undefined && reviewed.text !== expectedText)
    || reviewed.sha256 !== hash
  ) {
    errors.push(`${key}: text changed after content-strategist review`);
  }
  if (!reviewed.review.runId || !reviewed.review.transcript) {
    errors.push(`${key}: review provenance is incomplete`);
    return;
  }
  const transcript = path.resolve(root, reviewed.review.transcript);
  if (
    !transcript.startsWith(`${root}${path.sep}`)
    || !existsSync(transcript)
  ) {
    errors.push(`${key}: review transcript does not exist inside the repository`);
    return;
  }
  const transcriptText = readFileSync(transcript, 'utf8');
  if (!transcriptText.includes(reviewed.review.runId)) {
    errors.push(`${key}: review transcript does not name its recorded run`);
  }
  if (
    key.startsWith('hosted.')
    && expectedText !== undefined
    && !transcriptText.includes(`\`${expectedText}\``)
  ) {
    errors.push(`${key}: review transcript does not contain the exact hosted copy`);
  }
};

for (const file of REVIEWED_ARTIFACT_FILES) {
  const reviewed = artifactManifest[file];
  if (!reviewed) {
    errors.push(`${file}: missing full-artifact content review`);
    continue;
  }
  const absolute = path.resolve(root, file);
  if (
    file !== path.posix.normalize(file)
    || !absolute.startsWith(`${root}${path.sep}`)
    || !existsSync(absolute)
  ) {
    errors.push(`${file}: reviewed artifact does not exist inside the repository`);
    continue;
  }
  if (reviewed.sha256 !== copyHash(readFileSync(absolute, 'utf8'))) {
    errors.push(`${file}: artifact changed after content-strategist review`);
  }
  if (!reviewed.review.runId || !reviewed.review.transcript) {
    errors.push(`${file}: artifact review provenance is incomplete`);
    continue;
  }
  const transcript = path.resolve(root, reviewed.review.transcript);
  if (!transcript.startsWith(`${root}${path.sep}`) || !existsSync(transcript)) {
    errors.push(`${file}: artifact review transcript does not exist inside the repository`);
  } else {
    const transcriptText = readFileSync(transcript, 'utf8');
    if (!transcriptText.includes(reviewed.review.runId)) {
      errors.push(`${file}: artifact review transcript does not name its recorded run`);
    }
    if (!/\bAPPROVED\b/u.test(transcriptText)) {
      errors.push(`${file}: artifact review transcript does not record an APPROVED verdict`);
    }
  }
}
for (const file of Object.keys(artifactManifest)) {
  if (!REVIEWED_ARTIFACT_FILES.includes(file)) {
    errors.push(`${file}: artifact review is not in the scanner allowlist`);
  }
}

for (const [key, text] of Object.entries(copy)) {
  const reviewed = manifest[key];
  if (!reviewed) {
    errors.push(`${key}: missing content-strategist review`);
    continue;
  }
  validateReview(key, reviewed, text);
}
for (const key of Object.keys(manifest)) {
  if (!(key in copy)) errors.push(`${key}: stale reviewed-copy entry`);
}

const companionCopy: Record<string, string> = {};
for (const [key, value] of Object.entries(COMPANION_COPY)) {
  if (typeof value === 'string') companionCopy[`web.${key}`] = value;
}
const dartCopyPath = path.join(root, 'companion', 'lib', 'companion_copy.dart');
for (const [key, value] of Object.entries(
  extractDartCopyConstants(readFileSync(dartCopyPath, 'utf8')),
)) {
  companionCopy[`android.${key}`] = value;
}
const nativeCopyPath = path.join(
  root,
  'companion',
  'android',
  'app',
  'src',
  'main',
  'kotlin',
  'app',
  'accrawl',
  'accrawl_companion',
  'NotificationCopy.kt',
);
const nativeCopy = extractKotlinCopyConstants(readFileSync(nativeCopyPath, 'utf8'));
const nativeCatalogue = JSON.stringify(
  Object.fromEntries(Object.entries(nativeCopy).sort(([left], [right]) => left.localeCompare(right))),
);
// One digest gates the complete native catalogue. Any added, removed, renamed, or edited notification string
// changes this value and therefore requires a fresh content-strategy review entry.
companionCopy['androidNative.__catalogueDigest'] = copyHash(nativeCatalogue);
for (const [key, text] of Object.entries(companionCopy)) {
  const reviewed = companionManifest[key];
  if (!reviewed) {
    errors.push(`${key}: missing companion content-strategist review`);
    continue;
  }
  validateReview(key, reviewed, text);
}
for (const key of Object.keys(companionManifest)) {
  if (!(key in companionCopy)) errors.push(`${key}: stale reviewed companion-copy entry`);
}
for (const text of directFlutterCopyLiterals(
  readFileSync(path.join(root, 'companion', 'lib', 'main.dart'), 'utf8'),
)) {
  errors.push(`companion/lib/main.dart: direct user-facing literal "${text}" must use CompanionCopy`);
}

const sourceFiles: string[] = [];
const collectFiles = (directory: string): void => {
  for (const name of readdirSync(directory)) {
    const absolute = path.join(directory, name);
    if (statSync(absolute).isDirectory()) {
      collectFiles(absolute);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) {
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      if (!DEDICATED_COPY_FILES.has(relative)) sourceFiles.push(absolute);
    }
  }
};
collectFiles(path.join(root, 'apps', 'web', 'src'));
collectFiles(path.join(root, 'apps', 'control-plane', 'src', 'routes'));
sourceFiles.push(path.join(root, 'apps', 'control-plane', 'src', 'openapi', 'spec.ts'));
// Auth guards answer callers in their own words — a refusal the route behind them never gets to write —
// so that copy is user-facing too and goes through the same review.
sourceFiles.push(path.join(root, 'apps', 'control-plane', 'src', 'auth', 'middleware.ts'));
sourceFiles.push(path.join(root, 'apps', 'control-plane', 'src', 'data', 'cancel-session.ts'));
sourceFiles.push(path.join(root, 'apps', 'control-plane', 'src', 'orchestration', 'run-crawl.ts'));
sourceFiles.push(path.join(root, 'apps', 'control-plane', 'src', 'scheduling', 'scheduler.ts'));
// The hosted crawl orchestrator and worker broker used to be scanned here. They belong to whichever
// deployment supplies them now; the words they say to a caller come from HOSTED_COPY, which is in
// contracts and is reviewed above.
sourceFiles.sort();

const sourceFileSet = new Set(
  sourceFiles.map((sourceFile) => path.relative(root, sourceFile).split(path.sep).join('/')),
);

const decodePackedCounts = (packedBase64: string, label: string): Map<string, number> => {
  const packed = Buffer.from(packedBase64, 'base64');
  if (packed.length % 32 !== 0) {
    errors.push(`${label}: packed hashes are malformed`);
    return new Map();
  }
  const counts = new Map<string, number>();
  for (let offset = 0; offset + 32 <= packed.length; offset += 32) {
    const hash = packed.subarray(offset, offset + 32).toString('hex');
    counts.set(hash, (counts.get(hash) ?? 0) + 1);
  }
  return counts;
};

if (!/^[0-9a-f]{40}$/.test(baseline.sourceRevision) || !baseline.files) {
  errors.push('user-visible baseline is missing its source revision or per-file hashes');
}
if (baseline.sourceRevision !== BASELINE_SOURCE_REVISION) {
  errors.push('user-visible baseline source revision is not the immutable project baseline');
}
// The baseline is a FROZEN ARTIFACT, not a query against a live repository.
//
// It used to reconstruct itself by reading every file at sourceRevision through `git show`. That made
// the whole copy gate depend on one commit still being reachable — and it already was not: the
// revision is not an ancestor of any branch, it survived only on tool-created refs, and a fresh clone
// therefore failed `pnpm test` on its first command with "source revision is not available in git".
// Publishing the project rewrites history, which would have made that permanent for everyone.
//
// Both passes it recomputed are now recorded IN the artifact — `files` (the original extractor
// semantics) and `improvedFiles` (the widened pass that keeps copy the better extractor newly sees
// from being re-gated). Each was verified to reconstruct from the revision at the moment it was
// frozen, while that revision was still readable. What the gate grandfathers is unchanged; what it no
// longer needs is a commit nobody can clone.
if (!baseline.improvedFiles) {
  errors.push('user-visible baseline is missing its frozen improved-extractor pass');
}
const baselineByFile = new Map<string, Map<string, number>>();
for (const [file, packed] of Object.entries(baseline.files ?? {})) {
  if (!sourceFileSet.has(file)) {
    errors.push(`baseline ${file}: file is outside the scanned source set`);
  }
  const baselineCounts = decodePackedCounts(packed, `baseline ${file}`);
  const improved = (baseline.improvedFiles ?? {})[file];
  if (improved === undefined) {
    errors.push(`baseline ${file}: no frozen improved-extractor entry`);
  } else {
    // Copy the improved extractor finds that was already present at the frozen revision is still
    // baseline copy. Later occurrences remain gated.
    for (const [hash, count] of decodePackedCounts(improved, `baseline improved ${file}`)) {
      baselineCounts.set(hash, Math.max(baselineCounts.get(hash) ?? 0, count));
    }
  }
  baselineByFile.set(file, baselineCounts);
}

const reviewedByFile = new Map<string, Map<string, number>>();
for (const [key, reviewed] of Object.entries(sourceManifest)) {
  validateReview(key, reviewed);
  if (!Array.isArray(reviewed.occurrences) || reviewed.occurrences.length === 0) {
    errors.push(`${key}: reviewed source copy has no occurrence grants`);
    continue;
  }
  const seenFiles = new Set<string>();
  for (const occurrence of reviewed.occurrences) {
    if (
      path.posix.normalize(occurrence.file) !== occurrence.file
      || occurrence.file.startsWith('/')
      || occurrence.file.startsWith('../')
      || !sourceFileSet.has(occurrence.file)
    ) {
      errors.push(`${key}: invalid or unscanned occurrence file ${occurrence.file}`);
      continue;
    }
    if (!Number.isInteger(occurrence.count) || occurrence.count <= 0) {
      errors.push(`${key}: occurrence count must be a positive integer`);
      continue;
    }
    if (seenFiles.has(occurrence.file)) {
      errors.push(`${key}: duplicate occurrence grant for ${occurrence.file}`);
      continue;
    }
    seenFiles.add(occurrence.file);
    const fileCounts = reviewedByFile.get(occurrence.file) ?? new Map<string, number>();
    fileCounts.set(
      reviewed.sha256,
      (fileCounts.get(reviewed.sha256) ?? 0) + occurrence.count,
    );
    reviewedByFile.set(occurrence.file, fileCounts);
  }
}

for (const sourceFile of sourceFiles) {
  const relativeFile = path.relative(root, sourceFile).split(path.sep).join('/');
  const values = extractUserVisibleCopy(readFileSync(sourceFile, 'utf8'), sourceFile);
  const baselineCounts = baselineByFile.get(relativeFile) ?? new Map();
  const reviewedCounts = reviewedByFile.get(relativeFile) ?? new Map();
  for (const value of unreviewedCopy(values, baselineCounts, reviewedCounts)) {
    errors.push(
      `${relativeFile}: ${value.count} unreviewed occurrence(s) of `
      + `"${value.text}" (${value.sha256})`,
    );
  }

  const currentCounts = countCopy(values);
  for (const [hash, reviewedCount] of reviewedCounts) {
    const currentCount = currentCounts.get(hash)?.count ?? 0;
    const baselineCount = baselineCounts.get(hash) ?? 0;
    const requiredReviewCount = Math.max(0, currentCount - baselineCount);
    if (reviewedCount !== requiredReviewCount) {
      errors.push(
        `${relativeFile}: reviewed occurrence grant for ${hash} is stale `
        + `(granted ${reviewedCount}, required ${requiredReviewCount})`,
      );
    }
  }
}

if (errors.length > 0) {
  throw new Error(`Unreviewed user-facing copy:\n${errors.join('\n')}`);
}
console.log(
  `[copy-review] verified ${Object.keys(copy).length} status review(s), `
  + `${Object.keys(sourceManifest).length} source review(s), `
  + `${Object.keys(companionManifest).length} companion review(s), `
  + `${sourceFiles.length} source files, and `
  + `${REVIEWED_ARTIFACT_FILES.length} reviewed artifact(s)`,
);
