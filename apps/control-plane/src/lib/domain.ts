/**
 * Domain helpers for the anti-phishing anchor.
 *
 * The canonical domain is the registrable domain (eTLD+1, via the public-suffix list) of a
 * config's loginUrl. Credentials are bound to an operator-verified canonical domain, and the
 * engine's egress guard only allows the eTLD+1 + explicit allowedDomains — so a malicious
 * imported config can't silently point the login at an attacker domain.
 */
import { getDomain } from 'tldts';

/**
 * Whether a login URL may be plain HTTP.
 *
 * A login URL is where the operator's bank credentials get typed and posted. Over `http:` they cross
 * the network in the clear and the anti-phishing anchor guarantees nothing, because anyone on the path
 * can rewrite the page that asks for them. So `https:` is required.
 *
 * Two exceptions, both narrow and neither available in production:
 *   - a loopback host, where there is no network to intercept; and
 *   - an explicit opt-in for a local mock bank, which the end-to-end suite uses.
 *
 * Double-gated exactly like the Companion's transport rule (routes/companion.ts): never in production,
 * and never without the operator saying so.
 */
export function insecureLoginUrlAllowed(
  hostname: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const host = hostname.toLowerCase();
  // Anchored at BOTH ends. A prefix match on "127." also matches 127.0.0.1.evil.com, which is an
  // ordinary public domain someone can register — it would have been handed a plain-HTTP credential
  // form in production.
  const isLoopback = host === 'localhost'
    || host === '::1'
    || host === '[::1]'
    || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
  if (isLoopback) return true;
  return env.NODE_ENV !== 'production' && env.ACCRAWL_ALLOW_INSECURE_LOGIN_URL === '1';
}

/** Parse a crawlable web URL and return its lowercased hostname. */
function webHostname(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (
      (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')
      || parsed.username !== ''
      || parsed.password !== ''
    ) {
      return null;
    }
    return parsed.hostname.length > 0 ? parsed.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * Whether this login URL's transport is acceptable. Kept separate from canonical-domain derivation so
 * a caller can tell an insecure scheme apart from an unanchorable host and say which one it rejected.
 */
export function isSecureLoginUrl(url: string, env: NodeJS.ProcessEnv = process.env): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === 'https:') return true;
  if (parsed.protocol !== 'http:') return false;
  return insecureLoginUrlAllowed(parsed.hostname, env);
}

/**
 * The registrable domain (eTLD+1) of a URL, lowercased. Returns null when the URL is invalid
 * or has no registrable domain (a raw IP, `localhost`, or a bare TLD) — such a loginUrl can't
 * anchor anti-phishing and must be rejected by the caller.
 */
export function deriveCanonicalDomain(url: string): string | null {
  const hostname = webHostname(url);
  if (!hostname) return null;
  // allowPrivateDomains so a bank on a multi-tenant platform (appspot.com, web.app, github.io, …) anchors
  // to ITS tenant (victim.appspot.com), not the shared suffix (appspot.com) — otherwise a sibling tenant
  // (attacker.appspot.com) would pass the loginUrlOverride/verify-domain anti-phishing check.
  const domain = getDomain(hostname, { allowPrivateDomains: true });
  return domain && domain.length > 0 ? domain.toLowerCase() : null;
}

/**
 * Whether a value is a real registrable host (has an eTLD+1) — NOT a bare public suffix, IP, or
 * localhost. An allowedDomain MUST be registrable: declaring a bare suffix (e.g. "com", "co.uk",
 * "github.io") would widen the engine's egress pin to an entire TLD/registrar and defeat §1.
 */
export function isRegistrableHost(value: string): boolean {
  return deriveCanonicalDomain(value.includes('://') ? value : `https://${value}`) !== null;
}

/** The hostname of a URL, lowercased, or null if it can't be parsed. */
export function hostnameOf(url: string): string | null {
  return webHostname(url);
}

/**
 * Whether a URL's host is within a canonical domain — i.e. equals it or is a subdomain.
 * `login.bank.com` is within `bank.com`; `bank.com.evil.com` is NOT (suffix-with-dot guard).
 */
export function isHostWithinDomain(url: string, canonicalDomain: string): boolean {
  const host = hostnameOf(url);
  if (!host) return false;
  const dom = canonicalDomain.toLowerCase();
  return host === dom || host.endsWith(`.${dom}`);
}
