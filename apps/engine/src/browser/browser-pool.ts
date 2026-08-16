/**
 * Browser Pool
 *
 * Manages Playwright Chromium browser lifecycle.
 * One browser instance per one-shot crawl worker/process.
 */

import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { buildChromiumEnvironment } from './chromium-environment';

let browser: Browser | null = null;
let browserLaunch: Promise<Browser> | null = null;
let browserLifecycleGeneration = 0;

export class BrowserFenceError extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = 'BrowserFenceError';
  }
}

/** Chromium switch NAMES (no prefix) that DEFEAT the hardcoded secure defaults and must never be accepted via
 *  EXTRA_CHROMIUM_ARGS. Any would silently re-disable TLS / same-origin validation — e.g. ignore-certificate-errors
 *  overrides `ignoreHTTPSErrors: false` and reopens the device-proxy tunnel-MITM. Stored WITHOUT a dash prefix
 *  and matched after stripping prefixes, because Chromium accepts `--flag`, `-flag`, and `/flag` alike (a
 *  double-dash-only check was bypassable with the single-dash form — verified). */
const BLOCKED_CHROMIUM_FLAGS = new Set([
  'ignore-certificate-errors',
  'ignore-certificate-errors-spki-list',
  'ignore-urlfetcher-cert-requests',
  'allow-insecure-localhost',
  'ignore-ssl-errors',
  'disable-web-security',
  'reduce-security-for-testing',
  'allow-running-insecure-content',
  'unsafely-treat-insecure-origin-as-secure',
]);

/**
 * Whether to launch Chromium WITHOUT its own sandbox.
 *
 * Default false — the sandbox stays on. It is the boundary between a renderer parsing a hostile page
 * and everything else in this process tree, and it is the only one of the two isolation layers that
 * protects the browser process from its own renderer. Container hardening (non-root, no-new-privileges,
 * every capability dropped) bounds what an escape reaches on the HOST; it does nothing about what an
 * escaped renderer reaches inside the container, which is the live bank session.
 *
 * A deployment whose kernel or container runtime denies unprivileged user namespaces cannot start
 * Chromium with the sandbox on, and sets CHROMIUM_DISABLE_SANDBOX=1 to say so explicitly. That is a
 * deliberate, recorded downgrade — not a default, and not something a reader has to infer from a
 * hardcoded flag.
 */
export function disableChromiumSandbox(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = (env.CHROMIUM_DISABLE_SANDBOX ?? '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

/** Parse EXTRA_CHROMIUM_ARGS (one flag per line), DROPPING any security-defeating flag with a loud warning, so
 *  neither an operator nor a copy-pasted config can silently turn off TLS/same-origin validation out from under
 *  the secure defaults. Legitimate flags (custom CA, upstream proxy, --host-resolver-rules) pass through. */
export function sanitizeChromiumArgs(raw: string | undefined): string[] {
  return (raw ?? '')
    .split('\n')
    .map((a) => a.trim())
    .filter(Boolean)
    .filter((a) => {
      // Normalize to the bare switch name: drop any `=value`, then ALL leading dash/slash prefixes (Chromium
      // treats --flag, -flag and /flag identically, so we must too — the single-dash form was a real bypass).
      const flag = a.split('=')[0].replace(/^[-/]+/, '').toLowerCase();
      if (BLOCKED_CHROMIUM_FLAGS.has(flag)) {
        console.warn(`[Browser] REFUSING security-defeating EXTRA_CHROMIUM_ARGS flag: ${a.split('=')[0]} — TLS/same-origin validation is enforced and cannot be disabled.`);
        return false;
      }
      return true;
    });
}

/** Keep the anti-detection UA aligned with the exact Chrome binary that Playwright launched. A hardcoded
 * version becomes an internally inconsistent fingerprint the moment the container's browser advances. */
export function chromeUserAgent(version: string): string {
  const normalized = version.trim();
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(normalized)) {
    throw new Error(`Chrome reported an unexpected version: ${version}`);
  }
  return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
    + 'AppleWebKit/537.36 (KHTML, like Gecko) '
    + `Chrome/${normalized} Safari/537.36`;
}

/**
 * Launch a browser instance (reuses existing if available).
 */
export async function getBrowser(): Promise<Browser> {
  if (browser?.isConnected()) return browser;
  if (browserLaunch) return browserLaunch;

  const generation = browserLifecycleGeneration;
  const headless = process.env.HEADLESS !== 'false';
  let launch!: Promise<Browser>;
  launch = chromium.launch({
      channel: 'chrome',
      headless,
      // Chromium renders attacker-influenceable bank pages. Give it only the
      // OS/runtime variables it needs, never the engine's credentials, cloud
      // identity, crawl metadata, or database/model secrets.
      env: buildChromiumEnvironment(process.env),
      args: [
        // Chrome's own sandbox. Its namespace sandbox needs unprivileged user namespaces, which a
        // hardened container may not grant, so a deployment that cannot provide them turns it off HERE
        // rather than by patching this file — see disableChromiumSandbox(). The default is ON: the
        // renderer parses attacker-influenceable pages inside a live bank session, and container
        // isolation bounds what a renderer escape reaches on the HOST while doing nothing about what it
        // reaches inside this container.
        ...(disableChromiumSandbox() ? ['--no-sandbox', '--disable-setuid-sandbox'] : []),
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-blink-features=AutomationControlled',
        // Site isolation is deliberately NOT disabled. It is what keeps a cross-origin frame — an ad, a
        // widget, an injected iframe — out of the address space holding the bank origin, and unlike the
        // sandbox above it costs no Linux capability, so no container hardening can justify removing it.
        '--window-size=1280,900',
        '--disable-infobars',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-default-apps',
        // Operator-supplied extra Chromium flags, one per line in EXTRA_CHROMIUM_ARGS — e.g. a custom CA, an
        // upstream proxy, or a host-resolver override (--host-resolver-rules) for self-managed DNS. Sanitized:
        // security-defeating flags (cert/TLS/same-origin disabling) are refused so they can't undo the secure
        // defaults (the tunnel-MITM would reopen if --ignore-certificate-errors slipped in here).
        ...sanitizeChromiumArgs(process.env.EXTRA_CHROMIUM_ARGS),
      ],
    })
    .then(async (launched) => {
      // An ownership fence can arrive while Chromium is still launching, before
      // a BrowserContext exists in activeSessions. Never publish that late
      // browser: close it before getBrowser resolves so no caller can begin
      // navigation after its durable lease was lost.
      if (generation !== browserLifecycleGeneration) {
        try {
          await launched.close();
        } catch (error) {
          throw new BrowserFenceError(
            'Fenced browser launch could not be closed',
            error,
          );
        }
        throw new Error('Browser launch was fenced during startup');
      }
      browser = launched;
      return launched;
    })
    .finally(() => {
      if (browserLaunch === launch) browserLaunch = null;
    });
  browserLaunch = launch;
  const launched = await launch;
  if (launched === browser) {
    console.log(`[Browser] Launched Chromium (headless: ${headless})`);
  }
  return launched;
}

/** Country-to-locale/timezone mapping for common institution regions */
const REGION_DEFAULTS: Record<string, { locale: string; timezoneId: string }> = {
  IL: { locale: 'he-IL', timezoneId: 'Asia/Jerusalem' },
  AE: { locale: 'en-AE', timezoneId: 'Asia/Dubai' },
  US: { locale: 'en-US', timezoneId: 'America/New_York' },
  GB: { locale: 'en-GB', timezoneId: 'Europe/London' },
};

/** Navigator.languages spoof per locale — must match the context locale */
export const REGION_LANGUAGES: Record<string, string[]> = {
  'he-IL': ['he', 'he-IL', 'en'],
  'en-AE': ['en', 'en-AE', 'ar'],
  'en-US': ['en-US', 'en'],
  'en-GB': ['en-GB', 'en'],
};

/**
 * Create a new browser context with a realistic user agent and viewport.
 * @param country - Institution country code (e.g. "IL", "AE") for locale/timezone
 * @param proxy - Optional SOCKS5/HTTP proxy URL (e.g. "socks5://127.0.0.1:1080")
 */
export async function createContext(country?: string, proxy?: string): Promise<BrowserContext> {
  const generation = browserLifecycleGeneration;
  const b = await getBrowser();
  if (generation !== browserLifecycleGeneration) {
    throw new Error('Browser context creation was fenced during startup');
  }
  const region = (country && REGION_DEFAULTS[country]) || REGION_DEFAULTS.US;

  const context = await b.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent: chromeUserAgent(b.version()),
    locale: region.locale,
    timezoneId: region.timezoneId,
    // STRICT TLS (never ignore cert errors). This agent types real bank credentials, so a TLS cert error is
    // a MITM/wrong-site red flag that MUST abort the connection, not be silently accepted. It is CRITICAL for
    // device-proxy (tunnel) crawls: egress there exits through the operator's phone, and a malicious/compromised
    // relay could otherwise connect the SOCKS5 CONNECT to an attacker host and present a self-signed cert for the
    // bank domain — with cert validation off, Chromium would accept it and hand the credentials to the attacker
    // under an "allowed" origin. Real banks serve valid certs, so this doesn't break legitimate crawls; a genuine
    // per-bank exception would be a deliberate, audited per-institution opt-in — never a global default.
    ignoreHTTPSErrors: false,
    acceptDownloads: true,
    // Block service workers — they can fetch outside page-route interception (an egress-guard bypass).
    serviceWorkers: 'block',
    ...(proxy ? { proxy: { server: proxy } } : {}),
  });
  if (generation !== browserLifecycleGeneration) {
    try {
      await context.close();
    } catch (error) {
      throw new BrowserFenceError(
        'Fenced browser context could not be closed during startup',
        error,
      );
    }
    throw new Error('Browser context creation was fenced during startup');
  }

  // Comprehensive anti-detection: spoof navigator properties to look like a real browser
  const languages = REGION_LANGUAGES[region.locale] || REGION_LANGUAGES['en-US'];
  await context.addInitScript((langs: string[]) => {
    // Hide webdriver flag
    Object.defineProperty(navigator, 'webdriver', { get: () => false });

    // Spoof plugins — modern Chrome only reports PDF Viewer
    Object.defineProperty(navigator, 'plugins', {
      get: () => {
        const plugins = [
          { name: 'PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
        ];
        (plugins as any).length = 1;
        (plugins as any).item = (i: number) => plugins[i] || null;
        (plugins as any).namedItem = (n: string) => plugins.find(p => p.name === n) || null;
        (plugins as any).refresh = () => {};
        return plugins;
      },
    });

    // Spoof languages to match context locale
    Object.defineProperty(navigator, 'languages', { get: () => langs });

    // Spoof chrome.runtime (headless Chrome lacks this)
    if (!(window as any).chrome) (window as any).chrome = {};
    if (!(window as any).chrome.runtime) {
      (window as any).chrome.runtime = {
        connect: () => {},
        sendMessage: () => {},
        onMessage: { addListener: () => {} },
      };
    }

    // Spoof permissions query to avoid detection via Notification permission
    const origQuery = window.navigator.permissions?.query?.bind(window.navigator.permissions);
    if (origQuery) {
      (window.navigator.permissions as any).query = (params: any) => {
        if (params.name === 'notifications') {
          return Promise.resolve({ state: 'prompt', onchange: null } as PermissionStatus);
        }
        return origQuery(params);
      };
    }

    // Override window.print() — some sites open a blob page and
    // call window.print(), which blocks the browser in headless mode.
    // Making it a no-op lets us read the print view HTML without blocking.
    window.print = () => {};
  }, languages);

  // addInitScript is asynchronous too. A fence that lands during initialization
  // must close the context before createContext can publish it to the crawler.
  if (generation !== browserLifecycleGeneration) {
    try {
      await context.close();
    } catch (error) {
      throw new BrowserFenceError(
        'Fenced browser context could not be closed during initialization',
        error,
      );
    }
    throw new Error('Browser context creation was fenced during startup');
  }
  return context;
}

/**
 * Create a new page in a context with default navigation timeout.
 */
export async function createPage(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  // Generous timeouts — traffic may proxy through a user's mobile device via SOCKS5
  page.setDefaultTimeout(120_000);
  page.setDefaultNavigationTimeout(180_000);
  return page;
}

/**
 * Close the browser instance.
 */
export async function closeBrowser(): Promise<void> {
  // Increment first: an in-flight chromium.launch observes the generation
  // change and closes its result before exposing it to createContext.
  browserLifecycleGeneration += 1;
  const current = browser;
  const pending = browserLaunch;
  browser = null;

  const pendingCleanup = pending
    ? pending.then(
        async (launched) => {
          if (launched !== current) {
            try {
              await launched.close();
            } catch (error) {
              throw new BrowserFenceError(
                'Late browser launch could not be closed',
                error,
              );
            }
          }
        },
        (error: unknown) => {
          // A normal launch rejection or a generation fence that successfully
          // closed its late browser leaves no resource to clean up. A close
          // failure is different: preserve it so the worker must terminate.
          if (error instanceof BrowserFenceError) throw error;
        },
      )
    : Promise.resolve();

  if (current) {
    await Promise.all([current.close(), pendingCleanup]);
  } else {
    await pendingCleanup;
  }
}
