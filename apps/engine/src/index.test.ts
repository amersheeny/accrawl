import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Express } from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { buildRecentTransactionHistory } from '@accrawl/contracts';

const tunnelMocks = vi.hoisted(() => ({
  attachTunnelHandler: vi.fn(),
  closeTunnel: vi.fn(),
  fenceCrawl: vi.fn(async () => undefined),
}));
const crawlMocks = vi.hoisted(() => ({
  executeCrawl: vi.fn(),
  activeSessions: new Map(),
  cancelExecution: vi.fn(async () => true),
  hasActiveExecution: vi.fn(() => false),
}));

// The index module imports the tunnel server and the crawl executor at load time. Stub these so
// importing the app factory has no side effects (no browser pool) during the unit test.
vi.mock('./tunnel/tunnel-server', () => ({
  ...tunnelMocks,
}));
vi.mock('./crawl-executor', () => crawlMocks);
vi.mock('./browser/browser-pool', () => ({
  closeBrowser: vi.fn(),
}));

import {
  resolveServiceMode,
  modeEnablesCrawlRoutes,
  modeEnablesTunnel,
  createApp,
  type ServiceMode,
} from './index';
// The same mocked module the app imports — assert the crawl executor is (not) reached.
import { activeSessions, executeCrawl } from './crawl-executor';

/** Extract registered { path, method } route entries from an Express app. */
function registeredRoutes(app: Express): Array<{ path: string; methods: string[] }> {
  // Express 5 exposes the router as app.router.
  const router = (app as unknown as { router?: { stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }> } }).router;
  const stack = router?.stack ?? [];
  return stack
    .filter((layer) => layer.route)
    .map((layer) => ({
      path: layer.route!.path,
      methods: Object.keys(layer.route!.methods),
    }));
}

function hasRoute(app: Express, path: string, method: string): boolean {
  return registeredRoutes(app).some((r) => r.path === path && r.methods.includes(method));
}

describe('resolveServiceMode', () => {
  it('maps unset / empty / "development" to development', () => {
    expect(resolveServiceMode(undefined)).toBe('development');
    expect(resolveServiceMode('')).toBe('development');
    expect(resolveServiceMode('development')).toBe('development');
  });

  it('maps "crawl" and "tunnel" to themselves', () => {
    expect(resolveServiceMode('crawl')).toBe('crawl');
    expect(resolveServiceMode('tunnel')).toBe('tunnel');
  });

  it('throws on an unrecognized mode rather than defaulting to everything-on', () => {
    expect(() => resolveServiceMode('crawler')).toThrow(/Invalid SERVICE_MODE/);
    expect(() => resolveServiceMode('TUNNEL')).toThrow(/Invalid SERVICE_MODE/);
  });
});

describe('mode capability flags', () => {
  it('crawl mode enables crawl routes but not the tunnel (a hosted split: non-postgres)', () => {
    expect(modeEnablesCrawlRoutes('crawl')).toBe(true);
    expect(modeEnablesTunnel('crawl', 'remote')).toBe(false);
    expect(modeEnablesTunnel('crawl', 'local')).toBe(false);
    expect(modeEnablesTunnel('crawl', undefined)).toBe(false);
  });

  it('crawl mode ALSO serves the tunnel under self-host (PLATFORM=postgres): one container, both surfaces', () => {
    expect(modeEnablesCrawlRoutes('crawl')).toBe(true);
    expect(modeEnablesTunnel('crawl', 'postgres')).toBe(true);
    expect(modeEnablesTunnel('crawl', 'POSTGRES')).toBe(true); // case-insensitive
  });

  it('tunnel mode enables the tunnel but not crawl routes (any platform)', () => {
    expect(modeEnablesCrawlRoutes('tunnel')).toBe(false);
    expect(modeEnablesTunnel('tunnel', 'postgres')).toBe(true);
    expect(modeEnablesTunnel('tunnel', 'remote')).toBe(true);
  });

  it('development mode enables everything (any platform)', () => {
    expect(modeEnablesCrawlRoutes('development')).toBe(true);
    expect(modeEnablesTunnel('development', 'local')).toBe(true);
    expect(modeEnablesTunnel('development', 'postgres')).toBe(true);
  });
});

describe('createApp route registration per mode', () => {
  it('crawl mode registers /crawl and /cancel/:sessionId plus health', () => {
    const app = createApp('crawl');
    expect(hasRoute(app, '/', 'get')).toBe(true);
    expect(hasRoute(app, '/crawl', 'post')).toBe(true);
    expect(hasRoute(app, '/crawl/transaction-history', 'post')).toBe(true);
    expect(hasRoute(app, '/cancel/:sessionId', 'post')).toBe(true);
  });

  it('tunnel mode registers ONLY health — no /crawl or /cancel on the public service', () => {
    const app = createApp('tunnel');
    expect(hasRoute(app, '/', 'get')).toBe(true);
    expect(hasRoute(app, '/crawl', 'post')).toBe(false);
    expect(hasRoute(app, '/crawl/transaction-history', 'post')).toBe(false);
    expect(hasRoute(app, '/cancel/:sessionId', 'post')).toBe(false);
  });

  it('development mode registers crawl routes (tunnel is attached separately at server start)', () => {
    const app = createApp('development');
    expect(hasRoute(app, '/crawl', 'post')).toBe(true);
    expect(hasRoute(app, '/cancel/:sessionId', 'post')).toBe(true);
  });

  it('every mode always exposes the health endpoint', () => {
    for (const mode of ['crawl', 'tunnel', 'development'] as ServiceMode[]) {
      expect(hasRoute(createApp(mode), '/', 'get')).toBe(true);
    }
  });
});

describe('POST /crawl — fail-closed dispatch', () => {
  // Drive the real handler over HTTP. verifyOidcToken is a no-op outside a hosted runtime with no
  // ENGINE_SHARED_SECRET (pure local dev — the endpoint is open), so the request reaches the route
  // body and we observe whether executeCrawl is called. We never mock the route itself.
  let server: Server | null = null;

  afterEach(async () => {
    vi.mocked(executeCrawl).mockClear();
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }
    delete process.env.K_SERVICE;
    delete process.env.ENGINE_SHARED_SECRET;
    delete process.env.PLATFORM; // default (local) contract unless a test opts into postgres
  });

  async function startCrawlApp(): Promise<string> {
    const app = createApp('crawl');
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    const port = (server!.address() as AddressInfo).port;
    return `http://127.0.0.1:${port}`;
  }

  /** Boot the crawl app on an ephemeral port and POST `body` to /crawl; return { status, json }. */
  async function postCrawl(body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
    const origin = await startCrawlApp();
    const res = await fetch(`${origin}/crawl`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    // The mocked executeCrawl returns undefined -> the pre-fix fall-through leaves an empty body.
    // Tolerate that so the assertions (status, executeCrawl-not-called) surface the defect, not a parse crash.
    const text = await res.text();
    const json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    return { status: res.status, json };
  }

  /** A schema-valid CrawlRequest body; spread `over` to vary the device-proxy fields. */
  function crawlBody(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      sessionId: 'sess-failclosed',
      loginUrl: 'https://example.com/login',
      username: 'u',
      password: 'p',
      requires2fa: false,
      maxSteps: 10,
      timeoutSeconds: 60,
      ...over,
    };
  }

  function recentTransaction(providerTransactionId: string) {
    return {
      providerAccountId: 'account-a',
      providerTransactionId,
      bookingDate: '2026-07-25',
      amount: -10,
      currency: 'GBP',
      description: providerTransactionId,
      isPending: false,
    };
  }

  async function uploadHistory(
    origin: string,
    sessionId: string,
    history: ReturnType<typeof buildRecentTransactionHistory>,
  ): Promise<void> {
    for (const chunk of history.chunks) {
      const response = await fetch(`${origin}/crawl/transaction-history`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, manifest: history.manifest, chunk }),
      });
      expect(response.status).toBe(204);
    }
  }

  it('refuses (400) a useDeviceProxy crawl with no tunnelToken and does NOT call executeCrawl', async () => {
    // useDeviceProxy:true + tunnelToken omitted is schema-valid (both optional), so it passes
    // safeParse and reaches the fail-closed guard. It must NOT fall through to the unproxied
    // executeCrawl — running a device-proxy crawl over the datacenter IP defeats the residential exit.
    const { status, json } = await postCrawl(crawlBody({ useDeviceProxy: true }));

    expect(status).toBe(400);
    expect(String(json.error)).toMatch(/tunnelToken|unproxied/i);
    expect(json.success).toBe(false); // standalone (local) contract shape
    expect(executeCrawl).not.toHaveBeenCalled();
  });

  it('standalone (PLATFORM=local): the response IS the CrawlResponse — synchronous delivery', async () => {
    // Positive control too: a plain crawl (no useDeviceProxy) hits executeCrawl. This guards the
    // fail-closed assertion above against a false pass where the request never reached the body.
    vi.mocked(executeCrawl).mockResolvedValueOnce({ success: true, stepsExecuted: 1 });
    const { status, json } = await postCrawl(crawlBody());
    expect(status).toBe(200);
    expect(json.success).toBe(true);
    expect(executeCrawl).toHaveBeenCalledTimes(1);
  });

  it('standalone error path returns a failure CrawlResponse, not a CrawlAck (shape matches the success contract)', async () => {
    // executeCrawl normally resolves a failure response, but if it REJECTS (e.g. completeSession throws
    // on an unwritable runs dir), the route's own catch runs. Under the standalone contract that must
    // still be a CrawlResponse — the documented shape — never the 202-path's CrawlAck.
    vi.mocked(executeCrawl).mockRejectedValueOnce(new Error('runs dir unwritable'));
    const { status, json } = await postCrawl(crawlBody());
    expect(status).toBe(500);
    expect(json.success).toBe(false);
    expect(json.stepsExecuted).toBe(0);
    expect(json).not.toHaveProperty('accepted');
    expect(String(json.error)).toMatch(/runs dir unwritable/);
  });

  it('orchestrated (PLATFORM=postgres): ACKs 202 and runs in the background — the session row carries the outcome', async () => {
    const prev = process.env.PLATFORM;
    process.env.PLATFORM = 'postgres';
    try {
      vi.mocked(executeCrawl).mockResolvedValueOnce({ success: true, stepsExecuted: 1 });
      const { status, json } = await postCrawl(crawlBody());
      expect(status).toBe(202);
      expect(json.accepted).toBe(true);
      await vi.waitFor(() => expect(executeCrawl).toHaveBeenCalledTimes(1));
    } finally {
      if (prev === undefined) delete process.env.PLATFORM; else process.env.PLATFORM = prev;
    }
  });

  it('accepts a valid inline history when no upload state exists', async () => {
    process.env.PLATFORM = 'postgres';
    const history = buildRecentTransactionHistory([
      recentTransaction('inline-only'),
    ]);
    vi.mocked(executeCrawl).mockResolvedValueOnce({ success: true, stepsExecuted: 1 });

    const { status, json } = await postCrawl(crawlBody({
      sessionId: 'inline-without-upload',
      recentTransactions: history.transactions,
      recentTransactionsManifest: history.manifest,
    }));

    expect(status).toBe(202);
    expect(json.accepted).toBe(true);
    await vi.waitFor(() => expect(executeCrawl).toHaveBeenCalledOnce());
    expect(vi.mocked(executeCrawl).mock.calls[0][0].recentTransactions)
      .toEqual(history.transactions);
  });

  it('rejects manifest omission after external history upload state exists', async () => {
    process.env.PLATFORM = 'postgres';
    const origin = await startCrawlApp();
    const history = buildRecentTransactionHistory([
      recentTransaction('uploaded-before-omission'),
    ]);
    await uploadHistory(origin, 'upload-then-omit', history);

    const response = await fetch(`${origin}/crawl`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(crawlBody({ sessionId: 'upload-then-omit' })),
    });

    expect(response.status).toBe(400);
    expect(executeCrawl).not.toHaveBeenCalled();
  });

  it('rejects inline substitution after external history upload state exists', async () => {
    process.env.PLATFORM = 'postgres';
    const origin = await startCrawlApp();
    const uploaded = buildRecentTransactionHistory([
      recentTransaction('externally-uploaded'),
    ]);
    const substituted = buildRecentTransactionHistory([
      recentTransaction('substituted-inline'),
    ]);
    await uploadHistory(origin, 'upload-then-inline', uploaded);

    const response = await fetch(`${origin}/crawl`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(crawlBody({
        sessionId: 'upload-then-inline',
        recentTransactions: substituted.transactions,
        recentTransactionsManifest: substituted.manifest,
      })),
    });

    expect(response.status).toBe(400);
    expect(executeCrawl).not.toHaveBeenCalled();
  });

  it('accepts an external history only with its exact uploaded manifest', async () => {
    process.env.PLATFORM = 'postgres';
    const origin = await startCrawlApp();
    const history = buildRecentTransactionHistory([
      recentTransaction('exact-upload'),
    ]);
    await uploadHistory(origin, 'exact-upload', history);
    vi.mocked(executeCrawl).mockResolvedValueOnce({ success: true, stepsExecuted: 1 });

    const response = await fetch(`${origin}/crawl`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(crawlBody({
        sessionId: 'exact-upload',
        recentTransactionsManifest: history.manifest,
      })),
    });

    expect(response.status).toBe(202);
    await vi.waitFor(() => expect(executeCrawl).toHaveBeenCalledOnce());
    expect(vi.mocked(executeCrawl).mock.calls[0][0].recentTransactions)
      .toEqual(history.transactions);
  });

  it('reassembles and verifies an ordered history larger than 1 MiB before crawl execution', async () => {
    const app = createApp('crawl');
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    const port = (server!.address() as AddressInfo).port;
    const origin = `http://127.0.0.1:${port}`;
    const history = buildRecentTransactionHistory([
      ...Array.from({ length: 9 }, (_, index) => ({
        providerAccountId: 'account-a',
        providerTransactionId: `500-${index}`,
        bookingDate: '2026-07-25',
        amount: -(index + 1),
        currency: 'GBP',
        description: `boundary-${index}-${'x'.repeat(125_000)}`,
        isPending: false,
      })),
      {
        providerAccountId: 'account-a',
        providerTransactionId: '000-first',
        bookingDate: '2026-07-25',
        amount: -100,
        currency: 'GBP',
        description: `first-${'a'.repeat(125_000)}`,
        isPending: false,
      },
      {
        providerAccountId: 'account-a',
        providerTransactionId: '999-final',
        bookingDate: '2026-07-25',
        amount: -101,
        currency: 'GBP',
        description: `final-${'z'.repeat(125_000)}`,
        isPending: false,
      },
    ]);
    expect(history.manifest.byteLength).toBeGreaterThan(1024 * 1024);
    for (const chunk of history.chunks) {
      const upload = await fetch(`${origin}/crawl/transaction-history`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sessionId: 'large-history',
          manifest: history.manifest,
          chunk,
        }),
      });
      expect(upload.status).toBe(204);
    }
    vi.mocked(executeCrawl).mockResolvedValueOnce({ success: true, stepsExecuted: 1 });
    const response = await fetch(`${origin}/crawl`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(crawlBody({
        sessionId: 'large-history',
        recentTransactionsManifest: history.manifest,
      })),
    });
    expect(response.status).toBe(200);
    expect(executeCrawl).toHaveBeenCalledOnce();
    const executed = vi.mocked(executeCrawl).mock.calls[0][0];
    expect(executed.recentTransactions).toEqual(history.transactions);
    expect(executed.recentTransactions?.[0].providerTransactionId).toBe('500-0');
    expect(executed.recentTransactions?.some(
      (transaction) => transaction.providerTransactionId === '500-4',
    )).toBe(true);
    expect(executed.recentTransactions?.at(-1)?.providerTransactionId).toBe('999-final');
  });

  it('rejects reordered, incomplete and corrupted history uploads before execution', async () => {
    const app = createApp('crawl');
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    const port = (server!.address() as AddressInfo).port;
    const origin = `http://127.0.0.1:${port}`;
    const history = buildRecentTransactionHistory(Array.from({ length: 3 }, (_, index) => ({
      providerAccountId: 'account-a',
      providerTransactionId: `tx-${index}`,
      bookingDate: '2026-07-25',
      amount: -(index + 1),
      currency: 'GBP',
      description: `${index}-${'x'.repeat(140_000)}`,
      isPending: false,
    })));
    expect(history.chunks.length).toBeGreaterThan(2);
    const upload = (sessionId: string, chunk: (typeof history.chunks)[number]) =>
      fetch(`${origin}/crawl/transaction-history`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, manifest: history.manifest, chunk }),
      });
    const finish = (sessionId: string) => fetch(`${origin}/crawl`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(crawlBody({
        sessionId,
        recentTransactionsManifest: history.manifest,
      })),
    });
    const finishWithoutHistory = (sessionId: string) => fetch(`${origin}/crawl`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(crawlBody({ sessionId })),
    });

    expect((await upload('reordered-history', history.chunks[1])).status).toBe(409);
    expect((await finishWithoutHistory('reordered-history')).status).toBe(400);

    expect((await upload('missing-history', history.chunks[0])).status).toBe(204);
    expect((await finish('missing-history')).status).toBe(400);

    const corrupted = history.chunks.map((chunk) => ({ ...chunk }));
    const bytes = Buffer.from(corrupted[0].data, 'base64');
    bytes[0] ^= 0x01;
    corrupted[0].data = bytes.toString('base64');
    for (const chunk of corrupted) {
      expect((await upload('corrupt-history', chunk)).status).toBe(204);
    }
    expect((await finish('corrupt-history')).status).toBe(400);
    expect(executeCrawl).not.toHaveBeenCalled();
  });
});

describe('POST /cancel/:sessionId — positive context fence', () => {
  let server: Server | null = null;

  afterEach(async () => {
    activeSessions.clear();
    tunnelMocks.fenceCrawl.mockClear();
    crawlMocks.cancelExecution.mockClear();
    crawlMocks.hasActiveExecution.mockReset().mockReturnValue(false);
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }
    delete process.env.K_SERVICE;
    delete process.env.ENGINE_SHARED_SECRET;
  });

  async function cancel(sessionId: string): Promise<number> {
    const app = createApp('crawl');
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    const port = (server!.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${port}/cancel/${sessionId}`, {
      method: 'POST',
    });
    return response.status;
  }

  it('acknowledges cancellation only after the context closes and is removed', async () => {
    const close = vi.fn(async () => undefined);
    activeSessions.set('cancel-ok', { close } as never);

    await expect(cancel('cancel-ok')).resolves.toBe(200);
    expect(close).toHaveBeenCalledOnce();
    expect(tunnelMocks.fenceCrawl)
      .toHaveBeenCalledWith('cancel-ok', 'crawl cancelled by control plane');
    expect(crawlMocks.cancelExecution)
      .toHaveBeenCalledWith('cancel-ok', 'crawl cancelled by control plane');
    expect(activeSessions.has('cancel-ok')).toBe(false);
  });

  it('records permanent fences before awaiting an orphaned context retry', async () => {
    let resolveClose!: () => void;
    const close = vi.fn(() => new Promise<void>((resolve) => {
      resolveClose = resolve;
    }));
    activeSessions.set('cancel-closing', { close } as never);

    const response = cancel('cancel-closing');
    await vi.waitFor(() => {
      expect(close).toHaveBeenCalledOnce();
      expect(tunnelMocks.fenceCrawl).toHaveBeenCalledWith(
        'cancel-closing',
        'crawl cancelled by control plane',
      );
      expect(crawlMocks.cancelExecution).toHaveBeenCalledWith(
        'cancel-closing',
        'crawl cancelled by control plane',
      );
    });
    expect(activeSessions.has('cancel-closing')).toBe(true);

    resolveClose();
    await expect(response).resolves.toBe(200);
    expect(activeSessions.has('cancel-closing')).toBe(false);
  });

  it('fences and acknowledges a parked device-proxy crawl before a browser context exists', async () => {
    await expect(cancel('cancel-parked')).resolves.toBe(200);
    expect(tunnelMocks.fenceCrawl)
      .toHaveBeenCalledWith('cancel-parked', 'crawl cancelled by control plane');
    expect(crawlMocks.cancelExecution)
      .toHaveBeenCalledWith('cancel-parked', 'crawl cancelled by control plane');
  });

  it('fences pre-browser non-proxy execution and waits for its registered lifecycle', async () => {
    await expect(cancel('cancel-before-context')).resolves.toBe(200);
    expect(tunnelMocks.fenceCrawl)
      .toHaveBeenCalledWith('cancel-before-context', 'crawl cancelled by control plane');
    expect(crawlMocks.cancelExecution)
      .toHaveBeenCalledWith('cancel-before-context', 'crawl cancelled by control plane');
  });

  it('records both fences for an id whose dispatch has not reached this instance yet', async () => {
    await expect(cancel('cancel-before-dispatch')).resolves.toBe(200);
    expect(tunnelMocks.fenceCrawl)
      .toHaveBeenCalledWith('cancel-before-dispatch', 'crawl cancelled by control plane');
    expect(crawlMocks.cancelExecution)
      .toHaveBeenCalledWith('cancel-before-dispatch', 'crawl cancelled by control plane');
  });

  it('returns 503 and retains the retry handle when context closure fails', async () => {
    const close = vi.fn(async () => {
      throw new Error('context still active');
    });
    activeSessions.set('cancel-failed', { close } as never);

    await expect(cancel('cancel-failed')).resolves.toBe(503);
    expect(close).toHaveBeenCalledOnce();
    expect(tunnelMocks.fenceCrawl)
      .toHaveBeenCalledWith('cancel-failed', 'crawl cancelled by control plane');
    expect(crawlMocks.cancelExecution)
      .toHaveBeenCalledWith('cancel-failed', 'crawl cancelled by control plane');
    expect(activeSessions.has('cancel-failed')).toBe(true);
  });
});
