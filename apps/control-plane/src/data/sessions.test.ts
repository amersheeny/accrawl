import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import type { Db } from '../db/client';
import {
  createCrawlSession,
  heartbeatSession,
  reapStaleSessions,
  restoreStaleScheduleClaim,
} from './sessions';

describe('crawl session lock + reaper (pglite)', () => {
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

  it('one active crawl per connection: a second acquire returns null until the first releases', async () => {
    const a = await createCrawlSession(db, { connectionId: connId, leaseOwner: 'w1', leaseMs: 60_000 });
    expect(a).not.toBeNull();

    const b = await createCrawlSession(db, { connectionId: connId, leaseOwner: 'w2', leaseMs: 60_000 });
    expect(b).toBeNull(); // lock held

    // complete the first → lock released → a new one acquires
    await db.update(schema.sessions).set({ status: 'completed' }).where(eq(schema.sessions.id, a as string));
    const c = await createCrawlSession(db, { connectionId: connId, leaseOwner: 'w3', leaseMs: 60_000 });
    expect(c).not.toBeNull();
  });

  it('fences stale or disabled scheduled deliveries while manual crawls remain available', async () => {
    expect(await createCrawlSession(db, {
      connectionId: connId,
      leaseOwner: 'stale-schedule',
      leaseMs: 60_000,
      expectedScheduleRevision: 1,
      expectedScheduleClaim: '11111111-1111-4111-8111-111111111111',
    })).toBeNull();

    await db.update(schema.connections).set({
      crawlScheduleEnabled: false,
      crawlScheduleRevision: 1,
    }).where(eq(schema.connections.id, connId));
    expect(await createCrawlSession(db, {
      connectionId: connId,
      leaseOwner: 'disabled-schedule',
      leaseMs: 60_000,
      expectedScheduleRevision: 1,
      expectedScheduleClaim: '11111111-1111-4111-8111-111111111111',
    })).toBeNull();

    expect(await createCrawlSession(db, {
      connectionId: connId,
      leaseOwner: 'manual',
      leaseMs: 60_000,
    })).not.toBeNull();
  });

  it('consumes a scheduled occurrence token exactly once even after its session is terminal', async () => {
    const claim = '11111111-1111-4111-8111-111111111111';
    await db.update(schema.connections).set({
      crawlScheduleClaim: claim,
    }).where(eq(schema.connections.id, connId));
    const first = await createCrawlSession(db, {
      connectionId: connId,
      leaseOwner: 'scheduled-first',
      leaseMs: 60_000,
      expectedScheduleRevision: 0,
      expectedScheduleClaim: claim,
    });
    expect(first).not.toBeNull();
    await db.update(schema.sessions).set({ status: 'completed' })
      .where(eq(schema.sessions.id, first as string));
    expect(await createCrawlSession(db, {
      connectionId: connId,
      leaseOwner: 'scheduled-replay',
      leaseMs: 60_000,
      expectedScheduleRevision: 0,
      expectedScheduleClaim: claim,
    })).toBeNull();
  });

  it('preserves a scheduled occurrence token when another crawl holds the lock', async () => {
    const active = await createCrawlSession(db, {
      connectionId: connId,
      leaseOwner: 'manual-active',
      leaseMs: 60_000,
    });
    expect(active).not.toBeNull();
    const claim = '22222222-2222-4222-8222-222222222222';
    await db.update(schema.connections).set({ crawlScheduleClaim: claim })
      .where(eq(schema.connections.id, connId));

    expect(await createCrawlSession(db, {
      connectionId: connId,
      leaseOwner: 'scheduled-conflict',
      leaseMs: 60_000,
      expectedScheduleRevision: 0,
      expectedScheduleClaim: claim,
    })).toBeNull();
    expect((await db.select({ claim: schema.connections.crawlScheduleClaim })
      .from(schema.connections)
      .where(eq(schema.connections.id, connId)))[0].claim).toBe(claim);
  });

  it('restores a stale scheduler claim without overwriting a crawl that acquired the lock', async () => {
    await db.update(schema.connections).set({
      status: 'syncing',
      crawlScheduleEnabled: false,
      crawlScheduleRevision: 1,
    }).where(eq(schema.connections.id, connId));
    expect(await restoreStaleScheduleClaim(db, {
      connectionId: connId,
      expectedScheduleRevision: 0,
      expectedScheduleClaim: '11111111-1111-4111-8111-111111111111',
      priorStatus: 'error',
    })).toBe(true);
    expect((await db.select({ status: schema.connections.status })
      .from(schema.connections)
      .where(eq(schema.connections.id, connId)))[0].status).toBe('error');

    await db.update(schema.connections).set({
      status: 'syncing',
      crawlScheduleRevision: 2,
    }).where(eq(schema.connections.id, connId));
    expect(await createCrawlSession(db, {
      connectionId: connId,
      leaseOwner: 'manual',
      leaseMs: 60_000,
    })).not.toBeNull();
    expect(await restoreStaleScheduleClaim(db, {
      connectionId: connId,
      expectedScheduleRevision: 1,
      expectedScheduleClaim: '22222222-2222-4222-8222-222222222222',
      priorStatus: 'connected',
    })).toBe(false);
    expect((await db.select({ status: schema.connections.status })
      .from(schema.connections)
      .where(eq(schema.connections.id, connId)))[0].status).toBe('syncing');
  });

  it('reaps an active session with a stale heartbeat AND expired lease (releasing the lock); spares a fresh one', async () => {
    const id = await createCrawlSession(db, { connectionId: connId, leaseOwner: 'w1', leaseMs: 60_000 });
    // backdate both heartbeat and lease to 5 minutes ago — the engine instance died
    await db.update(schema.sessions)
      .set({ heartbeatAt: new Date(Date.now() - 5 * 60_000), leaseExpiresAt: new Date(Date.now() - 5 * 60_000) })
      .where(eq(schema.sessions.id, id as string));

    const reaped = await reapStaleSessions(db, 90_000); // 90s staleness window
    expect(reaped).toEqual([{ id, connectionId: connId }]);

    const [s] = await db.select().from(schema.sessions).where(eq(schema.sessions.id, id as string));
    expect(s.status).toBe('failed');

    // lock is released — a new crawl can start
    const next = await createCrawlSession(db, { connectionId: connId, leaseOwner: 'w2', leaseMs: 60_000 });
    expect(next).not.toBeNull();

    // a fresh heartbeat is NOT reaped
    await heartbeatSession(db, next as string, 60_000);
    expect(await reapStaleSessions(db, 90_000)).toEqual([]);
  });

  it('spares a stale-heartbeat session whose lease has NOT yet expired (a transient stall, not a death)', async () => {
    const id = await createCrawlSession(db, { connectionId: connId, leaseOwner: 'w1', leaseMs: 10 * 60_000 });
    // heartbeat is stale, but the lease is still well in the future — don't steal the lock from a live crawl
    await db.update(schema.sessions).set({ heartbeatAt: new Date(Date.now() - 5 * 60_000) }).where(eq(schema.sessions.id, id as string));
    expect(await reapStaleSessions(db, 90_000)).toEqual([]);
  });
});
