/**
 * Execution-grounded test for the least-privilege engine role. Runs the REAL applyEngineGrants over the
 * REAL driver (postgres.js) against a REAL PostgreSQL with the REAL migrated schema, connecting as the
 * engine's own login role exactly as a worker does. The oracle is Postgres's own privilege introspection
 * (has_table_privilege / has_sequence_privilege) — independent of the code under test.
 *
 * The key adversarial case (codex finding): a FORBIDDEN grant is seeded BEFORE applying. An additive
 * (grant-only) implementation would leave it in place; the convergent (revoke-then-grant) one must strip
 * it. So the "forbidden privilege is false" assertions fail on additive code and pass on convergent code.
 */
import {
  describe, it, expect, beforeAll, afterAll,
} from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import postgres from 'postgres';
import type { Sql } from 'postgres';
import { applyEngineGrants } from './engine-grants';

const DATABASE = 'engine_grants';
const ROLE = 'accrawl_engine';
const ENGINE_PASSWORD = 'test-engine-pw';

/** The one PostgreSQL started for the whole run (see test/embedded-postgres.global.ts), as a given user. */
function cluster(user: string, password: string, database = DATABASE): string {
  const address = process.env.ACCRAWL_TEST_POSTGRES;
  if (!address) throw new Error('the shared test PostgreSQL is not running');
  return `postgres://${user}:${password}@${address}/${database}`;
}

async function can(sql: Sql, table: string, priv: string): Promise<boolean> {
  const [row] = await sql<{ ok: boolean }[]>`select has_table_privilege(${ROLE}, ${table}, ${priv}) as ok`;
  return row.ok;
}
async function canSeq(sql: Sql, seq: string, priv: string): Promise<boolean> {
  const [row] = await sql<{ ok: boolean }[]>`select has_sequence_privilege(${ROLE}, ${seq}, ${priv}) as ok`;
  return row.ok;
}
async function canColumn(sql: Sql, table: string, column: string, priv: string): Promise<boolean> {
  const [row] = await sql<{ ok: boolean }[]>`
    select has_column_privilege(${ROLE}, ${table}, ${column}, ${priv}) as ok`;
  return row.ok;
}
/**
 * Run a case the way a worker actually connects: as the engine's own login role, on its own connection,
 * with its claim presented as PostgreSQL startup parameters. That is exactly what
 * `workerDatabaseConnectionParameters` sends in production, so what is proved here is what deployments get.
 *
 * A connection per case is also what makes these assertions mean anything. They almost all assert what the
 * engine may NOT do, so any leakage of session state — a role or a claim still set from the previous case —
 * turns a real denial into a false pass. There is no shared session to leak from.
 */
async function asEngineRole<T>(
  run: (engine: Sql) => Promise<T>,
  settings: Record<string, string> = {},
): Promise<T> {
  const engine = postgres(
    cluster(ROLE, ENGINE_PASSWORD),
    { max: 1, connection: { application_name: 'accrawl-engine', ...settings } },
  );
  try {
    return await run(engine);
  } finally {
    await engine.end({ timeout: 5 });
  }
}

async function canFunction(sql: Sql, signature: string, priv: string): Promise<boolean> {
  const [row] = await sql<{ ok: boolean }[]>`select has_function_privilege(${ROLE}, ${signature}, ${priv}) as ok`;
  return row.ok;
}

describe('applyEngineGrants — convergent least privilege', () => {
  let sql: Sql;

  beforeAll(async () => {
    // A real PostgreSQL, not PGlite behind a wire socket. Every assertion here is about privileges and
    // row-level security, and on the socket-server substrate this file returned different answers for the
    // same grants between runs — it failed five times in ten, including reporting that the engine could
    // delete from crawl_jobs. A security test that is right most of the time is not a security test.
    //
    // A database of its own on the shared cluster: roles are cluster-wide, so this suite's engine role is
    // visible to the other suite, but no schema, table or row is.
    const admin = postgres(cluster('accrawl', 'accrawl', 'postgres'), { max: 1 });
    await admin.unsafe(`drop database if exists ${DATABASE}`);
    await admin.unsafe(`create database ${DATABASE}`);
    await admin.end({ timeout: 5 });
    sql = postgres(cluster('accrawl', 'accrawl'), { max: 1 });
    const dir = path.resolve(__dirname, '../../migrations');
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
      await sql.unsafe(fs.readFileSync(path.join(dir, f), 'utf8'));
    }

    // Seed the role with FORBIDDEN grants that a convergent applier must strip.
    await sql`do $$ begin
      if not exists (select from pg_roles where rolname = 'accrawl_engine') then
        create role accrawl_engine login;
      end if;
    end $$;`;
    await sql`grant select on accounts to accrawl_engine`;       // forbidden: canonical financial data
    await sql`grant select on connections to accrawl_engine`;    // forbidden: encrypted credentials
    await sql`grant update (username_ct) on connections to accrawl_engine`; // forbidden column ACL
    await sql`create sequence if not exists forbidden_seq`;
    await sql`grant usage on sequence forbidden_seq to accrawl_engine`; // forbidden sequence
    await sql`alter role accrawl_engine bypassrls`; // forbidden: bypasses the per-crawl policies

    await applyEngineGrants(sql, ENGINE_PASSWORD);
    await sql`insert into institutions (id, name, login_url, canonical_domain, type)
      values ('rls-bank', 'RLS Bank', 'https://rls.example', 'rls.example', 'bank')`;
  });

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
  });

  it('strips pre-existing forbidden grants (convergence, not additive)', async () => {
    expect(await can(sql, 'accounts', 'SELECT')).toBe(false);
    expect(await can(sql, 'connections', 'SELECT')).toBe(false);
    expect(await canColumn(sql, 'connections', 'username_ct', 'UPDATE')).toBe(false);
    expect(await canSeq(sql, 'forbidden_seq', 'USAGE')).toBe(false);
    const [role] = await sql<{ rolbypassrls: boolean }[]>`
      select rolbypassrls from pg_roles where rolname = ${ROLE}`;
    expect(role.rolbypassrls).toBe(false);
  });

  /**
   * The privilege assertions below are a list someone has to remember to extend; this one is not. It runs
   * the statements the engine ACTUALLY issues while arming an OTP episode, as the engine's own role, so a
   * read of a column nobody granted fails here instead of in a self-hosted deployment. It caught exactly
   * that: the engine began reading otp_requested without the matching grant, and every 2FA crawl on a real
   * deployment died with "permission denied for table sessions" — invisible to the e2e, which had been
   * connecting as the admin role.
   */
  it('permits every statement the engine issues to arm an OTP episode', async () => {
    const sessionId = '00000000-0000-4000-8000-000000000001';
    const active = ['starting', 'logging_in', 'navigating', 'waiting_for_otp', 'extracting'];
    await asEngineRole(async (sql) => {
      await expect(sql`
        update sessions set
          otp_requested = true, otp_requested_at = now(),
          otp_request_epoch = coalesce(otp_request_epoch, 0) + 1,
          otp_relay_online = false, otp_relay_online_at = null,
          otp_relay_ready = false, otp_relay_ready_at = null,
          otp_relay_mode = null
        where id = ${sessionId}
          and status = any(${active}::session_status[])
          and otp_requested is not true
        returning id`).resolves.toBeDefined();
      await expect(sql`
        select status, otp_requested from sessions where id = ${sessionId}`).resolves.toBeDefined();
      await expect(sql`
        select status, otp_requested, otp_relay_online, otp_relay_ready, otp_relay_mode
        from sessions where id = ${sessionId}`).resolves.toBeDefined();
    });
  });

  /**
   * `step_count = step_count` leaves a value untouched, and Postgres counts that as a read — so a column
   * the engine may write is a column it must also be able to select. These are the statements where that
   * bites, and they were denied for the same reason the OTP reads were.
   */
  it('permits the self-referential writes the engine uses to leave a value untouched', async () => {
    const sessionId = '00000000-0000-4000-8000-000000000001';
    const active = ['starting', 'logging_in', 'navigating', 'waiting_for_otp', 'extracting'];
    await asEngineRole(async (sql) => {
      await expect(sql`
        update sessions set
          status = status,
          current_step = ${'Working'},
          step_count = step_count,
          heartbeat_at = now()
        where id = ${sessionId} and status = any(${active}::session_status[])
        returning id`).resolves.toBeDefined();
      await expect(sql`
        update sessions set
          cost = cost, crawl_memory = crawl_memory, expires_at = now()
        where id = ${sessionId}`).resolves.toBeDefined();
    });
  });

  /**
   * Every remaining statement the engine issues, run as the engine's own role. The step upsert is the one
   * that bit: its DO UPDATE reads `excluded.log` and `excluded.screenshot_ref`, which Postgres treats as a
   * read of those columns, so the whole statement was refused — and because step recording is best-effort,
   * crawls finished and stored their results while silently losing every step log and screenshot.
   */
  it('permits the telemetry statements the engine issues while a crawl runs', async () => {
    const [connection] = await sql<{ id: string }[]>`
      insert into connections (owner_subject, institution_id, username_ct, password_ct)
      values ('self-hosted:operator', 'rls-bank', 'u', 'p') returning id`;
    const [session] = await sql<{ id: string }[]>`
      insert into sessions (connection_id, status) values (${connection.id}, 'starting') returning id`;
    await asEngineRole(async (sql) => {
      const step = async (): Promise<unknown> => sql`
        insert into session_steps (session_id, step_number, screenshot_ref, log)
        values (${session.id}, 1, ${'shot.jpg'}, '{"text":"step"}'::jsonb)
        on conflict (session_id, step_number)
        do update set log = excluded.log, screenshot_ref = excluded.screenshot_ref`;
      await expect(step()).resolves.toBeDefined();
      await expect(step()).resolves.toBeDefined(); // the re-record path, which is where the read happens
      await expect(sql`
        insert into session_events (session_id, seq, type, data)
        select ${session.id}, coalesce(max(seq), 0) + 1, 'status', '{}'::jsonb
        from session_events where session_id = ${session.id}`).resolves.toBeDefined();
      await expect(sql`
        insert into staged_records (session_id, kind, data)
        values (${session.id}, 'account', '{}'::jsonb)`).resolves.toBeDefined();
    });
  });

  /**
   * The engine may write only the crawl it was given, and that rule has to cover both ways a crawl is
   * dispatched. A session reached through a job belongs to that job's claim holder; a session dispatched
   * directly belongs to the engine that was handed it. These three cases pin the whole rule: a directly
   * dispatched crawl can be recorded end to end, a job-dispatched one still cannot be touched without the
   * claim, and the engine cannot move a session from the second case into the first.
   */
  describe('who may record a crawl', () => {
    const newSession = async (): Promise<string> => {
      const [connection] = await sql<{ id: string }[]>`
        insert into connections (owner_subject, institution_id, username_ct, password_ct)
        values ('self-hosted:operator', 'rls-bank', 'u', 'p') returning id`;
      const [session] = await sql<{ id: string }[]>`
        insert into sessions (connection_id, status) values (${connection.id}, 'starting') returning id`;
      return session.id;
    };

    it('records a directly dispatched crawl, including the failure it has to report', async () => {
      const id = await newSession();
      await asEngineRole(async (sql) => {
        await expect(sql`select status from sessions where id = ${id}`).resolves.toHaveLength(1);
        await expect(sql`
          update sessions set current_step = 'Reading accounts', heartbeat_at = now()
          where id = ${id} returning id`).resolves.toHaveLength(1);
        await expect(sql`
          insert into session_events (session_id, seq, type, data)
          select ${id}, coalesce(max(seq), 0) + 1, 'status', '{}'::jsonb
          from session_events where session_id = ${id}`).resolves.toBeDefined();
        await expect(sql`
          insert into session_steps (session_id, step_number, log)
          values (${id}, 1, '{"text":"step"}'::jsonb)`).resolves.toBeDefined();
        await expect(sql`
          insert into staged_records (session_id, kind, data)
          values (${id}, 'account', '{}'::jsonb)`).resolves.toBeDefined();
        // The terminal status, the staged rows and the final event land in ONE transaction, so the rule
        // must not depend on anything that can go false partway.
        await expect(sql`
          update sessions set status = 'failed', completed_at = now() where id = ${id} returning id`)
          .resolves.toHaveLength(1);
        await expect(sql`
          insert into session_events (session_id, seq, type, data)
          select ${id}, coalesce(max(seq), 0) + 1, 'done', '{}'::jsonb
          from session_events where session_id = ${id}`).resolves.toBeDefined();
      });
    });

    it('refuses a job-dispatched crawl to an engine holding no claim', async () => {
      const id = await newSession();
      await sql`insert into crawl_jobs (session_id, encrypted_payload, status, claim_token, claim_token_hash)
        values (${id}, 'ct', 'queued', 'tok', encode(sha256('tok'::bytea), 'hex'))`;
      await asEngineRole(async (sql) => {
        await expect(sql`select status from sessions where id = ${id}`).resolves.toHaveLength(0);
        await expect(sql`
          insert into session_events (session_id, seq, type, data)
          values (${id}, 1, 'status', '{}'::jsonb)`).rejects.toThrow(/row-level security/);
      });
    });

    it('does not let presenting a claim also unlock directly dispatched sessions', async () => {
      // The two rules must partition. A worker holding a claim for one crawl must not additionally inherit
      // every session that happens to have no job row.
      const direct = await newSession();
      await asEngineRole(async (engine) => {
        await expect(engine`select status from sessions where id = ${direct}`).resolves.toHaveLength(0);
        await expect(engine`
          insert into session_events (session_id, seq, type, data)
          values (${direct}, 1, 'status', '{}'::jsonb)`).rejects.toThrow(/row-level security/);
      }, {
        // A claim that matches no running crawl_jobs lease grants nothing.
        'accrawl.job_id': '00000000-0000-4000-8000-0000000000aa',
        'accrawl.claim_token': 'a-claim',
        'accrawl.worker_name': 'worker-a',
      });
    });

    it('cannot move a session out of the claim rule by touching crawl_jobs itself', async () => {
      const id = await newSession();
      await sql`insert into crawl_jobs (session_id, encrypted_payload, status, claim_token, claim_token_hash)
        values (${id}, 'ct', 'queued', 'tok2', encode(sha256('tok2'::bytea), 'hex'))`;
      await asEngineRole(async (sql) => {
        // Deleting the job row would hand the session to the direct rule; inserting one for a session it
        // was never given would deny another engine. It can do neither.
        await expect(sql`delete from crawl_jobs where session_id = ${id}`).rejects.toThrow(/permission denied/);
        await expect(sql`
          insert into crawl_jobs (session_id, encrypted_payload, status, claim_token, claim_token_hash)
          values (${id}, 'ct', 'queued', 't', 'h')`).rejects.toThrow(/permission denied/);
      });
    });
  });

  it('lets the engine read the relay mode and clear it with the episode it belongs to', async () => {
    // The control-plane decides the mode — it is the only side that can see the paired devices — but the
    // engine clears it in the same commit that opens the next episode, which is what makes a decision
    // unable to outlive the episode it was made for. That write grants nothing new: the engine can already
    // set otp_relay_ready, which ends the same wait.
    expect(await canColumn(sql, 'sessions', 'otp_relay_mode', 'SELECT')).toBe(true);
    expect(await canColumn(sql, 'sessions', 'otp_relay_mode', 'UPDATE')).toBe(true);
  });

  it('grants exactly the allowed telemetry + staging privileges', async () => {
    expect(await canColumn(sql, 'sessions', 'status', 'SELECT')).toBe(true);
    expect(await canColumn(sql, 'sessions', 'otp', 'SELECT')).toBe(true);
    expect(await canColumn(sql, 'sessions', 'otp_requested', 'SELECT')).toBe(true);
    expect(await canColumn(sql, 'sessions', 'status', 'UPDATE')).toBe(true);
    expect(await canColumn(sql, 'sessions', 'promotion_ready_at', 'UPDATE')).toBe(true);
    expect(await canColumn(sql, 'session_events', 'seq', 'SELECT')).toBe(true);
    expect(await canColumn(sql, 'session_events', 'data', 'INSERT')).toBe(true);
    expect(await canColumn(sql, 'session_steps', 'log', 'INSERT')).toBe(true);
    expect(await canColumn(sql, 'session_steps', 'log', 'UPDATE')).toBe(true);
    expect(await canColumn(sql, 'staged_records', 'data', 'INSERT')).toBe(true);
    expect(await canFunction(sql, 'accrawl_claim_crawl_job(uuid,text,text,integer)', 'EXECUTE')).toBe(true);
    expect(await canFunction(sql, 'accrawl_crawl_job_status(uuid)', 'EXECUTE')).toBe(false);
    expect(await canFunction(sql, 'accrawl_heartbeat_crawl_job(uuid,text,text,integer)', 'EXECUTE')).toBe(true);
    expect(await canFunction(sql, 'accrawl_finish_crawl_job(uuid,text,text,boolean,text)', 'EXECUTE')).toBe(true);
    expect(await canFunction(sql, 'accrawl_engine_owns_session(uuid)', 'EXECUTE')).toBe(true);
    expect(await canFunction(sql, 'accrawl_observe_crawl_job(uuid,text)', 'EXECUTE')).toBe(true);
  });

  it('does NOT grant write/extra access to allowed or forbidden tables it should not have', async () => {
    expect(await can(sql, 'sessions', 'INSERT')).toBe(false);   // engine never inserts sessions
    expect(await can(sql, 'sessions', 'DELETE')).toBe(false);
    expect(await can(sql, 'sessions', 'SELECT')).toBe(false); // column-scoped only
    expect(await can(sql, 'sessions', 'UPDATE')).toBe(false);
    expect(await canColumn(sql, 'sessions', 'connection_id', 'SELECT')).toBe(false);
    expect(await canColumn(sql, 'sessions', 'connection_id', 'UPDATE')).toBe(false);
    expect(await can(sql, 'staged_records', 'SELECT')).toBe(false); // insert-only
    expect(await can(sql, 'api_keys', 'SELECT')).toBe(false);
    expect(await can(sql, 'devices', 'SELECT')).toBe(false);
    expect(await can(sql, 'transactions', 'SELECT')).toBe(false);
    expect(await can(sql, 'session_transaction_targets', 'SELECT')).toBe(false);
    expect(await can(sql, 'session_transaction_targets', 'INSERT')).toBe(false);
    expect(await can(sql, 'transaction_occurrences', 'SELECT')).toBe(false);
    expect(await can(sql, 'transaction_occurrences', 'INSERT')).toBe(false);
    expect(await can(sql, 'positions', 'SELECT')).toBe(false);
    expect(await can(sql, 'crawl_jobs', 'SELECT')).toBe(false);
    expect(await can(sql, 'crawl_jobs', 'UPDATE')).toBe(false);
  });

  it('grants USAGE on only the one sequence the engine needs (session_events_id_seq), not SELECT', async () => {
    expect(await canSeq(sql, 'session_events_id_seq', 'USAGE')).toBe(true);
    expect(await canSeq(sql, 'session_events_id_seq', 'SELECT')).toBe(false);
  });

  it('is idempotent — a second apply leaves the same end-state', async () => {
    await applyEngineGrants(sql, ENGINE_PASSWORD);
    expect(await can(sql, 'accounts', 'SELECT')).toBe(false);
    expect(await canColumn(sql, 'session_events', 'data', 'INSERT')).toBe(true);
    expect(await canSeq(sql, 'session_events_id_seq', 'USAGE')).toBe(true);
  });

  it('grants an externally provisioned tenant-specific role without managing its lifecycle', async () => {
    const role = 'accrawl_engine_tenant_a';
    await sql.unsafe(`create role "${role}" login`);
    await applyEngineGrants(sql, 'not-used-by-the-public-core', role, false);
    const [allowed] = await sql<{ ok: boolean }[]>`
      select has_column_privilege(${role}, 'sessions', 'status', 'SELECT') as ok`;
    const [forbidden] = await sql<{ ok: boolean }[]>`
      select has_table_privilege(${role}, 'connections', 'SELECT') as ok`;
    expect(allowed.ok).toBe(true);
    expect(forbidden.ok).toBe(false);
  });

  it('fails closed when an external role is missing or its identifier is unsafe', async () => {
    await expect(applyEngineGrants(
      sql,
      'not-used',
      'accrawl_engine_missing',
      false,
    )).rejects.toThrow('does not exist');
    await expect(applyEngineGrants(
      sql,
      'not-used',
      'role"; drop table connections; --',
      false,
    )).rejects.toThrow('Invalid PostgreSQL role name');
  });

  it('refuses an externally managed role that can bypass row-level security', async () => {
    const role = 'accrawl_engine_bypass';
    await sql.unsafe(`create role "${role}" login bypassrls`);
    await expect(applyEngineGrants(sql, 'not-used', role, false))
      .rejects.toThrow('must be NOBYPASSRLS');
  });
});
