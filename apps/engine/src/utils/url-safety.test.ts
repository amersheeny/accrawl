import { describe, it, expect } from 'vitest';
import { assertSafeNavigationUrl, type HostResolver } from './url-safety';

// Deterministic resolvers so tests never hit real DNS. `pub` makes any hostname resolve to a public IP so the
// pre-resolution (scheme / IP-literal / blocked-hostname) checks are exercised in isolation.
const pub: HostResolver = async () => ['203.0.113.10']; // TEST-NET-3, public
const toIp = (ip: string): HostResolver => async () => [ip];
const dnsFails: HostResolver = async () => { throw new Error('DNS lookup failed'); };

describe('assertSafeNavigationUrl', () => {
  it('allows ordinary public https bank URLs (hostname resolves to a public IP)', async () => {
    await expect(assertSafeNavigationUrl('https://www.chase.com/login', pub)).resolves.toBeUndefined();
    await expect(assertSafeNavigationUrl('https://login.bankhapoalim.co.il/', pub)).resolves.toBeUndefined();
    await expect(assertSafeNavigationUrl('http://example.com/path?q=1', pub)).resolves.toBeUndefined();
    // A public IP literal is fine (resolver not consulted).
    await expect(assertSafeNavigationUrl('https://8.8.8.8/', pub)).resolves.toBeUndefined();
  });

  it('rejects non-http(s) schemes', async () => {
    await expect(assertSafeNavigationUrl('file:///etc/passwd', pub)).rejects.toThrow();
    await expect(assertSafeNavigationUrl('ftp://example.com/', pub)).rejects.toThrow();
    await expect(assertSafeNavigationUrl('gopher://example.com/', pub)).rejects.toThrow();
  });

  it('rejects the GCP metadata server (the canonical SSRF target)', async () => {
    await expect(assertSafeNavigationUrl('http://169.254.169.254/computeMetadata/v1/', pub)).rejects.toThrow();
    await expect(assertSafeNavigationUrl('http://metadata.google.internal/', pub)).rejects.toThrow();
    await expect(assertSafeNavigationUrl('http://metadata/', pub)).rejects.toThrow();
  });

  it('rejects loopback and localhost', async () => {
    await expect(assertSafeNavigationUrl('http://127.0.0.1:8080/', pub)).rejects.toThrow();
    await expect(assertSafeNavigationUrl('http://localhost/', pub)).rejects.toThrow();
    await expect(assertSafeNavigationUrl('http://foo.localhost/', pub)).rejects.toThrow();
    await expect(assertSafeNavigationUrl('http://[::1]/', pub)).rejects.toThrow();
  });

  it('rejects RFC1918 / link-local / CGNAT IPv4 ranges', async () => {
    for (const u of ['http://10.0.0.5/', 'http://172.16.0.1/', 'http://172.31.255.255/', 'http://192.168.1.1/', 'http://169.254.10.10/', 'http://100.64.0.1/', 'http://0.0.0.0/']) {
      await expect(assertSafeNavigationUrl(u, pub)).rejects.toThrow();
    }
  });

  it('allows public ranges adjacent to private ones', async () => {
    for (const u of ['http://172.15.0.1/', 'http://172.32.0.1/', 'http://192.169.0.1/']) {
      await expect(assertSafeNavigationUrl(u, pub)).resolves.toBeUndefined();
    }
  });

  it('rejects private IPv6 (ULA / link-local) and v4-mapped internal', async () => {
    for (const u of ['http://[fc00::1]/', 'http://[fd12:3456::1]/', 'http://[fe80::1]/', 'http://[::ffff:127.0.0.1]/']) {
      await expect(assertSafeNavigationUrl(u, pub)).rejects.toThrow();
    }
  });

  it('rejects trailing-dot FQDNs of blocked hosts (normalization bypass)', async () => {
    await expect(assertSafeNavigationUrl('http://metadata.google.internal./', pub)).rejects.toThrow();
    await expect(assertSafeNavigationUrl('http://localhost./', pub)).rejects.toThrow();
    await expect(assertSafeNavigationUrl('http://foo.localhost./', pub)).rejects.toThrow();
  });

  it('rejects integer / hex / octal IPv4 forms (URL parser normalizes them)', async () => {
    for (const u of ['http://2130706433/', 'http://0x7f000001/', 'http://017700000001/', 'http://0177.0.0.1/']) {
      await expect(assertSafeNavigationUrl(u, pub)).rejects.toThrow();
    }
  });

  it('ignores userinfo and checks the real host', async () => {
    await expect(assertSafeNavigationUrl('http://expected@169.254.169.254/', pub)).rejects.toThrow();
  });

  it('rejects IPv6 site-local, multicast, and IPv4-compatible internal addresses', async () => {
    for (const u of ['http://[fec0::1]/', 'http://[ff02::1]/', 'http://[::a9fe:a9fe]/', 'http://[::ffff:169.254.169.254]/']) {
      await expect(assertSafeNavigationUrl(u, pub)).rejects.toThrow();
    }
  });

  it('still allows ordinary public IPv6', async () => {
    await expect(assertSafeNavigationUrl('https://[2606:4700:4700::1111]/', pub)).resolves.toBeUndefined();
  });

  it('rejects malformed URLs', async () => {
    await expect(assertSafeNavigationUrl('not a url', pub)).rejects.toThrow();
    await expect(assertSafeNavigationUrl('', pub)).rejects.toThrow();
  });

  // NEW: DNS-based SSRF — a public-LOOKING hostname whose A/AAAA record is internal must be rejected.
  it('rejects a public hostname that RESOLVES to an internal IP (DNS SSRF)', async () => {
    await expect(assertSafeNavigationUrl('https://rebind.attacker.example/', toIp('169.254.169.254'))).rejects.toThrow();
    await expect(assertSafeNavigationUrl('https://rebind.attacker.example/', toIp('127.0.0.1'))).rejects.toThrow();
    await expect(assertSafeNavigationUrl('https://rebind.attacker.example/', toIp('10.1.2.3'))).rejects.toThrow();
    await expect(assertSafeNavigationUrl('https://rebind.attacker.example/', toIp('fc00::1'))).rejects.toThrow();
    // Rejects if ANY of several resolved records is internal (not just the first).
    await expect(assertSafeNavigationUrl('https://multi.example/', async () => ['203.0.113.5', '10.0.0.9'])).rejects.toThrow();
  });

  it('allows a hostname that resolves to a public IP, and FAILS OPEN on a resolution error', async () => {
    await expect(assertSafeNavigationUrl('https://realbank.example/', toIp('203.0.113.7'))).resolves.toBeUndefined();
    // A DNS hiccup must not block a legit crawl — the browser will fail to connect to an unresolvable host anyway.
    await expect(assertSafeNavigationUrl('https://transient.example/', dnsFails)).resolves.toBeUndefined();
  });
});
