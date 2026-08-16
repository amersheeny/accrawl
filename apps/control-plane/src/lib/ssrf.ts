/**
 * SSRF-guarded outbound fetch for operator-supplied URLs (community config import).
 *
 * Importing a config by URL makes the control-plane fetch an operator-supplied address server-side — a
 * classic SSRF vector (hit cloud metadata at 169.254.169.254, an internal admin panel on 10.x, localhost).
 * The guard, in layers:
 *   1. https ONLY — no http/file/gopher/data, so no plaintext creds and no non-HTTP scheme smuggling.
 *   2. A custom DNS `lookup` (guardedLookup) is the SOLE resolver the connection uses: it resolves ALL
 *      addresses and rejects the whole hostname if ANY is private/loopback/link-local/reserved. Because the
 *      connection is pinned to exactly the address this lookup returns, there is NO DNS-rebinding TOCTOU
 *      window (the naive "resolve, validate, then fetch" pattern re-resolves and can be rebound in between).
 *   3. Redirects are NOT followed (a 3xx is rejected) — a receiver can't 302 us into an internal target.
 *   4. A response size cap + a connect/read timeout — a hostile endpoint can't stream forever or hang us.
 *
 * The blocklist + lookup are injectable so the fetch wire path can be exercised against a local test server
 * (which necessarily resolves to loopback) without weakening the real guard used in production.
 */
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import type { LookupFunction } from 'node:net';

/** A URL/address the SSRF guard refused (bad scheme, private/blocked address, redirect, oversize, timeout). */
export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfError';
  }
}

/** The set of address ranges that must never be reachable from a server-side fetch: loopback, RFC-1918
 *  private, link-local (incl. the 169.254.169.254 cloud-metadata address), CGNAT, unique-local IPv6, etc.
 *  Built fresh so callers can't mutate a shared instance. */
export function buildPrivateBlockList(): net.BlockList {
  const b = new net.BlockList();
  // ── IPv4 ────────────────────────────────────────────────────────────────
  b.addSubnet('0.0.0.0', 8, 'ipv4');        // "this host on this network"
  b.addSubnet('10.0.0.0', 8, 'ipv4');       // RFC-1918 private
  b.addSubnet('100.64.0.0', 10, 'ipv4');    // RFC-6598 CGNAT
  b.addSubnet('127.0.0.0', 8, 'ipv4');      // loopback
  b.addSubnet('169.254.0.0', 16, 'ipv4');   // link-local (incl. 169.254.169.254 cloud metadata)
  b.addSubnet('172.16.0.0', 12, 'ipv4');    // RFC-1918 private
  b.addSubnet('192.0.0.0', 24, 'ipv4');     // IETF protocol assignments
  b.addSubnet('192.0.2.0', 24, 'ipv4');     // TEST-NET-1
  b.addSubnet('192.168.0.0', 16, 'ipv4');   // RFC-1918 private
  b.addSubnet('198.18.0.0', 15, 'ipv4');    // benchmarking
  b.addSubnet('198.51.100.0', 24, 'ipv4');  // TEST-NET-2
  b.addSubnet('203.0.113.0', 24, 'ipv4');   // TEST-NET-3
  b.addSubnet('224.0.0.0', 4, 'ipv4');      // multicast
  b.addSubnet('240.0.0.0', 4, 'ipv4');      // reserved
  b.addAddress('255.255.255.255', 'ipv4');  // broadcast
  // ── IPv6 ────────────────────────────────────────────────────────────────
  // NOTE: IPv4-mapped IPv6 (::ffff:0:0/96) is deliberately NOT a subnet here — net.BlockList represents
  // every IPv4 internally as its mapped form, so a ::ffff:0:0/96 entry would block ALL IPv4. Mapped
  // addresses are instead DECODED to their embedded IPv4 in isBlockedAddress and judged against the v4
  // ranges, so ::ffff:127.0.0.1 (and the hex-compressed ::ffff:7f00:1) is blocked while ::ffff:8.8.8.8 is
  // treated as the public 8.8.8.8 — consistently across both textual forms.
  b.addAddress('::1', 'ipv6');              // loopback
  b.addAddress('::', 'ipv6');               // unspecified
  b.addSubnet('64:ff9b::', 96, 'ipv6');     // NAT64 well-known prefix (RFC 6052 — embeds IPv4)
  b.addSubnet('64:ff9b:1::', 48, 'ipv6');   // NAT64 local-use prefix (RFC 8215 — also embeds IPv4)
  b.addSubnet('fc00::', 7, 'ipv6');         // unique-local
  b.addSubnet('fe80::', 10, 'ipv6');        // link-local
  b.addSubnet('ff00::', 8, 'ipv6');         // multicast
  b.addSubnet('2001:db8::', 32, 'ipv6');    // documentation
  return b;
}

const DEFAULT_BLOCKLIST = buildPrivateBlockList();

/** Decode an IPv4-mapped IPv6 address (::ffff:X) to its embedded IPv4 string, handling BOTH the dotted form
 *  (::ffff:127.0.0.1) and the hex-compressed form (::ffff:7f00:1) that WHATWG/Node emit. Returns null if the
 *  address isn't IPv4-mapped. So a mapped address is always judged by the IPv4 it actually represents. */
export function mappedToIpv4(address: string): string | null {
  const m = /^::ffff:(.+)$/i.exec(address);
  if (!m) return null;
  const rest = m[1];
  if (net.isIPv4(rest)) return rest; // ::ffff:127.0.0.1
  const parts = rest.split(':'); // ::ffff:7f00:1 → ['7f00','1']
  if (parts.length !== 2) return null;
  const hi = parseInt(parts[0], 16);
  const lo = parseInt(parts[1], 16);
  if (!Number.isFinite(hi) || !Number.isFinite(lo) || hi < 0 || hi > 0xffff || lo < 0 || lo > 0xffff) return null;
  if (!/^[0-9a-f]{1,4}$/i.test(parts[0]) || !/^[0-9a-f]{1,4}$/i.test(parts[1])) return null;
  return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
}

/** Whether an IP is in a blocked (private/loopback/reserved) range — the core SSRF predicate. A value that
 *  isn't even a valid IP is treated as blocked (fail-closed: never reach something we can't classify). An
 *  IPv4-mapped IPv6 is decoded and judged as its embedded IPv4, so the mapped form can't wear an IPv6 coat
 *  past the v4 ranges (nor be over-blocked when it maps to a public address). */
export function isBlockedAddress(address: string, blockList: net.BlockList = DEFAULT_BLOCKLIST): boolean {
  const v = net.isIP(address);
  if (v === 0) return true; // not a valid IP → block
  if (v === 6) {
    const mapped = mappedToIpv4(address);
    if (mapped) return blockList.check(mapped, 'ipv4');
    return blockList.check(address, 'ipv6');
  }
  return blockList.check(address, 'ipv4');
}

/**
 * A `lookup` function (drop-in for node:net/https `lookup`) that resolves a hostname and lets the connection
 * proceed ONLY if EVERY resolved address is public. If any address is blocked, the whole hostname is rejected
 * (we never cherry-pick the public one out of a mixed set — a rebinding attacker could pair a real public
 * record with a private one). This IS the resolver the socket uses, so the validated address is the one
 * connected to — closing the resolve-then-connect rebinding gap.
 */
export function createGuardedLookup(opts: { resolver?: typeof dns.lookup; blockList?: net.BlockList } = {}): LookupFunction {
  const resolver = opts.resolver ?? dns.lookup;
  const blockList = opts.blockList ?? DEFAULT_BLOCKLIST;
  return ((hostname: string, options: unknown, callback: (err: NodeJS.ErrnoException | null, address?: unknown, family?: number) => void) => {
    resolver(hostname, { all: true, verbatim: true }, (err, addresses) => {
      if (err) return callback(err);
      const list = Array.isArray(addresses) ? addresses : [];
      if (list.length === 0) return callback(new SsrfError(`${hostname} did not resolve`) as NodeJS.ErrnoException);
      for (const a of list) {
        if (isBlockedAddress(a.address, blockList)) {
          return callback(new SsrfError(`${hostname} resolves to a blocked address (${a.address})`) as NodeJS.ErrnoException);
        }
      }
      const wantsAll = !!(options && typeof options === 'object' && (options as { all?: boolean }).all);
      if (wantsAll) return callback(null, list as unknown, undefined);
      callback(null, list[0].address, list[0].family);
    });
  }) as LookupFunction;
}

export interface SafeFetchOpts {
  lookup?: LookupFunction;
  maxBytes?: number;
  timeoutMs?: number;
  /** Accept header (config import wants JSON; login-page recon wants HTML). Defaults to application/json. */
  accept?: string;
  /** Blocklist for the literal-IP host pre-check (defaults to the private/reserved set). */
  blockList?: net.BlockList;
  /** Test seam: swap the request implementation (defaults to node:https.request). */
  requestImpl?: typeof https.request;
}

export interface SafePostOpts {
  lookup?: LookupFunction;
  timeoutMs?: number;
  blockList?: net.BlockList;
  requestImpl?: typeof https.request;
}

/**
 * POST an exact JSON payload to a public HTTPS endpoint without a DNS-rebinding
 * window. The guarded lookup is the resolver used by the socket itself; literal
 * private addresses are rejected before connect; redirects are returned to the
 * caller and never followed.
 */
export function postJsonToPublicHttps(
  rawUrl: string,
  body: string,
  headers: Record<string, string>,
  opts: SafePostOpts = {},
): Promise<number> {
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const request = opts.requestImpl ?? https.request;
  const lookup = opts.lookup ?? createGuardedLookup();
  return new Promise((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      reject(new SsrfError('invalid URL'));
      return;
    }
    if (url.protocol !== 'https:') {
      reject(new SsrfError('hosted webhook URLs must use https'));
      return;
    }
    const literalHost = url.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(literalHost) !== 0
      && isBlockedAddress(literalHost, opts.blockList ?? DEFAULT_BLOCKLIST)) {
      reject(new SsrfError(`URL host is a blocked address (${literalHost})`));
      return;
    }
    const req = request(url, {
      method: 'POST',
      lookup,
      timeout: timeoutMs,
      headers: {
        ...headers,
        'content-length': String(Buffer.byteLength(body)),
      },
    }, (res) => {
      const status = res.statusCode ?? 0;
      // Drain but never follow a redirect and never buffer an attacker-controlled
      // response body. The status alone drives retry/permanent-error policy.
      res.resume();
      res.on('end', () => resolve(status));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new SsrfError(`webhook request timed out after ${timeoutMs}ms`)));
    req.on('error', (error) => reject(
      error instanceof SsrfError
        ? error
        : new SsrfError(`webhook request failed: ${error.message}`),
    ));
    req.end(body);
  });
}

/**
 * Fetch a URL's body as text under the SSRF guard: https-only, guarded-lookup DNS pinning, no redirect
 * following, a size cap, and a timeout. Throws SsrfError on any guard trip (bad scheme, blocked address,
 * redirect, oversize, timeout, non-200). Never returns a partial/oversize body.
 */
export function fetchTextFromUrl(rawUrl: string, opts: SafeFetchOpts = {}): Promise<string> {
  const maxBytes = opts.maxBytes ?? 1_000_000; // 1 MB — a config recipe is small
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const lookup = opts.lookup ?? createGuardedLookup();
  const request = opts.requestImpl ?? https.request;

  return new Promise((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return reject(new SsrfError('invalid URL'));
    }
    if (url.protocol !== 'https:') return reject(new SsrfError(`only https:// URLs may be imported (got ${url.protocol})`));

    // CRITICAL: when the host is a LITERAL IP, node:https does NOT call our `lookup` (there is nothing to
    // resolve) — it connects directly, so the guarded lookup would be bypassed entirely. We must classify the
    // literal here, BEFORE the request. WHATWG URL has already normalized encoded IPv4 forms (0x7f000001,
    // 2130706433, 0177.0.0.1 → 127.0.0.1); strip IPv6 brackets ([::1] → ::1). A literal PUBLIC IP is allowed
    // (a fixed IP has no rebinding risk); a private/reserved/mapped one is refused before any socket.
    const literalHost = url.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(literalHost) !== 0 && isBlockedAddress(literalHost, opts.blockList ?? DEFAULT_BLOCKLIST)) {
      return reject(new SsrfError(`URL host is a blocked address (${literalHost})`));
    }

    const req = request(
      url,
      { method: 'GET', lookup, timeout: timeoutMs, headers: { accept: opts.accept ?? 'application/json', 'user-agent': 'accrawl-config-import' } },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status !== 200) {
          // Redirects (3xx) and errors are NOT followed — we fetch the EXACT operator-approved URL only.
          res.resume();
          return reject(new SsrfError(`import URL returned ${status} (redirects are not followed)`));
        }
        let size = 0;
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            req.destroy();
            reject(new SsrfError(`import response exceeds ${maxBytes}-byte cap`));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new SsrfError(`import request timed out after ${timeoutMs}ms`)));
    req.on('error', (err) => reject(err instanceof SsrfError ? err : new SsrfError(`import request failed: ${err.message}`)));
    req.end();
  });
}
