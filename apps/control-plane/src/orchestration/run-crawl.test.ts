import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';

// Mock config so the device-proxy path has a deterministic ENGINE_SHARED_SECRET (the HMAC root the tunnel
// key is derived from) without depending on the host env. run-crawl reads only config.engineSharedSecret.
vi.mock('../config', () => ({
  config: { engineSharedSecret: 'test-engine-shared-secret', engineWsUrl: 'wss://host/tunnel' },
}));

import * as schema from '../db/schema';
import type { Db } from '../db/client';
import { deriveTunnelKey, verifyTunnelToken, type CrawlAck, type CrawlRequest } from '@accrawl/contracts';
import { config } from '../config';
import { createConnection, verifyLoginDomain } from '../data/connections';
import { pairDevice } from '../data/devices';
import { createCrawlSession } from '../data/sessions';
import { storeCrawlResults } from '../data/store-crawl';
import { runCrawl } from './run-crawl';
import { MAX_CRAWL_SECONDS } from '../lib/crawl-budget';
import type { CompanionWakeInput } from '../notifications/companion-push';

const KEY = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';

describe('runCrawl orchestration (pglite)', () => {
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
  });
  afterAll(async () => { await client.close(); delete process.env.CREDENTIAL_ENC_KEY; });
  beforeEach(async () => {
    // devices have no FK to institutions, so they survive `truncate institutions cascade` — clear them too
    // so the device-proxy "no paired device" case isn't polluted by a device paired in an earlier test.
    await client.exec('truncate devices cascade');
    await client.exec('truncate institutions cascade');
    await client.exec(
      `insert into institutions (id,name,login_url,canonical_domain,allowed_domains,type,transaction_lookback_days,scan_status)
       values ('acme','Acme','https://login.acme.com/','acme.com','["cdn.acme.com"]'::jsonb,'bank',14,'passed')`,
    );
    const c = await createConnection(db, { institutionId: 'acme', username: 'alice', password: 's3cret' });
    await verifyLoginDomain(db, c.id, 'acme.com');
    connId = c.id;
  });

  // Fast polling + a short completion deadline so a test that (deliberately or by mistake) never writes
  // a terminal session row fails in milliseconds instead of waiting out the real-world deadline.
  const deps = (dispatch: (r: CrawlRequest) => Promise<CrawlAck>) =>
    ({ dispatchCrawl: dispatch, leaseOwner: 'w1', pollIntervalMs: 5, completionDeadlineMs: 2_000 });

  /** Simulate the engine's completion write (completeSession): a SUCCESS stages its outcome + appends
   *  the 'done' event WITHOUT flipping the status (the control-plane promotes, then flips to
   *  'completed'); a failure/cancel flips the row's status directly. Optionally records a
   *  session_steps row carrying the transactionsExtracted watermark proxy. */
  async function engineFinishes(req: CrawlRequest, opts: {
    status?: 'completed' | 'failed' | 'cancelled'; error?: string | null; failureReason?: string | null;
    costUsd?: number; crawlMemory?: string; transactionsExtracted?: number;
  } = {}): Promise<void> {
    const status = opts.status ?? 'completed';
    const success = status === 'completed';
    await db.update(schema.sessions).set({
      ...(success
        ? { promotionReadyAt: new Date() }
        : { status, completedAt: new Date() }),
      error: opts.error ?? null,
      failureReason: opts.failureReason ?? null,
      cost: opts.costUsd !== undefined ? ({ totalCostUsd: opts.costUsd } as never) : null,
      crawlMemory: opts.crawlMemory ?? null,
    }).where(eq(schema.sessions.id, req.sessionId));
    await db.insert(schema.sessionEvents).values({
      sessionId: req.sessionId, seq: 999, type: 'done',
      data: { success, status: success ? 'completed' : status, counts: {} } as never,
    });
    if (opts.transactionsExtracted !== undefined) {
      await db.insert(schema.sessionSteps).values({
        sessionId: req.sessionId, stepNumber: 1,
        log: { action: 'reportData', transactionsExtracted: opts.transactionsExtracted } as never,
      });
    }
  }

  it('completed: assembles the request, stores staged extraction, updates bookkeeping, releases the lock', async () => {
    let captured: CrawlRequest | undefined;
    const dispatch = async (req: CrawlRequest): Promise<CrawlAck> => {
      captured = req;
      await db.insert(schema.stagedRecords).values([
        { sessionId: req.sessionId, kind: 'account', data: { providerAccountId: 'a1', name: 'Checking', currency: 'GBP', type: 'current', balance: 1000 } },
        { sessionId: req.sessionId, kind: 'transaction', data: { providerAccountId: 'a1', providerTransactionId: 'BANK1', bookingDate: '2026-06-10', amount: -50, currency: 'GBP', description: 'Shop', isPending: false } },
      ]);
      await engineFinishes(req, { costUsd: 0.03, crawlMemory: 'hint', transactionsExtracted: 1 });
      return { accepted: true, sessionId: req.sessionId };
    };

    const r = await runCrawl(db, { ...deps(dispatch), today: new Date('2026-06-28T10:00:00Z') }, { connectionId: connId });
    expect(r.outcome).toBe('completed');
    expect(r.store?.accountsStored).toBe(1);
    expect(r.store?.transactionsStored).toBe(1);

    // request assembled correctly
    expect(captured?.loginUrl).toBe('https://login.acme.com/');
    expect(captured?.allowedDomains).toEqual(['cdn.acme.com']);
    expect(captured?.username).toBe('alice'); // decrypted
    expect(captured?.password).toBe('s3cret');
    expect(captured?.cutoffDate).toBe('2026-03-30'); // first crawl → 90-day clamp from today

    // canonical tables + bookkeeping + session release
    expect(await db.select().from(schema.accounts).where(eq(schema.accounts.connectionId, connId))).toHaveLength(1);
    const [c] = await db.select().from(schema.connections).where(eq(schema.connections.id, connId));
    expect(c.status).toBe('connected');
    expect((c.crawlStats as { lastSuccessfulTxCrawlDay?: string }).lastSuccessfulTxCrawlDay).toBe('2026-06-28');
    expect(c.crawlMemory).toBe('hint');
    const [s] = await db.select().from(schema.sessions).where(eq(schema.sessions.id, r.sessionId as string));
    expect(s.status).toBe('completed');
  });

  it('uses no first-crawl comparison list, then every row from the seven-day lower bound in booking-date-desc order', async () => {
    const inWindow = [
      {
        providerAccountId: 'window-account',
        providerTransactionId: 'lower-boundary',
        bookingDate: '2026-06-21',
        amount: -1,
        currency: 'GBP',
        description: 'Lower boundary',
        isPending: false,
      },
      ...Array.from({ length: 501 }, (_, index) => ({
        providerAccountId: 'window-account',
        providerTransactionId: `window-${String(index).padStart(3, '0')}`,
        bookingDate: '2026-06-24',
        amount: -(index + 2),
        currency: 'GBP',
        description: `Window row ${index}`,
        isPending: false,
      })),
      {
        providerAccountId: 'window-account',
        providerTransactionId: 'upper-boundary',
        bookingDate: '2026-06-28',
        amount: -504,
        currency: 'GBP',
        description: 'Upper boundary',
        isPending: false,
      },
    ];
    const outsideWindow = [{
      providerAccountId: 'window-account',
      providerTransactionId: 'day-eight',
      bookingDate: '2026-06-20',
      amount: -505,
      currency: 'GBP',
      description: 'Day eight',
      isPending: false,
    }, {
      providerAccountId: 'window-account',
      providerTransactionId: 'future-row',
      bookingDate: '2026-06-29',
      amount: -506,
      currency: 'GBP',
      description: 'Future row',
      isPending: false,
    }];
    const laterCrawlHistory = [...inWindow, outsideWindow[1]];
    await storeCrawlResults(db, {
      connectionId: connId,
      accounts: [{
        providerAccountId: 'window-account',
        name: 'Window account',
        currency: 'GBP',
        type: 'current',
        balance: 100,
      }],
      transactions: [outsideWindow[0]],
      positions: [],
    });
    const first = await runCrawl(db, {
      ...deps(async (req) => {
        expect(req.cutoffDate).toBe('2026-03-30');
        expect(req.recentTransactions).toEqual([]);
        await db.insert(schema.stagedRecords).values([{
          sessionId: req.sessionId,
          kind: 'account',
          data: {
            providerAccountId: 'window-account',
            name: 'Window account',
            currency: 'GBP',
            type: 'current',
            balance: 100,
          },
        }, ...[...inWindow, outsideWindow[1]].map((data) => ({
          sessionId: req.sessionId,
          kind: 'transaction' as const,
          data,
        }))]);
        await engineFinishes(req, {
          transactionsExtracted: inWindow.length + 1,
        });
        return { accepted: true, sessionId: req.sessionId };
      }),
      today: new Date('2026-06-28T23:59:59.999Z'),
    }, { connectionId: connId });
    expect(first.outcome).toBe('completed');

    const [connection] = await db.select().from(schema.connections)
      .where(eq(schema.connections.id, connId));
    await db.update(schema.connections).set({
      crawlStats: {
        ...connection.crawlStats,
        lastSuccessfulTxCrawlDay: '2020-01-01',
      },
    }).where(eq(schema.connections.id, connId));
    await client.exec(
      `update institutions set transaction_lookback_days = 1 where id = 'acme'`,
    );

    const second = await runCrawl(db, {
      ...deps(async (req) => {
        expect(req.cutoffDate).toBe('2026-06-21');
        expect(req.recentTransactions).toHaveLength(laterCrawlHistory.length);
        expect(new Set(req.recentTransactions.map((row) =>
          row.providerTransactionId))).toEqual(new Set(laterCrawlHistory.map((row) =>
          row.providerTransactionId)));
        expect(req.recentTransactions.map((row) => row.bookingDate)).toEqual(
          laterCrawlHistory.map((row) => row.bookingDate)
            .sort((left, right) => right.localeCompare(left)),
        );
        expect(req.recentTransactions[0]?.providerTransactionId)
          .toBe('future-row');
        const targets = await db.select().from(schema.sessionTransactionTargets)
          .where(eq(schema.sessionTransactionTargets.sessionId, req.sessionId));
        expect(targets).toHaveLength(laterCrawlHistory.length);
        await engineFinishes(req, { transactionsExtracted: 0 });
        return { accepted: true, sessionId: req.sessionId };
      }),
      today: new Date('2026-06-28T00:00:00.000Z'),
    }, { connectionId: connId });
    expect(second.outcome).toBe('completed');
  });

  it('persists the private authoritative row target before dispatch and updates that exact row', async () => {
    await storeCrawlResults(db, {
      connectionId: connId,
      accounts: [{
        providerAccountId: 'a1',
        name: 'Checking',
        currency: 'GBP',
        type: 'current',
        balance: 1000,
      }],
      transactions: [{
        providerAccountId: 'a1',
        providerTransactionId: 'AUTH-1',
        bookingDate: '2026-06-21',
        amount: -50,
        currency: 'GBP',
        description: 'Pending',
        isPending: true,
        extractionOccurrenceId: '00000000-0000-4000-8000-000000000201',
      }],
      positions: [],
    });
    const [connection] = await db.select().from(schema.connections)
      .where(eq(schema.connections.id, connId));
    await db.update(schema.connections).set({
      crawlStats: {
        ...connection.crawlStats,
        lastSuccessfulTxCrawlDay: '2026-06-20',
      },
    }).where(eq(schema.connections.id, connId));
    const [before] = await db.select().from(schema.transactions)
      .where(eq(schema.transactions.connectionId, connId));

    const dispatch = async (req: CrawlRequest): Promise<CrawlAck> => {
      expect(req.recentTransactions).toContainEqual(expect.objectContaining({
        providerTransactionId: 'AUTH-1',
      }));
      const targets = await db.select().from(schema.sessionTransactionTargets)
        .where(eq(schema.sessionTransactionTargets.sessionId, req.sessionId));
      expect(targets).toContainEqual(expect.objectContaining({
        canonicalId: 'AUTH-1',
        transactionId: before.id,
      }));
      await db.insert(schema.stagedRecords).values({
        sessionId: req.sessionId,
        kind: 'transaction',
        data: {
          providerAccountId: 'a1',
          providerTransactionId: 'POSTED-1',
          bookingDate: '2026-06-21',
          amount: -50,
          currency: 'GBP',
          description: 'Posted',
          isPending: false,
          existingCanonicalId: 'AUTH-1',
        },
      });
      await engineFinishes(req, { transactionsExtracted: 1 });
      return { accepted: true, sessionId: req.sessionId };
    };

    const result = await runCrawl(
      db,
      { ...deps(dispatch), today: new Date('2026-06-28T10:00:00Z') },
      { connectionId: connId },
    );

    expect(result.outcome).toBe('completed');
    const rows = await db.select().from(schema.transactions)
      .where(eq(schema.transactions.connectionId, connId));
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(before.id);
    expect(rows[0].data).toMatchObject({
      providerTransactionId: 'POSTED-1',
      description: 'Posted',
      isPending: false,
    });
  });

  it('excludes stored rows outside the exact later-crawl comparison window', async () => {
    await storeCrawlResults(db, {
      connectionId: connId,
      accounts: [],
      transactions: [{
        providerAccountId: 'a1',
        providerTransactionId: 'OLDER-STORED-ROW',
        bookingDate: '2026-04-10',
        amount: -25,
        currency: 'GBP',
        description: 'Older stored row',
        isPending: false,
      }],
      positions: [],
    });
    const [connection] = await db.select().from(schema.connections)
      .where(eq(schema.connections.id, connId));
    await db.update(schema.connections).set({
      crawlStats: {
        ...connection.crawlStats,
        lastSuccessfulTxCrawlDay: '2026-06-20',
      },
    }).where(eq(schema.connections.id, connId));

    let captured: CrawlRequest | undefined;
    const dispatch = async (req: CrawlRequest): Promise<CrawlAck> => {
      captured = req;
      await engineFinishes(req, { transactionsExtracted: 0 });
      return { accepted: true, sessionId: req.sessionId };
    };
    const result = await runCrawl(
      db,
      { ...deps(dispatch), today: new Date('2026-06-28T10:00:00Z') },
      { connectionId: connId },
    );

    expect(result.outcome).toBe('completed');
    expect(captured?.cutoffDate).toBe('2026-06-21');
    expect(captured?.recentTransactions).toEqual([]);
    const targets = await db.select().from(schema.sessionTransactionTargets)
      .where(eq(schema.sessionTransactionTargets.sessionId, result.sessionId as string));
    expect(targets).toHaveLength(0);
  });

  it('clamps a stored over-ceiling timeoutSeconds to the 30-min max at dispatch (a live crawl can never outrun its lease)', async () => {
    // A row stored before the ceiling was lowered (or a direct DB edit) can carry a larger timeout; the
    // point-of-use clamp must cap it so the crawl can never outlive the per-connection lock lease (= CRAWL_EXPIRE).
    await client.exec(`update institutions set timeout_seconds = 7200 where id = 'acme'`);
    let captured: CrawlRequest | undefined;
    const dispatch = async (req: CrawlRequest): Promise<CrawlAck> => {
      captured = req;
      await engineFinishes(req, { costUsd: 0.01 });
      return { accepted: true, sessionId: req.sessionId };
    };
    await runCrawl(db, { ...deps(dispatch), today: new Date('2026-06-28T10:00:00Z') }, { connectionId: connId });
    expect(captured?.timeoutSeconds).toBe(MAX_CRAWL_SECONDS);
    expect(MAX_CRAWL_SECONDS).toBe(30 * 60);
  });

  it('failed: a failing engine outcome is recorded and the session released', async () => {
    const dispatch = async (req: CrawlRequest): Promise<CrawlAck> => {
      await engineFinishes(req, { status: 'failed', error: 'login failed', failureReason: 'bank_login_failed' });
      return { accepted: true, sessionId: req.sessionId };
    };
    const r = await runCrawl(db, deps(dispatch), { connectionId: connId });
    expect(r.outcome).toBe('failed');
    const [c] = await db.select().from(schema.connections).where(eq(schema.connections.id, connId));
    expect(c.status).toBe('error');
    expect(c.consecutiveFailures).toBe(1);
    const [s] = await db.select().from(schema.sessions).where(eq(schema.sessions.id, r.sessionId as string));
    expect(s.status).toBe('failed');
  });

  it('locked: refuses when a crawl is already active for the connection (does not dispatch)', async () => {
    await createCrawlSession(db, { connectionId: connId, leaseOwner: 'other', leaseMs: 60_000 });
    let called = false;
    const r = await runCrawl(db, deps(async (req) => { called = true; await engineFinishes(req); return { accepted: true, sessionId: req.sessionId }; }), { connectionId: connId });
    expect(r.outcome).toBe('locked');
    expect(called).toBe(false);
  });

  it('anti-phishing: refuses an unverified connection without dispatching', async () => {
    const unverified = await createConnection(db, { institutionId: 'acme', username: 'u', password: 'p' });
    let called = false;
    const r = await runCrawl(db, deps(async (req) => { called = true; await engineFinishes(req); return { accepted: true, sessionId: req.sessionId }; }), { connectionId: unverified.id });
    expect(r.outcome).toBe('failed');
    expect(r.error).toBe('This institution’s login domain hasn’t been verified, so the crawl can’t start.');
    expect(called).toBe(false);
  });

  it('supply-chain gate: refuses a config whose malice-scan is not passed (pending AND failed), without dispatching', async () => {
    // The connection is verified + crawlable; only the config's scan status blocks it. Without the run-crawl
    // scan gate this would dispatch (called=true) — so this is a fail-before/pass-after oracle for the gate.
    for (const status of ['pending', 'failed'] as const) {
      await client.exec(`update institutions set scan_status = '${status}' where id = 'acme'`);
      let called = false;
      const r = await runCrawl(db, deps(async (req) => { called = true; await engineFinishes(req); return { accepted: true, sessionId: req.sessionId }; }), { connectionId: connId });
      expect(r.outcome).toBe('failed');
      expect(r.error).toBe('The crawl can’t start until its safety check passes.');
      expect(called).toBe(false);
      // The connection is marked errored with a safe reason (never left stuck), and no session dangles active.
      const [c] = await db.select().from(schema.connections).where(eq(schema.connections.id, connId));
      expect(c.status).toBe('error');
    }
  });

  it('refuses (without dispatching) a connection that became non-crawlable (disabled) since it was enqueued', async () => {
    // The scheduler's enqueue is best-effort; a disconnect could disable the connection in the window
    // before the worker runs. The worker re-checks live status before any credential work.
    await db.update(schema.connections).set({ status: 'disabled' }).where(eq(schema.connections.id, connId));
    let called = false;
    const r = await runCrawl(db, deps(async (req) => { called = true; await engineFinishes(req); return { accepted: true, sessionId: req.sessionId }; }), { connectionId: connId });
    expect(r.outcome).toBe('failed');
    expect(r.error).toBe('This connection must be enabled and signed in before the crawl can start.');
    expect(called).toBe(false);
  });

  it('anti-phishing: refuses (without dispatching) when a stored loginUrlOverride is off the institution domain', async () => {
    // A stale override that somehow survived (e.g. set before a domain change). The point-of-use guard
    // must never dispatch credentials to an off-domain target, even on a verified connection.
    await db.update(schema.connections).set({ loginUrlOverride: 'https://secure.evil.com/login' }).where(eq(schema.connections.id, connId));
    let called = false;
    const r = await runCrawl(db, deps(async (req) => { called = true; await engineFinishes(req); return { accepted: true, sessionId: req.sessionId }; }), { connectionId: connId });
    expect(r.outcome).toBe('failed');
    expect(r.error).toBe('The saved login address doesn’t match this institution’s domain.');
    expect(called).toBe(false);
  });

  // ── Device-proxy (useDeviceProxy) gate ─────────────────────────────────────
  // A verified connection on a useDeviceProxy=true institution.
  async function proxyConn(): Promise<string> {
    await client.exec(
      `insert into institutions (id,name,login_url,canonical_domain,allowed_domains,type,transaction_lookback_days,use_device_proxy,scan_status)
       values ('proxybank','ProxyBank','https://login.proxybank.com/','proxybank.com','[]'::jsonb,'bank',14,true,'passed')`,
    );
    const c = await createConnection(db, { institutionId: 'proxybank', username: 'bob', password: 'pw' });
    await verifyLoginDomain(db, c.id, 'proxybank.com');
    return c.id;
  }

  it('device-proxy: with a paired device, sets tunnel_requested + threads a valid session+device-bound tunnel token', async () => {
    const pId = await proxyConn();
    const device = await pairDevice(db, {
      name: 'Pixel',
      connectionGrants: [pId],
    });

    let captured: CrawlRequest | undefined;
    const wakeCompanion = vi.fn(async (_db: Db, input: CompanionWakeInput) => {
      const [armed] = await db.select({
        tunnelRequested: schema.sessions.tunnelRequested,
        tunnelDeviceId: schema.sessions.tunnelDeviceId,
      }).from(schema.sessions).where(eq(schema.sessions.id, input.data.sessionId));
      expect(armed).toEqual({ tunnelRequested: true, tunnelDeviceId: device.id });
      return { attempted: 1, delivered: 1, invalidated: 0 };
    });
    const dispatch = async (req: CrawlRequest): Promise<CrawlAck> => {
      captured = req;
      await engineFinishes(req);
      return { accepted: true, sessionId: req.sessionId };
    };
    const r = await runCrawl(db, {
      ...deps(dispatch),
      wakeCompanion,
    }, { connectionId: pId });
    expect(r.outcome).toBe('completed');

    // request carries the proxy fields
    expect(captured?.useDeviceProxy).toBe(true);
    expect(typeof captured?.tunnelToken).toBe('string');
    // the token is real, bound to THIS session + THIS device, and verifies under the derived key
    const v = verifyTunnelToken(deriveTunnelKey(config.engineSharedSecret as string), captured!.tunnelToken!);
    expect(v?.sid).toBe(r.sessionId);
    expect(v?.did).toBe(device.id);

    // tunnel_requested set on the session
    const [s] = await db.select().from(schema.sessions).where(eq(schema.sessions.id, r.sessionId as string));
    expect(s.tunnelRequested).toBe(true);
    expect(wakeCompanion).toHaveBeenCalledOnce();
    expect(wakeCompanion).toHaveBeenCalledWith(db, {
      ownerSubject: 'self-hosted:operator',
      connectionId: pId,
      deviceId: device.id,
      data: {
        type: 'tunnel',
        sessionId: r.sessionId,
        institutionId: 'proxybank',
        institutionName: 'ProxyBank',
      },
    });
  });

  it('device-proxy: a missed push leaves the durable tunnel request available for Companion recovery', async () => {
    const pId = await proxyConn();
    await pairDevice(db, { name: 'Pixel', connectionGrants: [pId] });
    const wakeCompanion = vi.fn(async () => {
      throw new Error('temporary FCM outage');
    });
    let dispatched = false;
    const r = await runCrawl(db, {
      ...deps(async (req) => {
        dispatched = true;
        await engineFinishes(req);
        return { accepted: true, sessionId: req.sessionId };
      }),
      wakeCompanion,
    }, { connectionId: pId });

    expect(r.outcome).toBe('completed');
    expect(dispatched).toBe(true);
    expect(wakeCompanion).toHaveBeenCalledOnce();
    const [session] = await db.select().from(schema.sessions)
      .where(eq(schema.sessions.id, r.sessionId as string));
    expect(session.tunnelRequested).toBe(true);
  });

  it('a junk thinking_level stored out-of-band degrades to the engine default instead of failing the crawl', async () => {
    await client.exec(`update institutions set thinking_level = 'turbo' where id = 'acme'`);
    let captured: CrawlRequest | undefined;
    const dispatch = async (req: CrawlRequest): Promise<CrawlAck> => {
      captured = req;
      await engineFinishes(req);
      return { accepted: true, sessionId: req.sessionId };
    };
    const r = await runCrawl(db, deps(dispatch), { connectionId: connId });
    expect(r.outcome).toBe('completed');
    expect(captured?.thinkingLevel).toBeUndefined(); // junk never reaches the engine
    // a real value still flows through
    await client.exec(`update institutions set thinking_level = 'high' where id = 'acme'`);
    const r2 = await runCrawl(db, deps(dispatch), { connectionId: connId });
    expect(r2.outcome).toBe('completed');
    expect(captured?.thinkingLevel).toBe('high');
  });

  it('a refused ack is recorded as instance_died and the session released', async () => {
    const r = await runCrawl(db, deps(async () => ({ accepted: false, error: 'engine dispatch failed: connect ECONNREFUSED' })), { connectionId: connId });
    expect(r.outcome).toBe('failed');
    expect(r.error).toMatch(/ECONNREFUSED/);
    const [s1] = await db.select().from(schema.sessions).where(eq(schema.sessions.id, r.sessionId as string));
    expect(s1.status).toBe('failed');
  });

  it('fences a silent engine before the deadline failure releases the connection lock', async () => {
    // This encodes the class of bug where a crawl outlives the dispatch transport: completion must come
    // from the session row, and a silent engine must be positively stopped before a replacement can start.
    const fenceCrawl = vi.fn(async (sessionId: string) => {
      const [duringFence] = await db.select().from(schema.sessions)
        .where(eq(schema.sessions.id, sessionId));
      expect(duringFence.status).toBe('cancelling');
      expect(await createCrawlSession(db, {
        connectionId: connId,
        leaseOwner: 'replacement',
        leaseMs: 60_000,
      })).toBeNull();
    });
    const r = await runCrawl(
      db,
      {
        ...deps(async (req) => ({ accepted: true, sessionId: req.sessionId })),
        completionDeadlineMs: 60,
        fenceCrawl,
      },
      { connectionId: connId },
    );
    expect(fenceCrawl).toHaveBeenCalledOnce();
    expect(r.outcome).toBe('failed');
    expect(r.error).toBe('The crawl didn’t finish within the allowed time.');
    const [s1] = await db.select().from(schema.sessions).where(eq(schema.sessions.id, r.sessionId as string));
    expect(s1.status).toBe('failed');
    const [c] = await db.select().from(schema.connections).where(eq(schema.connections.id, connId));
    expect(c.status).toBe('error'); // lock released, failure counted
  });

  it('keeps the connection lock when a timed-out execution cannot be fenced', async () => {
    const r = await runCrawl(
      db,
      {
        ...deps(async (req) => ({ accepted: true, sessionId: req.sessionId })),
        completionDeadlineMs: 60,
        fenceCrawl: async () => {
          throw new Error('execution fence unavailable');
        },
      },
      { connectionId: connId },
    );
    expect(r.outcome).toBe('failed');
    expect(r.error).toMatch(/execution fence unavailable/);
    const [session] = await db.select().from(schema.sessions)
      .where(eq(schema.sessions.id, r.sessionId as string));
    expect(session.status).toBe('cancelling');
    expect(await createCrawlSession(db, {
      connectionId: connId,
      leaseOwner: 'replacement',
      leaseMs: 60_000,
    })).toBeNull();
  });

  it('a crawl cancelled mid-run stays cancelled — the outcome write never clobbers it to failed', async () => {
    const dispatch = async (req: CrawlRequest): Promise<CrawlAck> => {
      // Simulate the operator pressing Stop while the crawl runs: the cancel route's status flip.
      await db.update(schema.sessions)
        .set({ status: 'cancelled', error: 'cancelled by operator', completedAt: new Date() })
        .where(eq(schema.sessions.id, req.sessionId));
      return { accepted: true, sessionId: req.sessionId };
    };
    const r = await runCrawl(db, deps(dispatch), { connectionId: connId });
    expect(r.outcome).toBe('failed');
    expect(r.error).toMatch(/cancelled by operator/);
    const [s1] = await db.select().from(schema.sessions).where(eq(schema.sessions.id, r.sessionId as string));
    expect(s1.status).toBe('cancelled'); // NOT overwritten to failed
    expect(s1.error).toBe('cancelled by operator');
  });

  it('does not promote a late successful done event while two-phase cancellation owns the session', async () => {
    const dispatch = async (req: CrawlRequest): Promise<CrawlAck> => {
      await db.insert(schema.stagedRecords).values({
        sessionId: req.sessionId,
        kind: 'account',
        data: { providerAccountId: 'late', name: 'Late result', currency: 'GBP', type: 'current', balance: 1 },
      });
      await db.update(schema.sessions)
        .set({ status: 'cancelling', error: 'cancellation requested by operator' })
        .where(eq(schema.sessions.id, req.sessionId));
      await db.insert(schema.sessionEvents).values({
        sessionId: req.sessionId,
        seq: 999,
        type: 'done',
        data: { success: true, status: 'completed', counts: { accounts: 1 } },
      });
      setTimeout(() => {
        void (async () => {
          await db.update(schema.sessions)
            .set({ status: 'cancelled', error: 'cancelled by operator', completedAt: new Date() })
            .where(eq(schema.sessions.id, req.sessionId));
        })();
      }, 20);
      return { accepted: true, sessionId: req.sessionId };
    };

    const r = await runCrawl(db, deps(dispatch), { connectionId: connId });
    expect(r.outcome).toBe('failed');
    expect(r.error).toMatch(/cancelled by operator/);
    expect(await db.select().from(schema.accounts).where(eq(schema.accounts.connectionId, connId)))
      .toHaveLength(0);
  });

  it('device-proxy: with NO paired device, fails fast with a clear error and does NOT dispatch', async () => {
    const pId = await proxyConn(); // no device paired
    let called = false;
    const r = await runCrawl(db, deps(async (req) => { called = true; await engineFinishes(req); return { accepted: true, sessionId: req.sessionId }; }), { connectionId: pId });
    expect(r.outcome).toBe('failed');
    expect(r.error).toBe('None of the paired phones is allowed to crawl this connection.');
    expect(called).toBe(false);
    // failure recorded on the connection + session released
    const [c] = await db.select().from(schema.connections).where(eq(schema.connections.id, pId));
    expect(c.status).toBe('error');
    const [s] = await db.select().from(schema.sessions).where(eq(schema.sessions.id, r.sessionId as string));
    expect(s.status).toBe('failed');
  });

  it('device-proxy: never binds a paired phone that lacks the connection grant', async () => {
    const pId = await proxyConn();
    await pairDevice(db, {
      name: 'Different connection phone',
      connectionGrants: [connId],
    });
    let called = false;
    const r = await runCrawl(
      db,
      deps(async (req) => {
        called = true;
        await engineFinishes(req);
        return { accepted: true, sessionId: req.sessionId };
      }),
      { connectionId: pId },
    );
    expect(r.outcome).toBe('failed');
    expect(r.error).toBe('None of the paired phones is allowed to crawl this connection.');
    expect(called).toBe(false);
    const [session] = await db
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.id, r.sessionId as string));
    expect(session.tunnelDeviceId).toBeNull();
    expect(session.tunnelRequested).toBe(false);
    // Explicit fixture cleanup also applies when this final case is selected and no later beforeEach runs.
    await db.delete(schema.devices);
  });
});
