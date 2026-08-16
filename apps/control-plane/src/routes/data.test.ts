import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import type { Db } from '../db/client';
import { createConnection } from '../data/connections';
import {
  clampLimit, listConnectionAccountsContract, listConnectionTransactionsContract,
  listConnectionHoldings, transactionSyncPage, decodeCursor,
} from '../data/public-data';
import { storeCrawlResults } from '../data/store-crawl';
import { deterministicAccountId } from '../data/tx-identity';

const KEY = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';

describe('normalized data API v1 — projections + change cursor (pglite)', () => {
  let client: PGlite;
  let db: Db;
  let connId: string;

  beforeAll(async () => {
    process.env.CREDENTIAL_ENC_KEY = KEY;
    client = new PGlite();
    db = drizzle(client, { schema }) as unknown as Db;
    const dir = path.resolve(__dirname, '../../migrations');
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
      await client.exec(fs.readFileSync(path.join(dir, f), 'utf8'));
    }
    await client.exec(`insert into institutions (id,name,login_url,canonical_domain,type) values ('acme','Acme','https://login.acme.com/','acme.com','bank')`);
    connId = (await createConnection(db, { institutionId: 'acme', username: 'alice', password: 's3cret' })).id;
  });
  afterAll(async () => { await client.close(); delete process.env.CREDENTIAL_ENC_KEY; });

  // Seed accounts with the REAL deterministic id (accounts.id = hash(connectionId:providerAccountId)),
  // so the accountId join on transactions/holdings resolves as it does in production.
  const aid = (p: string) => deterministicAccountId(connId, p);

  it('projects accounts to two-level type + subtype + balance triple', async () => {
    await db.insert(schema.accounts).values([
      { id: aid('p1'), connectionId: connId, data: { providerAccountId: 'p1', name: 'Checking', description: '', currency: 'GBP', type: 'current', balance: 1000, available: 1200, limit: 500 } },
      { id: aid('p2'), connectionId: connId, data: { providerAccountId: 'p2', name: 'Card', description: '', currency: 'GBP', type: 'credit', balance: -30 } },
      { id: aid('p3'), connectionId: connId, data: { providerAccountId: 'p3', name: 'Pension', description: '', currency: 'GBP', type: 'pension', balance: 50000, pensionDetail: { scheme: 'defined_contribution' } } },
    ]);
    const { items } = await listConnectionAccountsContract(db, connId, clampLimit(undefined), 0);
    const byId = Object.fromEntries(items.map((a) => [a.id, a]));
    expect(byId[aid('p1')]).toMatchObject({ type: 'depository', subtype: 'current', balance: { current: 1000, available: 1200, limit: 500 } });
    expect(byId[aid('p2')]).toMatchObject({ type: 'credit', subtype: 'credit_card', balance: { current: -30 } });
    expect(byId[aid('p3')]).toMatchObject({ type: 'pension', subtype: 'pension', pensionDetail: { scheme: 'defined_contribution' } });
  });

  it('windows transactions by [from,to] on bookingDate', async () => {
    await db.insert(schema.transactions).values([
      { id: 'tx-may', connectionId: connId, data: { providerTransactionId: 'm', bookingDate: '2026-05-15', amount: -5, currency: 'GBP', description: 'May', isPending: false } },
      { id: 'tx-jun', connectionId: connId, data: { providerTransactionId: 'j', bookingDate: '2026-06-15', amount: -6, currency: 'GBP', description: 'Jun', isPending: true } },
    ]);
    const june = await listConnectionTransactionsContract(db, connId, clampLimit(undefined), 0, '2026-06-01', '2026-06-30');
    expect(june.items.map((t) => t.id)).toEqual(['tx-jun']);
    expect(june.items[0]).toMatchObject({ status: 'pending', amount: -6 });
    const all = await listConnectionTransactionsContract(db, connId, clampLimit(undefined), 0);
    expect(all.items).toHaveLength(2);
  });

  it('projects holdings with account linkage + de-duplicated securities', async () => {
    await db.insert(schema.positions).values([
      { id: 'h1', connectionId: connId, data: { providerPositionId: 'pp1', providerAccountId: 'p3', name: 'Apple', symbol: 'AAPL', isin: 'US0378331005', quantity: 10, currency: 'USD', valueNative: 1500 } },
      { id: 'h2', connectionId: connId, data: { providerPositionId: 'pp2', name: 'Tracking Fund', securityType: 'tracking fund', quantity: 5, currency: 'EUR', valueNative: 300 } },
    ]);
    const { holdings, securities } = await listConnectionHoldings(db, connId, clampLimit(undefined), 0);
    expect(holdings).toHaveLength(2);
    // accountId is the CANONICAL account id (hash of connectionId:providerAccountId) — the pension
    // account (p3) was seeded above, so h1 joins to it; it is NOT the raw provider id.
    expect(holdings.find((h) => h.id === 'h1')).toMatchObject({ accountId: aid('p3'), securityId: 'isin:US0378331005', value: 1500 });
    expect(holdings.find((h) => h.id === 'h2')?.accountId).toBeNull();
    const fund = securities.find((s) => s.id === 'pos:pp2');
    expect(fund?.securityType).toBe('mutual_fund');
  });

  it('nulls accountId for an ORPHAN provider account (no matching account row — never a dangling id)', async () => {
    const c = (await createConnection(db, { institutionId: 'acme', username: 'gwen', password: 's3cret' })).id;
    // A transaction referencing a providerAccountId the crawl never produced an account for.
    await db.insert(schema.transactions).values({
      id: 'orphan', connectionId: c,
      data: { providerAccountId: 'ghost', providerTransactionId: 'g1', bookingDate: '2026-06-01', amount: -1, currency: 'GBP', description: 'x', isPending: false },
    });
    const { items } = await listConnectionTransactionsContract(db, c, clampLimit(undefined), 0);
    expect(items[0].accountId).toBeNull();
  });

  it('change cursor: added, then paging, removed always empty, cursor round-trips', async () => {
    // Fresh connection so the cursor walk is isolated from the rows seeded above.
    const c = (await createConnection(db, { institutionId: 'acme', username: 'carol', password: 's3cret' })).id;
    const now = new Date('2026-07-01T00:00:00.000Z');
    await db.insert(schema.transactions).values([1, 2, 3].map((n) => ({
      id: `s${n}`, connectionId: c, createdAt: now, updatedAt: now,
      data: { providerTransactionId: `s${n}`, bookingDate: '2026-06-20', amount: -n, currency: 'GBP', description: `t${n}`, isPending: false },
    })));

    const page1 = await transactionSyncPage(db, c, undefined, 2);
    expect(page1.added).toHaveLength(2);
    expect(page1.modified).toHaveLength(0);
    expect(page1.removed).toEqual([]);
    expect(page1.hasMore).toBe(true);

    const page2 = await transactionSyncPage(db, c, page1.nextCursor, 2);
    expect(page2.added).toHaveLength(1);
    expect(page2.hasMore).toBe(false);
    // No overlap across the two pages.
    const ids = [...page1.added, ...page2.added].map((t) => t.id);
    expect(new Set(ids)).toEqual(new Set(['s1', 's2', 's3']));

    // A row modified after insert (updatedAt advanced past createdAt) classifies as `modified`.
    const later = new Date('2026-07-02T00:00:00.000Z');
    await db.update(schema.transactions)
      .set({ updatedAt: later, data: { providerTransactionId: 's1', bookingDate: '2026-06-20', amount: -1, currency: 'GBP', description: 't1 POSTED', isPending: false } })
      .where(eq(schema.transactions.id, 's1'));
    const afterAll = await transactionSyncPage(db, c, page2.nextCursor, 10);
    expect(afterAll.added).toHaveLength(0);
    expect(afterAll.modified.map((t) => t.id)).toEqual(['s1']);
  });

  it('decodeCursor tolerates a missing/garbage cursor (→ epoch start)', () => {
    expect(decodeCursor(undefined).updatedAt.getTime()).toBe(0);
    expect(decodeCursor('not-base64!!').updatedAt.getTime()).toBe(0);
  });

  it('store reports added vs modified counts and no-ops an unchanged re-store', async () => {
    const c = (await createConnection(db, { institutionId: 'acme', username: 'dave', password: 's3cret' })).id;
    const acct = { providerAccountId: 'pA', name: 'Acc', description: '', currency: 'GBP', type: 'current', balance: 1 };
    const tx = {
      providerAccountId: 'pA',
      providerTransactionId: 'B1',
      bookingDate: '2026-06-10',
      amount: -9,
      currency: 'GBP',
      description: 'buy',
      isPending: true,
      extractionOccurrenceId: '00000000-0000-4000-8000-000000000101',
    };
    const [originalSession] = await db.insert(schema.sessions)
      .values({ connectionId: c, status: 'completed' })
      .returning({ id: schema.sessions.id });

    const first = await storeCrawlResults(db, {
      connectionId: c,
      sessionId: originalSession.id,
      accounts: [acct],
      transactions: [tx],
      positions: [],
    });
    expect(first).toMatchObject({ transactionsAdded: 1, transactionsModified: 0 });
    const [stored] = await db.select().from(schema.transactions).where(eq(schema.transactions.connectionId, c));

    // Re-store identical data → no change, so no updatedAt bump and neither added nor modified.
    const again = await storeCrawlResults(db, {
      connectionId: c,
      sessionId: originalSession.id,
      accounts: [acct],
      transactions: [tx],
      positions: [],
    });
    expect(again).toMatchObject({ transactionsAdded: 0, transactionsModified: 0, transactionsStored: 1 });

    // Re-store the SAME transaction now posted → data differs → counted as modified.
    const [updateSession] = await db.insert(schema.sessions)
      .values({ connectionId: c, status: 'completed' })
      .returning({ id: schema.sessions.id });
    await db.insert(schema.sessionTransactionTargets).values({
      sessionId: updateSession.id,
      providerAccountId: 'pA',
      canonicalId: 'B1',
      transactionId: stored.id,
    });
    const posted = await storeCrawlResults(db, {
      connectionId: c,
      sessionId: updateSession.id,
      accounts: [acct],
      transactions: [{
        ...tx,
        isPending: false,
        existingCanonicalId: 'B1',
        extractionOccurrenceId: '00000000-0000-4000-8000-000000000102',
      }],
      positions: [],
    });
    expect(posted).toMatchObject({ transactionsAdded: 0, transactionsModified: 1 });
  });

  it('accountId joins a transaction to its account resource (seeded via the real store path)', async () => {
    const c = (await createConnection(db, { institutionId: 'acme', username: 'erin', password: 's3cret' })).id;
    await storeCrawlResults(db, {
      connectionId: c,
      accounts: [{ providerAccountId: 'B7', name: 'Broker', description: '', currency: 'USD', type: 'current', balance: 0 }],
      transactions: [{ providerAccountId: 'B7', providerTransactionId: 'k1', bookingDate: '2026-06-01', amount: -5, currency: 'USD', description: 'buy', isPending: false }],
      positions: [],
    });
    const { items: accts } = await listConnectionAccountsContract(db, c, clampLimit(undefined), 0);
    const { added } = await transactionSyncPage(db, c, undefined, 100);
    expect(added).toHaveLength(1);
    // The transaction's accountId equals the account's ContractAccount.id → a consumer can join them.
    expect(added[0].accountId).toBe(accts[0].id);
    expect(added[0].accountId).toBe(deterministicAccountId(c, 'B7'));
  });

  it('a µs-precision updated_at does not re-emit across cursor pages (timestamp(3) guard)', async () => {
    const c = (await createConnection(db, { institutionId: 'acme', username: 'frank', password: 's3cret' })).id;
    // Simulates a row whose updated_at carries sub-millisecond digits (as Postgres now() would produce).
    // The timestamp(3) column truncates it to ms, so the ms-precision cursor advances past it exactly once.
    await client.query(
      `insert into transactions (id, connection_id, data, created_at, updated_at)
       values ('mu', $1, $2, '2026-07-01 00:00:00.123456+00', '2026-07-01 00:00:00.123456+00')`,
      [c, JSON.stringify({ providerTransactionId: 'x', bookingDate: '2026-06-01', amount: -1, currency: 'GBP', description: 't', isPending: false })],
    );
    const p1 = await transactionSyncPage(db, c, undefined, 10);
    expect(p1.added.map((t) => t.id)).toEqual(['mu']);
    const p2 = await transactionSyncPage(db, c, p1.nextCursor, 10);
    expect([...p2.added, ...p2.modified]).toEqual([]);
  });
});

describe('v1 routes — registration + auth gate (inject)', () => {
  it('every v1 route is registered and 401s without an API key', async () => {
    process.env.ACCRAWL_ADMIN_PASSWORD = 'x';
    const { buildServer } = await import('../index');
    const app = await buildServer();
    await app.ready();
    try {
      const gets = [
        '/api/v1/connections',
        '/api/v1/connections/abc/accounts',
        '/api/v1/connections/abc/transactions',
        '/api/v1/connections/abc/transactions/sync',
        '/api/v1/connections/abc/holdings',
      ];
      for (const url of gets) {
        expect((await app.inject({ method: 'GET', url })).statusCode, url).toBe(401);
      }
      // The v1 surface is reads only — the retrieval routes it used to carry are gone, not merely guarded.
      for (const url of ['/api/v1/connections/abc/refresh', '/api/v1/syncs/abc']) {
        expect((await app.inject({ method: 'POST', url })).statusCode, url).toBe(404);
      }
      expect((await app.inject({ method: 'GET', url: '/api/v1/syncs/abc' })).statusCode).toBe(404);
    } finally {
      await app.close();
      delete process.env.ACCRAWL_ADMIN_PASSWORD;
    }
  });
});
