import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import type { FastifyInstance } from 'fastify';
import * as schema from '../db/schema';
import { deterministicAccountId } from '../data/tx-identity';

/**
 * End-to-end read path for the normalized /api/v1 contract: a real Fastify server backed by a real
 * (pglite-over-socket) Postgres, an API key minted through the actual /api/keys route with read:data +
 * a connection grant, and the projected JSON eyeballed for correctness. Complements the pure-projection
 * unit tests (data.test.ts) by exercising Fastify + auth middleware + the DB pool.
 */
const DB_PORT = 54339;
const KEY = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';

describe('normalized data API v1 — authenticated HTTP happy path (real server + pglite)', () => {
  let client: PGlite;
  let dbServer: PGLiteSocketServer;
  let app: FastifyInstance;
  let closeDb: (() => Promise<void>) | undefined;
  let db: import('../db/client').Db;
  let operatorToken: string;
  let connId: string;
  let syncId: string;
  let readKey: string;

  beforeAll(async () => {
    client = new PGlite();
    const dir = path.resolve(__dirname, '../../migrations');
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
      await client.exec(fs.readFileSync(path.join(dir, f), 'utf8'));
    }
    dbServer = new PGLiteSocketServer({ db: client, port: DB_PORT });
    await dbServer.start();
    process.env.DATABASE_URL = `postgres://localhost:${DB_PORT}/postgres`;
    process.env.CREDENTIAL_ENC_KEY = KEY;
    process.env.SETUP_CLAIM_TOKEN = 'test-setup-code';
    process.env.DB_POOL_MAX = '1';

    const { db: dbc, sql } = await import('../db/client');
    db = dbc;
    closeDb = () => sql.end({ timeout: 5 });
    const { buildServer } = await import('../index');
    app = await buildServer();
    await app.ready();

    await app.inject({ method: 'POST', url: '/api/setup', payload: { password: 'hunter2-pw', setupCode: 'test-setup-code' } });
    operatorToken = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'hunter2-pw', setupCode: 'test-setup-code' } })).json().token;

    await client.exec(`insert into institutions (id,name,login_url,canonical_domain,type) values ('bk','BankCo','https://bk.com/','bk.com','bank')`);
    const { createConnection } = await import('../data/connections');
    connId = (await createConnection(db, { institutionId: 'bk', username: 'u', password: 'p' })).id;

    // Seed through the REAL store path so account/transaction/position ids are the deterministic hashes
    // production uses — otherwise the accountId join under test would be an artefact of hand-picked ids.
    const { storeCrawlResults } = await import('../data/store-crawl');
    await storeCrawlResults(db, {
      connectionId: connId,
      accounts: [
        { providerAccountId: 'p1', name: 'Everyday', description: '', currency: 'GBP', type: 'current', balance: 2500, available: 2400 },
        { providerAccountId: 'p2', name: 'Visa', description: '', currency: 'GBP', type: 'credit', balance: -420, limit: 5000, creditCardLiability: { minimumPaymentAmount: 25, aprs: [{ percentage: 21.9, type: 'purchase' }] } },
      ],
      transactions: [
        { providerAccountId: 'p1', providerTransactionId: 't1', bookingDate: '2026-06-02', amount: -12.5, currency: 'GBP', description: 'Coffee', isPending: false },
        { providerAccountId: 'p1', providerTransactionId: 't2', bookingDate: '2026-05-20', amount: -80, currency: 'GBP', description: 'Groceries', isPending: false },
      ],
      positions: [
        { providerPositionId: 'z1', providerAccountId: 'p1', name: 'Vanguard S&P 500', symbol: 'VUSA', exchange: 'LSE', isin: 'IE00B3XXRP09', securityType: 'ETF', quantity: 3, currency: 'GBP', valueNative: 240 },
      ],
    });
    // A completed session doubles as a Sync; seed persisted counts to prove GET /syncs/:id surfaces them.
    const started = new Date('2026-06-03T09:00:00.000Z');
    const done = new Date('2026-06-03T09:00:20.000Z');
    const [s] = await db.insert(schema.sessions).values({
      connectionId: connId, status: 'completed', startedAt: started, completedAt: done,
      syncCounts: { accounts: 2, transactionsAdded: 2, transactionsModified: 0 },
    }).returning({ id: schema.sessions.id });
    syncId = s.id;

    const mint = await app.inject({ method: 'POST', url: '/api/keys', headers: { authorization: `Bearer ${operatorToken}` }, payload: { name: 'consumer', scopes: ['read:data'], connectionGrants: [connId] } });
    expect(mint.statusCode).toBe(201);
    readKey = mint.json().key;
  });

  afterAll(async () => {
    await app?.close();
    await closeDb?.();
    await dbServer?.stop();
    await client?.close();
    delete process.env.DATABASE_URL;
    delete process.env.CREDENTIAL_ENC_KEY;
    delete process.env.DB_POOL_MAX;
  });

  const get = (url: string, key = readKey) => app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${key}` } });

  it('GET /accounts projects the two-level taxonomy, balance triple, and credit-card overlay', async () => {
    const res = await get(`/api/v1/connections/${connId}/accounts`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ hasMore: false, limit: expect.any(Number), offset: 0 });
    const byId = Object.fromEntries(body.items.map((a: { id: string }) => [a.id, a]));
    expect(byId[deterministicAccountId(connId, 'p1')]).toMatchObject({ type: 'depository', subtype: 'current', balance: { current: 2500, available: 2400 } });
    expect(byId[deterministicAccountId(connId, 'p2')]).toMatchObject({ type: 'credit', subtype: 'credit_card', balance: { current: -420, limit: 5000 }, creditCardLiability: { minimumPaymentAmount: 25 } });
  });

  it('GET /transactions windows by booking date, projects signed amount + status, and joins accountId', async () => {
    const res = await get(`/api/v1/connections/${connId}/transactions?from=2026-06-01&to=2026-06-30`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items).toHaveLength(1); // only the June 'Coffee' txn is in-window
    // accountId is the canonical account id, so it joins to the depository account above.
    expect(body.items[0]).toMatchObject({ amount: -12.5, status: 'posted', description: 'Coffee', accountId: deterministicAccountId(connId, 'p1') });
  });

  it('GET /transactions/sync returns the change cursor (both txns added, none removed)', async () => {
    const res = await get(`/api/v1/connections/${connId}/transactions/sync`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.added).toHaveLength(2);
    expect(body.modified).toEqual([]);
    expect(body.removed).toEqual([]);
    expect(typeof body.nextCursor).toBe('string');
  });

  it('GET /holdings account-links the holding and emits a de-duplicated security', async () => {
    const res = await get(`/api/v1/connections/${connId}/holdings`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.holdings[0]).toMatchObject({ accountId: deterministicAccountId(connId, 'p1'), securityId: 'isin:IE00B3XXRP09', value: 240 });
    expect(body.securities[0]).toMatchObject({ id: 'isin:IE00B3XXRP09', ticker: 'VUSA', exchange: 'LSE', securityType: 'etf' });
  });

  it('GET /connections lists the connection the key is granted (grant-scoped directory)', async () => {
    const res = await get('/api/v1/connections');
    expect(res.statusCode).toBe(200);
    const ids = res.json().items.map((c: { id: string }) => c.id);
    expect(ids).toContain(connId);
    expect(res.json().items[0]).toMatchObject({ id: connId, status: expect.any(String) });
  });

  // A consumer renders these connections to the person who authorized them, so the directory names the
  // institution rather than handing over a storage slug.
  it('GET /connections names the institution (display metadata, not just the slug)', async () => {
    const res = await get('/api/v1/connections');
    const entry = res.json().items.find((c: { id: string }) => c.id === connId);
    expect(entry).toMatchObject({
      institutionId: expect.any(String),
      institutionName: expect.any(String),
      institutionType: expect.stringMatching(/^(bank|broker|retirement)$/),
    });
    expect(entry.institutionName).not.toBe(entry.institutionId);
    expect(entry).toHaveProperty('institutionLogoUrl');
  });

  it('exposes no retrieval surface: the sync-status and refresh routes do not exist', async () => {
    expect((await get(`/api/v1/syncs/${syncId}`)).statusCode).toBe(404);
    expect((await get(`/api/v1/connections/${connId}/refresh`)).statusCode).toBe(404);
  });

  it('rejects an out-of-range offset (scan-and-discard DoS guard)', async () => {
    expect((await get(`/api/v1/connections/${connId}/accounts?offset=200000`)).statusCode).toBe(400);
    expect((await get(`/api/v1/connections/${connId}/accounts?offset=100000`)).statusCode).toBe(200); // at the cap is fine
  });

  it('a read:data key WITHOUT a grant for the connection is refused (403 — cross-consumer isolation)', async () => {
    const mint = await app.inject({ method: 'POST', url: '/api/keys', headers: { authorization: `Bearer ${operatorToken}` }, payload: { name: 'other', scopes: ['read:data'], connectionGrants: [] } });
    const ungranted = mint.json().key;
    expect((await get(`/api/v1/connections/${connId}/accounts`, ungranted)).statusCode).toBe(403);
    expect((await get(`/api/v1/connections/${connId}/holdings`, ungranted)).statusCode).toBe(403);
    // The directory it CAN call simply shows nothing.
    expect((await get('/api/v1/connections', ungranted)).json().items).toEqual([]);
  });
});
