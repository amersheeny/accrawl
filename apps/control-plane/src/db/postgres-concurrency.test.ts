import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import postgres, { type Sql } from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import * as schema from './schema';
import type { Db } from './client';
import { prepareSessionStatusEnum } from './migration-preflight';
import { requestSessionCancellation } from '../data/cancel-session';
import { applyEngineGrants } from './engine-grants';
import { createHash } from 'node:crypto';

const DATABASE = 'postgres_concurrency';
const MIGRATIONS = path.resolve(__dirname, '../../migrations');

/** The one PostgreSQL started for the whole run (see test/embedded-postgres.global.ts). */
function cluster(database = DATABASE): string {
  const address = process.env.ACCRAWL_TEST_POSTGRES;
  const owner = process.env.ACCRAWL_TEST_POSTGRES_OWNER;
  if (!address || !owner) throw new Error('the shared test PostgreSQL is not running');
  return `postgres://${owner}@${address}/${database}`;
}

/**
 * These races depend on PostgreSQL's row-lock and READ COMMITTED recheck
 * semantics. PGlite covers the fast test matrix; this focused suite keeps the
 * production database behavior executable as well.
 */
describe('production PostgreSQL migration and cancellation ordering', () => {
  let directory: string;
  let sql: Sql;
  let database: Db;
  let legacyMigrations: string;

  beforeAll(async () => {
    directory = mkdtempSync(path.join(tmpdir(), 'accrawl-postgres-concurrency-'));
    // A database of its own on the shared cluster: these races need a real server, but not a second one.
    const admin = postgres(cluster('postgres'), { max: 1 });
    await admin.unsafe(`drop database if exists ${DATABASE}`);
    await admin.unsafe(`create database ${DATABASE}`);
    await admin.end({ timeout: 5 });
    const databaseUrl = cluster();
    sql = postgres(databaseUrl, { max: 4 });
    database = drizzle(sql, { schema }) as unknown as Db;

    // Immutable migration fixture for a deployed database at 0012. It uses the
    // real Drizzle journal/timestamps so the production migrator later sees
    // 0013+ as pending, while its 0000 retains the enum as originally shipped.
    legacyMigrations = path.join(directory, 'legacy-0012-migrations');
    fs.mkdirSync(path.join(legacyMigrations, 'meta'), { recursive: true });
    const journal = JSON.parse(
      fs.readFileSync(path.join(MIGRATIONS, 'meta', '_journal.json'), 'utf8'),
    ) as { entries: Array<{ tag: string }> };
    journal.entries = journal.entries.filter((entry) => entry.tag < '0013');
    fs.writeFileSync(
      path.join(legacyMigrations, 'meta', '_journal.json'),
      JSON.stringify(journal, null, 2),
    );
    for (const entry of journal.entries) {
      const file = `${entry.tag}.sql`;
      let source = fs.readFileSync(path.join(MIGRATIONS, file), 'utf8');
      if (file.startsWith('0000_')) source = source.replace(", 'cancelling'", '');
      fs.writeFileSync(path.join(legacyMigrations, file), source);
    }
    await migrate(drizzle(sql), { migrationsFolder: legacyMigrations });
  }, 30_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    if (directory) rmSync(directory, { recursive: true, force: true });
  }, 30_000);

  it('upgrades immutable 0012 through the production preflight and actual Drizzle migrator', async () => {
    const legacyLabels = await sql<Array<{ enumlabel: string }>>`
      select enumlabel
      from pg_enum
      where enumtypid = 'public.session_status'::regtype
      order by enumsortorder`;
    expect(legacyLabels.map((row) => row.enumlabel)).not.toContain('cancelling');

    await sql`
      insert into institutions (
        id, name, login_url, canonical_domain, type, scan_status
      )
      values (
        'postgres-legacy',
        'Postgres legacy',
        'https://postgres-legacy.test',
        'postgres-legacy.test',
        'bank',
        'passed'
      )`;
    const [legacyConnection] = await sql`
      insert into connections (institution_id, username_ct, password_ct)
      values ('postgres-legacy', 'u', 'p')
      returning id`;
    const [legacySession] = await sql`
      insert into sessions (connection_id, status)
      values (${legacyConnection.id}, 'extracting')
      returning id`;
    await sql`
      insert into session_events (session_id, seq, type, data)
      values (
        ${legacySession.id},
        1,
        'done',
        ${JSON.stringify({ success: true, status: 'completed' })}::jsonb
      )`;

    await prepareSessionStatusEnum(sql);
    await expect(migrate(drizzle(sql), {
      migrationsFolder: MIGRATIONS,
    })).resolves.toBeUndefined();

    const [index] = await sql<Array<{ predicate: string }>>`
      select pg_get_expr(indpred, indrelid) as predicate
      from pg_index
      where indexrelid = 'sessions_active_connection_uq'::regclass`;
    expect(index.predicate).toContain('cancelling');
    const [legacy] = await sql`
      select promotion_ready_at
      from sessions
      where id = ${legacySession.id}`;
    expect(legacy.promotion_ready_at).toBeTruthy();
  });

  it('applies the production migrator to a fresh PostgreSQL database', async () => {
    await sql.unsafe('create database accrawl_fresh');
    const freshSql = postgres(
      cluster('accrawl_fresh'),
      { max: 1 },
    );
    try {
      await prepareSessionStatusEnum(freshSql);
      await migrate(drizzle(freshSql), { migrationsFolder: MIGRATIONS });
      const [index] = await freshSql<Array<{ predicate: string }>>`
        select pg_get_expr(indpred, indrelid) as predicate
        from pg_index
        where indexrelid = 'sessions_active_connection_uq'::regclass`;
      expect(index.predicate).toContain('cancelling');
      const [rls] = await freshSql<Array<{ relrowsecurity: boolean }>>`
        select relrowsecurity from pg_class where oid = 'sessions'::regclass`;
      expect(rls.relrowsecurity).toBe(true);
    } finally {
      await freshSql.end({ timeout: 5 });
    }
  });

  it('confines the shared engine role to the one durably claimed crawl', async () => {
    const role = 'accrawl_engine_rls_test';
    const password = 'engine-rls-test-password';
    await applyEngineGrants(sql, password, role);
    await sql`
      insert into institutions (
        id, name, login_url, canonical_domain, type, scan_status
      )
      values (
        'postgres-rls',
        'Postgres RLS',
        'https://postgres-rls.test',
        'postgres-rls.test',
        'bank',
        'passed'
      )
      on conflict (id) do nothing`;
    const [ownConnection] = await sql`
      insert into connections (institution_id, username_ct, password_ct)
      values ('postgres-rls', 'u', 'p')
      returning id`;
    const [otherConnection] = await sql`
      insert into connections (institution_id, username_ct, password_ct)
      values ('postgres-rls', 'u', 'p')
      returning id`;
    const [ownSession] = await sql`
      insert into sessions (connection_id, status, otp)
      values (${ownConnection.id}, 'extracting', '111111')
      returning id`;
    const [otherSession] = await sql`
      insert into sessions (connection_id, status, otp)
      values (${otherConnection.id}, 'extracting', '999999')
      returning id`;
    const token = 'one-crawl-rls-capability';
    await sql`
      insert into crawl_jobs (
        id, session_id, encrypted_payload, claim_token, claim_token_hash
      )
      values (
        ${ownSession.id},
        ${ownSession.id},
        'encrypted',
        ${token},
        ${createHash('sha256').update(token).digest('hex')}
      )`;

    const engine = postgres(
      `postgres://${role}:${password}@${process.env.ACCRAWL_TEST_POSTGRES}/${DATABASE}`,
      {
        max: 1,
        connection: {
          application_name: 'accrawl-engine-rls-test',
          'accrawl.job_id': ownSession.id,
          'accrawl.claim_token': token,
          'accrawl.worker_name': 'worker-a',
        },
      },
    );
    try {
      const claimed = await engine`
        select * from accrawl_claim_crawl_job(
          ${ownSession.id}::uuid,
          ${token},
          'worker-a',
          120
        )`;
      expect(claimed).toHaveLength(1);

      const visible = await engine<Array<{ id: string; otp: string }>>`
        select id, otp from sessions order by id`;
      expect(visible).toEqual([{ id: ownSession.id, otp: '111111' }]);
      expect(await engine`
        update sessions set current_step = 'owned'
        where id = ${otherSession.id}
        returning id`).toHaveLength(0);
      await expect(engine`
        update sessions set connection_id = ${otherConnection.id}
        where id = ${ownSession.id}`).rejects.toMatchObject({ code: '42501' });

      await engine`
        insert into staged_records (session_id, kind, data)
        values (${ownSession.id}, 'account', '{"providerAccountId":"owned"}'::jsonb)`;
      await expect(engine`
        insert into staged_records (session_id, kind, data)
        values (${otherSession.id}, 'account', '{"providerAccountId":"forged"}'::jsonb)`)
        .rejects.toMatchObject({ code: '42501' });
      const [counts] = await sql<Array<{ own_count: number; other_count: number }>>`
        select
          count(*) filter (where session_id = ${ownSession.id})::int as own_count,
          count(*) filter (where session_id = ${otherSession.id})::int as other_count
        from staged_records`;
      expect(counts).toEqual({ own_count: 1, other_count: 0 });
    } finally {
      await engine.end({ timeout: 5 });
    }
  });

  it('orders successful completion before a concurrently blocked cancellation', async () => {
    await sql`
      insert into institutions (
        id, name, login_url, canonical_domain, type, scan_status
      )
      values (
        'postgres-race',
        'Postgres race',
        'https://postgres-race.test',
        'postgres-race.test',
        'bank',
        'passed'
      )`;
    const [connection] = await sql`
      insert into connections (institution_id, username_ct, password_ct)
      values ('postgres-race', 'u', 'p')
      returning id`;
    const [session] = await sql`
      insert into sessions (
        connection_id, status, lease_owner, lease_expires_at, heartbeat_at
      )
      values (
        ${connection.id}, 'extracting', 'control', now() + interval '1 hour', now()
      )
      returning id`;

    // The sequence is non-transactional, so it gives the test a deterministic
    // signal that complete() already owns the row and is inside its UPDATE.
    await sql`create sequence completion_update_entered`;
    await sql.unsafe(`
      create function pause_completion_update() returns trigger
      language plpgsql as $$
      begin
        if new.cost is distinct from old.cost then
          perform nextval('completion_update_entered');
          perform pg_sleep(0.5);
        end if;
        return new;
      end
      $$;
      create trigger pause_completion_update
      before update on sessions
      for each row execute function pause_completion_update();
    `);

    // Mirror the adapter's one completion transaction: lock the session,
    // update its completion metadata, then publish the successful done event.
    // postgres.test.ts separately exercises complete() itself; this real-server
    // test isolates the database concurrency guarantee shared by both sides.
    const completion = sql.begin(async (tx) => {
      await tx`select status from sessions where id = ${session.id} for update`;
      await tx`
        update sessions
        set
          cost = ${JSON.stringify({ totalCostUsd: 0.01 })}::jsonb,
          promotion_ready_at = now()
        where id = ${session.id}`;
      await tx`
        insert into session_events (session_id, seq, type, data)
        values (
          ${session.id},
          1,
          'done',
          ${JSON.stringify({
            success: true,
            status: 'completed',
            counts: {},
          })}::jsonb
        )`;
    });
    for (;;) {
      const [entered] = await sql<Array<{ is_called: boolean }>>`
        select is_called from completion_update_entered`;
      if (entered.is_called) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const cancellation = requestSessionCancellation(
      database,
      session.id as string,
    );
    await completion;
    await expect(cancellation).resolves.toBe('already_terminal');

    const [current] = await sql`
      select status, promotion_ready_at from sessions where id = ${session.id}`;
    expect(current.status).toBe('extracting');
    expect(current.promotion_ready_at).toBeTruthy();
    const [done] = await sql<Array<{ success: boolean }>>`
      select (data->>'success')::boolean as success
      from session_events
      where session_id = ${session.id} and type = 'done'`;
    expect(done.success).toBe(true);
  }, 15_000);

  it('lets a pre-marker worker that commits success first win cancellation ordering', async () => {
    await sql`
      insert into institutions (
        id, name, login_url, canonical_domain, type, scan_status
      )
      values (
        'postgres-legacy-first',
        'Postgres legacy first',
        'https://postgres-legacy-first.test',
        'postgres-legacy-first.test',
        'bank',
        'passed'
      )`;
    const [connection] = await sql`
      insert into connections (institution_id, username_ct, password_ct)
      values ('postgres-legacy-first', 'u', 'p')
      returning id`;
    const [session] = await sql`
      insert into sessions (connection_id, status)
      values (${connection.id}, 'extracting')
      returning id`;
    await sql`create sequence legacy_completion_entered`;

    const legacyCompletion = sql.begin(async (tx) => {
      const [locked] = await tx<Array<{ status: string }>>`
        select status from sessions where id = ${session.id} for update`;
      expect(locked.status).toBe('extracting');
      await tx`select nextval('legacy_completion_entered')`;
      await tx`select pg_sleep(0.5)`;
      await tx`
        insert into session_events (session_id, seq, type, data)
        values (
          ${session.id},
          1,
          'done',
          ${JSON.stringify({ success: true, status: 'completed' })}::jsonb
        )`;
    });
    for (;;) {
      const [entered] = await sql<Array<{ is_called: boolean }>>`
        select is_called from legacy_completion_entered`;
      if (entered.is_called) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const cancellation = requestSessionCancellation(database, session.id as string);
    await legacyCompletion;
    await expect(cancellation).resolves.toBe('already_terminal');
    const [current] = await sql`
      select status, promotion_ready_at from sessions where id = ${session.id}`;
    expect(current.status).toBe('extracting');
    expect(current.promotion_ready_at).toBeNull();
  }, 15_000);

  it('lets cancellation that locks first fence a pre-marker worker', async () => {
    await sql`
      insert into institutions (
        id, name, login_url, canonical_domain, type, scan_status
      )
      values (
        'postgres-cancel-first',
        'Postgres cancel first',
        'https://postgres-cancel-first.test',
        'postgres-cancel-first.test',
        'bank',
        'passed'
      )`;
    const [connection] = await sql`
      insert into connections (institution_id, username_ct, password_ct)
      values ('postgres-cancel-first', 'u', 'p')
      returning id`;
    const [session] = await sql`
      insert into sessions (connection_id, status)
      values (${connection.id}, 'extracting')
      returning id`;
    await sql`create sequence cancellation_update_entered`;
    await sql.unsafe(`
      create function pause_cancellation_update() returns trigger
      language plpgsql as $$
      begin
        if new.status = 'cancelling' and old.status <> 'cancelling' then
          perform nextval('cancellation_update_entered');
          perform pg_sleep(0.5);
        end if;
        return new;
      end
      $$;
      create trigger pause_cancellation_update
      before update on sessions
      for each row execute function pause_cancellation_update();
    `);

    const cancellation = requestSessionCancellation(database, session.id as string);
    for (;;) {
      const [entered] = await sql<Array<{ is_called: boolean }>>`
        select is_called from cancellation_update_entered`;
      if (entered.is_called) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const legacyCompletion = sql.begin(async (tx) => {
      const [locked] = await tx<Array<{ status: string }>>`
        select status from sessions where id = ${session.id} for update`;
      if (locked.status !== 'extracting') return false;
      await tx`
        insert into session_events (session_id, seq, type, data)
        values (
          ${session.id},
          1,
          'done',
          ${JSON.stringify({ success: true, status: 'completed' })}::jsonb
        )`;
      return true;
    });

    await expect(cancellation).resolves.toBe('cancellation_requested');
    await expect(legacyCompletion).resolves.toBe(false);
    const [current] = await sql`
      select status from sessions where id = ${session.id}`;
    expect(current.status).toBe('cancelling');
    const [eventCount] = await sql<Array<{ count: number }>>`
      select count(*)::int as count
      from session_events
      where session_id = ${session.id} and type = 'done'`;
    expect(eventCount.count).toBe(0);
  }, 15_000);
});
