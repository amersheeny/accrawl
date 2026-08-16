import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import type { Db } from '../db/client';
import type { NormalizedTransaction } from '@accrawl/contracts';
import { storeCrawlResults } from './store-crawl';
import { canonicalUpdateKey, deterministicAccountId, deterministicTransactionId } from './tx-identity';

const acct = { providerAccountId: 'a1', name: 'Checking', currency: 'GBP', type: 'current', balance: 1000 };
const tx1 = { providerAccountId: 'a1', providerTransactionId: 'BANK1', bookingDate: '2026-06-10', amount: -50, currency: 'GBP', description: 'Shop', isPending: false };
const pos1 = { providerPositionId: 'p1', providerAccountId: 'a1', name: 'Apple', quantity: 10, currency: 'USD', valueNative: 1500 };
const updateTargets = (
  providerAccountId: string,
  canonicalId: string,
  ...transactionIds: string[]
): Map<string, Set<string>> => new Map([
  [canonicalUpdateKey(providerAccountId, canonicalId), new Set(transactionIds)],
]);

describe('storeCrawlResults (pglite)', () => {
  let client: PGlite;
  let db: Db;
  let connId: string;

  beforeAll(async () => {
    client = new PGlite();
    db = drizzle(client, { schema }) as unknown as Db;
    const dir = path.resolve(__dirname, '../../migrations');
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
      await client.exec(fs.readFileSync(path.join(dir, f), 'utf8'));
    }
  });
  afterAll(async () => { await client.close(); });
  beforeEach(async () => {
    await client.exec('truncate institutions cascade');
    await client.exec(`insert into institutions (id,name,login_url,canonical_domain,type) values ('b','B','https://b.com','b.com','bank')`);
    const r = await client.query<{ id: string }>(`insert into connections (institution_id, username_ct, password_ct) values ('b','u','p') returning id`);
    connId = r.rows[0].id;
  });

  it('validates + stores accounts/transactions/positions; reports the newest booking date', async () => {
    const r = await storeCrawlResults(db, { connectionId: connId, accounts: [acct], transactions: [tx1], positions: [pos1] });
    expect(r.accountsStored).toBe(1);
    expect(r.transactionsStored).toBe(1);
    expect(r.positionsStored).toBe(1);
    expect(r.newestBookingDate).toBe('2026-06-10');

    expect(await db.select().from(schema.accounts).where(eq(schema.accounts.connectionId, connId))).toHaveLength(1);
    expect(await db.select().from(schema.transactions).where(eq(schema.transactions.connectionId, connId))).toHaveLength(1);
    expect(await db.select().from(schema.positions).where(eq(schema.positions.connectionId, connId))).toHaveLength(1);
  });

  it('accepts a transaction with no bank id when it carries an engine occurrence id', async () => {
    const noBankId = {
      providerAccountId: 'a1',
      bookingDate: '2026-06-12',
      amount: -9.99,
      currency: 'GBP',
      description: 'Coffee',
      isPending: false,
      extractionOccurrenceId: '00000000-0000-4000-8000-000000000001',
    };
    const r = await storeCrawlResults(db, { connectionId: connId, accounts: [acct], transactions: [noBankId], positions: [] });
    expect(r.rejected.transactions).toBe(0);
    expect(r.transactionsStored).toBe(1);
    const rows = await db.select().from(schema.transactions).where(eq(schema.transactions.connectionId, connId));
    const coffee = rows.find((x) => (x.data as { description: string }).description === 'Coffee');
    expect(coffee).toBeDefined();
    expect((coffee!.data as { providerTransactionId: string }).providerTransactionId).toMatch(/^occurrence:/);
    expect(coffee!.data).not.toHaveProperty('extractionOccurrenceId');
  });

  it('preserves a later unattributed observation when its bank reference is reused', async () => {
    const a1 = { providerAccountId: 'a1', name: 'Checking', currency: 'GBP', type: 'current', balance: 1000 };
    const a2 = { providerAccountId: 'a2', name: 'Savings', currency: 'GBP', type: 'savings', balance: 500 };
    const orphanBankId = { providerTransactionId: 'BANKX', bookingDate: '2026-06-16', amount: -33, currency: 'GBP', description: 'Transfer', isPending: false };

    await storeCrawlResults(db, { connectionId: connId, accounts: [a1, a2], transactions: [orphanBankId], positions: [] });
    const later = await storeCrawlResults(db, {
      connectionId: connId,
      accounts: [a2, a1],
      transactions: [{ ...orphanBankId, description: 'Independent later transfer' }],
      positions: [],
    });

    const rows = await db.select().from(schema.transactions).where(eq(schema.transactions.connectionId, connId));
    expect(later).toMatchObject({ transactionsStored: 1, transactionsDropped: 0 });
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => (row.data as NormalizedTransaction).description).sort())
      .toEqual(['Independent later transfer', 'Transfer']);
    expect(rows.some((row) =>
      (row.data as NormalizedTransaction).providerTransactionId.startsWith('occurrence:'),
    )).toBe(true);
  });

  it('stores two equal-looking id-less occurrences as two transactions', async () => {
    const base = {
      providerAccountId: 'a1',
      bookingDate: '2026-06-15',
      amount: -20,
      currency: 'GBP',
      description: 'ATM withdrawal',
      isPending: false,
    };
    const result = await storeCrawlResults(db, {
      connectionId: connId,
      accounts: [acct],
      transactions: [
        { ...base, extractionOccurrenceId: '00000000-0000-4000-8000-000000000001' },
        { ...base, extractionOccurrenceId: '00000000-0000-4000-8000-000000000002' },
      ],
      positions: [],
    });
    expect(result.transactionsStored).toBe(2);
    expect(await db.select().from(schema.transactions).where(eq(schema.transactions.connectionId, connId))).toHaveLength(2);
  });

  it('drops repeated update claims without aborting the promotion', async () => {
    await storeCrawlResults(db, {
      connectionId: connId,
      accounts: [acct],
      transactions: [{
        providerAccountId: 'a1',
        providerTransactionId: 'NONE',
        bookingDate: '2026-06-15',
        amount: -20,
        currency: 'GBP',
        description: 'Pending purchase',
        isPending: true,
        extractionOccurrenceId: '00000000-0000-4000-8000-000000000001',
      }],
      positions: [],
    });
    const initial = await db.select().from(schema.transactions).where(eq(schema.transactions.connectionId, connId));
    const canonicalId = (initial[0].data as { providerTransactionId: string }).providerTransactionId;

    const result = await storeCrawlResults(db, {
      connectionId: connId,
      accounts: [acct],
      transactions: [
        {
          providerAccountId: 'a1',
          providerTransactionId: 'NONE',
          bookingDate: '2026-06-15',
          amount: -20,
          currency: 'GBP',
          description: 'Posted purchase 1',
          isPending: false,
          existingCanonicalId: canonicalId,
        },
        {
          providerAccountId: 'a1',
          providerTransactionId: 'NONE',
          bookingDate: '2026-06-15',
          amount: -20,
          currency: 'GBP',
          description: 'Posted purchase 2',
          isPending: false,
          existingCanonicalId: canonicalId,
        },
      ],
      positions: [],
      recentlySentUpdateTargets: updateTargets('a1', canonicalId, initial[0].id),
    });
    expect(result).toMatchObject({ transactionsStored: 0, transactionsDropped: 2 });
    const rows = await db.select().from(schema.transactions).where(eq(schema.transactions.connectionId, connId));
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(initial[0].id);
    expect(rows[0].data).toMatchObject({
      description: 'Pending purchase',
      isPending: true,
    });
  });

  it('keeps targeting the authoritative row after a content occurrence acquires a bank reference', async () => {
    const first = await storeCrawlResults(db, {
      connectionId: connId,
      accounts: [acct],
      transactions: [{
        providerAccountId: 'a1',
        providerTransactionId: 'NONE',
        bookingDate: '2026-06-15',
        amount: -20,
        currency: 'GBP',
        description: 'Pending purchase',
        isPending: true,
        extractionOccurrenceId: '00000000-0000-4000-8000-000000000001',
      }],
      positions: [],
    });
    expect(first.transactionsStored).toBe(1);
    const [initial] = await db.select().from(schema.transactions).where(eq(schema.transactions.connectionId, connId));
    const occurrenceCanonical = (initial.data as NormalizedTransaction).providerTransactionId;

    await storeCrawlResults(db, {
      connectionId: connId,
      accounts: [acct],
      transactions: [{
        providerAccountId: 'a1',
        providerTransactionId: 'BANK-POSTED',
        bookingDate: '2026-06-15',
        amount: -20,
        currency: 'GBP',
        description: 'Posted purchase',
        isPending: false,
        existingCanonicalId: occurrenceCanonical,
        extractionOccurrenceId: '00000000-0000-4000-8000-000000000002',
      }],
      positions: [],
      recentlySentUpdateTargets: updateTargets('a1', occurrenceCanonical, initial.id),
    });

    await storeCrawlResults(db, {
      connectionId: connId,
      accounts: [acct],
      transactions: [{
        providerAccountId: 'a1',
        providerTransactionId: 'BANK-POSTED',
        bookingDate: '2026-06-16',
        amount: -20,
        currency: 'GBP',
        description: 'Posted purchase final',
        isPending: false,
        existingCanonicalId: 'BANK-POSTED',
        extractionOccurrenceId: '00000000-0000-4000-8000-000000000003',
      }],
      positions: [],
      recentlySentUpdateTargets: updateTargets('a1', 'BANK-POSTED', initial.id),
    });

    const rows = await db.select().from(schema.transactions).where(eq(schema.transactions.connectionId, connId));
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(initial.id);
    expect((rows[0].data as NormalizedTransaction).description).toBe('Posted purchase final');
  });

  it('preserves a new occurrence when an old stored row already owns the provider reference', async () => {
    await storeCrawlResults(db, {
      connectionId: connId,
      accounts: [acct],
      transactions: [{ ...tx1, providerTransactionId: 'RECYCLED', bookingDate: '2026-01-10' }],
      positions: [],
    });
    const result = await storeCrawlResults(db, {
      connectionId: connId,
      accounts: [acct],
      transactions: [{
        ...tx1,
        providerTransactionId: 'RECYCLED',
        bookingDate: '2026-06-20',
        amount: -75,
        extractionOccurrenceId: '00000000-0000-4000-8000-000000000002',
      }],
      positions: [],
    });
    expect(result.transactionsStored).toBe(1);
    const rows = await db.select().from(schema.transactions).where(eq(schema.transactions.connectionId, connId));
    expect(rows).toHaveLength(2);
    expect(rows.map(row => (row.data as NormalizedTransaction).bookingDate).sort())
      .toEqual(['2026-01-10', '2026-06-20']);
    expect(rows.find(row => (row.data as NormalizedTransaction).bookingDate === '2026-06-20')?.data)
      .toMatchObject({ providerTransactionId: expect.stringMatching(/^occurrence:/) });
  });

  it('preserves every row when a provider reference repeats and occurrence ids are omitted', async () => {
    const result = await storeCrawlResults(db, {
      connectionId: connId,
      accounts: [acct],
      transactions: [
        {
          ...tx1,
          providerTransactionId: 'SHARED',
        },
        {
          ...tx1,
          providerTransactionId: 'SHARED',
        },
      ],
      positions: [],
    });
    expect(result.transactionsStored).toBe(2);
    const rows = await db.select().from(schema.transactions).where(eq(schema.transactions.connectionId, connId));
    expect(rows).toHaveLength(2);
    expect(rows.every(row => (row.data as NormalizedTransaction).providerTransactionId.startsWith('occurrence:'))).toBe(true);
  });

  it('treats provider references as opaque and does not trim them into one identity', async () => {
    const result = await storeCrawlResults(db, {
      connectionId: connId,
      accounts: [acct],
      transactions: [
        { ...tx1, providerTransactionId: 'OPAQUE-REF' },
        { ...tx1, providerTransactionId: ' OPAQUE-REF' },
      ],
      positions: [],
    });

    expect(result).toMatchObject({ transactionsStored: 2, transactionsDropped: 0 });
    const rows = await db.select().from(schema.transactions)
      .where(eq(schema.transactions.connectionId, connId));
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => (row.data as NormalizedTransaction).providerTransactionId).sort())
      .toEqual([' OPAQUE-REF', 'OPAQUE-REF']);
  });

  it('replays the same observed bank-id row idempotently through its durable occurrence claim', async () => {
    const [session] = await db.insert(schema.sessions)
      .values({ connectionId: connId, status: 'completed' })
      .returning({ id: schema.sessions.id });
    const observed = {
      ...tx1,
      extractionOccurrenceId: '00000000-0000-4000-8000-000000000011',
    };
    const first = await storeCrawlResults(db, {
      connectionId: connId,
      sessionId: session.id,
      accounts: [acct],
      transactions: [observed],
      positions: [],
    });
    const replay = await storeCrawlResults(db, {
      connectionId: connId,
      sessionId: session.id,
      accounts: [acct],
      transactions: [observed],
      positions: [],
    });

    expect(first).toMatchObject({ transactionsStored: 1, transactionsAdded: 1 });
    expect(replay).toMatchObject({
      transactionsStored: 1,
      transactionsAdded: 0,
      transactionsModified: 0,
    });
    expect(await db.select().from(schema.transactions).where(eq(schema.transactions.connectionId, connId)))
      .toHaveLength(1);
    expect(await db.select().from(schema.transactionOccurrences)
      .where(eq(schema.transactionOccurrences.connectionId, connId)))
      .toHaveLength(1);
  });

  it('fails the promotion atomically when two input rows reuse one occurrence id', async () => {
    const occurrenceId = '00000000-0000-4000-8000-000000000012';
    await expect(storeCrawlResults(db, {
      connectionId: connId,
      accounts: [acct],
      transactions: [
        { ...tx1, providerTransactionId: 'FIRST', extractionOccurrenceId: occurrenceId },
        { ...tx1, providerTransactionId: 'SECOND', extractionOccurrenceId: occurrenceId },
      ],
      positions: [],
    })).rejects.toThrow('same transaction occurrence id');

    expect(await db.select().from(schema.transactions).where(eq(schema.transactions.connectionId, connId)))
      .toHaveLength(0);
    expect(await db.select().from(schema.transactionOccurrences)
      .where(eq(schema.transactionOccurrences.connectionId, connId)))
      .toHaveLength(0);
  });

  it('scopes occurrence claims to the crawl session so a later session cannot be mistaken for replay', async () => {
    const sessionRows = await db.insert(schema.sessions).values([
      { connectionId: connId, status: 'completed' },
      { connectionId: connId, status: 'completed' },
    ]).returning({ id: schema.sessions.id });
    const occurrenceId = '00000000-0000-4000-8000-000000000013';

    await storeCrawlResults(db, {
      connectionId: connId,
      sessionId: sessionRows[0].id,
      accounts: [acct],
      transactions: [{
        ...tx1,
        providerTransactionId: 'NONE',
        extractionOccurrenceId: occurrenceId,
      }],
      positions: [],
    });
    await storeCrawlResults(db, {
      connectionId: connId,
      sessionId: sessionRows[1].id,
      accounts: [acct],
      transactions: [{
        ...tx1,
        providerTransactionId: 'NONE',
        description: 'Independent later observation',
        extractionOccurrenceId: occurrenceId,
      }],
      positions: [],
    });

    expect(await db.select().from(schema.transactions).where(eq(schema.transactions.connectionId, connId)))
      .toHaveLength(2);
    const claims = await db.select().from(schema.transactionOccurrences)
      .where(eq(schema.transactionOccurrences.connectionId, connId));
    expect(claims).toHaveLength(2);
    expect(new Set(claims.map((claim) => claim.scopeId))).toEqual(
      new Set(sessionRows.map((session) => session.id)),
    );
  });

  it('does not let an old occurrence replay overwrite a later authoritative update', async () => {
    const sessionRows = await db.insert(schema.sessions).values([
      { connectionId: connId, status: 'completed' },
      { connectionId: connId, status: 'completed' },
    ]).returning({ id: schema.sessions.id });
    const original = {
      ...tx1,
      description: 'Pending original',
      isPending: true,
      extractionOccurrenceId: '00000000-0000-4000-8000-000000000021',
    };
    await storeCrawlResults(db, {
      connectionId: connId,
      sessionId: sessionRows[0].id,
      accounts: [acct],
      transactions: [original],
      positions: [],
    });
    const [stored] = await db.select().from(schema.transactions)
      .where(eq(schema.transactions.connectionId, connId));
    await db.insert(schema.sessionTransactionTargets).values({
      sessionId: sessionRows[1].id,
      providerAccountId: 'a1',
      canonicalId: 'BANK1',
      transactionId: stored.id,
    });

    await storeCrawlResults(db, {
      connectionId: connId,
      sessionId: sessionRows[1].id,
      accounts: [acct],
      transactions: [{
        ...original,
        description: 'Posted final',
        isPending: false,
        existingCanonicalId: 'BANK1',
        extractionOccurrenceId: '00000000-0000-4000-8000-000000000022',
      }],
      positions: [],
    });
    await storeCrawlResults(db, {
      connectionId: connId,
      sessionId: sessionRows[0].id,
      accounts: [acct],
      transactions: [original],
      positions: [],
    });

    const [afterReplay] = await db.select().from(schema.transactions)
      .where(eq(schema.transactions.connectionId, connId));
    expect((afterReplay.data as NormalizedTransaction)).toMatchObject({
      description: 'Posted final',
      isPending: false,
    });
  });

  it('resolves chained updates independently of processing order', async () => {
    const run = async (order: Array<'A' | 'B'>): Promise<Array<NormalizedTransaction>> => {
      const connection = await client.query<{ id: string }>(
        `insert into connections (institution_id, username_ct, password_ct) values ('b','u','p') returning id`,
      );
      const connectionId = connection.rows[0].id;
      await storeCrawlResults(db, {
        connectionId,
        accounts: [acct],
        transactions: [
          { ...tx1, providerTransactionId: 'X', description: 'A', extractionOccurrenceId: '00000000-0000-4000-8000-000000000031' },
          { ...tx1, providerTransactionId: 'Y', description: 'B', extractionOccurrenceId: '00000000-0000-4000-8000-000000000032' },
        ],
        positions: [],
      });
      const before = await db.select().from(schema.transactions)
        .where(eq(schema.transactions.connectionId, connectionId));
      const aId = before.find((row) => (row.data as NormalizedTransaction).description === 'A')!.id;
      const bId = before.find((row) => (row.data as NormalizedTransaction).description === 'B')!.id;
      const targets = new Map<string, Set<string>>([
        [canonicalUpdateKey('a1', 'X'), new Set([aId])],
        [canonicalUpdateKey('a1', 'Y'), new Set([bId])],
      ]);
      const updates = {
        A: {
          ...tx1,
          providerTransactionId: 'Y',
          description: 'A updated',
          existingCanonicalId: 'X',
          extractionOccurrenceId: '00000000-0000-4000-8000-000000000033',
        },
        B: {
          ...tx1,
          providerTransactionId: 'Z',
          description: 'B updated',
          existingCanonicalId: 'Y',
          extractionOccurrenceId: '00000000-0000-4000-8000-000000000034',
        },
      };
      await storeCrawlResults(db, {
        connectionId,
        accounts: [acct],
        transactions: order.map((key) => updates[key]),
        positions: [],
        recentlySentUpdateTargets: targets,
      });
      return (await db.select().from(schema.transactions)
        .where(eq(schema.transactions.connectionId, connectionId)))
        .map((row) => row.data as NormalizedTransaction)
        .sort((left, right) => left.description.localeCompare(right.description));
    };

    const aThenB = await run(['A', 'B']);
    const bThenA = await run(['B', 'A']);
    expect(aThenB).toEqual(bThenA);
    expect(aThenB.map((transaction) => transaction.providerTransactionId).sort()).toEqual(['X', 'Z']);
  });

  it('drops an ambiguous canonical update without aborting the promotion', async () => {
    const duplicateCanonical = 'LEGACY-SHARED';
    await db.insert(schema.transactions).values([
      {
        id: 'legacy-row-a',
        connectionId: connId,
        data: { ...tx1, providerTransactionId: duplicateCanonical, description: 'Legacy A' },
      },
      {
        id: 'legacy-row-b',
        connectionId: connId,
        data: { ...tx1, providerTransactionId: duplicateCanonical, description: 'Legacy B' },
      },
    ]);
    const before = await db.select().from(schema.transactions)
      .where(eq(schema.transactions.connectionId, connId));
    const result = await storeCrawlResults(db, {
      connectionId: connId,
      accounts: [acct],
      transactions: [{
        ...tx1,
        providerTransactionId: duplicateCanonical,
        existingCanonicalId: duplicateCanonical,
        extractionOccurrenceId: '00000000-0000-4000-8000-000000000003',
      }],
      positions: [],
      recentlySentUpdateTargets: updateTargets(
        'a1',
        duplicateCanonical,
        'legacy-row-a',
        'legacy-row-b',
      ),
    });
    expect(result).toMatchObject({ transactionsStored: 0, transactionsDropped: 1 });
    const rows = await db.select().from(schema.transactions).where(eq(schema.transactions.connectionId, connId));
    expect(rows).toEqual(before);
  });

  it('drops an unknown update target while storing unrelated valid records', async () => {
    const result = await storeCrawlResults(db, {
      connectionId: connId,
      accounts: [{ ...acct, balance: 999 }],
      transactions: [
        {
          ...tx1,
          providerTransactionId: 'VALID-ADDITION',
          extractionOccurrenceId: '00000000-0000-4000-8000-000000000041',
        },
        {
          ...tx1,
          providerTransactionId: 'OBSERVED-NEW',
          existingCanonicalId: 'NOT-SUPPLIED',
          extractionOccurrenceId: '00000000-0000-4000-8000-000000000042',
        },
      ],
      positions: [pos1],
    });
    expect(result).toMatchObject({ transactionsStored: 1, transactionsDropped: 1 });

    expect(await db.select().from(schema.accounts).where(eq(schema.accounts.connectionId, connId)))
      .toHaveLength(1);
    expect(await db.select().from(schema.transactions).where(eq(schema.transactions.connectionId, connId)))
      .toHaveLength(1);
    expect(await db.select().from(schema.positions).where(eq(schema.positions.connectionId, connId)))
      .toHaveLength(1);
  });

  it('rejects a cross-account update target and leaves the authoritative row unchanged', async () => {
    await storeCrawlResults(db, {
      connectionId: connId,
      accounts: [acct],
      transactions: [{ ...tx1, extractionOccurrenceId: '00000000-0000-4000-8000-000000000043' }],
      positions: [],
    });
    const before = await db.select().from(schema.transactions)
      .where(eq(schema.transactions.connectionId, connId));

    const result = await storeCrawlResults(db, {
      connectionId: connId,
      accounts: [acct, { ...acct, providerAccountId: 'a2', name: 'Savings' }],
      transactions: [{
        ...tx1,
        providerAccountId: 'a2',
        providerTransactionId: 'BANK1-POSTED',
        existingCanonicalId: 'BANK1',
        extractionOccurrenceId: '00000000-0000-4000-8000-000000000044',
      }],
      positions: [],
      recentlySentUpdateTargets: updateTargets('a1', 'BANK1', before[0].id),
    });
    expect(result).toMatchObject({ transactionsStored: 0, transactionsDropped: 1 });

    expect(await db.select().from(schema.transactions).where(eq(schema.transactions.connectionId, connId)))
      .toEqual(before);
  });

  it('rejects a cross-connection update target and leaves both connections unchanged', async () => {
    const foreignConnection = await client.query<{ id: string }>(
      `insert into connections (institution_id, username_ct, password_ct) values ('b','u','p') returning id`,
    );
    await storeCrawlResults(db, {
      connectionId: foreignConnection.rows[0].id,
      accounts: [acct],
      transactions: [{ ...tx1, extractionOccurrenceId: '00000000-0000-4000-8000-000000000045' }],
      positions: [],
    });
    const [foreignRow] = await db.select().from(schema.transactions)
      .where(eq(schema.transactions.connectionId, foreignConnection.rows[0].id));

    const result = await storeCrawlResults(db, {
      connectionId: connId,
      accounts: [acct],
      transactions: [{
        ...tx1,
        description: 'Cross-connection overwrite',
        existingCanonicalId: 'BANK1',
        extractionOccurrenceId: '00000000-0000-4000-8000-000000000046',
      }],
      positions: [],
      recentlySentUpdateTargets: updateTargets('a1', 'BANK1', foreignRow.id),
    });
    expect(result).toMatchObject({ transactionsStored: 0, transactionsDropped: 1 });

    expect(await db.select().from(schema.transactions).where(eq(schema.transactions.connectionId, connId)))
      .toHaveLength(0);
    expect(await db.select().from(schema.transactions)
      .where(eq(schema.transactions.connectionId, foreignConnection.rows[0].id)))
      .toEqual([foreignRow]);
  });

  it('updates the authoritative target without adopting a provider reference owned by another row', async () => {
    await storeCrawlResults(db, {
      connectionId: connId,
      accounts: [acct],
      transactions: [
        {
          ...tx1,
          providerTransactionId: 'NONE',
          description: 'Pending target',
          isPending: true,
          extractionOccurrenceId: '00000000-0000-4000-8000-000000000001',
        },
        {
          ...tx1,
          providerTransactionId: 'ALREADY-OWNED',
          description: 'Different stored transaction',
        },
      ],
      positions: [],
    });
    const before = await db.select().from(schema.transactions).where(eq(schema.transactions.connectionId, connId));
    const target = before.find(row => (row.data as NormalizedTransaction).description === 'Pending target')!;
    const targetCanonical = (target.data as NormalizedTransaction).providerTransactionId;

    await storeCrawlResults(db, {
      connectionId: connId,
      accounts: [acct],
      transactions: [{
        ...tx1,
        providerTransactionId: 'ALREADY-OWNED',
        description: 'Target posted',
        isPending: false,
        existingCanonicalId: targetCanonical,
        extractionOccurrenceId: '00000000-0000-4000-8000-000000000002',
      }],
      positions: [],
      recentlySentUpdateTargets: updateTargets('a1', targetCanonical, target.id),
    });

    const rows = await db.select().from(schema.transactions).where(eq(schema.transactions.connectionId, connId));
    expect(rows).toHaveLength(2);
    const updatedTarget = rows.find(row => row.id === target.id)!;
    expect((updatedTarget.data as NormalizedTransaction).description).toBe('Target posted');
    expect((updatedTarget.data as NormalizedTransaction).providerTransactionId).toBe(targetCanonical);
    expect(rows.filter(row => (row.data as NormalizedTransaction).providerTransactionId === 'ALREADY-OWNED'))
      .toHaveLength(1);
  });

  it('does not overwrite a legacy row occupying a new provider reference hash target', async () => {
    const accountId = deterministicAccountId(connId, 'a1');
    const occupiedId = deterministicTransactionId(accountId, 'NEW-REFERENCE');
    await db.insert(schema.transactions).values({
      id: occupiedId,
      connectionId: connId,
      data: { ...tx1, providerTransactionId: 'LEGACY-CANONICAL', description: 'Legacy occupant' },
    });
    await storeCrawlResults(db, {
      connectionId: connId,
      accounts: [acct],
      transactions: [{
        ...tx1,
        providerTransactionId: 'NEW-REFERENCE',
        description: 'New observation',
        extractionOccurrenceId: '00000000-0000-4000-8000-000000000004',
      }],
      positions: [],
    });
    const rows = await db.select().from(schema.transactions).where(eq(schema.transactions.connectionId, connId));
    expect(rows).toHaveLength(2);
    expect((rows.find(row => row.id === occupiedId)!.data as NormalizedTransaction).description)
      .toBe('Legacy occupant');
    expect(rows.find(row => row.id !== occupiedId)?.data)
      .toMatchObject({
        description: 'New observation',
        providerTransactionId: expect.stringMatching(/^occurrence:/),
      });
  });

  it('rejects malformed records (invalid calendar date/currency, reasoning text, NaN) without storing them', async () => {
    const bad = [
      { ...tx1, bookingDate: '// Note: batching the remaining transactions...' }, // the real corruption bug
      { ...tx1, providerTransactionId: 'X', amount: Number.NaN },
      { ...tx1, providerTransactionId: 'BAD-DATE', bookingDate: '2026-13-40' },
      { ...tx1, providerTransactionId: 'BAD-CURRENCY', currency: 'gbp' },
      { ...tx1, providerTransactionId: 'LONG-CURRENCY', currency: 'GBPP' },
    ];
    const r = await storeCrawlResults(db, { connectionId: connId, accounts: [acct], transactions: bad, positions: [] });
    expect(r.rejected.transactions).toBe(5);
    expect(r.transactionsStored).toBe(0);
  });

  it('preserves additive optional fields while refreshing explicitly replaceable fields', async () => {
    const firstAccount = {
      providerAccountId: 'a1',
      name: 'Card',
      description: 'Primary card',
      currency: 'GBP',
      type: 'credit',
      balance: -100,
      available: 900,
      limit: 1000,
      creditCardLiability: {
        lastStatementDate: '2026-06-01',
        lastStatementBalance: 95,
      },
    };
    const firstTransaction = {
      ...tx1,
      merchant: 'Coffee Shop',
      providerCategory: 'FOOD',
      category: { primary: 'food', detailed: 'coffee' },
      extractionOccurrenceId: '00000000-0000-4000-8000-000000000091',
    };
    const firstPosition = {
      ...pos1,
      symbol: 'AAPL',
      costBasisNative: 1200,
      isin: 'US0378331005',
      exchange: 'NASDAQ',
      securityType: 'stock',
    };

    await storeCrawlResults(db, {
      connectionId: connId,
      accounts: [firstAccount],
      transactions: [firstTransaction],
      positions: [firstPosition],
    });
    const [storedTransaction] = await db.select().from(schema.transactions)
      .where(eq(schema.transactions.connectionId, connId));

    await storeCrawlResults(db, {
      connectionId: connId,
      accounts: [{
        providerAccountId: 'a1',
        name: 'Card renamed',
        currency: 'GBP',
        type: 'credit',
        balance: -125,
      }],
      transactions: [{
        providerAccountId: 'a1',
        providerTransactionId: 'BANK1',
        bookingDate: '2026-06-11',
        amount: -50,
        currency: 'GBP',
        description: 'Shop posted',
        isPending: false,
        existingCanonicalId: 'BANK1',
        extractionOccurrenceId: '00000000-0000-4000-8000-000000000092',
      }],
      positions: [{
        providerPositionId: 'p1',
        providerAccountId: 'a1',
        name: 'Apple Inc.',
        quantity: 11,
        currency: 'USD',
        valueNative: 1650,
      }],
      recentlySentUpdateTargets: updateTargets('a1', 'BANK1', storedTransaction.id),
    });

    const [account] = await db.select().from(schema.accounts)
      .where(eq(schema.accounts.connectionId, connId));
    const [transaction] = await db.select().from(schema.transactions)
      .where(eq(schema.transactions.connectionId, connId));
    const [position] = await db.select().from(schema.positions)
      .where(eq(schema.positions.connectionId, connId));

    expect(account.data).toEqual({
      ...firstAccount,
      name: 'Card renamed',
      description: '',
      balance: -125,
    });
    expect(transaction.data).toMatchObject({
      providerTransactionId: 'BANK1',
      bookingDate: '2026-06-11',
      description: 'Shop posted',
      merchant: 'Coffee Shop',
      providerCategory: 'FOOD',
    });
    expect(transaction.data).not.toHaveProperty('category');
    expect(position.data).toEqual({
      providerPositionId: 'p1',
      providerAccountId: 'a1',
      name: 'Apple Inc.',
      quantity: 11,
      currency: 'USD',
      valueNative: 1650,
      isin: 'US0378331005',
      exchange: 'NASDAQ',
      securityType: 'stock',
    });
  });

  it('retains an account omitted from a partial crawl without marking it inactive', async () => {
    const acct2 = { ...acct, providerAccountId: 'a2', name: 'Savings' };
    await storeCrawlResults(db, { connectionId: connId, accounts: [acct, acct2], transactions: [], positions: [] });

    const r = await storeCrawlResults(db, { connectionId: connId, accounts: [acct], transactions: [], positions: [] });
    expect(r.quarantinedAccounts).toBe(0);

    const rows = await db.select().from(schema.accounts).where(eq(schema.accounts.connectionId, connId));
    expect(rows).toHaveLength(2); // NOT deleted
    const a2 = rows.find((x) => (x.data as { providerAccountId: string }).providerAccountId === 'a2');
    const a1 = rows.find((x) => (x.data as { providerAccountId: string }).providerAccountId === 'a1');
    expect(a2?.missingSinceCrawlCount).toBe(0);
    expect(a1?.missingSinceCrawlCount).toBe(0);
  });

  it('retains positions omitted from a partial crawl', async () => {
    const pos2 = { ...pos1, providerPositionId: 'p2', name: 'MSFT' };
    await storeCrawlResults(db, { connectionId: connId, accounts: [acct], transactions: [], positions: [pos1, pos2] });

    const r = await storeCrawlResults(db, { connectionId: connId, accounts: [], transactions: [], positions: [pos1] });
    expect(r.staleDeletedPositions).toBe(0);
    expect(await db.select().from(schema.positions).where(eq(schema.positions.connectionId, connId))).toHaveLength(2);

    const r2 = await storeCrawlResults(db, { connectionId: connId, accounts: [], transactions: [], positions: [] });
    expect(r2.staleDeletedPositions).toBe(0);
    expect(await db.select().from(schema.positions).where(eq(schema.positions.connectionId, connId))).toHaveLength(2);
  });

  it('scopes equal provider position ids to their owning accounts', async () => {
    const secondAccount = { ...acct, providerAccountId: 'a2', name: 'Second portfolio' };
    const result = await storeCrawlResults(db, {
      connectionId: connId,
      accounts: [acct, secondAccount],
      transactions: [],
      positions: [
        pos1,
        { ...pos1, providerAccountId: 'a2', name: 'Apple in second portfolio' },
      ],
    });
    expect(result.positionsStored).toBe(2);
    expect(await db.select().from(schema.positions).where(eq(schema.positions.connectionId, connId))).toHaveLength(2);
  });

  it('rejects a position whose owning account is not known on the connection', async () => {
    const result = await storeCrawlResults(db, {
      connectionId: connId,
      accounts: [acct],
      transactions: [],
      positions: [{ ...pos1, providerAccountId: 'invented-account' }],
    });
    expect(result.rejected.positions).toBe(1);
    expect(result.positionsStored).toBe(0);
  });

  it('rejects a position without an owning account id', async () => {
    const { providerAccountId: _providerAccountId, ...orphan } = pos1;
    const result = await storeCrawlResults(db, {
      connectionId: connId,
      accounts: [],
      transactions: [],
      positions: [orphan],
    });
    expect(result.rejected.positions).toBe(1);
    expect(result.positionsStored).toBe(0);
  });
});
