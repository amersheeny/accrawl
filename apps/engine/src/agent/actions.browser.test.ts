/**
 * Browser-context tests for executeAction's ambiguous-selector disambiguation.
 *
 * These MUST run in a real browser (not JSDOM): the disambiguation builds its
 * per-match suggestions inside `locator.evaluateAll`, whose body is serialized
 * and executed in the page. That path can't be exercised by the JSDOM unit
 * tests, and it has a specific failure mode — tsx/esbuild `keepNames` wraps any
 * nested named function in a `__name` helper that doesn't exist in the page,
 * throwing "ReferenceError: __name is not defined" at runtime. This test pins
 * that down and proves the suggested selectors are GLOBALLY UNIQUE in a real DOM.
 *
 * Skips gracefully if a Chromium binary isn't available (keeps CI green).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { executeAction } from './actions';
import { ActionError } from './errors';

const NO_CREDS = { username: '', password: '' };

// A real brokerage's shape: the "Export to Excel" <li> is rendered inside FOUR dropdown menus;
// only the open one (display:block) is visible. One selector matches all four.
const MULTI_MENU_HTML = `
  <body>
    <nav id="navbar">
      <ul class="dropdown-menu tab-module-settings" style="display: none"><li class="export excel" ng-click="vm.exportToExcel()">Export to Excel</li></ul>
      <ul class="dropdown-menu tab-module-settings" style="display: block"><li class="export excel" ng-click="vm.exportToExcel()">Export to Excel</li></ul>
    </nav>
    <ul class="dropdown-menu tab-module-settings" style="display: none"><li class="export excel" ng-click="vm.exportToExcel()">Export to Excel</li></ul>
    <ul class="dropdown-menu tab-module-settings" style="display: none"><li class="export excel" ng-click="vm.exportToExcel()">Export to Excel</li></ul>
  </body>
`;

describe('executeAction ambiguous-selector disambiguation (browser)', () => {
  let browser: Browser | undefined;
  let page: Page | undefined;
  let available = true;

  beforeAll(async () => {
    // Match the crawler: it launches system Chrome (channel:'chrome'); fall back
    // to the bundled Chromium (CI). Skip only if neither is installed.
    const attempts = [{ channel: 'chrome' as const, args: ['--no-sandbox'] }, { args: ['--no-sandbox'] }];
    for (const opts of attempts) {
      try {
        browser = await chromium.launch(opts);
        page = await browser.newPage();
        return;
      } catch {
        /* try next launcher */
      }
    }
    available = false;
    // eslint-disable-next-line no-console
    console.warn('[actions.browser.test] No Chrome/Chromium available — skipping browser tests');
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
  });

  it('rejects an ambiguous click with enriched, GLOBALLY-UNIQUE selectors (no __name crash)', async () => {
    if (!available || !page) return; // skip gracefully
    await page.setContent(MULTI_MENU_HTML);

    let err: unknown;
    try {
      await executeAction(
        page,
        { action: 'click', selector: 'li.export.excel[ng-click="vm.exportToExcel()"]', description: 'Export' } as never,
        NO_CREDS,
      );
    } catch (e) {
      err = e;
    }

    expect(err).toBeInstanceOf(ActionError);
    const msg = (err as ActionError).message;
    // Regression: the browser-serialized code must not reference the esbuild helper.
    expect(msg).not.toContain('__name');
    expect((err as ActionError).type).toBe('ambiguous_selector');

    // Enriched context the model needs to choose.
    expect(msg).toContain('VISIBLE');
    expect(msg).toContain('display:block → OPEN');
    expect(msg).toContain('display:none → CLOSED');
    expect(msg).toContain('ng-click="vm.exportToExcel()"');

    // Every suggested "selector:" must resolve to EXACTLY ONE element.
    const selectors = msg
      .split('\n')
      .map(l => l.trim())
      .filter(l => l.startsWith('selector:'))
      .map(l => l.replace(/^selector:\s*/, ''));
    expect(selectors.length).toBe(4);
    for (const sel of selectors) {
      expect(await page.locator(sel).count(), `"${sel}" must be unique`).toBe(1);
    }

    // The single VISIBLE match's selector must resolve to the one in the OPEN menu.
    const visibleSel = msg
      .split('\n')
      .reduce<string[]>((acc, line, i, arr) => {
        if (line.includes('VISIBLE') && arr[i + 1]?.includes('selector:')) {
          acc.push(arr[i + 1].trim().replace(/^selector:\s*/, ''));
        }
        return acc;
      }, []);
    expect(visibleSel.length).toBe(1);
    const target = page.locator(visibleSel[0]);
    expect(await target.count()).toBe(1);
    expect(await target.isVisible()).toBe(true);
  }, 30_000);

  it('clicks a single visible match normally (no disambiguation when unique)', async () => {
    if (!available || !page) return;
    await page.setContent(`<body><button id="go" onclick="window.__clicked=true">Go</button></body>`);
    const res = await executeAction(
      page,
      { action: 'click', selector: '#go', description: 'Go' } as never,
      NO_CREDS,
    );
    expect(res.status).toBe('success');
    expect(await page.evaluate(() => (window as unknown as { __clicked?: boolean }).__clicked)).toBe(true);
  }, 30_000);
});
