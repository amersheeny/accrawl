// @vitest-environment jsdom
//
// DEFECT-2 regression (OTP correctness): capturePageState must NEVER abandon the live-DOM OTP mask/restore.
//
// takeScreenshot masks the live OTP fields, screenshots, then RESTORES them in its own finally. If that restore
// were run inside capturePageState's OUTER abandonable withTimeout (the ~45s backstop), an outer-timeout
// rejection could return to the caller while a slow restore was still in flight — leaving the live OTP fields
// bullet-masked, so the subsequent submit would read dots and FAIL the bank login.
//
// The fix awaits takeScreenshot UN-RACED (it owns its own internal bounds), and wraps ONLY the HTML capture
// (which mutates a detached clone, nothing live to unwind) in the outer abandonable timeout. So even when the
// OUTER capture timeout fires, the OTP field is already restored before capturePageState settles.
//
// This test forces the OUTER timeout to fire (the HTML-capture page.evaluate hangs forever, with a tiny
// CAPTURE_TIMEOUT_MS) while a SLOW restore runs inside the injected screenshot fn, and asserts the live field
// holds the REAL OTP the instant capturePageState settles. TEETH: if takeScreenshot were moved back inside the
// raced promise, the outer timeout would fire mid-restore and the field would still be masked at settle time.

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import type { Page } from 'playwright';

const REAL_OTP = '123456';
const MASK = '•'.repeat(REAL_OTP.length);
/** Outer capture backstop, set tiny so the hung HTML capture trips it fast. */
const OUTER_TIMEOUT_MS = 50;
/** Restore delay > OUTER_TIMEOUT_MS: under the buggy (raced) structure the outer timeout would fire BEFORE
 *  this restore completed, stranding the field masked. Under the fix it is awaited un-raced, so it always
 *  completes before the outer timeout (which only wraps the later HTML capture) can fire. */
const SLOW_RESTORE_MS = 200;

let capturePageState: typeof import('./agent-loop').capturePageState;

beforeAll(async () => {
  process.env.CAPTURE_TIMEOUT_MS = String(OUTER_TIMEOUT_MS);
  const mod = await import('./agent-loop');
  capturePageState = mod.capturePageState;
});

afterAll(() => {
  delete process.env.CAPTURE_TIMEOUT_MS;
});

/** Read the live value the submit would read from the masked field. */
function liveValue(id: string): string {
  return (document.getElementById(id) as HTMLInputElement).value;
}

/**
 * Page stub whose `evaluate` (used by getPageContent — the HTML capture) HANGS FOREVER, so capturePageState's
 * OUTER withTimeout is guaranteed to fire. frames() returns just the main frame.
 */
function hangingHtmlCapturePage(): Page {
  const evaluate = () => new Promise<never>(() => {}); // never resolves → forces the outer timeout
  const mainFrame = { evaluate, url: () => 'https://bank.example.com/otp' };
  return {
    evaluate,
    url: () => 'https://bank.example.com/otp',
    mainFrame: () => mainFrame,
    frames: () => [mainFrame],
  } as unknown as Page;
}

/**
 * Stand-in for the real takeScreenshot's live-DOM contract: mask the OTP field NOW, then run a SLOW restore on
 * the way out (mirroring takeScreenshot's `finally { await restore() }`). Awaited un-raced by capturePageState,
 * so this whole thing — including the slow restore — must complete before the HTML capture (and thus the outer
 * timeout) even begins.
 */
function maskThenSlowRestoreScreenshot(fieldId: string) {
  return async (_page: Page, maskOtp?: string | null): Promise<string> => {
    const el = document.getElementById(fieldId) as HTMLInputElement;
    if (maskOtp && el.value.includes(maskOtp)) {
      el.value = MASK; // masked for the (notional) shot
    }
    try {
      return 'screenshot-base64';
    } finally {
      // Slow restore — the exact window DEFECT-2 was about. Must finish before capturePageState settles.
      await new Promise((r) => setTimeout(r, SLOW_RESTORE_MS));
      el.value = REAL_OTP;
    }
  };
}

describe('capturePageState — DEFECT-2: OTP restore is never abandoned by the outer capture timeout', () => {
  it('restores the real OTP before settling, even when the OUTER capture timeout fires during a slow restore', async () => {
    document.body.innerHTML = `<form><input id="otp" name="code" value="${REAL_OTP}"></form>`;
    expect(liveValue('otp')).toBe(REAL_OTP);

    const page = hangingHtmlCapturePage();

    // The outer timeout (HTML capture hangs) makes capturePageState reject — that's expected and fine. What
    // matters is the field state at settle time.
    await expect(
      capturePageState(page, undefined, REAL_OTP, maskThenSlowRestoreScreenshot('otp')),
    ).rejects.toThrow(/capturePageState.*timed out/);

    // The instant capturePageState settled, the live field already holds the REAL OTP — the slow restore was
    // awaited un-raced (it could not be abandoned by the outer timeout). A submit now reads the real code.
    expect(liveValue('otp')).toBe(REAL_OTP);
  });

  it('also holds when the HTML capture succeeds — restore runs before the HTML capture begins', async () => {
    document.body.innerHTML = `<form><input id="otp" name="code" value="${REAL_OTP}"></form>`;

    // A page whose HTML capture resolves quickly. The injected screenshot fn records the field value the moment
    // the HTML capture starts — proving restore already completed (ordering guarantee), not just by the end.
    let valueWhenHtmlCaptureStarted = '';
    const evaluate = async () => {
      valueWhenHtmlCaptureStarted = liveValue('otp');
      return '<html></html>';
    };
    const mainFrame = { evaluate, url: () => 'https://bank.example.com/otp' };
    const page = {
      evaluate,
      url: () => 'https://bank.example.com/otp',
      mainFrame: () => mainFrame,
      frames: () => [mainFrame],
    } as unknown as Page;

    const state = await capturePageState(page, undefined, REAL_OTP, maskThenSlowRestoreScreenshot('otp'));

    // Restore completed BEFORE the HTML capture began (takeScreenshot is awaited un-raced, fully ahead of it).
    expect(valueWhenHtmlCaptureStarted).toBe(REAL_OTP);
    // And the field still holds the real OTP after the whole capture.
    expect(liveValue('otp')).toBe(REAL_OTP);
    expect(state.screenshotBase64).toBe('screenshot-base64');
  });
});
