/**
 * Where step screenshots are kept, when they are not kept on this machine's disk.
 *
 * A crawl captures one JPEG per step; the console renders them as the run's history. A deployment that
 * runs everything itself writes them under SCREENSHOT_DIR and serves them from there. A deployment
 * whose workers run elsewhere has nowhere shared to put a file, so it supplies an archive instead.
 *
 * What the archive supplies is deliberately small — create-if-absent, describe, open. The rule that
 * matters is here: a step's screenshot is written exactly once, and a retry is accepted only when the
 * object already there is byte-for-byte the one the first attempt accepted. That rule is the product's,
 * because it is what stops a reclaimed worker from replacing evidence of a crawl somebody already read.
 */
import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';

/** What is stored at a path, without reading the bytes back. */
export interface StoredScreenshot {
  contentType: string;
  byteLength: number;
  /** The digest recorded when the object was created, if the archive kept it. */
  sha256?: string;
}

export interface ScreenshotArchive {
  /**
   * Create the object only if nothing is there yet, recording `sha256` alongside it so a later retry
   * can be recognised. Returns 'exists' rather than throwing when the path is already taken — deciding
   * what that means is the caller's job.
   */
  createIfAbsent(
    objectPath: string,
    jpeg: Buffer,
    metadata: { sha256: string },
  ): Promise<'created' | 'exists'>;

  /** What is stored at `objectPath`, or undefined when nothing is. */
  describe(objectPath: string): Promise<StoredScreenshot | undefined>;

  /** Open the stored screenshot for reading, or undefined when there is none. */
  open(objectPath: string): Promise<{ contentType: string; body: Readable } | undefined>;
}

let registered: (() => ScreenshotArchive) | undefined;

/** Supply the archive for a deployment that keeps screenshots somewhere shared. */
export function registerScreenshotArchive(factory: () => ScreenshotArchive): void {
  registered = factory;
}

/** The registered archive, or undefined when this deployment keeps screenshots on its own disk. */
export function screenshotArchive(): ScreenshotArchive | undefined {
  return registered?.();
}

/** Test-only reset so a case can compose a different deployment. */
export function resetScreenshotArchiveForTest(): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('resetScreenshotArchiveForTest is available only under NODE_ENV=test');
  }
  registered = undefined;
}

/**
 * Store one step's screenshot at a path that belongs to exactly one crawl attempt.
 *
 * Writing is idempotent, not overwriting: a worker that retries the same upload succeeds, and anything
 * that would put different bytes at a path already spoken for fails loudly.
 */
export async function saveImmutableScreenshot(
  archive: ScreenshotArchive,
  objectPath: string,
  bytes: Buffer,
): Promise<void> {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (await archive.createIfAbsent(objectPath, bytes, { sha256 }) === 'created') return;
  const existing = await archive.describe(objectPath);
  if (
    !existing
    || existing.contentType !== 'image/jpeg'
    || existing.byteLength !== bytes.length
    || existing.sha256 !== sha256
  ) {
    throw new Error('worker screenshot object conflicts with the accepted output');
  }
}
