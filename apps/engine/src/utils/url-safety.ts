/**
 * URL safety guard for browser navigation (SSRF defense-in-depth).
 *
 * The crawl agent can be steered by the (untrusted) content of the page it is
 * looking at — a prompt-injection on a hostile page could ask the model to
 * `navigate` somewhere it shouldn't. For tunnel crawls all browser egress goes
 * through the user's own phone (SOCKS5), so a host's internal addresses are
 * not reachable; but the direct `/crawl` path egresses from the server's own
 * instance itself, where `http://169.254.169.254/` (the GCP metadata server) and
 * other internal hosts WOULD be reachable. We therefore refuse to navigate to
 * loopback / private / link-local / metadata targets regardless of crawl mode.
 *
 * This blocks IP-literal + well-known-hostname SSRF, AND resolves a plain hostname
 * and refuses it if any A/AAAA record is a private/internal/metadata IP (so a
 * public name whose DNS points at 169.254.169.254 is caught, not just the literal).
 * The residual is a true DNS-REBIND — the host resolving public here but internal
 * again when the browser makes its own connection; fully closing that needs
 * resolve-and-pin at the socket layer. Banks use stable public DNS, so that
 * remaining window is low-risk.
 */
import { lookup as dnsLookup } from 'node:dns/promises';

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata',
  'metadata.google.internal',
]);

/** Parse a dotted-quad IPv4 string into its four octets, or null if not IPv4. */
function parseIpv4(host: string): number[] | null {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const octets = m.slice(1, 5).map((n) => Number(n));
  if (octets.some((o) => o > 255)) return null;
  return octets;
}

/** True if an IPv4 address is loopback / private / link-local / CGNAT / unspecified. */
function isPrivateIpv4(octets: number[]): boolean {
  const [a, b] = octets;
  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local (incl. metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  return false;
}

/** True if an IPv6 literal (host without brackets) is loopback / ULA / link-local / unspecified / v4-mapped-internal. */
function isPrivateIpv6(host: string): boolean {
  const h = host.toLowerCase();
  if (h === '::1' || h === '::') return true; // loopback / unspecified
  if (h.startsWith('fc') || h.startsWith('fd')) return true; // fc00::/7 unique-local
  // fe80::/10 link-local (fe8/fe9/fea/feb) AND fec0::/10 site-local (fec/fed/
  // fee/fef, deprecated but still routable on some hosts). Together: fe[8-f].
  if (/^fe[8-9a-f]/.test(h)) return true;
  if (h.startsWith('ff')) return true; // ff00::/8 multicast

  // Decode any embedded IPv4 and apply the v4 range checks. Covers both:
  //   - IPv4-mapped  ::ffff:a.b.c.d  (WHATWG normalizes the tail to hex:
  //     ::ffff:7f00:1), and
  //   - IPv4-compatible (deprecated) ::a.b.c.d  →  ::a9fe:a9fe etc.
  // so e.g. ::169.254.169.254 (the metadata server) can't slip through.
  const mappedDotted = h.match(/^::(?:ffff:)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mappedDotted) {
    const v4 = parseIpv4(mappedDotted[1]);
    return v4 ? isPrivateIpv4(v4) : true;
  }
  const embeddedHex = h.match(/^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (embeddedHex) {
    const g1 = parseInt(embeddedHex[1], 16);
    const g2 = parseInt(embeddedHex[2], 16);
    return isPrivateIpv4([g1 >> 8, g1 & 0xff, g2 >> 8, g2 & 0xff]);
  }
  return false;
}

/** Throw if a single IP string is a private/internal/metadata address — shared by the IP-literal check and
 *  the resolved-hostname check so both apply the exact same range rules. */
function assertIpIsPublic(ip: string, host: string): void {
  const v4 = parseIpv4(ip);
  if (v4 && isPrivateIpv4(v4)) throw new Error(`navigate target resolves to a private/internal address (${host} -> ${ip})`);
  if (ip.includes(':') && isPrivateIpv6(ip)) throw new Error(`navigate target resolves to a private/internal address (${host} -> ${ip})`);
}

/** Resolve a hostname to its A/AAAA addresses. Injectable so tests don't hit real DNS. */
export type HostResolver = (host: string) => Promise<string[]>;
const defaultResolver: HostResolver = async (host) => (await dnsLookup(host, { all: true })).map((a) => a.address);

/**
 * Throw if `url` is not a safe public http(s) navigation target. Async because it RESOLVES a plain hostname
 * and rejects it if any resolved IP is internal (SSRF via DNS), on top of the IP-literal / known-hostname checks.
 *
 * @throws Error if the scheme is not http/https, or the host is (or resolves to) a loopback / private /
 *   link-local / metadata address, or is a blocked hostname.
 */
export async function assertSafeNavigationUrl(url: string, resolve: HostResolver = defaultResolver): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`navigate target is not a valid URL: ${url}`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`navigate target must be http(s), got ${parsed.protocol}`);
  }

  // URL.hostname keeps the surrounding brackets on IPv6 literals (e.g. "[::1]");
  // strip them so the range checks see the bare address.
  let host = parsed.hostname.toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) {
    host = host.slice(1, -1);
  }
  // Strip trailing dot(s): a fully-qualified name like "metadata.google.internal."
  // resolves to the same host but is kept verbatim by the URL parser, so it would
  // otherwise slip past the exact-match blocklist. (The parser already strips the
  // trailing dot from IP literals, so this only affects hostnames.)
  host = host.replace(/\.+$/, '');

  if (BLOCKED_HOSTNAMES.has(host) || host.endsWith('.localhost')) {
    throw new Error(`navigate target host is not allowed: ${host}`);
  }

  // IP LITERAL — validate directly (no DNS).
  const v4 = parseIpv4(host);
  const isIpLiteral = !!v4 || host.includes(':');
  if (v4 && isPrivateIpv4(v4)) {
    throw new Error(`navigate target resolves to a private/internal address: ${host}`);
  }
  if (host.includes(':') && isPrivateIpv6(host)) {
    throw new Error(`navigate target resolves to a private/internal address: ${host}`);
  }

  // HOSTNAME — resolve and reject if it points at an internal IP (a public name whose A record is
  // 169.254.169.254 / 10.x / ::1 …). Fail OPEN on a resolution error: the browser can't reach an
  // unresolvable host either, so a transient DNS hiccup shouldn't block a legit crawl.
  if (!isIpLiteral) {
    let ips: string[];
    try {
      ips = await resolve(host);
    } catch {
      return;
    }
    for (const ip of ips) assertIpIsPublic(ip, host);
  }
}
