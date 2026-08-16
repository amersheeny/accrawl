/**
 * Schema + migration validation against a real Postgres engine (pglite, in-process).
 * Applies every generated migration on a fresh DB, then round-trips inserts to
 * exercise enums, jsonb defaults, timestamps, and FK cascade.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { eq, sql } from 'drizzle-orm';
import * as schema from './schema';

const EXPECTED_TABLES = [
  'institutions', 'connections', 'sessions', 'session_steps', 'session_events',
  'staged_records', 'accounts', 'transactions', 'positions', 'api_keys',
  'devices', 'device_pairing_intents', 'webhooks', 'connections_due', 'operator_credential', 'email_otp_config',
  'audit_log', 'oauth_clients', 'authorization_codes', 'oauth_grants', 'oauth_refresh_tokens',
  'crawl_jobs', 'organizations', 'organization_shares',
];

describe('control-plane migrations + schema', () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  beforeAll(async () => {
    client = new PGlite();
    db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: path.join(__dirname, '..', '..', 'migrations') });
  });

  afterAll(async () => {
    await client.close();
  });

  it('applies all migrations and creates every expected table', async () => {
    const res = await db.execute(
      sql`select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'`,
    );
    const names = (res.rows as Array<{ table_name: string }>).map((r) => r.table_name);
    for (const t of EXPECTED_TABLES) {
      expect(names, `table ${t} should exist`).toContain(t);
    }
  });

  it('round-trips an institution (enum + jsonb defaults + numeric defaults)', async () => {
    await db.insert(schema.institutions).values({
      id: 'test-bank', name: 'Test Bank', loginUrl: 'https://test.example',
      canonicalDomain: 'test.example', type: 'bank',
    });
    const rows = await db.select().from(schema.institutions).where(eq(schema.institutions.id, 'test-bank'));
    expect(rows).toHaveLength(1);
    expect(rows[0].requires2fa).toBe(false);
    expect(rows[0].allowedDomains).toEqual([]);
    expect(rows[0].scanStatus).toBe('pending');
    expect(rows[0].source).toBe('local');
    expect(rows[0].maxSteps).toBe(120);
    expect(rows[0].createdAt).toBeInstanceOf(Date);
  });

  it('enforces the FK + cascade-deletes sessions when a connection is removed', async () => {
    const [conn] = await db.insert(schema.connections).values({
      institutionId: 'test-bank', usernameCt: 'ct-user', passwordCt: 'ct-pass',
    }).returning();
    expect(conn.status).toBe('connecting');
    expect(conn.crawlSchedule).toBe('0 6 * * *');
    expect(conn.loginDomainVerified).toBe(false);
    expect(conn.crawlStats).toEqual({
      totalCount: 0, completedCount: 0, failedCount: 0, consecutiveFailures: 0, avgCostUsd: 0, recentCosts: [],
    });

    const [sess] = await db.insert(schema.sessions).values({ connectionId: conn.id }).returning();
    expect(sess.status).toBe('starting');

    await db.delete(schema.connections).where(eq(schema.connections.id, conn.id));
    const remaining = await db.select().from(schema.sessions).where(eq(schema.sessions.connectionId, conn.id));
    expect(remaining).toHaveLength(0); // cascade
  });

  it('rejects an institution_type outside the enum', async () => {
    await expect(
      db.insert(schema.institutions).values({
        // @ts-expect-error — deliberately invalid enum value to prove the DB enforces it
        id: 'bad', name: 'Bad', loginUrl: 'https://x.example', canonicalDomain: 'x.example', type: 'crypto_casino',
      }),
    ).rejects.toThrow();
  });

  it('allows at most one in-flight session per connection (the overlap lock)', async () => {
    const [conn] = await db.insert(schema.connections).values({
      institutionId: 'test-bank', usernameCt: 'u', passwordCt: 'p',
    }).returning();
    const [s1] = await db.insert(schema.sessions).values({ connectionId: conn.id, status: 'logging_in' }).returning();
    // A second in-flight session for the same connection is rejected by the partial unique index.
    await expect(
      db.insert(schema.sessions).values({ connectionId: conn.id, status: 'starting' }),
    ).rejects.toThrow();
    // Once the first reaches a terminal state, a new in-flight session is allowed again.
    await db.update(schema.sessions).set({ status: 'completed' }).where(eq(schema.sessions.id, s1.id));
    const [s2] = await db.insert(schema.sessions).values({ connectionId: conn.id, status: 'starting' }).returning();
    expect(s2.id).toBeTruthy();
    // ...and now a second concurrent one is blocked again.
    await expect(
      db.insert(schema.sessions).values({ connectionId: conn.id, status: 'navigating' }),
    ).rejects.toThrow();
  });
});
