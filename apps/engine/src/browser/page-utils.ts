/**
 * Page Utilities
 *
 * Helper functions for Playwright page operations:
 * screenshots, waiting for stability, and content extraction.
 */

import type { Page } from 'playwright';
import sharp from 'sharp';
import { withTimeout } from '../utils/with-timeout';
import type { SessionLogger } from '../utils/logger';
import {
  safeBrowserUrl,
  safeBrowserUrlsInText,
} from '../utils/safe-browser-url';

/** Max width for screenshots. Height scales proportionally (uncapped for fullPage). */
const SCREENSHOT_MAX_WIDTH = 800;
/** JPEG quality after resize — model only needs text readability. */
const SCREENSHOT_JPEG_QUALITY = 40;

/** Bound for page.screenshot() + sharp processing. Env-overridable. */
const SCREENSHOT_TIMEOUT_MS = Number(process.env.SCREENSHOT_TIMEOUT_MS ?? '25000');
/** Bound for each page.evaluate()/frame.evaluate() — evaluate has no native timeout. */
const CONTENT_EVAL_TIMEOUT_MS = Number(process.env.CONTENT_EVAL_TIMEOUT_MS ?? '20000');

/** Placeholder substituted for a live OTP/2FA secret in any captured artifact (HTML or a masked DOM value)
 *  before it is persisted or sent to the model. The real code never leaves the field it was filled into. */
export const OTP_REDACTION_PLACEHOLDER = '[OTP_REDACTED]';

/**
 * The digits of an OTP secret, with ALL non-digits (whitespace, hyphens, the separators a grouped rendering or
 * a sloppy LLM extraction can carry) stripped. Every redaction path matches on THIS, never on the raw string.
 *
 * WHY (confirmed leak): the mask used to test `input.value.includes(rawCode)`. The engine types the code via
 * `keyboard.type` into a `maxlength`-bounded field, and the code handed to the mask comes from an LLM
 * extraction — so the field's `.value` ("133336") and the mask's `code` (" 133336", a trailing space) routinely
 * differ by formatting. The bank accepts `code.trim()` so the login still succeeds, but `"133336".includes(" 133336")`
 * is false, the mask masked NOTHING, and the live OTP rendered into the persisted screenshot. Comparing digits-only,
 * in BOTH directions (field-contains-code OR code-contains-field, the latter covering a maxlength-clipped field),
 * removes that whole class of silent misses. */
export function otpDigits(code: string | null | undefined): string {
  return (code ?? '').replace(/\D/g, '');
}

/**
 * Browser-context predicate: does this `<input>` look like a one-time-code / 2FA field? Used as a SECOND,
 * content-independent mask trigger so that while an OTP is live we redact a plausible OTP field even if the
 * code we were handed doesn't match its value at all (e.g. the extraction returned a differently-formatted or
 * outright wrong code). Over-masking here is harmless — the value is restored right after the screenshot — while
 * under-masking leaks a live 2FA secret. Signals: autocomplete="one-time-code", a numeric inputmode on a short
 * maxlength field, or an id/name/aria-label naming it a code/otp/2fa/verification field. */
const OTP_FIELD_IDENTITY_FN = `
  // STRICT (high precision): autocomplete="one-time-code", or an id/name/aria-label that NAMES the field a
  // code/otp/2fa/verification field. Safe for PERSISTED redaction — it won't hit a generic ZIP/phone/PIN/CVV.
  function __accrawlOtpFieldStrict(el) {
    try {
      var ac = ((el.getAttribute && el.getAttribute('autocomplete')) || '').toLowerCase();
      if (ac.indexOf('one-time-code') !== -1) return true;
      var hay = (((el.id || '') + ' ' + (el.name || '') + ' ' +
        ((el.getAttribute && el.getAttribute('aria-label')) || '')) || '').toLowerCase();
      if (/otp|2fa|mfa|one.?time|\\botc\\b|passcode|pass.?code|verif|security.?code|auth.?code|\\btoken\\b/.test(hay)) return true;
      return false;
    } catch (e) { return false; }
  }
  // BROAD (higher recall): strict OR a bare numeric/tel box on a short maxlength (an OTP field with no naming).
  // Use ONLY for the TRANSIENT screenshot mask — it is restored right after the shot, so over-masking a ZIP/PIN
  // there is harmless. NEVER use it for persisted HTML: it would wrongly redact a ZIP/PIN/CVV the model may need.
  function __accrawlLooksOneTimeCode(el) {
    try {
      if (__accrawlOtpFieldStrict(el)) return true;
      var im = ((el.getAttribute && el.getAttribute('inputmode')) || '').toLowerCase();
      var ml = parseInt((el.getAttribute && el.getAttribute('maxlength')) || '0', 10);
      if ((im === 'numeric' || im === 'tel') && ml > 0 && ml <= 10) return true;
      return false;
    } catch (e) { return false; }
  }
`;

/**
 * Browser-context detector for a SEGMENTED OTP widget — one `<input>` per digit, auto-advancing (common on
 * bank/2FA pages). The single-input mask (an input whose `.value` CONTAINS the whole code) misses these: the
 * six digits live in six separate fields, so neither the screenshot DOM mask nor the contiguous-string HTML
 * scrub catches the code.
 *
 * Defines a function `__accrawlFindOtpSegInputs(code, root)` in the page context that returns the array of
 * `<input>` elements which TOGETHER hold the OTP. Algorithm (content-based, never throws):
 *  - Collect "digit cells": inputs whose current value is a short numeric run (length 1–3, digits only),
 *    EXCLUDING non-OTP-candidate controls — `type="hidden"` inputs and (where layout is observable, i.e. the
 *    live DOM, not a detached clone) inputs that aren't visible. A hidden numeric input interleaved among the
 *    visible digit cells would otherwise land inside the contiguous window, the concatenation would no longer
 *    equal the OTP, and the visible cells would NOT be masked — the code would leak. So those controls are
 *    dropped BEFORE grouping/window-matching.
 *  - Group them by their nearest `form`/`fieldset` container (fall back to a single document-order group), so
 *    an unrelated digit field elsewhere on the page can't be spliced into the run.
 *  - Within each group, in DOCUMENT order, slide a window: find the shortest CONTIGUOUS run of cells whose
 *    concatenated values EQUAL or CONTAIN the OTP. Those cells are the participating inputs.
 *
 * Inlined (not imported) into the mask JS and the HTML-clone redaction JS so the SAME detection drives both
 * the screenshot mask and the HTML scrub. Returns `[]` on anything unexpected — masking/redaction is
 * best-effort hardening and must never break a capture or the crawl.
 */
const OTP_SEGMENTED_DETECT_FN = `
  function __accrawlStyleHides(style) {
    // True when a computed/inline style block hides the element (and therefore its subtree).
    return !!(style && (style.display === 'none' || style.visibility === 'hidden'));
  }
  function __accrawlAncestorHiddenNoLayout(el, win) {
    // No-layout (detached clone / jsdom) ancestor-hidden check: offsetParent is null for EVERY element here, so
    // it can't tell hidden from visible. Instead walk the ANCESTOR chain and exclude the element if any ancestor
    // is hidden by inline OR computed display:none / visibility:hidden — a hidden ancestor hides its subtree, so
    // an interleaved numeric input under one must NOT be treated as a visible OTP digit cell. Inline style is
    // checked first (always present on a clone); computed style is checked too where getComputedStyle works.
    try {
      var node = el.parentElement || (el.parentNode && el.parentNode.nodeType === 1 ? el.parentNode : null);
      while (node) {
        // Inline style (survives cloneNode and needs no layout).
        var inline = node.style;
        if (inline && (inline.display === 'none' || inline.visibility === 'hidden')) return true;
        // Computed style where available (jsdom resolves the style attribute; a real no-layout context resolves
        // what it can). Best-effort — guarded so a getComputedStyle hiccup never drops a real cell.
        try {
          var cs = (win && win.getComputedStyle) ? win.getComputedStyle(node) : null;
          if (__accrawlStyleHides(cs)) return true;
        } catch (e2) { /* ignore — fall through to the next ancestor */ }
        node = node.parentElement || (node.parentNode && node.parentNode.nodeType === 1 ? node.parentNode : null);
      }
    } catch (e) { /* fail open — don't drop a cell we couldn't evaluate */ }
    return false;
  }
  function __accrawlIsOtpCandidate(el) {
    // Reject controls that can never be a VISIBLE OTP digit cell, so they can't be spliced into the run:
    //  - type="hidden" inputs — attribute-based, reliable on the live DOM AND a detached clone.
    //  - inputs hidden via display:none / visibility:hidden on their OWN computed style — reliable wherever a
    //    window with getComputedStyle exists (real Chromium and jsdom both).
    //  - inputs hidden by a display:none / visibility:hidden ANCESTOR. With LAYOUT (live DOM) this is detectable
    //    via offsetParent === null. WITHOUT layout (jsdom, or the detached HTML clone) offsetParent is null for
    //    EVERY element — visible or not — so we instead walk the ancestor chain and exclude on an inline/computed
    //    hidden ancestor. Without this, an interleaved numeric input under a display:none ANCESTOR stays in the
    //    candidate window in the clone path, breaks segmented detection, and the visible cells leak into the HTML.
    try {
      var typeAttr = ((el.getAttribute && el.getAttribute('type')) || '').toLowerCase();
      if (typeAttr === 'hidden') return false;
      var doc = el.ownerDocument;
      var win = doc && doc.defaultView;
      var style = (win && win.getComputedStyle) ? win.getComputedStyle(el) : null;
      // Own-style invisibility — reliable everywhere computed style is available.
      if (__accrawlStyleHides(style)) return false;
      // Ancestor-hidden / detached. The document root having client rects is the cross-environment "layout
      // exists" signal (true in Chromium, false in jsdom and for a detached clone).
      var connected = (typeof el.isConnected === 'boolean') ? el.isConnected : true;
      var root = doc && doc.documentElement;
      var layoutComputed = !!(connected && root && root.getClientRects && root.getClientRects().length > 0);
      if (layoutComputed) {
        // Layout-based (live DOM): offsetParent === null means hidden by an ancestor or detached.
        if (el.offsetParent === null && (!style || style.position !== 'fixed')) return false;
      } else {
        // No-layout (clone / jsdom): offsetParent is useless — walk ancestors for a hidden one instead.
        if (__accrawlAncestorHiddenNoLayout(el, win)) return false;
      }
      return true;
    } catch (e) {
      // If we can't evaluate visibility, don't drop the cell — failing open preserves redaction coverage.
      return true;
    }
  }
  function __accrawlFindOtpSegInputs(code, root) {
    try {
      if (!code || code.length < 4 || !/^[0-9]+$/.test(code)) return [];
      var scope = root || document;
      var inputs = Array.prototype.slice.call(scope.querySelectorAll('input'));
      // Keep document order (querySelectorAll already yields it) and isolate short digit-only cells.
      var cells = [];
      for (var i = 0; i < inputs.length; i++) {
        var el = inputs[i];
        // Skip non-OTP-candidate controls (hidden / invisible) BEFORE they can join the contiguous window.
        if (!__accrawlIsOtpCandidate(el)) continue;
        // Read the value from the live .value property when present, else the value attribute — the screenshot
        // mask runs on the live DOM (property), the HTML scrub runs on a clone (attribute mirrored from live).
        var raw = (typeof el.value === 'string' && el.value)
          ? el.value
          : ((el.getAttribute && el.getAttribute('value')) || '');
        var v = raw.trim();
        // Accept 1–3 digit cells: OTP widgets split into single digits, pairs, OR two 3-digit groups
        // ("123" "456"). Only a contiguous run whose concatenation CONTAINS the code is masked (below), so a
        // longer cell can't cause a spurious mask — it must actually spell the live code with its neighbours.
        if (v.length >= 1 && v.length <= 3 && /^[0-9]+$/.test(v)) cells.push({ el: el, v: v });
      }
      if (cells.length < 2) return []; // a single cell is the single-input case, handled elsewhere
      // Bucket cells by nearest form/fieldset so a stray numeric field elsewhere can't join the run.
      var groups = new Map();
      for (var j = 0; j < cells.length; j++) {
        var c = cells[j];
        var container = c.el.closest ? (c.el.closest('form, fieldset') || scope) : scope;
        if (!groups.has(container)) groups.set(container, []);
        groups.get(container).push(c);
      }
      var result = [];
      groups.forEach(function (groupCells) {
        if (result.length) return; // first matching group wins
        // Slide a contiguous window over the group's cells (document order) for the shortest run
        // whose concatenated digits EQUAL or CONTAIN the OTP.
        for (var start = 0; start < groupCells.length && !result.length; start++) {
          var concat = '';
          for (var end = start; end < groupCells.length; end++) {
            concat += groupCells[end].v;
            if (concat.indexOf(code) !== -1) {
              for (var k = start; k <= end; k++) result.push(groupCells[k].el);
              break;
            }
            if (concat.length >= code.length) break; // window already as long as the code, no match — advance start
          }
        }
      });
      return result;
    } catch (e) {
      return [];
    }
  }
`;

/**
 * Redact a known secret (the live OTP we just filled) from a captured HTML string before it is persisted or
 * sent to the model. After an OTP fill, the value lands in the input's serialized `value` attribute, so the
 * captured DOM HTML would otherwise carry the live 2FA code to the model and into any persisted snapshot.
 *
 * We replace the exact digit string AND its common grouped renderings (a space- or hyphen-separated form some
 * inputs echo back, e.g. "123 456") with a placeholder. This is a defensive string scrub layered on top of
 * the DOM value-masking done for the screenshot — together they stop the visible code from leaving the field.
 * No-op when there's no secret (the overwhelmingly common case), so non-OTP captures are unaffected.
 */
export function redactOtpFromHtml(html: string, otp: string | null | undefined): string {
  const codeN = otpDigits(otp); // digits only — a code handed to us with a stray space/newline must still scrub
  if (codeN.length < 4) return html; // nothing to redact / not a digit code
  // Match the code's digits in order, allowing an OPTIONAL single whitespace-or-hyphen between any two of them,
  // so every grouped rendering a field/markup might echo is caught: "123456", "123 456", "12-34-56",
  // "123\n456", "1 2 3 4 5 6", etc. `\s` (not a bare space) covers newline/tab/non-breaking-space. Kept to a
  // SINGLE optional separator on purpose — a greedy `\D*` would span unrelated content and mass-redact the page.
  const pattern = new RegExp(codeN.split('').join('[\\s\\-]?'), 'g');
  return html.replace(pattern, OTP_REDACTION_PLACEHOLDER);
}

/**
 * Take a screenshot and return as compressed base64 JPEG string.
 * Captures fullPage at CSS scale, then resizes width to SCREENSHOT_MAX_WIDTH
 * and re-encodes at lower JPEG quality to keep payload small.
 *
 * Bounded: page.screenshot() gets an explicit timeout, and the whole function
 * (including sharp processing) is wrapped in withTimeout as a backstop so a
 * stuck capture or hung sharp call can never consume the crawl budget.
 *
 * SECURITY (OTP): when `maskOtp` is the live 2FA code we just filled, any input whose current value contains
 * it has its value DOM-masked to dots for the duration of the screenshot, then restored. This stops the
 * visible code from being captured into the persisted/model-visible screenshot WITHOUT removing it from the
 * field the subsequent submit reads — the live submit value is never disturbed. Masking is best-effort: a
 * restore failure (e.g. the page navigated away) is tolerated, since a navigated-away field is gone anyway.
 *
 * CRITICAL ordering: the mask/restore brackets ONLY the timed screenshot, and the restore lives in the
 * OUTERMOST finally around that timed step. If the restore lived inside `withTimeout`'s raced promise instead,
 * an outer timeout could reject (returning to the caller) BEFORE the inner finally ran restore — leaving the
 * live OTP fields bullet-masked, so the subsequent submit would read the mask and FAIL the bank login. By
 * putting restore in a finally that wraps the `withTimeout` call itself, a screenshot timeout/error/hang
 * (the hang is bounded by withTimeout, which then rejects) ALWAYS runs restore before we return or throw.
 */
/**
 * FAIL-CLOSED verification: is the live OTP still rendered in ANY input on the page or its frames AFTER masking?
 * Returns true when the code's digits still appear in some input's value (mask missed it) OR when a frame can't
 * be evaluated at all (we cannot prove it's clean). Digit-only comparison, both directions — matches the mask.
 * A `true` return tells takeScreenshot to suppress the capture rather than persist a screenshot that leaks a
 * live 2FA secret. Never throws — an outright failure is treated as "might be visible" (fail closed). */
export async function otpMayStillBeVisible(page: Page, codeDigits: string): Promise<boolean> {
  if (codeDigits.length < 4) return false;
  // MUST start with `(() =>` — a `function`/param-leading evaluate string is misparsed (see maskJs). Fail closed
  // if the check itself can't run: treat "couldn't verify" as "might be visible".
  const checkJs = `
    (() => {
      ${OTP_SEGMENTED_DETECT_FN}
      var codeN = ${JSON.stringify(codeDigits)};
      try {
        var inputs = document.querySelectorAll('input');
        for (var i = 0; i < inputs.length; i++) {
          // Only a VISIBLE field can leak into a screenshot — skip type=hidden / display:none / ancestor-hidden
          // (a hidden shadow/backup input holding the whole code must NOT cause a spurious suppression).
          if (!__accrawlIsOtpCandidate(inputs[i])) continue;
          var v = inputs[i].value;
          if (typeof v !== 'string' || !v) continue;
          var vn = v.replace(/\\D/g, '');
          // Single/large field: direct digit overlap in either direction.
          if (vn.length >= 4 && (vn.indexOf(codeN) !== -1 || codeN.indexOf(vn) !== -1)) return true;
        }
        // Segmented widget: the code lives across per-digit/per-group cells (each too short to match alone).
        // Use the SAME visibility-aware, form-grouped, contiguous-window detector the mask uses — it fires only
        // on a VISIBLE run of digit cells whose concatenation contains the code. That both catches a
        // still-unmasked segmented code AND avoids a spurious suppression from stray hidden/unrelated short
        // inputs (a naive concat-everything check would false-positive on those — codex flagged both).
        if (__accrawlFindOtpSegInputs(codeN, document).length > 0) return true;
        return false;
      } catch (e) { return true; }
    })()
  `;
  const frames: Array<{ evaluate: typeof page.evaluate }> = [page];
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    frames.push(frame);
  }
  for (const f of frames) {
    try {
      const visible = await withTimeout(f.evaluate(checkJs) as Promise<boolean>, CONTENT_EVAL_TIMEOUT_MS, 'otpMayStillBeVisible');
      if (visible) return true;
    } catch {
      // Couldn't evaluate this frame (cross-origin / detached / hung) — we cannot prove the code isn't shown. Fail closed.
      return true;
    }
  }
  return false;
}

export async function takeScreenshot(page: Page, maskOtp?: string | null, log?: SessionLogger): Promise<string> {
  // Mask the live OTP fields, then bracket the (timed) screenshot so restore is GUARANTEED on every exit path
  // — success, screenshot error, or a withTimeout rejection. restore() itself never throws (see maskOtpInputs).
  const restore = await maskOtpInputs(page, maskOtp, log);
  let buffer: Buffer;
  try {
    // FAIL-CLOSED (OTP): before capturing, confirm the live code is not still rendered anywhere. If masking
    // couldn't be verified clean (still present, or a frame we couldn't evaluate), SUPPRESS this screenshot
    // rather than emit/persist one that leaks a live 2FA secret. '' → the caller writes no screenshot this step.
    const codeDigits = otpDigits(maskOtp);
    if (codeDigits.length >= 4 && (await otpMayStillBeVisible(page, codeDigits))) {
      log?.warn('[PageUtils] OTP redaction not verified clean — suppressing this screenshot (fail-closed)');
      return '';
    }
    buffer = await withTimeout(
      page.screenshot({
        type: 'jpeg',
        quality: 60,
        fullPage: true,
        scale: 'css',
        timeout: SCREENSHOT_TIMEOUT_MS,
      }),
      SCREENSHOT_TIMEOUT_MS,
      'takeScreenshot',
    );
  } finally {
    // OUTERMOST finally around the timed screenshot: runs even on timeout/error so the live OTP fields are
    // un-masked before control leaves this function. Best-effort — restore() swallows its own failures.
    await restore();
  }
  // sharp processing runs after restore() — the mask is already gone, so a slow/hung sharp call can never
  // strand the OTP fields. Bound it so it can't consume the crawl budget either.
  return withTimeout(
    (async () => {
      const compressed = await sharp(buffer)
        .resize({ width: SCREENSHOT_MAX_WIDTH, withoutEnlargement: true })
        .jpeg({ quality: SCREENSHOT_JPEG_QUALITY })
        .toBuffer();
      return compressed.toString('base64');
    })(),
    SCREENSHOT_TIMEOUT_MS,
    'takeScreenshot.compress',
  );
}

/**
 * For the duration of a screenshot, mask any input whose value equals/contains the live OTP, returning a
 * restore() that puts the original values back. Operates on the main frame and every accessible iframe (OTP
 * fields are sometimes inside a provider iframe). Returns a no-op restore when there's nothing to mask, so
 * the common non-OTP screenshot path is untouched. NEVER throws — masking is best-effort security hardening,
 * not a correctness requirement, and must never break a capture or the crawl.
 */
export async function maskOtpInputs(page: Page, otp?: string | null, log?: SessionLogger): Promise<() => Promise<void>> {
  const codeDigits = otpDigits(otp);
  if (codeDigits.length < 4) return async () => {};
  // The DOM op, masking (tagging each element with data-otp-orig so the one restore path puts every field back)
  // any input that could render the live code:
  //  1. DIGIT OVERLAP — the input's digits and the code's digits overlap in EITHER direction (field-contains-code
  //     OR code-contains-field, the latter for a maxlength-clipped field). Digit-only so formatting can't dodge it.
  //  2. FIELD IDENTITY — a plausible one-time-code field holding a short digit value, even if it doesn't match the
  //     code we were handed (covers a wrong/differently-formatted extraction). Restored right after, so harmless.
  //  3. SEGMENTED widget — one input per digit; __accrawlFindOtpSegInputs returns the participating cells.
  // Each masked input's value becomes a same-length dot mask. Returns the count masked. Swallow-safe per element
  // AND overall (the whole body is wrapped so a detector hiccup never breaks the capture).
  // CRITICAL: the evaluated string MUST start with `(() =>` so Playwright treats it as an expression to run. A
  // string that starts with `function` (which is how this looked when it began with the interpolated detector
  // declarations) is misparsed by page.evaluate as a function DEFINITION — it throws `SyntaxError: Unexpected
  // identifier`, the per-frame catch below swallows it, and the mask silently masks NOTHING (the live OTP then
  // renders into the screenshot — the exact leak this function exists to prevent). So the helper declarations
  // live INSIDE the arrow IIFE, never at the top of the string. (buildCloneScript follows the same rule.)
  const maskJs = `
    (() => {
      ${OTP_SEGMENTED_DETECT_FN}
      ${OTP_FIELD_IDENTITY_FN}
      var codeN = ${JSON.stringify(codeDigits)};
      var n = 0;
      var dot = function (s) { return '\\u2022'.repeat(Math.max(1, (s || '').length)); };
      var mask = function (el) {
        if (el.hasAttribute('data-otp-orig')) return;
        el.setAttribute('data-otp-orig', el.value);
        el.value = dot(el.value);
        n++;
      };
      try {
        document.querySelectorAll('input').forEach(function (el) {
          try {
            if (typeof el.value !== 'string' || !el.value) return;
            var valN = el.value.replace(/\\D/g, '');
            var digitMatch = codeN.length >= 4 && valN.length >= 4 &&
              (valN.indexOf(codeN) !== -1 || codeN.indexOf(valN) !== -1);
            var identityMatch = valN.length >= 4 && __accrawlLooksOneTimeCode(el);
            if (digitMatch || identityMatch) mask(el);
          } catch (e) { /* ignore a single hostile element */ }
        });
        var segInputs = __accrawlFindOtpSegInputs(codeN, document);
        for (var i = 0; i < segInputs.length; i++) {
          try { mask(segInputs[i]); } catch (e) { /* ignore a single hostile element */ }
        }
      } catch (e) { /* detector/query failed — fall back to whatever was masked so far */ }
      return n;
    })()
  `;
  const restoreJs = `
    (() => {
      document.querySelectorAll('input[data-otp-orig]').forEach(el => {
        try { el.value = el.getAttribute('data-otp-orig'); el.removeAttribute('data-otp-orig'); } catch (e) {}
      });
    })()
  `;
  const framesToTouch: Array<{ evaluate: typeof page.evaluate }> = [page];
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    framesToTouch.push(frame);
  }
  for (let fi = 0; fi < framesToTouch.length; fi++) {
    try {
      await withTimeout(framesToTouch[fi].evaluate(maskJs) as Promise<number>, CONTENT_EVAL_TIMEOUT_MS, 'maskOtpInputs');
    } catch (maskErr) {
      // A cross-origin/detached/hung frame legitimately can't be masked — but a failure on the MAIN frame is how
      // this mask silently no-op'd for so long (a mis-parsed evaluate string threw and was swallowed). NEVER
      // swallow it: surface it so a regression is visible. Security is still enforced downstream — takeScreenshot's
      // fail-closed check suppresses the capture if the live code remains visible after this returns.
      log?.warn(`[PageUtils] OTP mask evaluate failed on frame ${fi}${fi === 0 ? ' (MAIN)' : ''}:`, maskErr);
    }
  }
  return async () => {
    for (const f of framesToTouch) {
      try {
        await withTimeout(f.evaluate(restoreJs) as Promise<void>, CONTENT_EVAL_TIMEOUT_MS, 'restoreOtpInputs');
      } catch (restoreErr) {
        // Best-effort: a restore failure must NEVER throw past (that would strand the caller mid-finally), but
        // it IS surfaced — a navigated-away/detached frame has no field left to restore (benign), whereas a
        // failure on a still-live frame would leave the OTP field masked for the submit and must be visible.
        log?.warn('[PageUtils] OTP restore failed for a frame (field may stay masked if still live):', restoreErr);
      }
    }
  };
}

/**
 * Wait for page to stabilize (network idle + short delay).
 */
export async function waitForStability(page: Page, timeoutMs = 10_000): Promise<void> {
  try {
    await page.waitForLoadState('networkidle', { timeout: timeoutMs });
  } catch {
    // Network may never be fully idle on some sites; that's OK
  }
  // Small delay for JS rendering
  await page.waitForTimeout(500);
}

/**
 * Browser-context JS to strip provably-useless content from a DOM clone.
 * Each item removed is content the model cannot use:
 * - SVG: vector path data is unreadable; the screenshot shows rendered icons
 * - data: URIs: model can't decode base64 image data
 * - Event handlers: JavaScript strings, not CSS-queryable
 *
 * Everything the model needs is preserved: id, name, type, href, placeholder,
 * value, role, aria-label, class, data-* attributes, style, text content.
 */
const STRIP_USELESS_CONTENT_JS = `
  clone.querySelectorAll('script, style, noscript, iframe, svg').forEach(el => el.remove());
  clone.querySelectorAll('[src]').forEach(el => {
    var src = el.getAttribute('src');
    if (src && src.startsWith('data:')) el.setAttribute('src', '[data-uri]');
  });
  var eventAttrs = ['onclick','onchange','onsubmit','onmouseover','onfocus','onblur','onkeydown','onkeyup','onload','onerror','oninput','onscroll','onresize'];
  clone.querySelectorAll('*').forEach(el => {
    for (var i = 0; i < eventAttrs.length; i++) el.removeAttribute(eventAttrs[i]);
  });
`;

/**
 * Browser-context URL scrubbing for the detached DOM clone returned to the
 * model. URL-bearing attributes can contain OAuth codes, session identifiers,
 * signed-object credentials, or account identifiers in userinfo/query/fragment
 * components. Keep only the location needed to understand the page:
 * origin+path for web/socket URLs, a safe internal-browser path, or just the
 * scheme for opaque URLs.
 *
 * This intentionally runs on `clone`, never the live document: links and form
 * actions keep their original values for the real browser interaction.
 */
const SANITIZE_BROWSER_URLS_CLONE_JS = `
  var __accrawlUrlAttrs = [
    'action', 'archive', 'background', 'cite', 'codebase', 'data', 'formaction',
    'href', 'icon', 'itemid', 'longdesc', 'manifest', 'poster', 'profile', 'src',
    'usemap', 'xlink:href'
  ];
  var __accrawlSafeUrl = function(raw) {
    if (typeof raw !== 'string' || !raw) return '';
    try {
      var parsed = new URL(raw, document.baseURI);
      if (
        parsed.protocol === 'http:'
        || parsed.protocol === 'https:'
        || parsed.protocol === 'ws:'
        || parsed.protocol === 'wss:'
      ) {
        return parsed.origin + parsed.pathname;
      }
      if (parsed.protocol === 'about:') return 'about:' + parsed.pathname;
      if (
        parsed.protocol === 'chrome:'
        || parsed.protocol === 'chrome-error:'
        || parsed.protocol === 'devtools:'
      ) {
        return parsed.protocol + '//' + parsed.host + parsed.pathname;
      }
      return parsed.protocol;
    } catch (e) {
      return '';
    }
  };
  var __accrawlAbsoluteUrlPattern = /(?:https?|wss?|ftp|file|blob|data|mailto|tel):[^\\s<>"'\\x60]+|(?<!:)\\/\\/[^\\s<>"'\\x60]+/giu;
  var __accrawlRelativeUrlPattern = /(^|[\\s([{:;,="' ])((?:(?:\\/|\\.{1,2}\\/)[^\\s<>"'\\x60?#]*)?[?#][^\\s<>"'\\x60]+)/giu;
  var __accrawlSafeRelativeUrls = function(text) {
    return text.replace(__accrawlRelativeUrlPattern, function(_whole, prefix, url) {
      return prefix + __accrawlSafeUrl(url);
    });
  };
  clone.querySelectorAll('*').forEach(el => {
    Array.from(el.attributes).forEach(attr => {
      var name = attr.name.toLowerCase();
      var value = attr.value;
      if (!value) return;

      if (name === 'srcset' || name === 'imagesrcset') {
        // The srcset grammar permits commas inside data URLs, so splitting it
        // with a delimiter regex can accidentally reinterpret opaque payload
        // pieces as relative paths. The screenshot already carries the chosen
        // image; the model never needs a source-set value or selector.
        el.setAttribute(attr.name, '[url-set]');
        return;
      }

      if (name === 'ping') {
        el.setAttribute(
          attr.name,
          value.split(/\\s+/).filter(Boolean).map(__accrawlSafeUrl).filter(Boolean).join(' ')
        );
        return;
      }

      if (name === 'style') {
        el.setAttribute(
          attr.name,
          value.replace(/url\\(\\s*(["']?)(.*?)\\1\\s*\\)/giu, function(_whole, quote, url) {
            return 'url(' + quote + __accrawlSafeUrl(url) + quote + ')';
          }).replace(__accrawlAbsoluteUrlPattern, __accrawlSafeUrl)
        );
        return;
      }

      if (
        __accrawlUrlAttrs.indexOf(name) !== -1
        || /(?:^|[-_:])(url|uri|href|src|action|redirect|return|callback|endpoint)(?:$|[-_:])/i.test(name)
        || /^(?:[a-z][a-z0-9+.-]*:|\\/\\/)/i.test(value.trim())
      ) {
        el.setAttribute(attr.name, __accrawlSafeUrl(value.trim()));
      }
    });

    if (
      el.tagName === 'META'
      && /refresh/i.test(el.getAttribute('http-equiv') || '')
      && el.hasAttribute('content')
    ) {
      var refresh = el.getAttribute('content') || '';
      var refreshMatch = refresh.match(/^(\\s*\\d+(?:\\.\\d+)?\\s*;\\s*)(?:url\\s*=\\s*)?([\\s\\S]+)$/i);
      if (refreshMatch) {
        var refreshTarget = refreshMatch[2].trim();
        if (
          (refreshTarget.startsWith('"') && refreshTarget.endsWith('"'))
          || (refreshTarget.startsWith("'") && refreshTarget.endsWith("'"))
        ) {
          refreshTarget = refreshTarget.slice(1, -1);
        }
        el.setAttribute('content', refreshMatch[1] + 'url=' + __accrawlSafeUrl(refreshTarget));
      } else {
        el.setAttribute(
          'content',
          __accrawlSafeRelativeUrls(
            refresh.replace(__accrawlAbsoluteUrlPattern, __accrawlSafeUrl)
          )
        );
      }
    }
  });
  var __accrawlTextWalker = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT);
  var __accrawlTextNode;
  while ((__accrawlTextNode = __accrawlTextWalker.nextNode())) {
    __accrawlTextNode.nodeValue = __accrawlSafeRelativeUrls(
      (__accrawlTextNode.nodeValue || '').replace(
        __accrawlAbsoluteUrlPattern,
        __accrawlSafeUrl
      )
    );
  }
`;

/**
 * Browser-context JS to blank the `value` of a SEGMENTED OTP widget's per-digit inputs on the DOM clone
 * (`clone`) before it is serialized. The string scrub `redactOtpFromHtml` only catches a CONTIGUOUS code (the
 * single-input case); in a segmented widget the digits live in separate `value` attributes, so no contiguous
 * substring of the serialized HTML equals the OTP. Here we run the SAME detector used by the screenshot mask
 * against the clone and blank each participating input's serialized value (attribute + property), so the code
 * never survives in the captured HTML. Operates on the detached clone only — the live field the submit reads
 * is untouched. Wrapped so a detector hiccup never breaks the capture; no-op when no segmented widget matches.
 *
 * Reads each input's value from the live `.value` property OR the `value` attribute (a clone may carry either),
 * so it matches whichever form the digit landed in.
 */
const REDACT_SEGMENTED_OTP_CLONE_JS = `
  ${OTP_SEGMENTED_DETECT_FN}
  ${OTP_FIELD_IDENTITY_FN}
  try {
    if (typeof __ACCRAWL_OTP_CODE__ === 'string' && __ACCRAWL_OTP_CODE__) {
      // cloneNode(true) copies the value ATTRIBUTE but not the live .value PROPERTY (the form a programmatic
      // fill / auto-advance widget leaves the digit in), and serialization emits the attribute. So mirror each
      // live input's current .value onto the matching clone input's value attribute first. The live tree and
      // its deep clone enumerate inputs in identical document order (STRIP removes only script/style/svg/
      // iframe/noscript — never inputs), so a positional pairing is exact. This also makes the detector see
      // the same digits the serializer would emit.
      var liveInputs = document.querySelectorAll('input');
      var cloneInputs = clone.querySelectorAll('input');
      var pairCount = Math.min(liveInputs.length, cloneInputs.length);
      for (var p = 0; p < pairCount; p++) {
        try {
          var lv = (typeof liveInputs[p].value === 'string') ? liveInputs[p].value : '';
          if (lv) cloneInputs[p].setAttribute('value', lv);
        } catch (e) {}
      }
      // Detect the segmented widget on the clone (now carrying the live digits) and blank every participating
      // cell's serialized value. Single-input/contiguous codes are still handled by the string scrub.
      var segInputs = __accrawlFindOtpSegInputs(__ACCRAWL_OTP_CODE__, clone);
      for (var s = 0; s < segInputs.length; s++) {
        try { segInputs[s].setAttribute('value', ''); segInputs[s].value = ''; } catch (e) {}
      }
      // Field-identity net: redact any single clone input that is STRICTLY an OTP field (named otp/2fa/… or
      // autocomplete=one-time-code) and carries a short digit value, even if it didn't string-match the code —
      // covers a single-input OTP whose value we were handed in a form the contiguous-string scrub can't match
      // (odd/wrong extraction). STRICT (not the broad numeric+maxlength heuristic) because this is PERSISTED,
      // model-visible HTML: the broad rule would wrongly redact a ZIP/PIN/CVV the model may need. Write the
      // PLACEHOLDER (not blank) so the result is consistent with the string scrub's output. Clone-only.
      var cloneInputsAll = clone.querySelectorAll('input');
      for (var q = 0; q < cloneInputsAll.length; q++) {
        try {
          var cv = cloneInputsAll[q].getAttribute('value') || '';
          if (cv.replace(/[^0-9]/g, '').length >= 4 && __accrawlOtpFieldStrict(cloneInputsAll[q])) {
            cloneInputsAll[q].setAttribute('value', __ACCRAWL_OTP_PLACEHOLDER__);
            cloneInputsAll[q].value = __ACCRAWL_OTP_PLACEHOLDER__;
          }
        } catch (e) {}
      }
    }
  } catch (e) { /* best-effort: leave the contiguous-string scrub to catch what it can */ }
`;

/** Build the clone-and-strip browser script, optionally with the segmented-OTP clone redaction wired in.
 *  `otp` is embedded as a string literal the clone redaction reads; null/absent skips that pass entirely
 *  (the common non-OTP capture path is byte-for-byte the original script). */
function buildCloneScript(otp?: string | null): string {
  const codeN = otpDigits(otp); // digits only — a code with a stray space/newline must still drive clone redaction
  const otpLiteral = codeN.length >= 4 ? JSON.stringify(codeN) : 'null';
  const segRedaction = otpLiteral === 'null' ? '' : REDACT_SEGMENTED_OTP_CLONE_JS;
  return `
    (() => {
      var __ACCRAWL_OTP_CODE__ = ${otpLiteral};
      var __ACCRAWL_OTP_PLACEHOLDER__ = ${JSON.stringify(OTP_REDACTION_PLACEHOLDER)};
      var clone = document.body.cloneNode(true);
      ${STRIP_USELESS_CONTENT_JS}
      ${SANITIZE_BROWSER_URLS_CLONE_JS}
      ${segRedaction}
      return clone.innerHTML;
    })()
  `;
}

/**
 * Post-process HTML string to remove remaining noise:
 * - HTML comments (not in DOM, not visible, not selectable)
 * - Excessive whitespace (multiple spaces/newlines → single space)
 */
function cleanHtmlString(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, '').replace(/\s{2,}/g, ' ');
}

/**
 * Get page HTML content (sanitized — non-content elements removed).
 * Includes iframe content inline so the model can see form elements inside iframes.
 *
 * Strips provably-useless content (SVGs, data URIs, event handlers, comments,
 * excessive whitespace) while preserving all attributes and text the model needs
 * for CSS selectors and data extraction.
 *
 * SECURITY (OTP): `redactOtp`, when set to the live 2FA code we just filled, scrubs that code from the
 * returned HTML. Two layers, together covering both widget shapes: (1) the per-digit `value` attributes of a
 * SEGMENTED widget are blanked on the DOM clone before serialization (the code isn't contiguous in the HTML,
 * so a string scrub can't reach it); (2) the contiguous SINGLE-input code is string-scrubbed out of the
 * serialized result. The input's serialized `value` would otherwise carry the live 2FA code to the model and
 * into persisted snapshots. No-op when unset — the normal capture path is unaffected.
 */
export async function getPageContent(page: Page, log?: SessionLogger, redactOtp?: string | null): Promise<string> {
  // Build the clone script once — embeds the segmented-OTP clone redaction only when redactOtp is a live code,
  // so the common non-OTP path runs the byte-for-byte original strip script.
  const cloneScript = buildCloneScript(redactOtp);

  // Main frame content — evaluate() has no native timeout, so bound it. A hang
  // here is unrecoverable in place, so let it throw to capture-level recovery.
  const mainHtml = await withTimeout(
    page.evaluate(cloneScript) as Promise<string>,
    CONTENT_EVAL_TIMEOUT_MS,
    'getPageContent.mainFrame',
  );

  // Collect iframe content — one hung/cross-origin iframe must not kill the
  // whole capture, so bound each evaluate and skip (log + continue) on failure.
  const iframeHtmlParts: string[] = [];
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    const frameUrl = safeBrowserUrl(frame.url());
    try {
      const frameHtml = await withTimeout(
        frame.evaluate(cloneScript) as Promise<string>,
        CONTENT_EVAL_TIMEOUT_MS,
        `getPageContent.iframe(${frameUrl})`,
      );
      if (typeof frameHtml === 'string' && frameHtml.length > 10) {
        iframeHtmlParts.push(`\n[IFRAME: ${frameUrl}]\n${frameHtml}`);
      }
    } catch (frameErr) {
      // Cross-origin, detached, or hung frame — skip but surface the reason.
      log?.warn(`[PageUtils] Skipping iframe ${frameUrl} during content capture:`, frameErr);
    }
  }

  const cleanHtml = cleanHtmlString(mainHtml + iframeHtmlParts.join(''));
  // Defense in depth for absolute URLs emitted as text by unusual/custom
  // elements or by a mocked/non-DOM capture implementation. Standard and
  // relative URL-bearing attributes are already scrubbed on the DOM clone.
  return redactOtpFromHtml(safeBrowserUrlsInText(cleanHtml), redactOtp);
}

/**
 * Get the current page URL.
 */
export function getCurrentUrl(page: Page): string {
  return safeBrowserUrl(page.url());
}

/**
 * Enumerate visible interactive elements on the page (inputs, buttons, links).
 * Returns a concise list of selectors the AI agent can use to pick alternatives.
 * Searches main frame and all iframes.
 */
export async function getVisibleInteractiveElements(page: Page): Promise<string> {
  const collectFromFrame = async (frame: { evaluate: typeof page.evaluate }, label: string) => {
    try {
      return await frame.evaluate((frameLabel: string) => {
        const results: string[] = [];
        const els = Array.from(document.querySelectorAll('input, button, select, textarea, a[href]'));
        for (const el of els) {
          const htmlEl = el as HTMLElement;
          const rect = htmlEl.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) continue;
          const style = window.getComputedStyle(htmlEl);
          if (style.visibility === 'hidden' || style.display === 'none') continue;
          if (htmlEl.offsetParent === null && style.position !== 'fixed') continue;
          const tag = el.tagName.toLowerCase();
          const type = el.getAttribute('type') || '';
          const id = el.id ? `#${el.id}` : '';
          const name = el.getAttribute('name') ? `[name="${el.getAttribute('name')}"]` : '';
          const placeholder = el.getAttribute('placeholder') ? `[placeholder="${el.getAttribute('placeholder')}"]` : '';
          const text = htmlEl.textContent?.trim().substring(0, 80) || '';
          const selector = id || name || placeholder || `${tag}${type ? `[type="${type}"]` : ''}`;
          results.push(`${frameLabel}${tag}${type ? `[${type}]` : ''}: ${selector} ${text ? `"${text}"` : ''}`);
        }
        return results;
      }, label);
    } catch {
      return [];
    }
  };

  const mainElements = await collectFromFrame(page, '');
  const frameElements: string[] = [];
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    const els = await collectFromFrame(frame, `[iframe] `);
    frameElements.push(...els);
  }

  const all = [...mainElements, ...frameElements];
  return all.length > 0 ? all.slice(0, 2000).join('\n') : 'No visible interactive elements found';
}
