import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import * as schema from '../db/schema';
import type { Db } from '../db/client';
import {
  schedulerTick, nextRunFromCron, ensureDueRows, reapStaleCrawlJobs, sweepExpiredSessions,
  NON_AUTH_FAILURE_BACKOFF_MS,
} from './scheduler';

const NOW = new Date('2026-06-28T10:00:00Z');

describe('scheduler (pglite)', () => {
  let client: PGlite;
  let db: Db;

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
  });

  const mkConn = async (opts: {
    status: string;
    verified: boolean;
    fails: number;
    schedule?: string;
    failureReason?: string;
  }): Promise<string> => {
    const r = await client.query<{ id: string }>(
      `insert into connections (
         institution_id, username_ct, password_ct, status, login_domain_verified,
         consecutive_failures, crawl_schedule, crawl_stats
       )
       values ('b','u','p',$1,$2,$3,$4,$5::jsonb) returning id`,
      [
        opts.status,
        opts.verified,
        opts.fails,
        opts.schedule ?? '0 6 * * *',
        JSON.stringify({
          totalCount: opts.fails,
          completedCount: 0,
          failedCount: opts.fails,
          consecutiveFailures: opts.fails,
          avgCostUsd: 0,
          recentCosts: [],
          ...(opts.failureReason ? { lastFailureReason: opts.failureReason } : {}),
        }),
      ],
    );
    return r.rows[0].id;
  };

  it('nextRunFromCron honors the cron in UTC; bad cron falls back to +24h', () => {
    expect(nextRunFromCron('0 6 * * *', 'UTC', NOW).toISOString()).toBe('2026-06-29T06:00:00.000Z');
    expect(nextRunFromCron('not a cron', 'UTC', NOW).toISOString()).toBe('2026-06-29T10:00:00.000Z');
  });

  it('interprets wall-clock schedules in their IANA timezone', () => {
    expect(nextRunFromCron('0 6 * * *', 'Europe/London', NOW).toISOString())
      .toBe('2026-06-29T05:00:00.000Z');
  });

  it('self-heal: a verified connection gets a due-row and is enqueued; status->syncing; nextCrawlAt advances', async () => {
    const id = await mkConn({ status: 'connected', verified: true, fails: 0 });
    const enqueued: string[] = [];
    const r = await schedulerTick(db, { enqueueCrawl: async (cid) => { enqueued.push(cid); }, now: NOW });
    expect(r.enqueued).toBe(1);
    expect(enqueued).toEqual([id]);

    const [c] = await db.select().from(schema.connections).where(eq(schema.connections.id, id));
    expect(c.status).toBe('syncing');
    const [d] = await db.select().from(schema.connectionsDue).where(eq(schema.connectionsDue.connectionId, id));
    expect(d.nextCrawlAt.toISOString()).toBe('2026-06-29T06:00:00.000Z');
  });

  it('does not double-enqueue: the atomic claim advances nextCrawlAt so a re-tick at the same instant skips it', async () => {
    const id = await mkConn({ status: 'connected', verified: true, fails: 0 });
    const enqueued: string[] = [];
    const enqueue = async (cid: string): Promise<void> => { enqueued.push(cid); };
    await schedulerTick(db, { enqueueCrawl: enqueue, now: NOW });
    const r2 = await schedulerTick(db, { enqueueCrawl: enqueue, now: NOW }); // same instant — row already claimed
    expect(r2.enqueued).toBe(0);
    expect(enqueued).toEqual([id]); // enqueued exactly once
  });

  it('rolls the claim back if enqueue fails, so the crawl retries and status is restored (not stuck syncing)', async () => {
    const id = await mkConn({ status: 'connected', verified: true, fails: 0 });
    const r = await schedulerTick(db, { enqueueCrawl: async () => { throw new Error('queue down'); }, now: NOW });
    expect(r.enqueued).toBe(0);
    const [c] = await db.select().from(schema.connections).where(eq(schema.connections.id, id));
    expect(c.status).toBe('connected'); // restored — NOT left falsely 'syncing'
    const [d] = await db.select().from(schema.connectionsDue).where(eq(schema.connectionsDue.connectionId, id));
    expect(d.nextCrawlAt.getTime()).toBeLessThanOrEqual(NOW.getTime()); // still due -> next tick retries
  });

  it('restores status when Manual only races a failed queue hand-off', async () => {
    const id = await mkConn({ status: 'connected', verified: true, fails: 0 });
    await schedulerTick(db, {
      enqueueCrawl: async (cid) => {
        await db.transaction(async (tx) => {
          await tx.delete(schema.connectionsDue)
            .where(eq(schema.connectionsDue.connectionId, cid));
          await tx.update(schema.connections).set({
            crawlScheduleEnabled: false,
            crawlScheduleRevision: 1,
            crawlScheduleClaim: null,
          }).where(eq(schema.connections.id, cid));
        });
        throw new Error('queue down after Manual only edit');
      },
      now: NOW,
    });
    const [connection] = await db.select().from(schema.connections)
      .where(eq(schema.connections.id, id));
    expect(connection.status).toBe('connected');
    expect(connection.crawlScheduleEnabled).toBe(false);
    expect(await db.select().from(schema.connectionsDue)
      .where(eq(schema.connectionsDue.connectionId, id))).toHaveLength(0);
  });

  it('rollback is conditional: a late enqueue failure does not clobber a concurrent re-claim', async () => {
    const id = await mkConn({ status: 'connected', verified: true, fails: 0 });
    const TICK_B = new Date('2026-06-30T00:00:00.000Z'); // a newer tick's claimed next-run
    const enqueue = async (cid: string): Promise<void> => {
      // While this (hung) enqueue is in flight, a concurrent tick re-claims the row; then this one fails.
      await db.update(schema.connectionsDue).set({ nextCrawlAt: TICK_B }).where(eq(schema.connectionsDue.connectionId, cid));
      await db.update(schema.connections).set({
        crawlScheduleClaim: '22222222-2222-4222-8222-222222222222',
      }).where(eq(schema.connections.id, cid));
      throw new Error('late failure after a newer tick re-claimed');
    };
    await schedulerTick(db, { enqueueCrawl: enqueue, now: NOW });
    const [d] = await db.select().from(schema.connectionsDue).where(eq(schema.connectionsDue.connectionId, id));
    expect(d.nextCrawlAt.toISOString()).toBe(TICK_B.toISOString()); // newer claim preserved — NOT rolled back to due
  });

  it('backs off a non-recoverable connection and never enqueues it', async () => {
    await mkConn({ status: 'needs_reauth', verified: true, fails: 0 });
    const enqueued: string[] = [];
    const r = await schedulerTick(db, { enqueueCrawl: async (cid) => { enqueued.push(cid); }, now: NOW });
    expect(r.enqueued).toBe(0);
    expect(r.backedOff).toBe(1);
    expect(enqueued).toEqual([]);
  });

  it('escalates a connection past MAX_CONSECUTIVE_CRAWL_FAILURES to needs_reauth without enqueuing', async () => {
    const id = await mkConn({
      status: 'error',
      verified: true,
      fails: 6,
      failureReason: 'bank_login_failed',
    }); // > 5
    const enqueued: string[] = [];
    const r = await schedulerTick(db, { enqueueCrawl: async (cid) => { enqueued.push(cid); }, now: NOW });
    expect(r.escalated).toBe(1);
    expect(enqueued).toEqual([]);
    const [c] = await db.select().from(schema.connections).where(eq(schema.connections.id, id));
    expect(c.status).toBe('needs_reauth');
  });

  it('backs a persistent non-auth failure off for seven days and keeps truthful error status', async () => {
    const id = await mkConn({
      status: 'error',
      verified: true,
      fails: 6,
      failureReason: 'site_unavailable',
    });
    const enqueued: string[] = [];
    const r = await schedulerTick(db, {
      enqueueCrawl: async (cid) => { enqueued.push(cid); },
      now: NOW,
    });

    expect(r.escalated).toBe(0);
    expect(r.backedOff).toBe(1);
    expect(enqueued).toEqual([]);
    const [c] = await db.select().from(schema.connections).where(eq(schema.connections.id, id));
    const [d] = await db.select().from(schema.connectionsDue).where(eq(schema.connectionsDue.connectionId, id));
    expect(c.status).toBe('error');
    expect(d.nextCrawlAt.toISOString()).toBe(
      new Date(NOW.getTime() + NON_AUTH_FAILURE_BACKOFF_MS).toISOString(),
    );
  });

  it('reaping a stale session ALSO reconciles its connection: out of syncing -> error, failure counted', async () => {
    const id = await mkConn({ status: 'syncing', verified: true, fails: 0 });
    // Park the due-row so the tick's enqueue loop doesn't immediately re-claim the reconciled connection.
    await ensureDueRows(db, NOW);
    await db.update(schema.connectionsDue).set({ nextCrawlAt: new Date(NOW.getTime() + 3_600_000) }).where(eq(schema.connectionsDue.connectionId, id));
    // a dead engine: active session, heartbeat + lease both well past
    await client.query(
      `insert into sessions (connection_id, status, heartbeat_at, lease_expires_at) values ($1,'extracting',$2,$2)`,
      [id, new Date(NOW.getTime() - 10 * 60_000)],
    );
    const r = await schedulerTick(db, { enqueueCrawl: async () => {}, now: NOW });
    expect(r.reaped).toBe(1);
    const [c] = await db.select().from(schema.connections).where(eq(schema.connections.id, id));
    expect(c.status).toBe('error'); // no longer stuck 'syncing'
    expect(c.consecutiveFailures).toBe(1); // counted toward escalation
    expect((c.crawlStats as { lastFailureReason?: string }).lastFailureReason).toBe('instance_died');
  });

  it('reaps an expired ephemeral-worker lease and fails the owning session', async () => {
    const connectionId = await mkConn({ status: 'syncing', verified: true, fails: 0 });
    const [session] = await db.insert(schema.sessions).values({
      connectionId,
      status: 'extracting',
      leaseOwner: 'control',
      leaseExpiresAt: new Date(NOW.getTime() + 60 * 60_000),
      heartbeatAt: NOW,
    }).returning();
    await db.insert(schema.crawlJobs).values({
      id: session.id,
      sessionId: session.id,
      encryptedPayload: 'encrypted',
      claimToken: 'one-job-token',
      claimTokenHash: createHash('sha256').update('one-job-token').digest('hex'),
      status: 'running',
      leaseOwner: 'dead-worker',
      leaseExpiresAt: new Date(NOW.getTime() - 1),
      heartbeatAt: new Date(NOW.getTime() - 60_000),
    });

    expect(await reapStaleCrawlJobs(db, NOW)).toBe(1);
    const [job] = await db.select().from(schema.crawlJobs).where(eq(schema.crawlJobs.id, session.id));
    const [failedSession] = await db.select().from(schema.sessions).where(eq(schema.sessions.id, session.id));
    expect(job.status).toBe('failed');
    expect(job.encryptedPayload).toBe('');
    expect(job.claimToken).toBe('');
    expect(failedSession.status).toBe('failed');
    expect(failedSession.failureReason).toBe('instance_died');
  });

  it('finishes a stranded cancellation only after the worker lease fence expires', async () => {
    const connectionId = await mkConn({ status: 'syncing', verified: true, fails: 0 });
    const [session] = await db.insert(schema.sessions).values({
      connectionId,
      status: 'cancelling',
      leaseOwner: 'control',
      leaseExpiresAt: new Date(NOW.getTime() + 60 * 60_000),
      heartbeatAt: NOW,
    }).returning();
    await db.insert(schema.crawlJobs).values({
      id: session.id,
      sessionId: session.id,
      encryptedPayload: 'encrypted',
      claimToken: 'one-job-token',
      claimTokenHash: createHash('sha256').update('one-job-token').digest('hex'),
      status: 'running',
      leaseOwner: 'dead-worker',
      leaseExpiresAt: new Date(NOW.getTime() + 60_000),
      heartbeatAt: new Date(NOW.getTime() - 60_000),
    });

    expect(await reapStaleCrawlJobs(db, NOW)).toBe(0);
    const [stillFencingJob] = await db.select().from(schema.crawlJobs)
      .where(eq(schema.crawlJobs.id, session.id));
    const [stillLockedSession] = await db.select().from(schema.sessions)
      .where(eq(schema.sessions.id, session.id));
    expect(stillFencingJob.status).toBe('cancel_requested');
    expect(stillLockedSession.status).toBe('cancelling');

    await db.update(schema.crawlJobs)
      .set({ leaseExpiresAt: new Date(NOW.getTime() - 1) })
      .where(eq(schema.crawlJobs.id, session.id));
    expect(await reapStaleCrawlJobs(db, NOW)).toBe(1);
    const [job] = await db.select().from(schema.crawlJobs).where(eq(schema.crawlJobs.id, session.id));
    const [cancelledSession] = await db.select().from(schema.sessions)
      .where(eq(schema.sessions.id, session.id));
    expect(job.status).toBe('cancelled');
    expect(job.encryptedPayload).toBe('');
    expect(job.claimToken).toBe('');
    expect(cancelledSession.status).toBe('cancelled');
    expect(cancelledSession.error).toBeNull();
  });

  it('recovers a stranded completed crawl: terminal session + connection still syncing -> staged records promoted, connection reconciled', async () => {
    const id = await mkConn({ status: 'syncing', verified: true, fails: 0 });
    // Park the due-row so the tick's enqueue loop doesn't re-flip the recovered connection back to 'syncing'.
    await ensureDueRows(db, NOW);
    await db.update(schema.connectionsDue).set({ nextCrawlAt: new Date(NOW.getTime() + 3_600_000) }).where(eq(schema.connectionsDue.connectionId, id));
    // A completed session whose bookkeeping never ran (process died after markSessionTerminal), with
    // staged extraction left unpromoted. expires_at far in the future so the retention sweep ignores it.
    const s = await client.query<{ id: string }>(
      `insert into sessions (connection_id, status, expires_at) values ($1,'completed',$2) returning id`,
      [id, new Date(NOW.getTime() + 30 * 24 * 60 * 60_000)],
    );
    const sessionId = s.rows[0].id;
    await db.insert(schema.stagedRecords).values([
      { sessionId, kind: 'account', data: { providerAccountId: 'a1', name: 'Checking', currency: 'GBP', type: 'current', balance: 1000 } },
      { sessionId, kind: 'transaction', data: { providerAccountId: 'a1', providerTransactionId: 'BANK1', bookingDate: '2026-06-10', amount: -50, currency: 'GBP', description: 'Shop', isPending: false } },
    ]);

    const r = await schedulerTick(db, { enqueueCrawl: async () => {}, now: NOW });
    expect(r.recovered).toBe(1);

    // staged extraction promoted into the canonical tables
    expect(await db.select().from(schema.accounts).where(eq(schema.accounts.connectionId, id))).toHaveLength(1);
    expect(await db.select().from(schema.transactions).where(eq(schema.transactions.connectionId, id))).toHaveLength(1);
    // connection reconciled out of 'syncing' + watermark advanced (it reached the tx surface)
    const [c] = await db.select().from(schema.connections).where(eq(schema.connections.id, id));
    expect(c.status).toBe('connected');
    expect((c.crawlStats as { lastSuccessfulTxCrawlDay?: string }).lastSuccessfulTxCrawlDay).toBe('2026-06-28');
  });

  it('recovers an authorized update through the session’s exact stored row id', async () => {
    const id = await mkConn({ status: 'syncing', verified: true, fails: 0 });
    await ensureDueRows(db, NOW);
    await db.update(schema.connectionsDue)
      .set({ nextCrawlAt: new Date(NOW.getTime() + 3_600_000) })
      .where(eq(schema.connectionsDue.connectionId, id));
    await db.insert(schema.transactions).values({
      id: 'authoritative-row',
      connectionId: id,
      data: {
        providerAccountId: 'a1',
        providerTransactionId: 'AUTH-OLD',
        bookingDate: '2026-06-10',
        amount: -50,
        currency: 'GBP',
        description: 'Pending',
        isPending: true,
      },
    });
    const session = await client.query<{ id: string }>(
      `insert into sessions (connection_id, status, expires_at)
       values ($1,'completed',$2) returning id`,
      [id, new Date(NOW.getTime() + 30 * 24 * 60 * 60_000)],
    );
    const sessionId = session.rows[0].id;
    await db.insert(schema.sessionTransactionTargets).values({
      sessionId,
      providerAccountId: 'a1',
      canonicalId: 'AUTH-OLD',
      transactionId: 'authoritative-row',
    });
    const [staged] = await db.insert(schema.stagedRecords).values({
      sessionId,
      kind: 'transaction',
      data: {
        providerAccountId: 'a1',
        providerTransactionId: 'AUTH-POSTED',
        bookingDate: '2026-06-10',
        amount: -50,
        currency: 'GBP',
        description: 'Posted',
        isPending: false,
        existingCanonicalId: 'AUTH-OLD',
      },
    }).returning({ id: schema.stagedRecords.id });

    const recovered = await schedulerTick(db, { enqueueCrawl: async () => {}, now: NOW });

    expect(recovered.recovered).toBe(1);
    const rows = await db.select().from(schema.transactions)
      .where(eq(schema.transactions.connectionId, id));
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('authoritative-row');
    expect(rows[0].data).toMatchObject({
      providerTransactionId: 'AUTH-POSTED',
      description: 'Posted',
      isPending: false,
    });
    const claims = await db.select().from(schema.transactionOccurrences)
      .where(eq(schema.transactionOccurrences.connectionId, id));
    expect(claims).toContainEqual(expect.objectContaining({
      occurrenceId: staged.id,
      transactionId: 'authoritative-row',
    }));
  });

  it("recovers an ORPHANED SUCCESS: engine wrote 'done' + staged records but the process died before promotion", async () => {
    const id = await mkConn({ status: 'syncing', verified: true, fails: 0 });
    await ensureDueRows(db, NOW);
    await db.update(schema.connectionsDue).set({ nextCrawlAt: new Date(NOW.getTime() + 3_600_000) }).where(eq(schema.connectionsDue.connectionId, id));
    // The engine finished successfully: staged records + a success 'done' event are durable, but the
    // status is still ACTIVE (the control-plane flips 'completed' only after promotion — and it died).
    // Lease expired → no live runCrawl is racing us.
    // REAL shape: the engine heartbeated until its success write, so heartbeat_at is set and STALE —
    // the reaper must skip this row (it has a 'done' event) or it would fail completed work before
    // the recovery sweep runs.
    const s = await client.query<{ id: string }>(
      `insert into sessions (connection_id, status, lease_expires_at, heartbeat_at, expires_at)
       values ($1,'extracting',$2,$3,$4) returning id`,
      [id, new Date(NOW.getTime() - 60_000), new Date(NOW.getTime() - 3_600_000), new Date(NOW.getTime() + 30 * 24 * 60 * 60_000)],
    );
    const sessionId = s.rows[0].id;
    await db.insert(schema.stagedRecords).values([
      { sessionId, kind: 'account', data: { providerAccountId: 'a9', name: 'Savings', currency: 'GBP', type: 'savings', balance: 5000 } },
      { sessionId, kind: 'transaction', data: { providerAccountId: 'a9', providerTransactionId: 'BANK9', bookingDate: '2026-06-12', amount: 20, currency: 'GBP', description: 'Interest', isPending: false } },
    ]);
    await db.insert(schema.sessionEvents).values({ sessionId, seq: 1, type: 'done', data: { success: true, status: 'completed', counts: {} } as never });

    const r = await schedulerTick(db, { enqueueCrawl: async () => {}, now: NOW });
    expect(r.recovered).toBe(1);

    // promoted + session completed + connection reconciled — the reaper never gets to fail a success
    expect(await db.select().from(schema.accounts).where(eq(schema.accounts.connectionId, id))).toHaveLength(1);
    const [sess] = await db.select().from(schema.sessions).where(eq(schema.sessions.id, sessionId));
    expect(sess.status).toBe('completed');
    const [c] = await db.select().from(schema.connections).where(eq(schema.connections.id, id));
    expect(c.status).toBe('connected');
  });

  it('does NOT touch an active session whose lease is still valid (a live runCrawl owns the promotion)', async () => {
    const id = await mkConn({ status: 'syncing', verified: true, fails: 0 });
    await ensureDueRows(db, NOW);
    await db.update(schema.connectionsDue).set({ nextCrawlAt: new Date(NOW.getTime() + 3_600_000) }).where(eq(schema.connectionsDue.connectionId, id));
    const s = await client.query<{ id: string }>(
      `insert into sessions (connection_id, status, lease_expires_at, expires_at)
       values ($1,'extracting',$2,$3) returning id`,
      [id, new Date(NOW.getTime() + 300_000), new Date(NOW.getTime() + 30 * 24 * 60 * 60_000)],
    );
    await db.insert(schema.sessionEvents).values({ sessionId: s.rows[0].id, seq: 1, type: 'done', data: { success: true, status: 'completed', counts: {} } as never });

    const r = await schedulerTick(db, { enqueueCrawl: async () => {}, now: NOW });
    expect(r.recovered).toBe(0);
    const [sess] = await db.select().from(schema.sessions).where(eq(schema.sessions.id, s.rows[0].id));
    expect(sess.status).toBe('extracting'); // untouched — the live worker will promote and flip it
  });

  it('does NOT recover a syncing connection that has a live (active) session: that sync belongs to the new crawl', async () => {
    const id = await mkConn({ status: 'syncing', verified: true, fails: 0 });
    await ensureDueRows(db, NOW);
    await db.update(schema.connectionsDue).set({ nextCrawlAt: new Date(NOW.getTime() + 3_600_000) }).where(eq(schema.connectionsDue.connectionId, id));
    // An OLD terminal session with stranded staged records...
    const old = await client.query<{ id: string }>(
      `insert into sessions (connection_id, status, expires_at) values ($1,'completed',$2) returning id`,
      [id, new Date(NOW.getTime() + 30 * 24 * 60 * 60_000)],
    );
    await db.insert(schema.stagedRecords).values([
      { sessionId: old.rows[0].id, kind: 'account', data: { providerAccountId: 'a1', name: 'Checking', currency: 'GBP', type: 'current', balance: 1000 } },
    ]);
    // ...but a NEW crawl is live (an active session holds the lock), so the connection's 'syncing' is its.
    await client.query(`insert into sessions (connection_id, status, heartbeat_at) values ($1,'extracting',$2)`, [id, NOW]);

    const r = await schedulerTick(db, { enqueueCrawl: async () => {}, now: NOW });
    expect(r.recovered).toBe(0); // the live crawl owns the sync — old staged records must NOT be force-promoted
    expect(await db.select().from(schema.accounts).where(eq(schema.accounts.connectionId, id))).toHaveLength(0);
    const [c] = await db.select().from(schema.connections).where(eq(schema.connections.id, id));
    expect(c.status).toBe('syncing'); // left for the live crawl to finish
  });

  it('recovery is idempotent: re-running the tick does not double-apply (connection already off syncing)', async () => {
    const id = await mkConn({ status: 'syncing', verified: true, fails: 0 });
    // Park the due-row in the future so the tick's own enqueue loop doesn't re-flip the connection to
    // 'syncing' — this isolates the recovery sweeper's idempotency.
    await ensureDueRows(db, NOW);
    await db.update(schema.connectionsDue).set({ nextCrawlAt: new Date(NOW.getTime() + 3_600_000) }).where(eq(schema.connectionsDue.connectionId, id));
    const s = await client.query<{ id: string }>(
      `insert into sessions (connection_id, status, expires_at) values ($1,'completed',$2) returning id`,
      [id, new Date(NOW.getTime() + 30 * 24 * 60 * 60_000)],
    );
    await db.insert(schema.stagedRecords).values([
      { sessionId: s.rows[0].id, kind: 'account', data: { providerAccountId: 'a1', name: 'Checking', currency: 'GBP', type: 'current', balance: 1000 } },
    ]);
    const r1 = await schedulerTick(db, { enqueueCrawl: async () => {}, now: NOW });
    expect(r1.recovered).toBe(1);
    const r2 = await schedulerTick(db, { enqueueCrawl: async () => {}, now: NOW });
    expect(r2.recovered).toBe(0); // connection no longer 'syncing' -> not re-promoted
    const [c] = await db.select().from(schema.connections).where(eq(schema.connections.id, id));
    expect(c.crawlStats as { completedCount: number }).toMatchObject({ completedCount: 1 }); // applied exactly once
  });

  it('retention sweep deletes sessions past expires_at (cascading staged records); spares unexpired ones', async () => {
    const id = await mkConn({ status: 'connected', verified: true, fails: 0 });
    const expired = await client.query<{ id: string }>(
      `insert into sessions (connection_id, status, expires_at) values ($1,'completed',$2) returning id`,
      [id, new Date(NOW.getTime() - 60_000)], // already past
    );
    const live = await client.query<{ id: string }>(
      `insert into sessions (connection_id, status, expires_at) values ($1,'completed',$2) returning id`,
      [id, new Date(NOW.getTime() + 60_000)], // not yet
    );
    await db.insert(schema.stagedRecords).values([{ sessionId: expired.rows[0].id, kind: 'account', data: {} }]);

    const purged = await sweepExpiredSessions(db, NOW);
    expect(purged).toBe(1);
    expect(await db.select().from(schema.sessions).where(eq(schema.sessions.id, expired.rows[0].id))).toHaveLength(0);
    expect(await db.select().from(schema.sessions).where(eq(schema.sessions.id, live.rows[0].id))).toHaveLength(1);
    // cascade dropped the staged record
    expect(await db.select().from(schema.stagedRecords).where(eq(schema.stagedRecords.sessionId, expired.rows[0].id))).toHaveLength(0);
  });

  it('does not enqueue a connection whose nextCrawlAt is in the future; reaps stale sessions', async () => {
    const id = await mkConn({ status: 'connected', verified: true, fails: 0 });
    await ensureDueRows(db, NOW);
    await db.update(schema.connectionsDue).set({ nextCrawlAt: new Date(NOW.getTime() + 3_600_000) }).where(eq(schema.connectionsDue.connectionId, id));
    // a stale active session for this connection (heartbeat well past the default staleness window)
    const s = await client.query<{ id: string }>(`insert into sessions (connection_id, status, heartbeat_at) values ($1,'extracting',$2) returning id`, [id, new Date(NOW.getTime() - 10 * 60_000)]);

    const enqueued: string[] = [];
    const r = await schedulerTick(db, { enqueueCrawl: async (cid) => { enqueued.push(cid); }, now: NOW });
    expect(enqueued).toEqual([]); // not due
    expect(r.reaped).toBe(1); // the stale session was reaped
    const [reapedSession] = await db.select().from(schema.sessions).where(eq(schema.sessions.id, s.rows[0].id));
    expect(reapedSession.status).toBe('failed');
  });
});
