/**
 * Real-browser test for the OTP screenshot mask. Regression guard for a CONFIRMED production leak: the mask
 * evaluate string began with `function` (interpolated helper declarations), which Playwright mis-parses as a
 * function DEFINITION — it threw `SyntaxError`, the per-frame catch swallowed it, and the mask masked NOTHING,
 * so a live 2FA code rendered into the persisted screenshot. Secondary: the mask matched `value.includes(rawCode)`
 * exactly, so any formatting difference (a trailing space on the extracted code, a maxlength-clipped field) also
 * masked nothing. These tests exercise the REAL maskOtpInputs / takeScreenshot in a real browser (the in-process
 * mock-platform tests never did) and assert the field is dotted — an oracle independent of the mask's own logic.
 *
 * Skips gracefully without a Chromium binary.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { maskOtpInputs, takeScreenshot, otpMayStillBeVisible, getPageContent } from './page-utils';

describe('OTP screenshot mask — real browser', () => {
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
    console.warn('[page-utils.otp-mask.browser.test] No Chrome/Chromium available — skipping browser test');
  });
  afterAll(async () => { await browser?.close(); });

  // A single-input OTP field (autocomplete=one-time-code, the common bank shape) + two decoy inputs that must
  // NEVER be masked: a long account number and a name. maxlength clips the OTP field to 6, mirroring the real page.
  const FORM = `
    <input id="otp-code" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6">
    <input id="acct" name="account" type="text" value="000111222333">
    <input id="name" name="fullname" type="text" value="Alice Morgan">
  `;

  async function setup(code: string) {
    const page = await browser!.newPage();
    await page.setContent(FORM);
    await page.click('#otp-code');
    await page.keyboard.type(code, { delay: 0 }); // engine-style typing; maxlength=6 clips like production
    return page;
  }

  async function underMask(page: Awaited<ReturnType<typeof setup>>, maskCode: string) {
    const restore = await maskOtpInputs(page, maskCode);
    const masked = await page.$eval('#otp-code', (e) => (e as HTMLInputElement).value);
    const acct = await page.$eval('#acct', (e) => (e as HTMLInputElement).value);
    const name = await page.$eval('#name', (e) => (e as HTMLInputElement).value);
    await restore();
    const restored = await page.$eval('#otp-code', (e) => (e as HTMLInputElement).value);
    return { masked, acct, name, restored };
  }

  it('masks the OTP field when the code is handed to the mask with trailing whitespace (the confirmed leak)', async () => {
    if (!available) return;
    const page = await setup('704605');
    const r = await underMask(page, '704605 '); // padded — the exact-includes match used to miss this and leak
    expect(r.masked).toMatch(/^•+$/); // all bullets, no digits
    expect(r.masked).not.toMatch(/\d/);
    expect(r.restored).toBe('704605');            // live value restored for the submit
    expect(r.acct).toBe('000111222333');          // unrelated long-digit field untouched
    expect(r.name).toBe('Alice Morgan');
    await page.close();
  }, 30000);

  it('masks a one-time-code field by identity even when the code does not match its value', async () => {
    if (!available) return;
    const page = await setup('508456');
    const r = await underMask(page, '999999'); // wrong code entirely — identity trigger must still redact
    expect(r.masked).toMatch(/^•+$/);
    expect(r.acct).toBe('000111222333');          // non-OTP 12-digit field NOT over-masked
    expect(r.name).toBe('Alice Morgan');
    await page.close();
  }, 30000);

  it('masks with an exact code (regression) and never touches non-OTP fields', async () => {
    if (!available) return;
    const page = await setup('238457');
    const r = await underMask(page, '238457');
    expect(r.masked).toMatch(/^•+$/);
    expect(r.acct).toBe('000111222333');
    expect(r.name).toBe('Alice Morgan');
    await page.close();
  }, 30000);

  it('takeScreenshot returns a real (non-empty) redacted screenshot on an OTP page and restores the field', async () => {
    if (!available) return;
    const page = await setup('704605');
    const b64 = await takeScreenshot(page, '704605 ');
    // Non-empty => the mask ran and the fail-closed check passed clean (a broken mask returns '' — suppressed).
    expect(b64.length).toBeGreaterThan(200);
    expect(await page.$eval('#otp-code', (e) => (e as HTMLInputElement).value)).toBe('704605');
    await page.close();
  }, 30000);

  // codex finding 1: the fail-closed net must also see a SEGMENTED code (six one-digit cells), or a
  // six-single-digit OTP left unmasked would slip past it and a leaking screenshot would be emitted.
  it('fail-closed check detects a segmented OTP spread across six single-digit inputs', async () => {
    if (!available) return;
    const page = await browser!.newPage();
    await page.setContent(
      `<form>` + [1, 2, 3, 4, 5, 6].map((n, i) => `<input id="d${i}" inputmode="numeric" maxlength="1" value="${n}">`).join('') + `</form>`,
    );
    // The six cells hold 1,2,3,4,5,6 — none matches "123456" alone; the concatenation does.
    expect(await otpMayStillBeVisible(page, '123456')).toBe(true);
    // A code not present across the cells is NOT flagged.
    expect(await otpMayStillBeVisible(page, '999999')).toBe(false);
    await page.close();
  }, 30000);

  // codex re-review finding 1: a 3+3 split (two three-digit inputs) must be masked — it evaded the seg
  // detector (needed <=2-digit cells), the single-input path (needs >=4), and field identity (needs >=4).
  it('masks a 3+3 split OTP spread across two three-digit inputs', async () => {
    if (!available) return;
    const page = await browser!.newPage();
    await page.setContent('<form><input id="a" value="123"><input id="b" value="456"></form>');
    const restore = await maskOtpInputs(page, '123456');
    const a = await page.$eval('#a', (e) => (e as HTMLInputElement).value);
    const b = await page.$eval('#b', (e) => (e as HTMLInputElement).value);
    await restore();
    expect(a).toMatch(/^•+$/);
    expect(b).toMatch(/^•+$/);
    expect(await page.$eval('#a', (e) => (e as HTMLInputElement).value)).toBe('123'); // restored
    await page.close();
  }, 30000);

  // codex re-review finding 2: the fail-closed check must not false-positive on HIDDEN/unrelated short inputs
  // whose digits happen to equal the code (a naive concat-everything would suppress every OTP screenshot).
  it('fail-closed ignores hidden inputs whose digits equal the code (no spurious suppression)', async () => {
    if (!available) return;
    const page = await browser!.newPage();
    await page.setContent(
      '<form><input id="otp" autocomplete="one-time-code" value="••••••">' +
        [1, 2, 3, 4, 5, 6].map((n, i) => `<input type="hidden" id="h${i}" value="${n}">`).join('') +
        '</form>',
    );
    // OTP field already masked (dots); the six matching digits are all in HIDDEN inputs → not a visible leak.
    expect(await otpMayStillBeVisible(page, '123456')).toBe(false);
    await page.close();
  }, 30000);

  // codex re-review (3rd pass): a HIDDEN input holding the WHOLE code must not trip the single-field scan
  // either — only a visible field can leak into a screenshot.
  it('fail-closed ignores a hidden full-code input (single-field visibility filter)', async () => {
    if (!available) return;
    const page = await browser!.newPage();
    await page.setContent(
      '<form><input id="otp" autocomplete="one-time-code" value="••••••">' +
        '<input type="hidden" name="otp_shadow" value="123456"></form>',
    );
    expect(await otpMayStillBeVisible(page, '123456')).toBe(false);
    // Sanity: a VISIBLE unmasked full-code field IS still caught.
    await page.setContent('<form><input id="otp2" value="123456"></form>');
    expect(await otpMayStillBeVisible(page, '123456')).toBe(true);
    await page.close();
  }, 30000);

  // codex finding 3: a non-OTP numeric field (ZIP) must NOT be redacted in the persisted/model-visible HTML,
  // even while an OTP is live — the broad numeric+maxlength heuristic is for transient screenshot masking only.
  it('captured HTML redacts the OTP field but keeps a non-OTP numeric field (ZIP)', async () => {
    if (!available) return;
    const page = await browser!.newPage();
    await page.setContent(
      `<form>` +
        `<input id="otp-code" name="code" autocomplete="one-time-code" maxlength="6" value="123456">` +
        `<input id="zip" name="zip" inputmode="numeric" maxlength="5" value="94105">` +
        `</form>`,
    );
    const html = await getPageContent(page, undefined, '123456');
    expect(html).not.toContain('123456'); // OTP redacted
    expect(html).toContain('94105');      // ZIP preserved (not treated as an OTP)
    await page.close();
  }, 30000);
});
