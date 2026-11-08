import { describe, it, expect } from 'vitest';
import {
  assertSafeNavigationUrl,
  assertConnectedAddressIsPublic,
  ConnectedAddressRefusedError,
  type HostResolver,
} from './url-safety';

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

describe('assertConnectedAddressIsPublic', () => {
  const response = (ipAddress: string | null, url = 'https://bank.example/x') => ({
    serverAddr: async () => (ipAddress ? { ipAddress } : null),
    url: () => url,
  });

  it('catches the rebind the name check cannot: public at lookup, internal at connect', async () => {
    // This is the attack. The pre-flight check saw a public A record and allowed the name; by the
    // time the browser connected, DNS answered with the metadata address instead.
    await expect(assertConnectedAddressIsPublic(response('169.254.169.254'), 'https://bank.example/x'))
      .rejects.toThrow(/private\/internal address/);
  });

  it('refuses every internal range the pre-flight check refuses', async () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '::1', 'fd00::1', 'fe80::1']) {
      await expect(assertConnectedAddressIsPublic(response(ip), 'https://bank.example/x'))
        .rejects.toThrow(/private\/internal address/);
    }
  });

  it('allows a genuinely public peer', async () => {
    for (const ip of ['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946']) {
      await expect(assertConnectedAddressIsPublic(response(ip), 'https://bank.example/x')).resolves.toBeUndefined();
    }
  });

  it('allows an internal peer only for a host the deployment declared, and never in production', async () => {
    const declared = { NODE_ENV: 'test', ACCRAWL_ALLOW_PRIVATE_CRAWL_TARGETS: 'bank.example' } as NodeJS.ProcessEnv;
    await expect(assertConnectedAddressIsPublic(response('127.0.0.1'), 'https://bank.example/x', declared))
      .resolves.toBeUndefined();
    // a different host is not covered by that declaration
    await expect(assertConnectedAddressIsPublic(response('127.0.0.1'), 'https://other.example/x', declared))
      .rejects.toThrow(/private\/internal address/);
    // An undeclared deployment is unaffected: with nothing listed, nothing is allowed.
    for (const env of [{}, { NODE_ENV: 'production' }] as NodeJS.ProcessEnv[]) {
      await expect(assertConnectedAddressIsPublic(response('127.0.0.1'), 'https://bank.example/x', env))
        .rejects.toThrow(/private\/internal address/);
    }
  });

  it('honours a declaration in production too, because an on-premises bank is a real deployment', () => {
    // Gating this on NODE_ENV would have made the packaged end-to-end run impossible — its worker must
    // stay at NODE_ENV=production or the control plane refuses to trust it — and would have blocked
    // the self-hoster whose institution is only reachable inside their own network.
    const prod = {
      NODE_ENV: 'production',
      ACCRAWL_ALLOW_PRIVATE_CRAWL_TARGETS: 'bank.internal',
    } as NodeJS.ProcessEnv;
    return expect(assertConnectedAddressIsPublic(response('10.0.0.5'), 'https://bank.internal/x', prod))
      .resolves.toBeUndefined();
  });

  it('says nothing when there is no navigation or no peer address to inspect', async () => {
    await expect(assertConnectedAddressIsPublic(null, 'https://bank.example/x')).resolves.toBeUndefined();
    await expect(assertConnectedAddressIsPublic(response(null), 'https://bank.example/x')).resolves.toBeUndefined();
  });

  it('refuses with its own error type, while the name check before loading anything keeps a plain error', async () => {
    await expect(assertConnectedAddressIsPublic(response('10.0.0.5'), 'https://bank.example/x'))
      .rejects.toBeInstanceOf(ConnectedAddressRefusedError);
    const nameRefusal = await assertSafeNavigationUrl('http://10.0.0.5/', pub).catch((error: unknown) => error);
    expect(nameRefusal).toBeInstanceOf(Error);
    expect(nameRefusal).not.toBeInstanceOf(ConnectedAddressRefusedError);
  });

  describe('through a phone tunnel', () => {
    // The browser's peer is the engine's own SOCKS relay, whatever the phone reached.
    const relayed = (url = 'https://bank.example/x') => response('127.0.0.1', url);
    const reported = (byTarget: Record<string, string[]>) => (host: string, port: number) => byTarget[`${host}:${port}`] ?? [];

    it('checks the address the phone reached instead of the relay', async () => {
      const peers = reported({ 'bank.example:443': ['93.184.216.34'] });
      await expect(assertConnectedAddressIsPublic(relayed(), 'https://bank.example/x', {}, peers)).resolves.toBeUndefined();
    });

    it('refuses an internal address the phone reached, naming it', async () => {
      const peers = reported({ 'bank.example:443': ['93.184.216.34', '10.0.0.5'] });
      await expect(assertConnectedAddressIsPublic(relayed(), 'https://bank.example/x', {}, peers))
        .rejects.toThrow('navigate target resolves to a private/internal address (bank.example -> 10.0.0.5)');
      await expect(assertConnectedAddressIsPublic(relayed(), 'https://bank.example/x', {}, peers))
        .rejects.toBeInstanceOf(ConnectedAddressRefusedError);
    });

    it('looks up the origin of the response that arrived, with its port', async () => {
      const peers = reported({ 'login.bank.example:8443': ['192.168.1.1'] });
      await expect(assertConnectedAddressIsPublic(
        relayed('https://login.bank.example:8443/start'), 'https://bank.example/x', {}, peers,
      )).rejects.toThrow(/login\.bank\.example -> 192\.168\.1\.1/);
    });

    it('leaves the name check standing alone when the phone reported nothing', async () => {
      await expect(assertConnectedAddressIsPublic(relayed(), 'https://bank.example/x', {}, reported({})))
        .resolves.toBeUndefined();
    });

    it('still honours a declared private host', async () => {
      const declared = { ACCRAWL_ALLOW_PRIVATE_CRAWL_TARGETS: 'bank.example' } as NodeJS.ProcessEnv;
      const peers = reported({ 'bank.example:443': ['10.0.0.5'] });
      await expect(assertConnectedAddressIsPublic(relayed(), 'https://bank.example/x', declared, peers))
        .resolves.toBeUndefined();
    });

    it('exempts a declared host the navigation was redirected to', async () => {
      const declared = { ACCRAWL_ALLOW_PRIVATE_CRAWL_TARGETS: 'intranet.bank.example' } as NodeJS.ProcessEnv;
      const peers = reported({ 'intranet.bank.example:443': ['10.0.0.5'] });
      await expect(assertConnectedAddressIsPublic(
        relayed('https://intranet.bank.example/home'), 'https://bank.example/x', declared, peers,
      )).resolves.toBeUndefined();
    });

    it('does not let the starting host\'s declaration cover the host it redirected to', async () => {
      const declared = { ACCRAWL_ALLOW_PRIVATE_CRAWL_TARGETS: 'bank.example' } as NodeJS.ProcessEnv;
      const peers = reported({ 'intranet.bank.example:443': ['10.0.0.5'] });
      await expect(assertConnectedAddressIsPublic(
        relayed('https://intranet.bank.example/home'), 'https://bank.example/x', declared, peers,
      )).rejects.toThrow(/intranet\.bank\.example -> 10\.0\.0\.5/);
    });
  });
});
