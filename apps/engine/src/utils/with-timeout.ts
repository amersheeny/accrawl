/**
 * withTimeout
 *
 * Races a promise against a timeout. If the timeout fires first, the returned
 * promise REJECTS with a clear Error so callers can recover or classify the
 * failure. The timer is always cleared so it never keeps the event loop alive.
 *
 * This exists because several Playwright operations (notably page.evaluate and
 * the sharp image processing after a screenshot) have NO native timeout — a
 * heavy or unstable DOM can hang them forever, silently consuming the entire
 * crawl budget. Wrapping them with withTimeout makes every such operation
 * bounded.
 */
export async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Operation "${label}" timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
