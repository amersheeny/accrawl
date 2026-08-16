// @vitest-environment jsdom
//
// Segmented-OTP redaction (screenshot DOM mask + HTML clone scrub) exercised against a REAL DOM (jsdom), so
// the actual browser-context JS that ships in page-utils runs — not a stub of it. A segmented OTP widget is
// one <input> per digit (auto-advancing), common on bank/2FA pages: the original single-input mask (an input
// whose .value CONTAINS the whole code) never fired for it, so the post-fill screenshot DOM and the captured
// HTML still carried the digits. These tests prove the segmented case is now masked for the screenshot and
// scrubbed from the HTML, that the real values are RESTORED after the screenshot (the crawl's submit reads the
// live code), that a SINGLE-input OTP still masks, and that an unrelated numeric field (an amount) is NOT
// touched.

import { describe, it, expect, vi, beforeAll } from 'vitest';

// takeScreenshot reaches sharp only after page.screenshot() resolves; stub it so the native binding isn't
// loaded and the screenshot path returns deterministically.
vi.mock('sharp', () => ({
  default: () => ({
    resize: () => ({ jpeg: () => ({ toBuffer: async () => Buffer.from('img') }) }),
  }),
}));

import type { Page } from 'playwright';

let takeScreenshot: typeof import('./page-utils').takeScreenshot;
let getPageContent: typeof import('./page-utils').getPageContent;

beforeAll(async () => {
  const mod = await import('./page-utils');
  takeScreenshot = mod.takeScreenshot;
  getPageContent = mod.getPageContent;
});

/**
 * Build a Playwright-shaped Page stub backed by the jsdom `document`, whose `evaluate(js)` actually RUNS the
 * production browser-context JS string against that live DOM (indirect eval in the jsdom global scope, where
 * `document`/`window`/`Map` are defined). This is what makes the test exercise the real mask/restore/clone code
 * rather than a re-implementation. The single jsdom document is shared by the main frame and "iframe-less"
 * stub — getPageContent in these tests has no extra frames.
 */
function jsdomPage(): Page {
  const evaluate = async (js: string) => {
    // Indirect eval → runs in global scope, so the script's `document` is jsdom's document.
    // eslint-disable-next-line no-eval
    const indirectEval = eval;
    return indirectEval(js);
  };
  const mainFrame = { evaluate };
  return {
    screenshot: async () => Buffer.from('img'),
    url: () => 'https://bank.example.com/otp',
    evaluate,
    mainFrame: () => mainFrame,
    frames: () => [mainFrame],
  } as unknown as Page;
}

/** Set the .value PROPERTY of an input (what an OTP fill / auto-advance widget does at runtime). */
function setInputValue(id: string, value: string): void {
  const el = document.getElementById(id) as HTMLInputElement;
  el.value = value;
}

/** Read the current .value property of an input (the live value the submit would read). */
function liveValue(id: string): string {
  return (document.getElementById(id) as HTMLInputElement).value;
}

/** A segmented form whose per-digit inputs hold the code only via the live .value PROPERTY (what a
 *  programmatic fill / JS auto-advance widget produces). Use for the screenshot-mask path, which reads the
 *  live property. */
const SEGMENTED_FORM = (digits: string[]) => `
  <form id="otp-form" action="/otp" method="post">
    <label>Enter the 6-digit code</label>
    ${digits.map((_, i) => `<input id="d${i}" name="d${i}" inputmode="numeric" maxlength="1" autocomplete="one-time-code">`).join('\n')}
    <button type="submit">Verify</button>
  </form>
`;

/** A segmented form whose per-digit inputs reflect the code into the value ATTRIBUTE (a controlled / SSR-style
 *  widget) — the genuine HTML leak vector: clone serialization emits the value attribute. Use for the HTML
 *  scrub path. */
const SEGMENTED_FORM_WITH_VALUE_ATTRS = (digits: string[]) => `
  <form id="otp-form" action="/otp" method="post">
    <label>Enter the 6-digit code</label>
    ${digits.map((d, i) => `<input id="d${i}" name="d${i}" inputmode="numeric" maxlength="1" value="${d}" autocomplete="one-time-code">`).join('\n')}
    <button type="submit">Verify</button>
  </form>
`;

describe('segmented OTP — screenshot DOM mask + restore', () => {
  it('masks every per-digit input for the screenshot, then restores the real digits (submit reads the live code)', async () => {
    document.body.innerHTML = SEGMENTED_FORM(['1', '2', '3', '4', '5', '6']);
    const digits = ['1', '2', '3', '4', '5', '6'];
    digits.forEach((d, i) => setInputValue(`d${i}`, d));

    const page = jsdomPage();
    const observedDuringShot: string[] = [];
    // Capture the masked DOM AT screenshot time: the stub's screenshot reads the live field values, which are
    // masked while the shot is taken and restored immediately after.
    (page as unknown as { screenshot: () => Promise<Buffer> }).screenshot = async () => {
      for (let i = 0; i < 6; i++) observedDuringShot.push(liveValue(`d${i}`));
      return Buffer.from('img');
    };

    await takeScreenshot(page, '123456');

    // During the screenshot the per-digit values were masked — no real digit visible.
    expect(observedDuringShot.join('')).not.toContain('123456');
    observedDuringShot.forEach((v) => expect(v).not.toMatch(/[0-9]/));
    // After the screenshot the real digits are back — the live submit value is never disturbed.
    expect([0, 1, 2, 3, 4, 5].map((i) => liveValue(`d${i}`)).join('')).toBe('123456');
  });
});

describe('segmented OTP — HTML clone scrub', () => {
  it('blanks the per-digit value attributes (the leak vector) in captured HTML, leaving the live DOM intact', async () => {
    // The widget reflects each digit into the value ATTRIBUTE — without redaction the serialized clone HTML
    // would carry value="1"…value="6". (Sanity: the un-redacted body proves the leak vector is real.)
    document.body.innerHTML = SEGMENTED_FORM_WITH_VALUE_ATTRS(['1', '2', '3', '4', '5', '6']);
    expect((document.body.innerHTML.match(/value="[0-9]"/g) || []).map((m) => m.replace(/\D/g, '')).join('')).toBe('123456');

    const page = jsdomPage();
    const html = await getPageContent(page, undefined, '123456');

    // The captured HTML carries none of the digits in any per-digit value.
    expect(html).not.toMatch(/value="[0-9]"/);
    // And the per-digit values can no longer reconstruct the OTP.
    expect((html.match(/value="[0-9]"/g) || []).join('')).toBe('');
    // The live DOM still holds the real digits (only the detached clone was scrubbed).
    expect([0, 1, 2, 3, 4, 5].map((i) => liveValue(`d${i}`)).join('')).toBe('123456');
  });

  it('also scrubs a segmented widget whose digits live only in the live .value property', async () => {
    // Defensive coverage: digits set via the property (no value attribute). The redaction mirrors the live
    // property onto the clone, detects, and blanks — so even if a serialization path emitted the property,
    // no digit survives. The live DOM is untouched.
    document.body.innerHTML = SEGMENTED_FORM(['1', '2', '3', '4', '5', '6']);
    ['1', '2', '3', '4', '5', '6'].forEach((d, i) => setInputValue(`d${i}`, d));

    const page = jsdomPage();
    const html = await getPageContent(page, undefined, '123456');

    // The redaction mirrors each live .value onto the clone attribute, then blanks the participating cells —
    // so no per-digit value attribute carrying a digit survives serialization.
    expect(html).not.toMatch(/value="[0-9]"/);
    expect([0, 1, 2, 3, 4, 5].map((i) => liveValue(`d${i}`)).join('')).toBe('123456');
  });
});

describe('single-input OTP — still masked (regression guard)', () => {
  it('masks a single OTP input for the screenshot and restores it after', async () => {
    document.body.innerHTML = `<form><input id="otp" name="code" maxlength="6"><button>Verify</button></form>`;
    setInputValue('otp', '482910');

    const page = jsdomPage();
    let valueAtShot = '';
    (page as unknown as { screenshot: () => Promise<Buffer> }).screenshot = async () => {
      valueAtShot = liveValue('otp');
      return Buffer.from('img');
    };

    await takeScreenshot(page, '482910');

    expect(valueAtShot).not.toContain('482910');
    expect(valueAtShot).not.toMatch(/[0-9]/); // masked to dots
    expect(liveValue('otp')).toBe('482910'); // restored for submit
  });

  it('scrubs a single OTP input value from captured HTML', async () => {
    document.body.innerHTML = `<form><input id="otp" name="code" value="482910"></form>`;
    const page = jsdomPage();
    const html = await getPageContent(page, undefined, '482910');
    expect(html).not.toContain('482910');
    expect(html).toContain('[OTP_REDACTED]');
  });
});

describe('segmented OTP — DEFECT-1: a hidden/invisible numeric input interleaved among the digit cells', () => {
  // A hidden numeric input spliced between the visible digit cells (d0,d1,<hidden value="0">,d2,d3,d4,d5)
  // would, without the candidate filter, join the contiguous window so the concatenation ("1209..." rather
  // than "123456") no longer equals the OTP — and the VISIBLE cells would NOT be masked/scrubbed → leak.
  // The detector now drops type="hidden" (and invisible) inputs BEFORE grouping, so the run still matches.
  // Two non-OTP-candidate numeric inputs are interleaved among the visible digit cells: a type="hidden" one
  // (d1,d2,<hidden>,d3) and a display:none one (d4,<display:none>,d5). Both must be excluded so the visible
  // cells d0..d5 still form the contiguous "123456" window.
  const FORM_WITH_INTERLEAVED_HIDDEN = `
    <form id="otp-form" action="/otp" method="post">
      <label>Enter the 6-digit code</label>
      <input id="d0" name="d0" inputmode="numeric" maxlength="1" value="1">
      <input id="d1" name="d1" inputmode="numeric" maxlength="1" value="2">
      <input id="h" name="hidden0" type="hidden" value="0">
      <input id="d2" name="d2" inputmode="numeric" maxlength="1" value="3">
      <input id="d3" name="d3" inputmode="numeric" maxlength="1" value="4">
      <input id="ninv" name="ninv" inputmode="numeric" maxlength="1" value="7" style="display:none">
      <input id="d4" name="d4" inputmode="numeric" maxlength="1" value="5">
      <input id="d5" name="d5" inputmode="numeric" maxlength="1" value="6">
      <button type="submit">Verify</button>
    </form>
  `;

  it('still MASKS every visible digit cell for the screenshot (the hidden cell is excluded from the window)', async () => {
    document.body.innerHTML = FORM_WITH_INTERLEAVED_HIDDEN;
    // Digits live in the live .value property (post auto-advance fill).
    ['1', '2', '3', '4', '5', '6'].forEach((d, i) => setInputValue(`d${i}`, d));
    setInputValue('h', '0');

    const page = jsdomPage();
    const observedDuringShot: string[] = [];
    (page as unknown as { screenshot: () => Promise<Buffer> }).screenshot = async () => {
      for (let i = 0; i < 6; i++) observedDuringShot.push(liveValue(`d${i}`));
      return Buffer.from('img');
    };

    await takeScreenshot(page, '123456');

    // Every visible digit cell was masked during the shot — no digit visible, code not reconstructable.
    expect(observedDuringShot.join('')).not.toContain('123456');
    observedDuringShot.forEach((v) => expect(v).not.toMatch(/[0-9]/));
    // Real digits restored afterwards (submit reads the live code).
    expect([0, 1, 2, 3, 4, 5].map((i) => liveValue(`d${i}`)).join('')).toBe('123456');
  });

  it('still SCRUBS every visible digit cell from captured HTML (hidden cell excluded from the window)', async () => {
    document.body.innerHTML = FORM_WITH_INTERLEAVED_HIDDEN;

    const page = jsdomPage();
    const html = await getPageContent(page, undefined, '123456');

    // None of the visible per-digit values (1..6) survive in the serialized HTML.
    expect(html).not.toMatch(/value="[1-6]"/);
    // The visible digits can no longer reconstruct the OTP.
    const surviving = (html.match(/value="[0-9]"/g) || []).map((m) => m.replace(/\D/g, '')).join('');
    expect(surviving).not.toContain('123456');
    expect(surviving).not.toMatch(/[1-6]/);
    // The live DOM still holds the real digits (only the detached clone was scrubbed).
    expect([0, 1, 2, 3, 4, 5].map((i) => liveValue(`d${i}`)).join('')).toBe('123456');
  });

  // DEFECT-1 (clone path): the interleaved numeric input is hidden by an ANCESTOR (display:none / visibility:
  // hidden), NOT by its own style and NOT type="hidden". In the no-layout HTML clone, offsetParent is null for
  // every element, so the layout-based ancestor check is useless — without an ancestor-chain walk the hidden
  // input stays a candidate, splices into the contiguous window ("12" + "0" + "3456" ≠ "123456"), segmented
  // detection misses, and the visible cells leak their per-digit value attributes into the captured HTML.
  // The detector now walks ancestors in the no-layout case and drops the cell under a hidden ancestor.
  const FORM_WITH_ANCESTOR_HIDDEN_DISPLAY = `
    <form id="otp-form" action="/otp" method="post">
      <label>Enter the 6-digit code</label>
      <input id="d0" name="d0" inputmode="numeric" maxlength="1" value="1">
      <input id="d1" name="d1" inputmode="numeric" maxlength="1" value="2">
      <div style="display:none"><span><input id="anc" name="anc" inputmode="numeric" maxlength="1" value="0"></span></div>
      <input id="d2" name="d2" inputmode="numeric" maxlength="1" value="3">
      <input id="d3" name="d3" inputmode="numeric" maxlength="1" value="4">
      <fieldset style="visibility:hidden"><input id="anc2" name="anc2" inputmode="numeric" maxlength="1" value="9"></fieldset>
      <input id="d4" name="d4" inputmode="numeric" maxlength="1" value="5">
      <input id="d5" name="d5" inputmode="numeric" maxlength="1" value="6">
      <button type="submit">Verify</button>
    </form>
  `;

  it('SCRUBS the segmented OTP from captured HTML when an interleaved numeric input is hidden by a display:none / visibility:hidden ANCESTOR (clone path)', async () => {
    document.body.innerHTML = FORM_WITH_ANCESTOR_HIDDEN_DISPLAY;
    // Sanity: the un-redacted body really does carry every visible per-digit value (the leak vector is real),
    // including the two ancestor-hidden interleaved cells (value="0", value="9").
    // Document order: d0=1, d1=2, anc=0 (ancestor display:none), d2=3, d3=4, anc2=9 (ancestor visibility:hidden), d4=5, d5=6.
    expect((document.body.innerHTML.match(/value="[0-9]"/g) || []).map((m) => m.replace(/\D/g, '')).join('')).toBe('12034956');

    const page = jsdomPage();
    const html = await getPageContent(page, undefined, '123456');

    // None of the VISIBLE per-digit OTP values (1..6) survive — the ancestor-hidden cells were excluded from the
    // window, so the contiguous "123456" run was detected and blanked.
    expect(html).not.toMatch(/value="[1-6]"/);
    const surviving = (html.match(/value="[0-9]"/g) || []).map((m) => m.replace(/\D/g, '')).join('');
    expect(surviving).not.toContain('123456');
    expect(surviving).not.toMatch(/[1-6]/);
    // The live DOM still holds the real digits (only the detached clone was scrubbed).
    expect([0, 1, 2, 3, 4, 5].map((i) => liveValue(`d${i}`)).join('')).toBe('123456');
  });
});

describe('non-OTP numeric field — NEVER masked', () => {
  it('leaves an unrelated short numeric field (an amount entry) untouched for the screenshot', async () => {
    // Two single-digit amount fields whose concat ("12") is NOT the OTP, plus the real OTP elsewhere.
    document.body.innerHTML = `
      <form id="pay">
        <label>Whole dollars</label><input id="dollars" value="4">
        <label>Cents</label><input id="cents" value="5">
      </form>
      ${SEGMENTED_FORM(['1', '2', '3', '4', '5', '6'])}
    `;
    ['1', '2', '3', '4', '5', '6'].forEach((d, i) => setInputValue(`d${i}`, d));
    setInputValue('dollars', '4');
    setInputValue('cents', '5');

    const page = jsdomPage();
    const masked: Record<string, string> = {};
    (page as unknown as { screenshot: () => Promise<Buffer> }).screenshot = async () => {
      masked.dollars = liveValue('dollars');
      masked.cents = liveValue('cents');
      return Buffer.from('img');
    };

    await takeScreenshot(page, '123456');

    // The amount fields (different form, concat "45" ≠ OTP) are never masked, during or after the shot.
    expect(masked.dollars).toBe('4');
    expect(masked.cents).toBe('5');
    expect(liveValue('dollars')).toBe('4');
    expect(liveValue('cents')).toBe('5');
    // The OTP cells WERE restored after masking.
    expect([0, 1, 2, 3, 4, 5].map((i) => liveValue(`d${i}`)).join('')).toBe('123456');
  });

  it('does not scrub an unrelated amount from captured HTML', async () => {
    document.body.innerHTML = `<form><input id="amount" name="amount" value="45"></form>`;
    const page = jsdomPage();
    const html = await getPageContent(page, undefined, '123456'); // OTP not present on page
    expect(html).toContain('value="45"'); // the amount is preserved
  });
});
