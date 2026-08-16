import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';

// Short, deterministic bounds so the hang tests resolve under fake timers
// without depending on the production defaults.
process.env.SCREENSHOT_TIMEOUT_MS = '1000';
process.env.CONTENT_EVAL_TIMEOUT_MS = '1000';

// sharp is only reached if page.screenshot() resolves; the hang tests never get
// there. Stub it so importing page-utils has no native-binding side effects.
vi.mock('sharp', () => ({
  default: () => ({
    resize: () => ({
      jpeg: () => ({
        toBuffer: async () => Buffer.from('img'),
      }),
    }),
  }),
}));

import type { Page } from 'playwright';

// Imported dynamically in beforeAll so the env overrides above are in effect
// when the module reads its timeout constants.
let takeScreenshot: typeof import('./page-utils').takeScreenshot;
let getPageContent: typeof import('./page-utils').getPageContent;
let getCurrentUrl: typeof import('./page-utils').getCurrentUrl;
let redactOtpFromHtml: typeof import('./page-utils').redactOtpFromHtml;
let OTP_REDACTION_PLACEHOLDER: typeof import('./page-utils').OTP_REDACTION_PLACEHOLDER;

beforeAll(async () => {
  const mod = await import('./page-utils');
  takeScreenshot = mod.takeScreenshot;
  getPageContent = mod.getPageContent;
  getCurrentUrl = mod.getCurrentUrl;
  redactOtpFromHtml = mod.redactOtpFromHtml;
  OTP_REDACTION_PLACEHOLDER = mod.OTP_REDACTION_PLACEHOLDER;
});

afterEach(() => {
  vi.useRealTimers();
});

const noopLogger = {
  log: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  getLines: () => [],
};

/** A Page stub whose screenshot hangs forever. */
function pageWithHangingScreenshot(): Page {
  return {
    screenshot: () => new Promise(() => {}),
    url: () => 'https://example.com',
  } as unknown as Page;
}

/** A Page stub whose main-frame evaluate hangs forever. */
function pageWithHangingMainEvaluate(): Page {
  const mainFrame = { evaluate: () => new Promise(() => {}) };
  return {
    evaluate: () => new Promise(() => {}),
    mainFrame: () => mainFrame,
    frames: () => [mainFrame],
  } as unknown as Page;
}

/** A Page stub whose main frame is fine but one iframe evaluate hangs. */
function pageWithHangingIframe(): Page {
  const mainFrame = {
    evaluate: async () => '<div>main</div>',
  };
  const hangingFrame = {
    evaluate: () => new Promise(() => {}),
    url: () => 'https://iframe.example.com',
  };
  return {
    evaluate: async () => '<div>main</div>',
    mainFrame: () => mainFrame,
    frames: () => [mainFrame, hangingFrame],
  } as unknown as Page;
}

describe('redactOtpFromHtml (DEFECT-2: scrub a live filled OTP from captured HTML)', () => {
  it('replaces the exact OTP digit run with the placeholder', () => {
    const html = '<input id="otp" value="482910"><div>Balance 482910 is unrelated text</div>';
    const out = redactOtpFromHtml(html, '482910');
    expect(out).not.toContain('482910');
    expect(out).toContain(OTP_REDACTION_PLACEHOLDER);
  });
  it('also scrubs grouped renderings the field may echo (space / hyphen separated)', () => {
    expect(redactOtpFromHtml('<input value="123 456">', '123456')).not.toContain('123 456');
    expect(redactOtpFromHtml('<input value="123-456">', '123456')).not.toContain('123-456');
  });
  it('is a no-op when there is no OTP to redact (the common capture path)', () => {
    const html = '<input value="hello"><div>1234</div>';
    expect(redactOtpFromHtml(html, null)).toBe(html);
    expect(redactOtpFromHtml(html, undefined)).toBe(html);
    expect(redactOtpFromHtml(html, '')).toBe(html);
  });
  it('still scrubs when the code is handed to it with surrounding whitespace/separators (normalized to digits)', () => {
    // The old guard `!/^\d+$/.test(otp)` rejected these outright, leaving the live code in the HTML. An LLM
    // extraction can hand us " 482910"/"482910\n"/"48-29-10"; all must reduce to the digit run and scrub.
    expect(redactOtpFromHtml('<input value="482910">', ' 482910')).not.toContain('482910');
    expect(redactOtpFromHtml('<input value="482910">', '482910\n')).not.toContain('482910');
    expect(redactOtpFromHtml('<input value="482910">', '48-29-10')).not.toContain('482910');
  });
  it('scrubs a code rendered with a newline/tab between digit groups (codex finding 2), without mass-redacting', () => {
    // A grouped rendering separated by a NEWLINE (not just a space) must still scrub: `\s` covers it.
    expect(redactOtpFromHtml('<div>123\n456</div>', '123456')).not.toContain('123');
    expect(redactOtpFromHtml('<div>123\t456</div>', '123456')).toContain(OTP_REDACTION_PLACEHOLDER);
    // But the SINGLE-separator bound must NOT let the code span unrelated content (no greedy \D*): digits of the
    // code scattered across a paragraph of real text are left alone.
    const prose = '<p>Call 1 person, buy 2 apples, wait 3 days, read 4 books, run 5 miles, sleep 6 hours.</p>';
    expect(redactOtpFromHtml(prose, '123456')).toBe(prose);
  });
});

describe('takeScreenshot OTP masking (DEFECT-2: keep the visible code out of the screenshot)', () => {
  /** A page+frame stub that records evaluate() calls so we can assert mask→restore ran. */
  function pageWithOtpInput(initialValue: string) {
    const calls: string[] = [];
    let storedValue = initialValue; // simulates the input's live value across mask/restore
    const evaluate = async (js: string) => {
      calls.push(js);
      if (js.includes("setAttribute('data-otp-orig'")) {
        // mask
        if (storedValue.includes('482910')) storedValue = '•'.repeat(storedValue.length);
        return 1;
      }
      if (js.includes("getAttribute('data-otp-orig')")) {
        // restore
        storedValue = initialValue;
        return undefined;
      }
      return undefined;
    };
    const mainFrame = { evaluate };
    const page = {
      screenshot: async () => Buffer.from('img'),
      url: () => 'https://example.com',
      evaluate,
      mainFrame: () => mainFrame,
      frames: () => [mainFrame],
    } as unknown as Page;
    return { page, calls, liveValue: () => storedValue };
  }

  it('masks the OTP input for the screenshot then RESTORES the live value (submit reads the real code)', async () => {
    const { page, calls, liveValue } = pageWithOtpInput('482910');
    await takeScreenshot(page, '482910');
    // Both a mask and a restore evaluate ran.
    expect(calls.some((c) => c.includes("setAttribute('data-otp-orig'"))).toBe(true);
    expect(calls.some((c) => c.includes("getAttribute('data-otp-orig')"))).toBe(true);
    // The live value is back to the real code after the screenshot — the crawl's submit is never disturbed.
    expect(liveValue()).toBe('482910');
  });

  it('does NOT touch the DOM when no OTP is supplied (normal capture path)', async () => {
    const { page, calls } = pageWithOtpInput('482910');
    await takeScreenshot(page); // no maskOtp
    expect(calls.length).toBe(0);
  });

  // DEFECT-2 (CRAWL-BREAKER): the live OTP fields must be RESTORED on EVERY exit path. The restore must run
  // even when the screenshot step itself rejects/times out — otherwise the fields stay bullet-masked and the
  // subsequent submit reads the mask, FAILING the bank login. Restore lives in the OUTERMOST finally around
  // the timed screenshot, so a screenshot rejection still un-masks before takeScreenshot returns/throws.
  it('RESTORES the live OTP value even when the screenshot step REJECTS (submit must read the real code)', async () => {
    const { page, calls, liveValue } = pageWithOtpInput('482910');
    // Make the screenshot reject — simulates a screenshot error or a withTimeout rejection on a hung shot.
    (page as unknown as { screenshot: () => Promise<Buffer> }).screenshot = async () => {
      throw new Error('screenshot exploded');
    };
    // takeScreenshot propagates the screenshot failure (capture-level recovery handles it)...
    await expect(takeScreenshot(page, '482910')).rejects.toThrow(/screenshot exploded/);
    // ...but restore STILL ran: the mask was applied, then un-masked in the finally.
    expect(calls.some((c) => c.includes("setAttribute('data-otp-orig'"))).toBe(true);
    expect(calls.some((c) => c.includes("getAttribute('data-otp-orig')"))).toBe(true);
    // The live field holds the REAL OTP again — the strand-the-mask crawl-breaker is gone.
    expect(liveValue()).toBe('482910');
  });

  it('RESTORES the live OTP value even when the screenshot TIMES OUT (hang bounded by withTimeout)', async () => {
    vi.useFakeTimers();
    const { page, calls, liveValue } = pageWithOtpInput('482910');
    // Screenshot hangs forever; the inner withTimeout('takeScreenshot') must reject and the outer finally
    // must still un-mask the field.
    (page as unknown as { screenshot: () => Promise<Buffer> }).screenshot = () => new Promise(() => {});
    const promise = takeScreenshot(page, '482910');
    const assertion = expect(promise).rejects.toThrow(/timed out/i);
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
    // Field restored to the real code despite the timeout — no bullet-mask stranded for the submit.
    expect(calls.some((c) => c.includes("getAttribute('data-otp-orig')"))).toBe(true);
    expect(liveValue()).toBe('482910');
  });
});

describe('takeScreenshot bounded', () => {
  it('rejects within the timeout instead of hanging when screenshot never resolves', async () => {
    vi.useFakeTimers();
    const promise = takeScreenshot(pageWithHangingScreenshot());
    const assertion = expect(promise).rejects.toThrow(/timed out/i);
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
  });
});

describe('getPageContent bounded', () => {
  it('throws when the main-frame evaluate hangs (so capture-level recovery can kick in)', async () => {
    vi.useFakeTimers();
    const promise = getPageContent(pageWithHangingMainEvaluate());
    const assertion = expect(promise).rejects.toThrow(/getPageContent\.mainFrame.*timed out/i);
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
  });

  it('skips a hanging iframe (logs + continues) instead of failing the whole capture', async () => {
    vi.useFakeTimers();
    const promise = getPageContent(pageWithHangingIframe(), noopLogger);
    // Advance past the iframe evaluate timeout so the skip path runs.
    await vi.advanceTimersByTimeAsync(1000);
    const html = await promise;
    expect(html).toContain('main');
    expect(html).not.toContain('iframe.example.com');
    expect(noopLogger.warn).toHaveBeenCalled();
  });
});

describe('browser URL redaction', () => {
  it('removes credentials, query, and fragment from the current page URL', () => {
    const credential = 'page-credential';
    const querySecret = 'page-query';
    const fragmentSecret = 'page-fragment';
    const safe = getCurrentUrl({
      url: () =>
        `https://user:${credential}@bank.example/callback?code=${querySecret}#token=${fragmentSecret}`,
    } as unknown as Page);

    expect(safe.startsWith('https://bank.example/callback')).toBe(true);
    expect(safe.includes(credential)).toBe(false);
    expect(safe.includes(querySecret)).toBe(false);
    expect(safe.includes(fragmentSecret)).toBe(false);
    expect(safe.includes('?')).toBe(false);
    expect(safe.includes('#')).toBe(false);
  });

  it('removes query and fragment secrets from iframe model context', async () => {
    const querySecret = 'iframe-query';
    const fragmentSecret = 'iframe-fragment';
    const mainFrame = { evaluate: async () => '<main>safe</main>' };
    const iframe = {
      evaluate: async () => '<section>frame</section>',
      url: () =>
        `https://frame.bank.example/authorize?code=${querySecret}#token=${fragmentSecret}`,
    };
    const html = await getPageContent({
      evaluate: async () => '<main>safe</main>',
      mainFrame: () => mainFrame,
      frames: () => [mainFrame, iframe],
    } as unknown as Page);

    expect(html.includes(querySecret)).toBe(false);
    expect(html.includes(fragmentSecret)).toBe(false);
    expect(html.includes('?')).toBe(false);
    expect(html.includes('#')).toBe(false);
    expect(html.includes('https://frame.bank.example/authorize')).toBe(true);
  });
});
