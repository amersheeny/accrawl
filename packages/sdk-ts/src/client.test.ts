import { describe, it, expect } from 'vitest';
import { AccrawlClient } from './client';
import { AccrawlApiError } from './errors';

interface Recorded { url: string; method?: string; headers?: Record<string, string>; body?: string }

function stub(status: number, body: string | object) {
  const calls: Recorded[] = [];
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  const fetch = async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
    calls.push({ url, method: init?.method, headers: init?.headers, body: init?.body });
    return { status, text: async () => text };
  };
  return { fetch, calls };
}

const make = (fetch: ReturnType<typeof stub>['fetch']) =>
  new AccrawlClient({ baseUrl: 'https://acc.example.com/', apiKey: 'acck_test', fetch });

describe('AccrawlClient — construction', () => {
  it('requires baseUrl and apiKey', () => {
    expect(() => new AccrawlClient({ baseUrl: '', apiKey: 'k', fetch: stub(200, {}).fetch })).toThrow(/baseUrl/);
    expect(() => new AccrawlClient({ baseUrl: 'https://x', apiKey: '', fetch: stub(200, {}).fetch })).toThrow(/apiKey/);
  });
});

describe('AccrawlClient — requests', () => {
  it('strips the base trailing slash and sends the bearer', async () => {
    const s = stub(200, { items: [] });
    await make(s.fetch).listConnections();
    expect(s.calls[0].url).toBe('https://acc.example.com/api/v1/connections'); // no double slash
    expect(s.calls[0].method).toBe('GET');
    expect(s.calls[0].headers?.authorization).toBe('Bearer acck_test');
    expect(s.calls[0].body).toBeUndefined();
  });

  it('URL-encodes path ids (no path injection from an id)', async () => {
    const s = stub(200, { items: [], hasMore: false, limit: 50, offset: 0 });
    await make(s.fetch).listAccounts('a/b?x=1');
    expect(s.calls[0].url).toBe('https://acc.example.com/api/v1/connections/a%2Fb%3Fx%3D1/accounts');
  });

  // The client reads already-retrieved data. Starting a retrieval, following a session and relaying a
  // passcode are the account owner's, in their own console — the client has no method for any of them, and
  // every request it can make is a GET.
  it('OFFERS NO RETRIEVAL SURFACE and never issues a write', async () => {
    const client = make(stub(200, {}).fetch) as unknown as Record<string, unknown>;
    for (const gone of ['triggerCrawl', 'getSession', 'submitOtp', 'refreshConnection', 'getSync']) {
      expect(client[gone], gone).toBeUndefined();
    }
    const s = stub(200, { items: [], hasMore: false, limit: 50, offset: 0 });
    const c = make(s.fetch);
    await c.listConnections();
    await c.listAccounts('c');
    await c.listTransactions('c');
    await c.syncTransactions('c');
    await c.listHoldings('c');
    expect(s.calls).toHaveLength(5);
    for (const call of s.calls) {
      expect(call.method).toBe('GET');
      expect(call.body).toBeUndefined();
    }
  });
});

describe('AccrawlClient — normalized data contract (v1)', () => {
  it('listConnections GETs the directory and returns the projected summaries', async () => {
    const dir = { items: [{ id: 'c1', institutionId: 'bk', institutionName: 'Bank Co', institutionType: 'bank', institutionLogoUrl: null, status: 'connected', nickname: 'Everyday', lastSyncedAt: '2026-07-01' }] };
    const s = stub(200, dir);
    const r = await make(s.fetch).listConnections();
    expect(r.items[0].id).toBe('c1');
    expect(r.items[0].status).toBe('connected');
    expect(r.items[0].institutionName).toBe('Bank Co'); // what a consumer shows a person, not the slug
    expect(r.items[0].institutionType).toBe('bank');
    expect(s.calls[0].method).toBe('GET');
    expect(s.calls[0].url).toBe('https://acc.example.com/api/v1/connections');
  });

  it('listAccounts GETs the v1 path and returns the projected page', async () => {
    const page = { items: [{ id: 'a1', connectionId: 'c', type: 'depository', subtype: 'current', name: 'Chk', currency: 'GBP', balance: { current: 100 }, status: 'active' }], hasMore: false, limit: 50, offset: 0 };
    const s = stub(200, page);
    const r = await make(s.fetch).listAccounts('conn_1');
    expect(r.items[0].type).toBe('depository');
    expect(r.items[0].balance.current).toBe(100);
    expect(s.calls[0].url).toBe('https://acc.example.com/api/v1/connections/conn_1/accounts');
    expect(s.calls[0].method).toBe('GET');
  });

  it('listTransactions windows by from/to and paginates', async () => {
    const s = stub(200, { items: [], hasMore: false, limit: 100, offset: 0 });
    await make(s.fetch).listTransactions('c', { from: '2026-01-01', to: '2026-06-30', limit: 100 });
    expect(s.calls[0].url).toBe('https://acc.example.com/api/v1/connections/c/transactions?limit=100&from=2026-01-01&to=2026-06-30');
  });

  it('syncTransactions omits cursor on the first call and sends it thereafter', async () => {
    const s1 = stub(200, { added: [], modified: [], removed: [], nextCursor: 'CUR', hasMore: false });
    const r = await make(s1.fetch).syncTransactions('c');
    expect(s1.calls[0].url).toBe('https://acc.example.com/api/v1/connections/c/transactions/sync');
    expect(r.nextCursor).toBe('CUR');
    const s2 = stub(200, { added: [], modified: [], removed: [], nextCursor: 'CUR2', hasMore: false });
    await make(s2.fetch).syncTransactions('c', { cursor: 'a=b/c', limit: 25 });
    expect(s2.calls[0].url).toBe('https://acc.example.com/api/v1/connections/c/transactions/sync?cursor=a%3Db%2Fc&limit=25');
  });

  it('listHoldings returns holdings + securities', async () => {
    const s = stub(200, { holdings: [{ id: 'h1', accountId: 'p3', securityId: 'isin:X', quantity: 1, value: 10, currency: 'USD' }], securities: [{ id: 'isin:X', name: 'X', securityType: 'equity' }], hasMore: false, limit: 50, offset: 0 });
    const r = await make(s.fetch).listHoldings('c');
    expect(r.holdings[0].securityId).toBe('isin:X');
    expect(r.securities[0].securityType).toBe('equity');
    expect(s.calls[0].url).toBe('https://acc.example.com/api/v1/connections/c/holdings');
  });
});

describe('AccrawlClient — errors', () => {
  it('maps a non-2xx JSON error to AccrawlApiError with status + message + body', async () => {
    const s = stub(403, { error: 'missing read:data scope' });
    await expect(make(s.fetch).listAccounts('c')).rejects.toMatchObject({
      name: 'AccrawlApiError', status: 403, message: 'missing read:data scope',
    });
    try {
      await make(stub(403, { error: 'nope' }).fetch).listAccounts('c');
    } catch (e) {
      expect(e).toBeInstanceOf(AccrawlApiError);
      expect((e as AccrawlApiError).body).toEqual({ error: 'nope' });
    }
  });

  it('handles a non-JSON error body with a generic message', async () => {
    const s = stub(500, 'internal server error');
    await expect(make(s.fetch).listConnections()).rejects.toMatchObject({ status: 500, message: /HTTP 500/ });
  });

  it('401 (expired credential) surfaces the server message', async () => {
    const s = stub(401, { error: 'invalid or revoked api key' });
    await expect(make(s.fetch).listHoldings('c')).rejects.toThrow(/invalid or revoked/);
  });
});
