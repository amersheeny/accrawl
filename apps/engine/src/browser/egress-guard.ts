/**
 * Egress guard (§1 exfiltration prevention).
 *
 * The agent operates inside the user's authenticated bank session. To stop a malicious or buggy
 * config from exfiltrating credentials/data, the browser context is PINNED to a set of allowed host
 * suffixes: the eTLD+1 of the loginUrl (so every bank subdomain is reachable) plus each
 * per-institution allowedDomain (matched as an exact host or a parent suffix — NOT widened to its
 * eTLD+1, so a shared CDN tenant can't open the whole provider). Every request — ALL methods,
 * including resource GETs (an off-domain `GET ...?d=<acct#>` beacon is itself exfil) — is intercepted
 * before it leaves; anything off the pinned set is aborted. Service workers are blocked at context
 * creation (they fetch outside page-route interception), and WebSockets are pinned the same way when
 * the Playwright build supports it.
 *
 * The LLM provider is NOT reachable from the browser (Gemini is called from the Node process), so it
 * needs no allowance here. This guard does not stop data reaching the LLM — that path is inside the
 * trust boundary by design and documented separately.
 */
import type { BrowserContext, Route, Request } from 'playwright';
import { getDomain, getHostname } from 'tldts';
import type { SessionLogger } from '../utils/logger';
import { safeBrowserUrl } from '../utils/safe-browser-url';
import {
  bodyParameters,
  isNonIdempotent,
  mergeParameters,
  queryParameters,
  type WriteGate,
} from './write-gate';

/** Schemes that never leave the machine — in-page/inert, always allowed. */
const INERT_SCHEME = /^(about|data|blob):/i;

/**
 * The allowed host suffixes: the loginUrl's eTLD+1 (covers all bank subdomains) followed by each
 * allowedDomain reduced to its hostname (matched as an exact host or parent suffix).
 */
export function allowedSuffixes(loginUrl: string, allowedDomains: string[] = [], logger?: SessionLogger): string[] {
  const out: string[] = [];
  // allowPrivateDomains so a bank hosted on a multi-tenant platform (github.io, pages.dev, web.app,
  // netlify.app, …) pins to ITS tenant (victimbank.github.io), not the whole shared suffix (github.io)
  // — otherwise the pin would allow exfil to any co-tenant (attacker.github.io).
  const pinned = getDomain(loginUrl, { allowPrivateDomains: true });
  if (pinned) out.push(pinned.toLowerCase());
  for (const d of allowedDomains) {
    const url = d.includes('://') ? d : `https://${d}`;
    const host = getHostname(url);
    // A bare public suffix / IP / localhost has no registrable domain (getDomain === null). Pushing
    // 'com' (or 'co.uk', 'github.io') would widen the pin to an entire TLD/registrar and defeat §1, so
    // only a specific registrable host (e.g. cdn.assets.com) is admitted. The control-plane rejects
    // these at config time too; this is defense-in-depth at the point of enforcement.
    if (host && getDomain(url, { allowPrivateDomains: true })) {
      out.push(host.toLowerCase());
    } else {
      (logger ?? console).warn(
        `[Egress] ignoring non-registrable allowedDomain "${safeBrowserUrl(url)}" (would widen the domain pin)`,
      );
    }
  }
  return out;
}

function hostWithin(host: string, suffix: string): boolean {
  return host === suffix || host.endsWith(`.${suffix}`);
}

/**
 * Runs in the page (before any page script) to remove the WebRTC constructors. WebRTC ICE/STUN/TURN and
 * data-channel traffic goes out over UDP, NOT through Playwright's HTTP route or routeWebSocket — so the
 * only reliable block is denying the API itself, turning the page into a WebRTC-less browser. Applied to
 * every frame via context.addInitScript.
 */
export function disableWebRtcInPage(): void {
  for (const key of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'mozRTCPeerConnection', 'RTCDataChannel']) {
    try {
      Object.defineProperty(window, key, { configurable: false, get: () => undefined });
    } catch {
      /* already locked by a prior run */
    }
  }
}

/** Whether a URL may be fetched: an inert scheme, or its host equals/sub-domains an allowed suffix. */
export function isUrlAllowed(url: string, suffixes: string[]): boolean {
  if (INERT_SCHEME.test(url)) return true;
  const host = getHostname(url);
  if (!host) return false;
  const h = host.toLowerCase();
  return suffixes.some((s) => hostWithin(h, s));
}

/**
 * Install the egress guard on a context BEFORE any navigation. Intercepts every HTTP(S) request and
 * (where supported) WebSocket; aborts anything off the pinned host suffixes.
 */
/**
 * §2 write gate at the request chokepoint. Only reached for a state-changing method, so every page
 * load, image and read XHR keeps the synchronous fast path. Any failure inside routes the request to
 * an abort rather than leaving it hanging — an unrouted request stalls the page forever.
 */
async function routeThroughWriteGate(
  route: Route,
  request: Request,
  writeGate: WriteGate,
  log: SessionLogger | Console,
): Promise<void> {
  const url = request.url();
  const safeUrl = safeBrowserUrl(url);
  try {
    let body: string | null = null;
    let contentType: string | undefined;
    try {
      body = request.postData();
      contentType = request.headers()['content-type'];
    } catch {
      // An unreadable body yields no parameters; the gate still decides, deny-biased.
    }
    const parameters = mergeParameters(queryParameters(url), bodyParameters(contentType, body));
    const decision = await writeGate.evaluate({
      method: request.method(),
      safeUrl,
      parameterNames: parameters.names,
      operationHints: parameters.hints,
    });
    if (decision.allowed) {
      await route.continue();
      return;
    }
    log.warn(`[WriteGate] BLOCKED ${request.method()} ${safeUrl} — ${decision.reason}`);
    await route.abort('blockedbyclient');
  } catch (error) {
    log.warn(
      `[WriteGate] Routing failed for ${request.method()} ${safeUrl} `
      + `(${error instanceof Error ? error.message : String(error)}) — denying.`,
    );
    await route.abort('blockedbyclient').catch(() => { /* request already handled or page gone */ });
  }
}

export async function installEgressGuard(
  context: BrowserContext,
  loginUrl: string,
  allowedDomains: string[] = [],
  logger?: SessionLogger,
  writeGate?: WriteGate,
): Promise<void> {
  const log = logger ?? console;
  const suffixes = allowedSuffixes(loginUrl, allowedDomains, logger);
  log.log(`[Egress] Browser pinned to: ${suffixes.join(', ') || '(none — loginUrl had no registrable domain!)'}`);

  // Deny WebRTC in every frame before page scripts run — it would otherwise tunnel data out over UDP
  // beneath the request/WebSocket route guards below.
  await context.addInitScript(disableWebRtcInPage);

  await context.route('**/*', (route: Route, request: Request) => {
    const url = request.url();
    if (!isUrlAllowed(url, suffixes)) {
      log.warn(
        `[Egress] BLOCKED off-domain ${request.method()} ${safeBrowserUrl(url)}`,
      );
      void route.abort('blockedbyclient');
      return;
    }
    // Money cannot move without a state-changing method, so only those pay for the gate.
    if (writeGate && isNonIdempotent(request.method())) {
      void routeThroughWriteGate(route, request, writeGate, log);
      return;
    }
    void route.continue();
  });

  // WebSocket pinning (Playwright >= 1.48). Off-domain sockets are closed; on-domain ones connect.
  const ctx = context as unknown as {
    routeWebSocket?: (
      pattern: string,
      handler: (ws: { url(): string; connectToServer(): void; close(): void }) => void,
    ) => Promise<void>;
  };
  if (typeof ctx.routeWebSocket === 'function') {
    await ctx.routeWebSocket('**/*', (ws) => {
      if (isUrlAllowed(ws.url(), suffixes)) {
        ws.connectToServer();
      } else {
        log.warn(
          `[Egress] BLOCKED off-domain WebSocket ${safeBrowserUrl(ws.url())}`,
        );
        ws.close();
      }
    });
  }
}
