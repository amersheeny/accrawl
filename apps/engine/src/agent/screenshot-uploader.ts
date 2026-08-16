/**
 * Screenshot Uploader
 *
 * Persists per-step crawl screenshots and returns a displayable URL. The actual
 * sink is the active platform (see ../platform): a hosted adapter uploads to
 * GCS with a signed URL, the local adapter writes a JPEG to the run directory and
 * returns a file:// URL. Upload failures are non-fatal — the step log still works.
 */

import type { SessionLogger } from '../utils/logger';
import type { ScreenshotUploadResult } from '../platform/types';
import { getPlatform } from '../platform';

export type { ScreenshotUploadResult } from '../platform/types';

export async function uploadScreenshot(
  sessionId: string,
  stepNumber: number,
  base64Screenshot: string,
  logger?: SessionLogger,
): Promise<ScreenshotUploadResult | null> {
  // A fail-closed OTP capture returns '' (takeScreenshot suppressed the shot rather than leak a live 2FA code).
  // Persist nothing in that case — an empty file is not a screenshot, and callers already treat null as
  // "no screenshot for this step".
  if (!base64Screenshot) return null;
  return getPlatform().screenshots.upload(sessionId, stepNumber, base64Screenshot, logger);
}
