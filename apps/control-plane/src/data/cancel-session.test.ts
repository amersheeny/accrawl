import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import type { Db } from '../db/client';
import { createConnection } from './connections';
import { createCrawlSession, markSessionTerminal } from './sessions';
import {
  finalizeSessionCancellation,
  finalizeSessionFailureAfterFence,
  requestSessionCancellation,
} from './cancel-session';

const KEY = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';

describe('two-phase session cancellation (pglite)', () => {
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
    await client.exec('truncate institutions cascade');
    await client.exec(
      `insert into institutions (id,name,login_url,canonical_domain,type)
       values ('acme','Acme','https://login.acme.com/','acme.com','bank')`,
    );
    const c = await createConnection(db, { institutionId: 'acme', username: 'alice', password: 's3cret' });
    connId = c.id;
  });

  const create = () => createCrawlSession(db, { connectionId: connId, leaseOwner: 'w1', leaseMs: 60_000 });

  it('retains the lock while cancelling and releases it only after the worker fence', async () => {
    const id = await create();
    expect(id).toBeTruthy();
    // The lock is held: a second create for the same connection is rejected (null).
    expect(await create()).toBeNull();

    expect(await requestSessionCancellation(db, id!)).toBe('cancellation_requested');

    const [s] = await db.select().from(schema.sessions).where(eq(schema.sessions.id, id!));
    expect(s.status).toBe('cancelling');
    expect(s.error).toBeNull();
    expect(s.completedAt).toBeNull();
    expect(await create()).toBeNull();

    expect(await finalizeSessionCancellation(db, id!)).toBe(true);
    const [cancelled] = await db.select().from(schema.sessions).where(eq(schema.sessions.id, id!));
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.error).toBeNull();
    expect(cancelled.completedAt).not.toBeNull();
    const next = await create();
    expect(next).toBeTruthy();
    expect(next).not.toBe(id);
  });

  it('is idempotent across both cancellation phases', async () => {
    const id = await create();
    expect(await requestSessionCancellation(db, id!)).toBe('cancellation_requested');
    expect(await requestSessionCancellation(db, id!)).toBe('already_cancelling');
    expect(await finalizeSessionCancellation(db, id!)).toBe(true);
    expect(await finalizeSessionCancellation(db, id!)).toBe(false);
    expect(await requestSessionCancellation(db, id!)).toBe('already_cancelled');
  });

  it('publishes a timeout failure only from the lock-retaining cancelling phase', async () => {
    const id = await create();
    expect(await finalizeSessionFailureAfterFence(db, id!, 'timed out')).toBe(false);
    expect(await requestSessionCancellation(db, id!)).toBe('cancellation_requested');
    expect(await finalizeSessionFailureAfterFence(db, id!, 'timed out')).toBe(true);
    const [failed] = await db.select().from(schema.sessions).where(eq(schema.sessions.id, id!));
    expect(failed.status).toBe('failed');
    expect(failed.error).toBe('timed out');
    expect(failed.failureReason).toBe('instance_died');
    expect(failed.completedAt).not.toBeNull();
    expect(await create()).toBeTruthy();
  });

  it('refuses to cancel a session that already finished (already_terminal)', async () => {
    const id = await create();
    await db.update(schema.sessions).set({ status: 'completed' }).where(eq(schema.sessions.id, id!));
    expect(await requestSessionCancellation(db, id!)).toBe('already_terminal');
  });

  it('refuses cancellation after the engine has durably handed a successful result to promotion', async () => {
    const id = await create();
    await db.update(schema.sessions)
      .set({ promotionReadyAt: new Date() })
      .where(eq(schema.sessions.id, id!));
    await db.insert(schema.sessionEvents).values({
      sessionId: id!,
      seq: 1,
      type: 'done',
      data: { success: true, status: 'completed', counts: {} },
    });
    expect(await requestSessionCancellation(db, id!)).toBe('already_terminal');
    const [s] = await db.select().from(schema.sessions).where(eq(schema.sessions.id, id!));
    expect(s.status).toBe('starting');
  });

  it('protects a successful handoff written before promotion_ready_at existed', async () => {
    const id = await create();
    await db.insert(schema.sessionEvents).values({
      sessionId: id!,
      seq: 1,
      type: 'done',
      data: { success: true, status: 'completed', counts: {} },
    });

    expect(await requestSessionCancellation(db, id!)).toBe('already_terminal');
    const [s] = await db.select().from(schema.sessions).where(eq(schema.sessions.id, id!));
    expect(s.status).toBe('starting');
    expect(s.promotionReadyAt).toBeNull();
  });

  it('returns not_found for an unknown session id', async () => {
    expect(await requestSessionCancellation(
      db,
      '00000000-0000-0000-0000-000000000000',
    )).toBe('not_found');
  });

  it('a crawl finishing after the request cannot clobber either cancellation phase', async () => {
    const id = await create();
    expect(await requestSessionCancellation(db, id!)).toBe('cancellation_requested');
    await markSessionTerminal(db, id!, true);
    const [cancelling] = await db.select().from(schema.sessions).where(eq(schema.sessions.id, id!));
    expect(cancelling.status).toBe('cancelling');

    await finalizeSessionCancellation(db, id!);
    await markSessionTerminal(db, id!, true);
    const [s] = await db.select().from(schema.sessions).where(eq(schema.sessions.id, id!));
    expect(s.status).toBe('cancelled');
  });
});
