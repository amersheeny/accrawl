/**
 * Postgres platform implementation.
 *
 * Used when the engine runs as a stateless worker behind the control-plane. The
 * engine writes only telemetry and **staged, unvalidated** extraction to Postgres,
 * under a least-privilege DB role (`ENGINE_DATABASE_URL`) that can touch its own
 * session's rows and the staging table but NOT the credential columns, api_keys, or
 * the canonical accounts/transactions/positions tables. The control-plane owns
 * completion: it validates the staged output and transactionally promotes it to the
 * final tables + advances the watermark. So this adapter never writes a final record.
 *
 *   - SessionStore   → sessions / session_steps rows + a sequenced session_events
 *                      append-log (for SSE Last-Event-ID replay). updateStatus throws
 *                      CrawlCancelledError when the control-plane has marked the
 *                      session cancelled.
 *   - ScreenshotSink → JPEG written under ${SCREENSHOT_DIR}/sessions/{id}/, with the
 *                      relative ref recorded on the step (the control-plane serves it).
 *   - OtpProvider    → signals otp_requested on the session and polls the session's
 *                      otp column (filled by the web UI / a relay POST). Manual-entry
 *                      semantics; the relay-ready handshake is added with the app.
 *   - SecretCipher   → identity. The control-plane decrypts and passes credentials in
 *                      the /crawl request over TLS, so the engine never sees ciphertext.
 *
 * Loaded lazily by getPlatform() only when PLATFORM=postgres, so a local install
 * (which omits the optional `postgres` driver) never resolves this module.
 */

import * as fs from 'fs';
import * as path from 'path';
import postgres from 'postgres';
import { CrawlCancelledError, getCompletionMetadata } from '../agent/session-updater';
import type {
  Platform,
  SessionStore,
  ScreenshotSink,
  OtpProvider,
  SecretCipher,
  TunnelStore,
  TunnelContext,
  ScreenshotUploadResult,
} from './types';
import type { SessionLogger, LogLine } from '../utils/logger';
import { workerDatabaseConnectionParameters } from './worker-database-scope';
import { notifyCompanionOtpWake } from '../otp/companion-wake';

/** The status values the sessions.status enum accepts. A status outside this set is
 *  written as a step-only update (never thrown), so a stray label can't drop the
 *  heartbeat/step progress with it. Keep in sync with the session_status DB enum. */
const VALID_STATUSES = new Set([
  'starting', 'logging_in', 'navigating', 'waiting_for_otp', 'extracting',
  'cancelling', 'completed', 'failed', 'cancelled',
]);

/** The non-terminal statuses an in-flight crawl owns. The status/heartbeat writers
 *  only advance a row that is still in one of these states: if the control-plane
 *  reaper has moved the row to a terminal status (cancelled/failed/completed) out
 *  from under us, advancing it would RESURRECT a reaped row back to active. Instead
 *  the writer self-aborts (CrawlCancelledError) so the crawl unwinds. Keep in sync
 *  with the control-plane's ACTIVE_SESSION_STATUSES. */
const ACTIVE_STATUSES = ['starting', 'logging_in', 'navigating', 'waiting_for_otp', 'extracting'];

type Sql = ReturnType<typeof postgres>;
/** A connection-scoped `sql` OR a transaction-scoped `sql` (the arg postgres.js
 *  hands `sql.begin`'s callback). Helpers that run both standalone and inside a
 *  transaction accept either. */
type Tx = postgres.TransactionSql;
type SqlOrTx = Sql | Tx;
/** The (recursive JSON) type postgres.js's sql.json() accepts. Our payloads — step
 *  logs, extracted records, cost — are JSON at runtime; this cast satisfies the strict
 *  static signature without widening to `any`. */
type JsonParam = Parameters<Sql['json']>[0];
let sqlClient: Sql | undefined;

function db(): Sql {
  if (!sqlClient) {
    const url = process.env.ENGINE_DATABASE_URL || process.env.DATABASE_URL;
    if (!url) {
      throw new Error('[platform] ENGINE_DATABASE_URL is not set (required for PLATFORM=postgres).');
    }
    sqlClient = postgres(url, {
      max: 4,
      idle_timeout: 20,
      connection: workerDatabaseConnectionParameters('accrawl-engine'),
    });
  }
  return sqlClient;
}

/** Append one sequenced event for SSE replay. Best-effort: a telemetry append must
 *  never abort a crawl, and the seq is assigned atomically in a single statement so
 *  the per-session single-writer never collides with the unique(session_id, seq). */
async function emitEvent(sql: Sql, sessionId: string, type: string, data: unknown): Promise<void> {
  // seq = coalesce(max(seq),0)+1 in one statement, but concurrent appends for the same session
  // (the async log flush racing the agent loop) can still pick the same next seq and collide on
  // UNIQUE(session_id, seq). Retry on that collision so no event — and thus no SSE replay step —
  // is silently lost. Best-effort otherwise: telemetry must never abort a crawl.
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await sql`
        insert into session_events (session_id, seq, type, data)
        select ${sessionId}, coalesce(max(seq), 0) + 1, ${type}, ${sql.json(data as JsonParam)}
        from session_events where session_id = ${sessionId}`;
      return;
    } catch (err) {
      if ((err as { code?: string })?.code === '23505' && attempt < 4) continue; // seq taken; recompute
      console.warn(`[Session] Failed to append event '${type}' for ${sessionId}:`, err);
      return;
    }
  }
}

// ─── SessionStore (Postgres) ────────────────────────────────────────

const postgresSessionStore: SessionStore = {
  async claimWorker(): Promise<'claimed'> {
    // PostgreSQL workers are claimed by the crawl_jobs lease before the engine
    // receives the decrypted request.
    return 'claimed';
  },

  async assertActive(sessionId): Promise<void> {
    const [row] = await db()`
      select status
      from sessions
      where id = ${sessionId}`;
    if (!row || !ACTIVE_STATUSES.includes(row.status)) {
      throw new CrawlCancelledError(sessionId);
    }
  },

  async updateStatus(sessionId, status, currentStep, stepCount, logger): Promise<void> {
    try {
      const sql = db();
      const validStatus = VALID_STATUSES.has(status) ? status : undefined;
      if (!validStatus) {
        (logger ?? console).warn(`[Session] Unknown status '${status}' for ${sessionId}; writing step only.`);
      }
      // Only advance a row that is STILL active. This atomic check-and-set means a
      // concurrent terminal transition (the reaper failing/cancelling us, or a
      // completion) is never overwritten with an active status — which would
      // RESURRECT a reaped row and let an abandoned crawl keep running.
      const updated = await sql`
        update sessions set
          status = ${validStatus ?? sql`status`},
          current_step = ${currentStep},
          step_count = ${stepCount ?? sql`step_count`},
          heartbeat_at = now()
        where id = ${sessionId} and status = any(${ACTIVE_STATUSES})
        returning id`;
      if (updated.length === 0) {
        const [row] = await sql`select status from sessions where id = ${sessionId}`;
        // Row exists but is no longer active — it was reaped/cancelled/completed out
        // from under us. Self-abort so the crawl unwinds instead of resurrecting it.
        if (row) throw new CrawlCancelledError(sessionId);
        return; // session no longer exists — best-effort telemetry, nothing to do
      }
      await emitEvent(sql, sessionId, 'status', { status, currentStep, stepCount });
    } catch (error) {
      if (error instanceof CrawlCancelledError) throw error;
      (logger ?? console).warn(`[Session] Failed to update session ${sessionId}:`, error);
    }
  },

  async appendStep(sessionId, stepLog, logger): Promise<void> {
    try {
      const sql = db();
      const step = (typeof stepLog === 'object' && stepLog !== null)
        ? (stepLog as Record<string, unknown>)
        : { value: stepLog };
      const stepNumber = Number(step.stepNumber ?? 0);
      const screenshotRef =
        (step.screenshotUrl as string | undefined) ??
        (step.screenshotRef as string | undefined) ??
        ((step.screenshot as { url?: string } | undefined)?.url) ??
        null;
      await sql`
        insert into session_steps (session_id, step_number, screenshot_ref, log)
        values (${sessionId}, ${stepNumber}, ${screenshotRef}, ${sql.json(step as JsonParam)})
        on conflict (session_id, step_number)
        do update set log = excluded.log, screenshot_ref = excluded.screenshot_ref`;
      await emitEvent(sql, sessionId, 'step', { stepNumber });
    } catch (err) {
      (logger ?? console).warn(`[Session] Failed to append step log for ${sessionId}:`, err);
    }
  },

  async complete(sessionId, success, error, results, logger): Promise<void> {
    try {
      const sql = db();
      const expiresAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
      const meta = getCompletionMetadata(success, error);

      // Record the outcome, stage the extraction, AND append the 'done' summary
      // event in ONE transaction. An SSE consumer that exits on the terminal status
      // must never miss the summary counts: committing them together guarantees the
      // 'done' event is durable the instant the outcome becomes observable.
      //
      // On SUCCESS the status is deliberately NOT flipped here: the control-plane still
      // has to validate + promote the staged records into the canonical tables, and a
      // publicly-visible 'completed' must MEAN "the data is ready" — an API consumer
      // that polls the session and reads accounts on 'completed' must never lose that
      // race. The control-plane watches for this transaction's 'done' event, promotes,
      // and then flips the status to 'completed' itself. Failures flip immediately
      // (there is nothing to promote), and a cancelled session keeps its status.
      //
      // Retry the whole transaction on a seq collision (the async log flush racing us
      // on UNIQUE(session_id, seq)) so the summary is never silently dropped.
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          await sql.begin(async (tx) => {
            // Serialize with the control-plane's cancellation update. Reading
            // before the transaction allowed cancellation to commit in the gap
            // and then be overwritten with `failed`.
            const [locked] = await tx`
              select status from sessions where id = ${sessionId} for update`;
            if (!locked) throw new Error(`Session ${sessionId} not found`);
            const cancellationRequested =
              locked.status === 'cancelling' || locked.status === 'cancelled';
            if (!cancellationRequested && !ACTIVE_STATUSES.includes(locked.status)) {
              throw new CrawlCancelledError(sessionId);
            }
            const doneData = {
              // Cancellation owns the outcome once its row transition commits.
              // A late successful browser result must never invite the control
              // plane to promote data extracted after the operator pressed Stop.
              success: cancellationRequested ? false : success,
              status: cancellationRequested ? 'cancelled' : meta.status,
              counts: {
                accounts: cancellationRequested ? 0 : (results?.accounts?.length ?? 0),
                transactions: cancellationRequested ? 0 : (results?.transactions?.length ?? 0),
                positions: cancellationRequested ? 0 : (results?.positions?.length ?? 0),
              },
            };
            const cost = results?.cost ? tx.json(results.cost as unknown as JsonParam) : tx`cost`;
            const crawlMemory = results?.crawlMemory ?? tx`crawl_memory`;
            if (cancellationRequested) {
              await tx`
                update sessions set
                  cost = ${cost}, crawl_memory = ${crawlMemory}, expires_at = ${expiresAt}
                where id = ${sessionId}`;
            } else if (success) {
              await tx`
                update sessions set
                  cost = ${cost},
                  crawl_memory = ${crawlMemory},
                  promotion_ready_at = now(),
                  expires_at = ${expiresAt}
                where id = ${sessionId}`;
            } else {
              const errVal = meta.clearLastError ? null : (meta.lastError ?? null);
              const failVal = meta.clearLastError ? null : (results?.failureReason ?? null);
              await tx`
                update sessions set
                  status = ${meta.status},
                  completed_at = now(),
                  error = ${errVal},
                  failure_reason = ${failVal},
                  cost = ${cost},
                  crawl_memory = ${crawlMemory},
                  expires_at = ${expiresAt}
                where id = ${sessionId}`;
            }

            // STAGE the extraction for the control-plane to validate + promote. The engine
            // never writes the canonical accounts/transactions/positions tables. Once
            // cancellation owns the row, discard any late result rather than leave data
            // that another recovery path could accidentally promote.
            if (!cancellationRequested) {
              await stageRecords(tx, sessionId, 'account', results?.accounts);
              await stageRecords(tx, sessionId, 'transaction', results?.transactions);
              await stageRecords(tx, sessionId, 'position', results?.positions);
            }

            // Append the 'done' event in-transaction so it lands atomically with the
            // terminal status. seq = coalesce(max(seq),0)+1 in one statement.
            await tx`
              insert into session_events (session_id, seq, type, data)
              select ${sessionId}, coalesce(max(seq), 0) + 1, 'done', ${tx.json(doneData as JsonParam)}
              from session_events where session_id = ${sessionId}`;
          });
          return;
        } catch (txErr) {
          if ((txErr as { code?: string })?.code === '23505' && attempt < 4) continue; // seq taken; retry the tx
          throw txErr;
        }
      }
    } catch (err) {
      (logger ?? console).warn(`[Session] Failed to complete session ${sessionId}:`, err);
      // This write is the authoritative hand-off to the control plane. Swallowing
      // it lets the one-shot worker report success and scrub its durable payload
      // even though no staged records/done event exist to promote.
      throw err;
    }
  },

  startHeartbeat(sessionId, intervalMs): () => void {
    // Only bump the heartbeat while the row is STILL active. An unconditional bump
    // would keep a reaped row looking alive — defeating the reaper's stale-heartbeat
    // detection and resurrecting a session that was failed/cancelled out from under
    // us. When the row is no longer active, stop heartbeating: the next status write
    // observes the reap and throws CrawlCancelledError, so the crawl self-aborts.
    const timer = setInterval(() => {
      const sql = db();
      sql`update sessions set heartbeat_at = now()
          where id = ${sessionId} and status = any(${ACTIVE_STATUSES})
          returning id`
        .then((updated) => {
          if (updated.length === 0) {
            console.warn(`[Session] Heartbeat stopped for ${sessionId}: session no longer active (reaped/cancelled/completed).`);
            clearInterval(timer);
          }
        })
        .catch((error: unknown) => console.warn(`[Session] Failed to heartbeat session ${sessionId}:`, error));
    }, intervalMs);
    // Don't let the heartbeat timer keep the process alive past the crawl.
    if (typeof timer.unref === 'function') timer.unref();
    return () => clearInterval(timer);
  },

  async flushLogs(sessionId, lines: LogLine[]): Promise<void> {
    try {
      const MAX_LINES = 2000;
      const truncated = lines.length > MAX_LINES ? lines.slice(-MAX_LINES) : lines;
      await emitEvent(db(), sessionId, 'log', { lines: truncated });
    } catch (err) {
      console.warn(`[Session] Failed to flush logs for ${sessionId}:`, err);
    }
  },
};

/** Insert a batch of staged records of one kind. No-op for an empty/absent list. */
async function stageRecords(
  sql: SqlOrTx,
  sessionId: string,
  kind: 'account' | 'transaction' | 'position',
  items: unknown[] | undefined,
): Promise<void> {
  if (!items || items.length === 0) return;
  const rows = items.map((data) => ({ session_id: sessionId, kind, data: sql.json(data as JsonParam) }));
  await sql`insert into staged_records ${sql(rows, 'session_id', 'kind', 'data')}`;
}

// ─── ScreenshotSink (filesystem; the control-plane serves the ref) ───

const SCREENSHOT_DIR = process.env.SCREENSHOT_DIR || process.env.RUNS_DIR || path.join(process.cwd(), 'runs');

/**
 * Where a step screenshot goes when this deployment does not keep them on disk. A deployment that stores
 * them elsewhere supplies this; leaving it unset writes to SCREENSHOT_DIR, which is what a deployment
 * running its own engine does.
 */
export interface ScreenshotArchive {
  save(objectPath: string, jpeg: Buffer): Promise<{ path: string }>;
}

let archive: ScreenshotArchive | undefined;

export function registerScreenshotArchive(supplied: ScreenshotArchive): void {
  archive = supplied;
}

function safeSegment(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, '_');
}

const postgresScreenshots: ScreenshotSink = {
  async upload(sessionId, stepNumber, base64Screenshot, logger): Promise<ScreenshotUploadResult | null> {
    try {
      const rel = path.posix.join('sessions', safeSegment(sessionId), `step-${String(stepNumber).padStart(3, '0')}.jpg`);
      if (archive) {
        const prefix = process.env.SCREENSHOT_PREFIX?.replace(/^\/+|\/+$/g, '');
        const objectName = prefix ? `${prefix}/${rel}` : rel;
        const stored = await archive.save(
          objectName,
          Buffer.from(base64Screenshot, 'base64'),
        );
        return { path: stored.path, url: rel };
      }
      const abs = path.join(SCREENSHOT_DIR, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, Buffer.from(base64Screenshot, 'base64'));
      // url is a stable relative ref; the control-plane maps it to a served route.
      return { path: abs, url: rel };
    } catch (error) {
      (logger ?? console).warn(`[Screenshot] Failed to write step ${stepNumber} for ${sessionId}:`, error);
      return null;
    }
  },
};

// ─── OtpProvider (session-column handshake; manual web entry / relay POST) ──

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const postgresOtp: OtpProvider = {
  async prepare(sessionId, offlineTimeoutMs, busyTimeoutMs, pollIntervalMs, logger): Promise<void> {
    const log = logger ?? console;
    const sql = db();
    // Atomically open an OTP-request episode only when none is active. The WHERE
    // predicate is the compare-and-set: concurrent/duplicate prepare calls return
    // zero rows and join the existing episode without resetting relay state,
    // incrementing its epoch, emitting another event, or waking the phone again.
    // No current_step here: arming happens at crawl start (before the bank has asked for anything),
    // and waitForOtp writes the 'Waiting for OTP code...' step when the agent actually needs the code.
    const prepared = await sql`
      update sessions set
        otp_requested = true, otp_requested_at = now(),
        otp_request_epoch = coalesce(otp_request_epoch, 0) + 1,
        otp_relay_online = false, otp_relay_online_at = null,
        otp_relay_ready = false, otp_relay_ready_at = null,
        otp_relay_mode = null
      where id = ${sessionId}
        and status = any(${ACTIVE_STATUSES})
        and otp_requested is not true
      returning id`;
    const joinedExistingEpisode = prepared.length === 0;
    if (joinedExistingEpisode) {
      const [row] = await sql`
        select status, otp_requested from sessions where id = ${sessionId}`;
      if (!row) throw new Error(`Session ${sessionId} not found`);
      if (!ACTIVE_STATUSES.includes(row.status)) throw new CrawlCancelledError(sessionId);
      if (row.otp_requested !== true) {
        // The active episode was closed after our CAS snapshot. Treat this
        // invocation as belonging to that completed episode; a later caller
        // may open the next one after observing the durable false state.
        log.log(`[OTP] OTP request episode closed while preparing session ${sessionId}`);
        return;
      } else {
        log.log(`[OTP] OTP request already active for session ${sessionId}; waiting for the same episode`);
      }
    } else {
      await emitEvent(sql, sessionId, 'otp_requested', {});
      log.log(`[OTP] Signaled otp_requested for session ${sessionId}`);
      await notifyCompanionOtpWake(sessionId, log);
    }

    const startedAt = Date.now();
    while (true) {
      const [state] = await sql`
        select status, otp_requested, otp_relay_online, otp_relay_ready, otp_relay_mode
        from sessions where id = ${sessionId}`;
      if (!state) throw new Error(`Session ${sessionId} not found`);
      if (!ACTIVE_STATUSES.includes(state.status)) throw new CrawlCancelledError(sessionId);
      if (joinedExistingEpisode && state.otp_requested !== true) {
        log.log(`[OTP] Existing OTP request episode completed for session ${sessionId}`);
        return;
      }
      if (state.otp_relay_ready === true) {
        log.log(`[OTP] Companion confirmed SMS access for session ${sessionId}`);
        return;
      }
      // No phone is authorized for this connection, so no confirmation can ever arrive and waiting for one
      // would burn the whole readiness window before failing. Go on to the login page and let the code be
      // typed into the console instead — the control-plane decides this the moment the episode is armed.
      if (state.otp_relay_mode === 'manual') {
        log.log(
          `[OTP] No Companion is paired for session ${sessionId} — the code will be entered in the console`,
        );
        return;
      }
      const elapsed = Date.now() - startedAt;
      const online = state.otp_relay_online === true;
      const timeout = online ? busyTimeoutMs : offlineTimeoutMs;
      if (elapsed >= timeout) {
        throw new Error(online
          ? `OTP relay did not become ready within ${busyTimeoutMs}ms`
          : `OTP relay did not come online within ${offlineTimeoutMs}ms`);
      }
      await sleep(pollIntervalMs);
    }
  },

  async waitForOtp(sessionId, timeoutMs, pollIntervalMs, logger): Promise<string> {
    const log = logger ?? console;
    const sql = db();
    // Guard the transition so it can't erase a concurrent cancellation.
    const started = await sql`
      update sessions set status = 'waiting_for_otp', current_step = 'Waiting for OTP code...'
      where id = ${sessionId} and status = any(${ACTIVE_STATUSES})
      returning status`;
    if (started.length === 0) {
      const [row] = await sql`select status from sessions where id = ${sessionId}`;
      if (row) throw new CrawlCancelledError(sessionId);
      throw new Error(`Session ${sessionId} not found`);
    }
    log.log(`[OTP] Polling for OTP on session ${sessionId} (timeout: ${timeoutMs}ms)`);

    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      // Atomically claim + clear the code only if the session isn't cancelled. The CTE captures
      // the OLD otp (RETURNING after `SET otp = null` would yield null) and FOR UPDATE serializes
      // concurrent consumers, so a code is never double-consumed or returned for a cancelled session.
      const consumed = await sql`
        with prev as (
          select otp from sessions
          where id = ${sessionId} and status = any(${ACTIVE_STATUSES}) and otp is not null
          for update
        )
        update sessions s set
          otp = null, otp_received_at = now(), otp_requested = false,
          otp_relay_online = false, otp_relay_online_at = null,
          otp_relay_ready = false, otp_relay_ready_at = null,
          status = 'logging_in', current_step = 'Entering OTP code...'
        from prev
        where s.id = ${sessionId}
        returning prev.otp as code`;
      if (consumed.length > 0) {
        await emitEvent(sql, sessionId, 'status', { status: 'logging_in', currentStep: 'Entering OTP code...' });
        log.log(`[OTP] OTP received for session ${sessionId}`);
        return String(consumed[0].code).trim();
      }
      // Nothing claimed: either cancelled (throw) or no code yet (keep polling).
      const [row] = await sql`select status from sessions where id = ${sessionId}`;
      if (!row) throw new Error(`Session ${sessionId} not found`);
      if (!ACTIVE_STATUSES.includes(row.status)) throw new CrawlCancelledError(sessionId);
      await sleep(pollIntervalMs);
    }
    throw new Error(`OTP timeout after ${timeoutMs}ms for session ${sessionId}`);
  },
};

// ─── SecretCipher (identity — the control-plane decrypts) ───────────

const postgresCipher: SecretCipher = {
  // Credentials arrive in the /crawl request already decrypted by the control-plane,
  // so "decryption" is the identity. The engine's DB role cannot read credential columns.
  async decrypt(ciphertext: string): Promise<string> {
    return ciphertext;
  },
};

// ─── TunnelStore (atomic single-use device-proxy claim) ─────────────

const postgresTunnel: TunnelStore = {
  async loadTunnelContext(sessionId, deviceId): Promise<TunnelContext | null> {
    const sql = db();
    // Single-use CAS: claim the tunnel for THIS connection iff the session requested one and it
    // hasn't been claimed yet. RETURNING tells us atomically whether we won — no separate read can
    // race in between. The engine role has SELECT+UPDATE on sessions (and nothing else), so this is
    // within its grants and needs no devices/connections access.
    const claimedRows = await sql<{ status: string }[]>`
      update sessions
        set tunnel_claimed_at = now()
        where id = ${sessionId}
          and status = any(${ACTIVE_STATUSES})
          and tunnel_requested = true
          and tunnel_device_id = ${deviceId}
          and tunnel_claimed_at is null
        returning status`;
    if (claimedRows.length > 0) {
      return { sessionId, status: claimedRows[0].status, tunnelRequested: true, claimed: true };
    }
    // We didn't claim it. Read the row to tell the caller WHY: a non-existent session (null), a
    // session that never requested a tunnel (tunnelRequested=false), or one already claimed by an
    // earlier connection (tunnelRequested=true, claimed=false) — all reject, but distinctly.
    const rows = await sql<{ status: string; tunnel_requested: boolean }[]>`
      select status, tunnel_requested from sessions where id = ${sessionId}`;
    if (rows.length === 0) return null;
    return { sessionId, status: rows[0].status, tunnelRequested: rows[0].tunnel_requested, claimed: false };
  },
  async releaseTunnelClaim(sessionId): Promise<void> {
    const sql = db();
    // Reverse a claim that was won with no parked crawl to run (the control-plane sets tunnel_requested
    // before it dispatches/parks, so a fast companion can claim in the gap). Guarded on currently-claimed
    // so it never resurrects a finished or never-claimed row. Within the engine's UPDATE-sessions grant.
    await sql`
      update sessions
        set tunnel_claimed_at = null
        where id = ${sessionId} and tunnel_claimed_at is not null`;
  },
};

export function createPostgresPlatform(): Platform {
  return {
    name: 'postgres',
    sessionStore: postgresSessionStore,
    screenshots: postgresScreenshots,
    otp: postgresOtp,
    cipher: postgresCipher,
    tunnel: postgresTunnel,
  };
}

/** Test/shutdown helper: close the pooled connection so the process can exit. */
export async function closePostgresPlatform(): Promise<void> {
  if (sqlClient) {
    await sqlClient.end({ timeout: 5 });
    sqlClient = undefined;
  }
}
