/**
 * Which browser contexts send their traffic through a phone's tunnel, and where to read the addresses that
 * phone reached.
 *
 * A context whose egress runs through the engine's local SOCKS5 relay never learns the bank's address from
 * the browser: Playwright's response.serverAddr() reports the relay (127.0.0.1) for every response. The
 * phone opens the real connection, so its report of the address it reached is the only one there is.
 */
import { isIP } from 'node:net';
import type { BrowserContext, Page } from 'playwright';

/** The addresses the phone reported reaching for host:port during this crawl; empty when it reported none. */
export type TunnelPeers = (host: string, port: number) => readonly string[];

const tunnelled = new WeakMap<BrowserContext, TunnelPeers>();

export function markTunnelled(context: BrowserContext, peers: TunnelPeers): void {
  tunnelled.set(context, peers);
}

export function tunnelPeersOf(page: Page): TunnelPeers | undefined {
  return tunnelled.get(page.context());
}

/**
 * One spelling per address, so a peer the phone reported can be compared with the private ranges and matched
 * against the host the browser asked for. Java prints IPv6 uncompressed (0:0:0:0:0:0:0:1) and may append a
 * zone (%wlan0); the range checks only recognise the compressed form, so an uncanonicalised loopback would
 * pass as public. Returns null for anything that is not an IP address.
 */
export function canonicalIp(raw: string): string | null {
  const ip = raw.trim().replace(/^\[|\]$/gu, '').replace(/%.*$/u, '');
  if (isIP(ip) === 4) return ip;
  if (isIP(ip) !== 6) return null;
  return new URL(`http://[${ip}]/`).hostname.slice(1, -1);
}

/** The key a tunnel connection's target and a navigated URL's origin share. */
export function peerKey(host: string, port: number): string {
  const name = host.trim().toLowerCase().replace(/^\[|\]$/gu, '');
  return `${canonicalIp(name) ?? name}:${port}`;
}
