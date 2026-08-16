import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import type { Db } from '../db/client';
import {
  createConnection, getConnection, listConnections, updateConnection, deleteConnection,
  verifyLoginDomain, decryptConnectionCredentials, DomainMismatchError, LoginUrlOverrideError,
} from './connections';

const KEY = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';

describe('connections data (pglite + encryption)', () => {
  let client: PGlite;
  let db: Db;

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
      `insert into institutions (id, name, login_url, canonical_domain, type)
       values ('acme', 'Acme', 'https://login.acme.com/', 'acme.com', 'bank')`,
    );
  });

  it('encrypts credentials at rest, round-trips via decrypt, and the view leaks NO secrets', async () => {
    const view = await createConnection(db, {
      institutionId: 'acme', username: 'alice', password: 's3cret!', dob: '1990-01-01', phone: '+15551234',
    });
    expect(JSON.stringify(view)).not.toContain('s3cret!');
    expect((view as Record<string, unknown>).passwordCt).toBeUndefined();
    expect(view.loginDomainVerified).toBe(false);

    const [raw] = await db.select().from(schema.connections).where(eq(schema.connections.id, view.id));
    expect(raw.passwordCt.startsWith('acc1.')).toBe(true);
    expect(raw.passwordCt).not.toContain('s3cret!');
    expect(decryptConnectionCredentials(raw)).toEqual({
      username: 'alice', password: 's3cret!', dob: '1990-01-01', phone: '+15551234',
    });
  });

  it('verify-domain flips loginDomainVerified only on an exact (case-insensitive) canonical-domain match', async () => {
    const c = await createConnection(db, { institutionId: 'acme', username: 'u', password: 'p' });
    await expect(verifyLoginDomain(db, c.id, 'evil.com')).rejects.toBeInstanceOf(DomainMismatchError);
    expect((await getConnection(db, c.id))?.loginDomainVerified).toBe(false);

    const ok = await verifyLoginDomain(db, c.id, 'ACME.com');
    expect(ok?.loginDomainVerified).toBe(true);
  });

  it('rejects a loginUrlOverride outside the institution canonical domain — on create AND update', async () => {
    const ok = await createConnection(db, {
      institutionId: 'acme', username: 'u', password: 'p', loginUrlOverride: 'https://secure.acme.com/login',
    });
    expect(ok.loginUrlOverride).toBe('https://secure.acme.com/login');

    await expect(createConnection(db, {
      institutionId: 'acme', username: 'u', password: 'p', loginUrlOverride: 'https://evil.com/login',
    })).rejects.toBeInstanceOf(LoginUrlOverrideError);

    // the codex-found bypass: changing the override off-domain after verification
    await expect(updateConnection(db, ok.id, { loginUrlOverride: 'https://evil.com/login' }))
      .rejects.toBeInstanceOf(LoginUrlOverrideError);
    expect((await getConnection(db, ok.id))?.loginUrlOverride).toBe('https://secure.acme.com/login');
  });

  it('verify-domain checks the CURRENT institution domain (a domain change invalidates an old-domain verify)', async () => {
    const c = await createConnection(db, { institutionId: 'acme', username: 'u', password: 'p' });
    await db.update(schema.institutions).set({ canonicalDomain: 'acme-bank.com' }).where(eq(schema.institutions.id, 'acme'));

    await expect(verifyLoginDomain(db, c.id, 'acme.com')).rejects.toBeInstanceOf(DomainMismatchError);
    expect((await getConnection(db, c.id))?.loginDomainVerified).toBe(false);

    const ok = await verifyLoginDomain(db, c.id, 'acme-bank.com');
    expect(ok?.loginDomainVerified).toBe(true);
  });

  it('update re-encrypts a changed password to the new value', async () => {
    const c = await createConnection(db, { institutionId: 'acme', username: 'u', password: 'old' });
    await updateConnection(db, c.id, { password: 'new-pass' });
    const [raw] = await db.select().from(schema.connections).where(eq(schema.connections.id, c.id));
    expect(decryptConnectionCredentials(raw).password).toBe('new-pass');
  });

  it('immediately re-times a verified normal-rotation connection when its schedule changes', async () => {
    const c = await createConnection(db, { institutionId: 'acme', username: 'u', password: 'p' });
    await verifyLoginDomain(db, c.id, 'acme.com');
    await db.insert(schema.connectionsDue).values({
      connectionId: c.id,
      nextCrawlAt: new Date('2030-01-01T00:00:00.000Z'),
    }).onConflictDoUpdate({
      target: schema.connectionsDue.connectionId,
      set: { nextCrawlAt: new Date('2030-01-01T00:00:00.000Z') },
    });

    const before = new Date();
    await updateConnection(db, c.id, { crawlSchedule: '*/5 * * * *' });
    const after = new Date();
    const [due] = await db.select().from(schema.connectionsDue)
      .where(eq(schema.connectionsDue.connectionId, c.id));

    expect(due.nextCrawlAt.getTime()).toBeGreaterThan(before.getTime());
    expect(due.nextCrawlAt.getTime()).toBeLessThanOrEqual(after.getTime() + 5 * 60_000);
    expect(due.nextCrawlAt.getUTCMinutes() % 5).toBe(0);
  });

  it('does not erase a persistent-failure backoff when the schedule is edited', async () => {
    const c = await createConnection(db, { institutionId: 'acme', username: 'u', password: 'p' });
    await verifyLoginDomain(db, c.id, 'acme.com');
    const backedOffUntil = new Date('2030-01-01T00:00:00.000Z');
    await db.update(schema.connections).set({
      status: 'error',
      consecutiveFailures: 6,
    }).where(eq(schema.connections.id, c.id));
    await db.insert(schema.connectionsDue).values({
      connectionId: c.id,
      nextCrawlAt: backedOffUntil,
    }).onConflictDoUpdate({
      target: schema.connectionsDue.connectionId,
      set: { nextCrawlAt: backedOffUntil },
    });

    await updateConnection(db, c.id, { crawlSchedule: '0 8 * * *' });
    const [due] = await db.select().from(schema.connectionsDue)
      .where(eq(schema.connectionsDue.connectionId, c.id));
    expect(due.nextCrawlAt.toISOString()).toBe(backedOffUntil.toISOString());
  });

  it('lists (optionally filtered by grant ids) and deletes', async () => {
    const a = await createConnection(db, { institutionId: 'acme', username: 'a', password: 'p' });
    await createConnection(db, { institutionId: 'acme', username: 'b', password: 'p' });
    expect(await listConnections(db)).toHaveLength(2);
    expect((await listConnections(db, [a.id])).map((c) => c.id)).toEqual([a.id]);
    expect(await deleteConnection(db, a.id)).toBe('deleted');
    expect(await listConnections(db)).toHaveLength(1);
    expect(await deleteConnection(db, a.id)).toBe('not_found');
  });

  it('deleting a connection cascades its sessions', async () => {
    const c = await createConnection(db, { institutionId: 'acme', username: 'u', password: 'p' });
    await db.insert(schema.sessions).values({ connectionId: c.id });
    expect(await deleteConnection(db, c.id)).toBe('active_crawl');
    const activeSessions = await db.select().from(schema.sessions)
      .where(eq(schema.sessions.connectionId, c.id));
    expect(activeSessions).toHaveLength(1);

    await db.update(schema.sessions)
      .set({ status: 'completed' })
      .where(eq(schema.sessions.connectionId, c.id));
    expect(await deleteConnection(db, c.id)).toBe('deleted');
    const sessions = await db.select().from(schema.sessions).where(eq(schema.sessions.connectionId, c.id));
    expect(sessions).toHaveLength(0);
  });

  it('keeps a cancelling connection and its lock until the worker is fenced', async () => {
    const c = await createConnection(db, { institutionId: 'acme', username: 'u', password: 'p' });
    await db.insert(schema.sessions).values({
      connectionId: c.id,
      status: 'cancelling',
    });

    expect(await deleteConnection(db, c.id)).toBe('active_crawl');
    expect(await getConnection(db, c.id)).not.toBeNull();
  });
});
