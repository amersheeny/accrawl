/**
 * Action Executor
 *
 * Executes AI agent actions on the Playwright page.
 * Handles credential substitution — the AI uses placeholders (USERNAME, PASSWORD, DOB,
 * PHONE, OTP_CODE) and this module substitutes real values.
 */

import type { Page, Locator } from 'playwright';
import type { CrawlRequest } from '../types';
import type { ExecutableStepResponse } from '../ai/schema';
import { waitForStability } from '../browser/page-utils';
import { ActionError } from './errors';
import { assertSafeNavigationUrl, assertConnectedAddressIsPublic } from '../utils/url-safety';
import type { SessionLogger } from '../utils/logger';
import { safeBrowserUrl } from '../utils/safe-browser-url';

/** Result metadata from executing an action — discriminated union on status */
export type ActionResult =
  | { status: 'success'; matchCount: number }
  | { status: 'fallback'; matchCount: number; clickMethod: 'force' | 'jsClick'; normalClickError: string };

type ClickMethod = 'normal' | 'force' | 'jsClick';

interface LocatorResult {
  locator: Locator;
  matchCount: number;
  /** The full (non-`.first()`) locator in the context that matched — used to
   *  disambiguate multi-matches by visibility before giving up. */
  base: Locator;
}

/**
 * Find a locator by selector, searching the main page first then all iframes.
 * Many bank login forms are embedded in iframes — this ensures we find elements
 * regardless of frame context.
 * Returns both the locator and the match count so callers can detect ambiguous selectors.
 */
async function findLocator(page: Page, selector: string, log?: SessionLogger): Promise<LocatorResult> {
  // Try main page first
  const mainBase = page.locator(selector);
  const mainLocator = mainBase.first();
  try {
    await mainLocator.waitFor({ state: 'attached', timeout: 2_000 });
    const matchCount = await mainBase.count();
    if (matchCount > 1) {
      (log ?? console).log(`[Actions] Selector "${selector}" matched ${matchCount} elements`);
    }
    return { locator: mainLocator, matchCount, base: mainBase };
  } catch {
    // Not in main frame — search iframes
  }

  const frames = page.frames();
  for (const frame of frames) {
    if (frame === page.mainFrame()) continue;
    const frameBase = frame.locator(selector);
    const frameLocator = frameBase.first();
    try {
      await frameLocator.waitFor({ state: 'attached', timeout: 2_000 });
      const matchCount = await frameBase.count();
      (log ?? console).log(
        `[Actions] Found "${selector}" in iframe: ${safeBrowserUrl(frame.url())}${matchCount > 1 ? ` (${matchCount} matches)` : ''}`,
      );
      return { locator: frameLocator, matchCount, base: frameBase };
    } catch {
      // Not in this frame
    }
  }

  throw new ActionError('selector_not_found', `No element found matching "${selector}" in any frame`);
}

/**
 * Attempt a single click method on an element.
 */
async function attemptClick(
  element: Locator,
  method: ClickMethod,
  selector: string,
  log?: SessionLogger,
): Promise<void> {
  switch (method) {
    case 'normal':
      await element.click({ timeout: 10_000 });
      return;
    case 'force':
      (log ?? console).log(`[Actions] Normal click failed on "${selector}", trying force click`);
      await element.click({ force: true, timeout: 5_000 });
      return;
    case 'jsClick':
      (log ?? console).log(`[Actions] Force click failed on "${selector}", trying el.click()`);
      await element.evaluate((el: HTMLElement) => el.click());
      return;
  }
}

/**
 * Build a valid CSS id selector. Plain `#id` is INVALID when the id starts with
 * a digit or contains CSS-special characters — one brokerage's ui-grid cells look like
 * `1781799904576-0-uiGrid-02BW-cell` — so fall back to an [id="..."] attribute
 * selector in those cases, which has no such restriction.
 * Exported (and re-inlined in browser context) so the generated selectors and
 * the disambiguation suggestions agree.
 */
export function idSelector(id: string): string {
  return /^[A-Za-z][\w-]*$/.test(id) ? `#${id}` : `[id="${id.replace(/"/g, '\\"')}"]`;
}

/**
 * Generate a guaranteed-unique CSS selector for a DOM element using :nth-of-type().
 * Walks up the tree until it hits an element with an id (a unique anchor) or the
 * <body> root. Crucially the path is ANCHORED — it always reaches an id or
 * `body`, never a bare relative path. A relative path like
 * `ul:nth-of-type(2) > li:nth-of-type(1)` is NOT unique: nth-of-type is relative
 * to siblings, so without a root anchor it re-matches every same-positioned
 * element anywhere in the document (this is what made a real site's export selectors
 * ambiguous). Exported for testing — also inlined in evaluateAll browser context.
 */
export function generateUniqueSelector(el: Element): string {
  const parts: string[] = [];
  let current: Element | null = el;
  while (current && current.tagName !== 'HTML') {
    if (current.id) {
      parts.unshift(idSelector(current.id));
      return parts.join(' > ');
    }
    if (current.tagName === 'BODY') {
      parts.unshift('body');
      break;
    }
    const tag = current.tagName.toLowerCase();
    let nth = 1;
    let sib = current.previousElementSibling;
    while (sib) {
      if (sib.tagName === current.tagName) nth++;
      sib = sib.previousElementSibling;
    }
    parts.unshift(`${tag}:nth-of-type(${nth})`);
    current = current.parentElement;
  }
  return parts.join(' > ');
}

/** Credential placeholders used by the AI agent */
export const CREDENTIAL_PLACEHOLDERS: Record<string, keyof Pick<CrawlRequest, 'username' | 'password' | 'dob' | 'phone'>> = {
  USERNAME: 'username',
  PASSWORD: 'password',
  DOB: 'dob',
  PHONE: 'phone',
};

/**
 * Execute a single agent action on the page.
 * Only handles browser actions (click, fill, select, wait, scroll, navigate).
 * Terminal actions (loginComplete, complete, error) and data extraction are
 * handled directly by the agent loop.
 */
export async function executeAction(
  page: Page,
  action: ExecutableStepResponse,
  credentials: Pick<CrawlRequest, 'username' | 'password' | 'dob' | 'phone'>,
  otpCode?: string,
  log?: SessionLogger
): Promise<ActionResult> {
  switch (action.action) {
    case 'click': {
      if (!action.selector) throw new ActionError('missing_field', 'click action requires a "selector" field — you omitted it');
      const { locator: element, matchCount, base } = await findLocator(page, action.selector, log);

      // Ambiguous selector — don't guess. Hand the model rich, accurate context
      // for EACH match so it can pick the right one and click it directly:
      //   • a short signature (tag / id / classes / intent attrs / text),
      //   • whether it is VISIBLE,
      //   • its containing menu/panel and that container's OPEN/CLOSED state —
      //     some sites render the "Export to Excel" <li> inside EVERY menu; only the
      //     one whose menu is display:block actually exports,
      //   • a genuinely-unique, valid selector to copy verbatim.
      // The model decides (LLM-first) — we never auto-pick a match for it.
      if (matchCount > 1) {
        const MAX_SUGGESTIONS = 30;
        // NOTE: everything inside evaluateAll is INLINED with no nested named
        // functions. tsx/esbuild's keepNames wraps named functions in a `__name`
        // helper that does NOT exist in the page context, so a nested
        // `const foo = () => …` here throws "ReferenceError: __name is not
        // defined" at runtime. Keep this in sync with generateUniqueSelector /
        // idSelector above (which the JSDOM unit tests cover).
        const uniqueSelectors = await base.evaluateAll((nodes, max) => {
          const out: string[] = [];
          const limit = Math.min(nodes.length, max);
          const ATTRS = ['ng-click', 'role', 'aria-label', 'href', 'type', 'name', 'data-testid', 'title'];
          for (let i = 0; i < limit; i++) {
            const el = nodes[i];
            // --- signature of the matched element ---
            let s = el.tagName.toLowerCase();
            if (el.id) s += '#' + el.id;
            if (el.classList && el.classList.length) s += '.' + Array.from(el.classList).join('.');
            for (const attr of ATTRS) {
              const v = el.getAttribute(attr);
              if (v) s += '[' + attr + '="' + v + '"]';
            }
            const text = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 30);
            if (text) s += ' "' + text + '"';
            // --- visibility ---
            const cv = (el as Element & { checkVisibility?: () => boolean }).checkVisibility;
            const visible = typeof cv === 'function' ? cv.call(el) : (el as HTMLElement).offsetParent !== null;
            // --- nearest meaningful container (menu/dropdown/dialog/panel, id'd,
            //     or inline display) annotated OPEN/CLOSED ---
            let container = '';
            let a: Element | null = el.parentElement;
            let depth = 0;
            while (a && a.tagName !== 'BODY' && depth < 12) {
              const cls = (a.className && a.className.toString()) || '';
              const display = ((a as HTMLElement).style && (a as HTMLElement).style.display) || '';
              if (a.id || display || /menu|dropdown|dialog|modal|popover|tab|panel/i.test(cls)) {
                container = a.tagName.toLowerCase();
                if (a.id) container += '#' + a.id;
                if (a.classList && a.classList.length) container += '.' + Array.from(a.classList).join('.');
                if (display) container += ' [display:' + display + (display === 'block' ? ' → OPEN' : display === 'none' ? ' → CLOSED' : '') + ']';
                break;
              }
              a = a.parentElement; depth++;
            }
            // --- guaranteed-unique, valid selector (anchored at an id or <body>) ---
            const parts: string[] = [];
            let cur: Element | null = el;
            while (cur && cur.tagName !== 'HTML') {
              if (cur.id) {
                parts.unshift(/^[A-Za-z][\w-]*$/.test(cur.id) ? '#' + cur.id : '[id="' + cur.id.replace(/"/g, '\\"') + '"]');
                break;
              }
              if (cur.tagName === 'BODY') { parts.unshift('body'); break; }
              let nth = 1; let sib = cur.previousElementSibling;
              while (sib) { if (sib.tagName === cur.tagName) nth++; sib = sib.previousElementSibling; }
              parts.unshift(cur.tagName.toLowerCase() + ':nth-of-type(' + nth + ')');
              cur = cur.parentElement;
            }
            out.push('[' + i + '] ' + s + ' — ' + (visible ? 'VISIBLE' : 'hidden')
              + (container ? ' — inside ' + container : '')
              + '\n     selector: ' + parts.join(' > '));
          }
          return out;
        }, MAX_SUGGESTIONS);
        const more = matchCount > MAX_SUGGESTIONS
          ? `\n…and ${matchCount - MAX_SUGGESTIONS} more (showing first ${MAX_SUGGESTIONS}).`
          : '';
        throw new ActionError('ambiguous_selector',
          `Selector "${action.selector}" matched ${matchCount} elements — pick the one you want and click it using the exact "selector:" value shown for that match (copy it verbatim; each is unique). ` +
          `Every match below shows its visibility and its containing menu/panel with OPEN/CLOSED state where it has one. ` +
          `For a dropdown action (e.g. Export to Excel) choose the match that is VISIBLE and inside the OPEN (display:block) menu:\n` +
          uniqueSelectors.join('\n') + more,
          { matchCount, uniqueSelectors },
        );
      }

      // §2 is enforced at the request chokepoint (browser/write-gate.ts), not here. A click is not
      // where money moves; the non-idempotent request it causes is, and that request is identical
      // whatever the button was labelled or whether it had a label at all.

      // Sequential click attempts: normal → force → jsClick
      const methods: ClickMethod[] = ['normal', 'force', 'jsClick'];
      let normalClickError: string | undefined;
      for (const method of methods) {
        try {
          await attemptClick(element, method, action.selector, log);
          await waitForStability(page, 10_000);
          if (method === 'normal') {
            return { status: 'success', matchCount };
          }
          return { status: 'fallback', matchCount, clickMethod: method, normalClickError: normalClickError! };
        } catch (err) {
          normalClickError ??= (err as Error).message;
        }
      }
      // All methods exhausted (shouldn't reach here due to jsClick throw, but just in case)
      throw new ActionError('click_failed',
        `Click failed on "${action.selector}": ${normalClickError}`,
        { methods },
      );
    }

    case 'fill': {
      if (!action.selector) throw new ActionError('missing_field', 'fill action requires a "selector" field — you omitted it');
      if (!action.value) throw new ActionError('missing_field', 'fill action requires a "value" field — you omitted it');
      const { locator: element, matchCount } = await findLocator(page, action.selector, log);
      const value = resolveValue(action.value, credentials, otpCode);
      const isCredential = Object.keys(CREDENTIAL_PLACEHOLDERS).includes(action.value) || action.value === 'OTP_CODE';

      if (isCredential) {
        // Use keyboard.type() for credential fields — more reliable on bank
        // sites with custom password handlers (e.g. CSS-masked password fields).
        await element.click({ timeout: 10_000 });
        await element.fill(''); // Clear first
        // For iframe elements, keyboard.type sends to the focused frame automatically
        await element.page().keyboard.type(value, { delay: 30 });
        await page.waitForTimeout(300);
      } else {
        await element.fill(value, { timeout: 10_000 });
      }
      return { status: 'success', matchCount };
    }

    case 'select': {
      if (!action.selector) throw new ActionError('missing_field', 'select action requires a "selector" field — you omitted it');
      if (!action.value) throw new ActionError('missing_field', 'select action requires a "value" field — you omitted it');
      const { locator: element, matchCount } = await findLocator(page, action.selector, log);
      const value = resolveValue(action.value, credentials, otpCode);
      await element.selectOption(value, { timeout: 10_000 });
      return { status: 'success', matchCount };
    }

    case 'wait': {
      await page.waitForTimeout(Math.min(action.ms ?? 2000, 30_000));
      return { status: 'success', matchCount: 0 };
    }

    case 'scroll': {
      const amount = action.amount ?? 500;
      const delta = action.direction === 'down' ? amount : -amount;
      await page.mouse.wheel(0, delta);
      await page.waitForTimeout(500);
      return { status: 'success', matchCount: 0 };
    }

    case 'navigate': {
      if (!action.url || !action.url.startsWith('http')) {
        throw new ActionError('missing_field', 'navigate action requires a valid "url" field starting with http');
      }
      // SSRF guard: the navigate target is model-chosen and can be steered by
      // hostile page content. Refuse loopback/private/link-local/metadata hosts.
      try {
        await assertSafeNavigationUrl(action.url);
      } catch (e) {
        throw new ActionError('missing_field', e instanceof Error ? e.message : 'unsafe navigate target');
      }
      const navigated = await page.goto(action.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      // The check above inspected a NAME; this one inspects the address the browser reached. Between
      // the two, DNS can change its mind, which is the whole of a rebind attack. Refusing here still
      // stops the page's content from reaching the model.
      await assertConnectedAddressIsPublic(navigated, action.url);
      await waitForStability(page, 10_000);
      return { status: 'success', matchCount: 0 };
    }

    default:
      throw new Error(`Unhandled executable action ${action.action}`);
  }
}

/**
 * Resolve a value by substituting credential and OTP placeholders.
 */
export function resolveValue(
  value: string,
  credentials: Pick<CrawlRequest, 'username' | 'password' | 'dob' | 'phone'>,
  otpCode?: string
): string {
  if (value === 'OTP_CODE') {
    if (!otpCode) {
      throw new Error("OTP_CODE placeholder used but no OTP value available");
    }
    return otpCode;
  }
  const credKey = CREDENTIAL_PLACEHOLDERS[value];
  if (credKey) {
    const resolved = credentials[credKey];
    if (!resolved) {
      throw new Error(`Credential placeholder '${value}' has no value`);
    }
    return resolved;
  }
  return value;
}
