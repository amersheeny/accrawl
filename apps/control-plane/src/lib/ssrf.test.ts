import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  isBlockedAddress,
  createGuardedLookup,
  fetchTextFromUrl,
  postJsonToPublicHttps,
  buildPrivateBlockList,
  SsrfError,
} from './ssrf';

describe('isBlockedAddress', () => {
  it('blocks loopback / private / link-local / metadata / reserved (IPv4 + IPv6)', () => {
    const blocked = [
      '127.0.0.1', '127.1.2.3', '0.0.0.0', '10.0.0.1', '10.255.255.255', '172.16.0.1', '172.31.255.255',
      '192.168.1.1', '169.254.169.254' /* cloud metadata */, '100.64.0.1' /* CGNAT */, '198.18.0.1',
      '255.255.255.255', '224.0.0.1' /* multicast */, '240.0.0.1' /* reserved */,
      '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1',
      '::ffff:127.0.0.1' /* IPv4-mapped loopback must not sneak past */, '::ffff:10.0.0.1',
      '::ffff:7f00:1' /* hex-compressed mapped loopback decodes to 127.0.0.1 */,
      '64:ff9b::7f00:1' /* NAT64 well-known (RFC 6052) */, '64:ff9b:1::a9fe:a9fe' /* NAT64 local-use (RFC 8215) */,
      'not-an-ip', '', '999.999.999.999',
    ];
    for (const ip of blocked) expect(isBlockedAddress(ip), `${ip} should be blocked`).toBe(true);
  });

  it('allows genuine public addresses (incl. an IPv4-mapped PUBLIC address, judged by its embedded IPv4)', () => {
    const ok = ['1.1.1.1', '8.8.8.8', '93.184.216.34', '172.15.0.1' /* just outside 172.16/12 */, '172.32.0.1',
      '2606:4700:4700::1111', '2001:4860:4860::8888',
      '::ffff:8.8.8.8' /* mapped public → 8.8.8.8 */, '::ffff:808:808' /* hex-compressed mapped public → 8.8.8.8 */];
    for (const ip of ok) expect(isBlockedAddress(ip), `${ip} should be allowed`).toBe(false);
  });
});

// A dns.lookup-shaped fake resolver returning a fixed address set (callback form used by createGuardedLookup).
const resolverReturning = (...addrs: { address: string; family: number }[]) =>
  ((_host: string, _opts: unknown, cb: (e: Error | null, a?: unknown) => void) => cb(null, addrs)) as unknown as typeof import('node:dns').lookup;

describe('createGuardedLookup', () => {
  const call = (lookup: ReturnType<typeof createGuardedLookup>, all = false) =>
    new Promise<{ err: Error | null; address?: unknown; family?: number }>((resolve) => {
      (lookup as unknown as (h: string, o: unknown, cb: (e: Error | null, a?: unknown, f?: number) => void) => void)(
        'bank.example', { all }, (err, address, family) => resolve({ err, address, family }),
      );
    });

  it('passes a hostname that resolves to only-public addresses', async () => {
    const r = await call(createGuardedLookup({ resolver: resolverReturning({ address: '1.2.3.4', family: 4 }) }));
    expect(r.err).toBeNull();
    expect(r.address).toBe('1.2.3.4');
    expect(r.family).toBe(4);
  });

  it('REJECTS when any resolved address is private (a rebinding pair public+private is rejected wholesale)', async () => {
    const mixed = createGuardedLookup({ resolver: resolverReturning({ address: '1.2.3.4', family: 4 }, { address: '169.254.169.254', family: 4 }) });
    const r = await call(mixed);
    expect(r.err).toBeInstanceOf(SsrfError);
    expect(r.err?.message).toMatch(/blocked address/);
  });

  it('rejects an empty resolution and propagates a resolver error', async () => {
    expect((await call(createGuardedLookup({ resolver: resolverReturning() }))).err).toBeInstanceOf(SsrfError);
    const boom = ((_h: string, _o: unknown, cb: (e: Error) => void) => cb(new Error('dns fail'))) as unknown as typeof import('node:dns').lookup;
    expect((await call(createGuardedLookup({ resolver: boom }))).err?.message).toMatch(/dns fail/);
  });

  it('honors the all:true option shape (returns the array)', async () => {
    const r = await call(createGuardedLookup({ resolver: resolverReturning({ address: '1.2.3.4', family: 4 }) }), true);
    expect(r.err).toBeNull();
    expect(r.address).toEqual([{ address: '1.2.3.4', family: 4 }]);
  });

  it('uses an injected blocklist (loopback allowed only when the test blocklist permits it)', async () => {
    const permissive = new (buildPrivateBlockList().constructor as new () => import('node:net').BlockList)(); // empty blocklist blocks nothing
    const r = await call(createGuardedLookup({ resolver: resolverReturning({ address: '127.0.0.1', family: 4 }), blockList: permissive }));
    expect(r.err).toBeNull();
    expect(r.address).toBe('127.0.0.1');
  });
});

describe('fetchTextFromUrl — scheme + guard wiring', () => {
  it('rejects a non-https URL without any network', async () => {
    await expect(fetchTextFromUrl('http://example.com/config.json')).rejects.toBeInstanceOf(SsrfError);
    await expect(fetchTextFromUrl('http://example.com/config.json')).rejects.toThrow(/only https/);
  });

  it('rejects an unparseable URL', async () => {
    await expect(fetchTextFromUrl('not a url')).rejects.toThrow(/invalid URL/);
  });

  it('the guarded lookup IS honored by the real node:https path: a private-resolving host is refused before connect', async () => {
    // The lookup returns 127.0.0.1 (blocked) via an injected resolver, so the REAL https.request must fail
    // with the guard's SsrfError — proving node:https actually routes DNS through our lookup (not the OS).
    const lookup = createGuardedLookup({ resolver: resolverReturning({ address: '127.0.0.1', family: 4 }) });
    await expect(fetchTextFromUrl('https://bank.example/config.json', { lookup, timeoutMs: 2000 })).rejects.toThrow(/blocked address/);
  });

  it('BLOCKS a literal private-IP host — node:https skips lookup for literal IPs, so the pre-check must catch it', async () => {
    // Fail-before/pass-after: without the literal-IP pre-check, node connects directly (guard bypassed).
    // A lookup that would THROW if called proves the rejection comes from the pre-check, not the lookup.
    const throwingLookup = createGuardedLookup({ resolver: resolverReturning({ address: '9.9.9.9', family: 4 }) });
    for (const url of [
      'https://127.0.0.1/x', 'https://169.254.169.254/latest/meta-data/', 'https://10.0.0.5:8443/x',
      'https://[::1]/x', 'https://[::ffff:127.0.0.1]/x',
      'https://2130706433/x' /* decimal 127.0.0.1 */, 'https://0x7f000001/x' /* hex */, 'https://0177.0.0.1/x' /* octal */,
    ]) {
      await expect(fetchTextFromUrl(url, { lookup: throwingLookup, timeoutMs: 1500 }), url).rejects.toThrow(/blocked address/);
    }
  });
});

// A fake https.request driving the response-handling logic (200-only, size cap, redirect reject) deterministically.
function fakeHttps(opts: { status?: number; chunks?: Buffer[] }): typeof import('node:https').request {
  return ((_url: URL, _options: unknown, cb: (res: unknown) => void) => {
    const req = new EventEmitter() as EventEmitter & { end: () => void; destroy: (e?: Error) => void };
    req.end = () => {};
    req.destroy = () => {};
    const res = new EventEmitter() as EventEmitter & { statusCode: number; resume: () => void };
    res.statusCode = opts.status ?? 200;
    res.resume = () => {};
    setImmediate(() => {
      cb(res);
      if ((opts.status ?? 200) !== 200) return; // fetch bails on non-200 before reading
      for (const c of opts.chunks ?? []) res.emit('data', c);
      res.emit('end');
    });
    return req;
  }) as unknown as typeof import('node:https').request;
}

describe('fetchTextFromUrl — response handling (injected request)', () => {
  const noop = createGuardedLookup({ resolver: resolverReturning({ address: '1.2.3.4', family: 4 }) });

  it('returns the body on a 200', async () => {
    const body = JSON.stringify({ id: 'x' });
    const text = await fetchTextFromUrl('https://ok.example/c.json', { lookup: noop, requestImpl: fakeHttps({ chunks: [Buffer.from(body)] }) });
    expect(text).toBe(body);
  });

  it('ALLOWS a literal PUBLIC IP host (a fixed public IP has no rebinding risk — must not be over-blocked)', async () => {
    const body = JSON.stringify({ id: 'y' });
    const text = await fetchTextFromUrl('https://8.8.8.8/c.json', { lookup: noop, requestImpl: fakeHttps({ chunks: [Buffer.from(body)] }) });
    expect(text).toBe(body);
  });

  it('rejects a redirect (3xx) — never chases into an internal target', async () => {
    await expect(
      fetchTextFromUrl('https://redir.example/', { lookup: noop, requestImpl: fakeHttps({ status: 302 }) }),
    ).rejects.toThrow(/returned 302/);
  });

  it('rejects a non-200 error status', async () => {
    await expect(
      fetchTextFromUrl('https://err.example/', { lookup: noop, requestImpl: fakeHttps({ status: 500 }) }),
    ).rejects.toThrow(/returned 500/);
  });

  it('enforces the size cap (a hostile endpoint cannot stream past maxBytes)', async () => {
    const big = fakeHttps({ chunks: [Buffer.alloc(600), Buffer.alloc(600)] });
    await expect(
      fetchTextFromUrl('https://big.example/', { lookup: noop, requestImpl: big, maxBytes: 1000 }),
    ).rejects.toThrow(/exceeds 1000-byte cap/);
  });
});

function fakePostHttps(
  status: number,
  captured: {
    body?: string;
    options?: {
      headers?: Record<string, string>;
      lookup?: unknown;
      method?: string;
      timeout?: number;
    };
  } = {},
): typeof import('node:https').request {
  return ((_url: URL, options: typeof captured.options, cb: (res: unknown) => void) => {
    captured.options = options;
    const req = new EventEmitter() as EventEmitter & {
      destroy: (error?: Error) => void;
      end: (body?: string) => void;
    };
    req.destroy = (error?: Error) => {
      if (error) req.emit('error', error);
    };
    req.end = (body?: string) => {
      captured.body = body;
      const res = new EventEmitter() as EventEmitter & {
        resume: () => void;
        statusCode: number;
      };
      res.statusCode = status;
      res.resume = () => {};
      setImmediate(() => {
        cb(res);
        res.emit('end');
      });
    };
    return req;
  }) as unknown as typeof import('node:https').request;
}

describe('postJsonToPublicHttps', () => {
  const publicLookup = createGuardedLookup({
    resolver: resolverReturning({ address: '1.2.3.4', family: 4 }),
  });

  it('rejects malformed, plaintext, and literal private webhook URLs before connect', async () => {
    const requestImpl = vi.fn();
    for (const url of [
      'not a url',
      'http://hooks.example/webhook',
      'https://127.0.0.1/webhook',
      'https://169.254.169.254/latest/meta-data',
      'https://[::1]/webhook',
      'https://2130706433/webhook',
    ]) {
      await expect(postJsonToPublicHttps(
        url,
        '{}',
        {},
        { lookup: publicLookup, requestImpl: requestImpl as never },
      ), url).rejects.toBeInstanceOf(SsrfError);
    }
    expect(requestImpl).not.toHaveBeenCalled();
  });

  it('uses the guarded socket lookup so a private DNS result is refused before connect', async () => {
    const privateLookup = createGuardedLookup({
      resolver: resolverReturning({ address: '10.0.0.8', family: 4 }),
    });
    await expect(postJsonToPublicHttps(
      'https://hooks.example/webhook',
      '{}',
      {},
      { lookup: privateLookup, timeoutMs: 2_000 },
    )).rejects.toThrow(/blocked address/);
  });

  it('posts the exact payload with a pinned lookup and returns, but never follows, redirects', async () => {
    const captured: Parameters<typeof fakePostHttps>[1] = {};
    const body = JSON.stringify({ event: 'crawl.completed' });
    const status = await postJsonToPublicHttps(
      'https://hooks.example/webhook',
      body,
      { authorization: 'Bearer test-signature' },
      {
        lookup: publicLookup,
        timeoutMs: 1_234,
        requestImpl: fakePostHttps(307, captured),
      },
    );

    expect(status).toBe(307);
    expect(captured.body).toBe(body);
    expect(captured.options).toMatchObject({
      method: 'POST',
      lookup: publicLookup,
      timeout: 1_234,
      headers: {
        authorization: 'Bearer test-signature',
        'content-length': String(Buffer.byteLength(body)),
      },
    });
  });
});
