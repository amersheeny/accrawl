import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../config', () => ({
  config: { engineUrl: 'http://engine:8080', engineSharedSecret: 'shared-secret', nodeEnv: 'production' },
}));

import { dispatchCrawlToEngine } from './dispatch-engine';
import { config } from '../config';
import {
  buildRecentTransactionHistory,
  type CrawlRecentTransaction,
  type CrawlRequest,
} from '@accrawl/contracts';

// Only request.timeoutSeconds + JSON.stringify(request) are exercised; the credentials are what must
// never come back in an error.
const req = { timeoutSeconds: 1, credentials: { username: 'alice', password: 's3cret-pw' } } as unknown as CrawlRequest;
const realFetch = global.fetch;

function largeRequest(): CrawlRequest {
  const recentTransactions: CrawlRecentTransaction[] = Array.from(
    { length: 11 },
    (_, index) => ({
      providerAccountId: 'account-a',
      providerTransactionId: index === 0
        ? '999-final'
        : index === 10
          ? '000-first'
          : `500-${String(index).padStart(3, '0')}`,
      bookingDate: '2026-07-25',
      amount: -10,
      currency: 'GBP',
      description: `${index}-${String(index).repeat(110_000)}`,
      isPending: false,
    }),
  );
  const history = buildRecentTransactionHistory(recentTransactions);
  expect(history.manifest.byteLength).toBeGreaterThan(1024 * 1024);
  return {
    sessionId: 'large-history-session',
    loginUrl: 'https://bank.example/login',
    username: 'alice',
    password: 'secret',
    requires2fa: false,
    maxSteps: 100,
    timeoutSeconds: 900,
    recentTransactions: history.transactions,
    recentTransactionsManifest: history.manifest,
  };
}

beforeEach(() => {
  (config as { engineSharedSecret: string; nodeEnv: string }).engineSharedSecret = 'shared-secret';
  (config as { nodeEnv: string }).nodeEnv = 'production';
});
afterEach(() => { global.fetch = realFetch; vi.restoreAllMocks(); });

describe('dispatchCrawlToEngine', () => {
  it('does NOT include the engine response body (which can echo credentials) in the error', async () => {
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'bad request', echoed: { password: 's3cret-pw' } }), { status: 400 }),
    ) as unknown as typeof fetch;
    const r = await dispatchCrawlToEngine(req);
    expect(r.accepted).toBe(false);
    expect(r.error).toBe("We couldn't start this refresh. Try again later.");
    expect(r.error).not.toContain('s3cret-pw');
    expect(r.error).not.toContain('password');
  });

  it('sends the Bearer shared secret when configured', async () => {
    let authHeader: string | undefined;
    global.fetch = vi.fn(async (_url: unknown, opts: { headers: Record<string, string> }) => {
      authHeader = opts.headers.authorization;
      return new Response(JSON.stringify({ accepted: true }), { status: 202 });
    }) as unknown as typeof fetch;
    await dispatchCrawlToEngine(req);
    expect(authHeader).toBe('Bearer shared-secret');
  });

  it('fails closed in production when the shared secret is empty (never dispatches without auth)', async () => {
    (config as { engineSharedSecret: string }).engineSharedSecret = '';
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    const r = await dispatchCrawlToEngine(req);
    expect(r.accepted).toBe(false);
    expect(r.error).toMatch(/ENGINE_SHARED_SECRET is required/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uploads an ordered >1 MiB history in bounded chunks before the crawl shell', async () => {
    const request = largeRequest();
    const calls: Array<{ url: string; body: unknown; bytes: number }> = [];
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const serialized = String(init?.body ?? '');
      calls.push({
        url: String(input),
        body: JSON.parse(serialized) as unknown,
        bytes: Buffer.byteLength(serialized),
      });
      return String(input).endsWith('/crawl')
        ? new Response(JSON.stringify({ accepted: true }), { status: 202 })
        : new Response(null, { status: 204 });
    }) as typeof fetch;

    await expect(dispatchCrawlToEngine(request)).resolves.toEqual({ accepted: true });

    const uploads = calls.filter(({ url }) => url.endsWith('/crawl/transaction-history'));
    expect(uploads.length).toBeGreaterThan(1);
    expect(uploads.every(({ bytes }) => bytes < 1024 * 1024)).toBe(true);
    expect(uploads.map(({ body }) =>
      (body as { chunk: { index: number } }).chunk.index,
    )).toEqual(Array.from({ length: uploads.length }, (_, index) => index));

    const final = calls.at(-1);
    expect(final?.url).toBe('http://engine:8080/crawl');
    expect(final?.body).not.toHaveProperty('recentTransactions');
    expect(final?.body).toMatchObject({
      sessionId: request.sessionId,
      recentTransactionsManifest: request.recentTransactionsManifest,
    });
  });

  it('does not dispatch the crawl shell when a history chunk is rejected', async () => {
    const request = largeRequest();
    const urls: string[] = [];
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response(null, { status: 409 });
    }) as typeof fetch;

    await expect(dispatchCrawlToEngine(request)).resolves.toEqual({
      accepted: false,
      error: "We couldn't start this refresh. Try again later.",
    });
    expect(urls).toEqual(['http://engine:8080/crawl/transaction-history']);
  });
});
