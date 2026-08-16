/**
 * Ensure the least-privilege engine DB role exists and **converges** to EXACTLY the allowed grants:
 * session-telemetry + staging tables only — never credentials (connections), api_keys, devices, or the
 * canonical accounts/transactions/positions. A compromised browser-agent (which connects as this role
 * via ENGINE_DATABASE_URL) must not become a data-plane compromise.
 *
 * Convergent, not additive: it REVOKEs every table/sequence privilege first, then grants only the
 * allowed set — so the role can never accumulate a grant across deploys or retain a manually-added or
 * previously-broader one. Idempotent.
 *
 * The engine adapter's exact column footprint (apps/engine/src/platform/postgres.ts) is further
 * constrained by row-level security to the one session named by the Job's startup capability:
 *   sessions        — SELECT status/otp, UPDATE status/step_count/cost/crawl_memory/otp
 *   session_events  — SELECT max(seq), INSERT      (id is bigserial → needs session_events_id_seq USAGE)
 *   session_steps   — INSERT ... ON CONFLICT DO UPDATE
 *   staged_records  — INSERT                       (uuid PK, no sequence)
 *   crawl_jobs      — no table grant; token-gated mutation RPCs and token-hash-gated observation
 */
import type { Sql } from 'postgres';

export const ENGINE_ROLE = 'accrawl_engine';

/**
 * The engine's exact column footprint on `sessions`, in one place because two lists drift and a drifted
 * list is not a lint: Postgres refuses the whole statement, so the crawl fails outright. It failed exactly
 * that way — the engine started reading otp_requested, and later incremented otp_request_epoch in place,
 * while the grant list stayed still; every 2FA crawl on a real deployment died with "permission denied for
 * table sessions", and no test saw it because the e2e connected as the admin role.
 *
 * Columns the engine may write. Several are also written self-referentially — `step_count = step_count`,
 * `cost = cost` — to leave a value untouched, and Postgres counts that as a READ. So every writable column
 * is necessarily readable too, which is why SELECT below is the union rather than a second hand-kept list.
 */
const ENGINE_SESSION_WRITE_COLUMNS = [
  'status', 'current_step', 'step_count', 'heartbeat_at', 'cost', 'crawl_memory',
  'promotion_ready_at', 'expires_at', 'completed_at', 'error', 'failure_reason',
  'otp_requested', 'otp_requested_at', 'otp_request_epoch', 'otp', 'otp_received_at',
  'otp_relay_online', 'otp_relay_online_at', 'otp_relay_ready', 'otp_relay_ready_at',
  // The control-plane decides the relay mode — it is the only side that can see the paired devices — but
  // the engine clears it in the same commit that opens the next OTP episode, so a decision can never
  // outlive the episode it was made for.
  'otp_relay_mode',
  'tunnel_claimed_at',
] as const;

/** Columns the engine only reads. */
const ENGINE_SESSION_READ_ONLY_COLUMNS = [
  'id', 'tunnel_requested', 'tunnel_device_id',
] as const;

const ENGINE_SESSION_SELECT_COLUMNS = [
  ...ENGINE_SESSION_READ_ONLY_COLUMNS,
  ...ENGINE_SESSION_WRITE_COLUMNS,
].join(', ');

function quotedIdentifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(value)) throw new Error(`Invalid PostgreSQL role name: ${value}`);
  return `"${value}"`;
}

function catalogIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

export async function applyEngineGrants(
  sql: Sql,
  enginePassword: string,
  engineRole: string = ENGINE_ROLE,
  manageRole = true,
): Promise<void> {
  const role = quotedIdentifier(engineRole);
  const roleLiteral = engineRole.replace(/'/g, "''");
  if (manageRole) {
    await sql.unsafe(`do $$ begin
      if not exists (select from pg_roles where rolname = '${roleLiteral}') then
        create role ${role} login;
      end if;
    end $$;`);
    // Set/rotate the login password and converge every privilege-bearing role
    // attribute. In particular, a legacy/manual BYPASSRLS flag would nullify
    // the one-crawl RLS capability even after all object grants were stripped.
    await sql.unsafe(
      `alter role ${role} login password '${enginePassword.replace(/'/g, "''")}' `
        + 'nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls',
    );
  } else {
    const [existing] = await sql<{ exists: boolean; bypasses_rls: boolean }[]>`
      select
        exists(select from pg_roles where rolname = ${engineRole}) as exists,
        coalesce((
          select rolbypassrls from pg_roles where rolname = ${engineRole}
        ), false) as bypasses_rls`;
    if (!existing?.exists) {
      throw new Error(`Externally managed PostgreSQL role does not exist: ${engineRole}`);
    }
    if (existing.bypasses_rls) {
      throw new Error(`Externally managed PostgreSQL role must be NOBYPASSRLS: ${engineRole}`);
    }
  }

  // Converge to least privilege: strip everything, then grant only the allowed set.
  await sql.unsafe(`revoke all privileges on all tables in schema public from ${role}`);
  await sql.unsafe(`revoke all privileges on all sequences in schema public from ${role}`);
  // Table-level REVOKE does not remove grants made on individual columns.
  // Strip every column ACL too, including manually-added grants on forbidden
  // tables, before rebuilding the exact worker footprint.
  const columns = await sql<Array<{ table_name: string; column_name: string }>>`
    select table_name, column_name
    from information_schema.columns
    where table_schema = 'public'
    order by table_name, ordinal_position`;
  const columnsByTable = new Map<string, string[]>();
  for (const column of columns) {
    const names = columnsByTable.get(column.table_name) ?? [];
    names.push(column.column_name);
    columnsByTable.set(column.table_name, names);
  }
  for (const [table, names] of columnsByTable) {
    await sql.unsafe(
      `revoke all privileges (${names.map(catalogIdentifier).join(', ')}) `
        + `on table ${catalogIdentifier(table)} from ${role}`,
    );
  }
  for (const signature of [
    'accrawl_claim_crawl_job(uuid, text, text, integer)',
    'accrawl_crawl_job_status(uuid)',
    'accrawl_heartbeat_crawl_job(uuid, text, text, integer)',
    'accrawl_finish_crawl_job(uuid, text, text, boolean, text)',
    'accrawl_engine_owns_session(uuid)',
    'accrawl_session_dispatched_directly(uuid)',
    'accrawl_observe_crawl_job(uuid, text)',
  ]) {
    await sql.unsafe(`revoke all on function ${signature} from ${role}`);
  }
  await sql.unsafe(`grant usage on schema public to ${role}`);

  await sql.unsafe(
    `grant select (${ENGINE_SESSION_SELECT_COLUMNS}) on sessions to ${role}`,
  );
  await sql.unsafe(
    `grant update (${ENGINE_SESSION_WRITE_COLUMNS.join(', ')}) on sessions to ${role}`,
  );
  await sql.unsafe(
    `grant select (session_id, seq), insert (session_id, seq, type, data) `
      + `on session_events to ${role}`,
  );
  // Re-recording a step is an upsert whose DO UPDATE reads `excluded.log` and `excluded.screenshot_ref`,
  // and Postgres counts that as a read of those columns — the same reason every writable column of
  // `sessions` is selectable above. Without it the whole statement is refused and a crawl silently loses
  // its step log and screenshots while still finishing and storing its results.
  await sql.unsafe(
    `grant select (session_id, step_number, screenshot_ref, log), `
      + `insert (session_id, step_number, screenshot_ref, log), `
      + `update (screenshot_ref, log) on session_steps to ${role}`,
  );
  await sql.unsafe(
    `grant insert (session_id, kind, data) on staged_records to ${role}`,
  );
  await sql.unsafe(`grant execute on function accrawl_claim_crawl_job(uuid, text, text, integer) to ${role}`);
  await sql.unsafe(`grant execute on function accrawl_heartbeat_crawl_job(uuid, text, text, integer) to ${role}`);
  await sql.unsafe(`grant execute on function accrawl_finish_crawl_job(uuid, text, text, boolean, text) to ${role}`);
  await sql.unsafe(`grant execute on function accrawl_engine_owns_session(uuid) to ${role}`);
  // Answers which of the two ownership rules covers a session: reached through a job, or dispatched
  // directly. The engine can read the answer and cannot change it — it holds no privilege on crawl_jobs.
  await sql.unsafe(`grant execute on function accrawl_session_dispatched_directly(uuid) to ${role}`);
  await sql.unsafe(`grant execute on function accrawl_observe_crawl_job(uuid, text) to ${role}`);
  // The ONLY sequence the engine needs: session_events.id (bigserial). USAGE suffices for INSERT;
  // SELECT (read sequence state) is not needed and is deliberately not granted.
  await sql.unsafe(`grant usage on sequence session_events_id_seq to ${role}`);
}
