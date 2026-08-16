import { describe, expect, it, vi } from 'vitest';
import { saveImmutableScreenshot, type ScreenshotArchive } from './screenshot-archive';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0xff, 0xd9]);
const SHA256 = '1d4d47030772999b01d3d1ba14be0f13ce77efc2860086dfaefdb0e8bacf6b2b';
const PATH = 'sessions/abc/1/step-001.jpg';

function archiveWith(overrides: Partial<ScreenshotArchive>): ScreenshotArchive {
  return {
    createIfAbsent: vi.fn(async () => 'created' as const),
    describe: vi.fn(async () => undefined),
    open: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe('storing a step screenshot', () => {
  it('creates it once, and records the digest that identifies those exact bytes', async () => {
    const createIfAbsent = vi.fn(async () => 'created' as const);
    const archive = archiveWith({ createIfAbsent });

    await saveImmutableScreenshot(archive, PATH, JPEG);

    expect(createIfAbsent).toHaveBeenCalledExactlyOnceWith(PATH, JPEG, { sha256: SHA256 });
    expect(archive.describe).not.toHaveBeenCalled();
  });

  it('accepts a worker retrying the same upload', async () => {
    const archive = archiveWith({
      createIfAbsent: vi.fn(async () => 'exists' as const),
      describe: vi.fn(async () => ({
        contentType: 'image/jpeg',
        byteLength: JPEG.length,
        sha256: SHA256,
      })),
    });

    await expect(saveImmutableScreenshot(archive, PATH, JPEG)).resolves.toBeUndefined();
  });

  it('refuses to let different bytes take a path that is already spoken for', async () => {
    // A reclaimed worker uploading over a step somebody already read would rewrite the record of
    // what happened during the crawl.
    const archive = archiveWith({
      createIfAbsent: vi.fn(async () => 'exists' as const),
      describe: vi.fn(async () => ({
        contentType: 'image/jpeg',
        byteLength: JPEG.length,
        sha256: '0'.repeat(64),
      })),
    });

    await expect(saveImmutableScreenshot(archive, PATH, JPEG))
      .rejects.toThrow(/conflicts with the accepted output/);
  });

  it('refuses when the archive says the path is taken but cannot say by what', async () => {
    const archive = archiveWith({ createIfAbsent: vi.fn(async () => 'exists' as const) });

    await expect(saveImmutableScreenshot(archive, PATH, JPEG))
      .rejects.toThrow(/conflicts with the accepted output/);
  });
});
