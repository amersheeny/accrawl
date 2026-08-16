/**
 * Postgres platform adapter — validated against a real Postgres wire protocol.
 *
 * pglite (in-process WASM Postgres) is exposed over a TCP socket so the adapter's
 * actual postgres.js SQL runs end-to-end: session/step/event writes, the sequenced
 * event log, the staging boundary (engine writes staged_records, NEVER the final
 * accounts/transactions/positions tables), OTP handshake, and cancellation.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { CrawlCancelledError } from '../agent/session-updater';
import { createPostgresPlatform, closePostgresPlatform } from './postgres';
import type { Platform } from './types';

const wakeMocks = vi.hoisted(() => ({
  notifyCompanionOtpWake: vi.fn().mockResolvedValue(true),
}));

vi.mock('../otp/companion-wake', () => ({
  notifyCompanionOtpWake: wakeMocks.notifyCompanionOtpWake,
}));

const MIGRATIONS_DIR = path.resolve(__dirname, '../../../control-plane/migrations');
const DEVICE_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_DEVICE_ID = '22222222-2222-4222-8222-222222222222';

let client: PGlite;
let server: PGLiteSocketServer;
let platform: Platform;
/** Insert a fresh connection + session (each session gets its own connection so the
 *  one-active-per-connection lock never trips across independent test cases). */
async function newSession(): Promise<string> {
  const c = await client.query<{ id: string }>(
    `insert into connections (institution_id, username_ct, password_ct) values ('test-bank', 'ct-u', 'ct-p') returning id`,
  );
  const r = await client.query<{ id: string }>(
    `insert into sessions (connection_id, status) values ($1, 'starting') returning id`,
    [c.rows[0].id],
  );
  return r.rows[0].id;
}

async function getSession(id: string): Promise<Record<string, unknown>> {
  const r = await client.query<Record<string, unknown>>(`select * from sessions where id = $1`, [id]);
  return r.rows[0];
}

describe('postgres platform adapter (real wire protocol via pglite socket)', () => {
  beforeAll(async () => {
    client = new PGlite();
    // Apply the control-plane migrations.
    for (const file of fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()) {
      await client.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
    }
    // Prerequisite institution + connection (FK chain for sessions/staged_records).
    await client.exec(
      `insert into institutions (id, name, login_url, canonical_domain, type) values ('test-bank', 'Test Bank', 'https://test.example', 'test.example', 'bank')`,
    );
    await client.query(
      `insert into devices (id, name, hashed_token, connection_grants)
       values ($1, 'Phone 1', 'hash-1', '[]'::jsonb), ($2, 'Phone 2', 'hash-2', '[]'::jsonb)`,
      [DEVICE_ID, OTHER_DEVICE_ID],
    );
    // Let the OS allocate a private port so this focused integration test can run
    // alongside other Accrawl sessions without taking over their database socket.
    // Match the production adapter's four-connection postgres.js pool. The
    // PGlite socket server defaults to one connection and rejects the second
    // socket, which makes a genuine concurrent prepare test fail with
    // ECONNRESET before it can exercise the OTP compare-and-set.
    server = new PGLiteSocketServer({ db: client, port: 0, maxConnections: 4 });
    await server.start();
    const assignedPort = Number(server.getServerConn().split(':').at(-1));
    if (!Number.isInteger(assignedPort) || assignedPort <= 0) {
      throw new Error(`PGlite did not expose its assigned TCP port: ${server.getServerConn()}`);
    }
    process.env.ENGINE_DATABASE_URL = `postgres://localhost:${assignedPort}/postgres`;
    platform = createPostgresPlatform();
  });

  afterAll(async () => {
    await closePostgresPlatform();
    await server?.stop();
    await client?.close();
    delete process.env.ENGINE_DATABASE_URL;
  });

  it('updateStatus writes status/step/heartbeat + a sequenced status event', async () => {
    const id = await newSession();
    await platform.sessionStore.updateStatus(id, 'logging_in', 'Signing in', 3);
    const s = await getSession(id);
    expect(s.status).toBe('logging_in');
    expect(s.current_step).toBe('Signing in');
    expect(s.step_count).toBe(3);
    expect(s.heartbeat_at).not.toBeNull();

    const ev = await client.query<{ seq: number; type: string }>(
      `select seq, type from session_events where session_id = $1 order by seq`, [id]);
    expect(ev.rows).toEqual([{ seq: 1, type: 'status' }]);
  });

  it('assertActive fails closed before browser allocation for terminal or missing sessions', async () => {
    const activeId = await newSession();
    await expect(platform.sessionStore.assertActive(activeId)).resolves.toBeUndefined();

    await client.query(
      `update sessions set status = 'cancelled' where id = $1`,
      [activeId],
    );
    await expect(platform.sessionStore.assertActive(activeId))
      .rejects.toBeInstanceOf(CrawlCancelledError);
    await expect(
      platform.sessionStore.assertActive('00000000-0000-0000-0000-000000000000'),
    ).rejects.toBeInstanceOf(CrawlCancelledError);
  });

  it('updateStatus with an out-of-enum status updates the step but NOT the status', async () => {
    const id = await newSession();
    await platform.sessionStore.updateStatus(id, 'logging_in', 'first', 1);
    await platform.sessionStore.updateStatus(id, 'totally-bogus', 'second', 2);
    const s = await getSession(id);
    expect(s.status).toBe('logging_in'); // unchanged — never threw, never corrupted the enum
    expect(s.current_step).toBe('second');
    expect(s.step_count).toBe(2);
  });

  it('updateStatus throws CrawlCancelledError when the session is cancelled', async () => {
    const id = await newSession();
    await client.query(`update sessions set status = 'cancelled' where id = $1`, [id]);
    await expect(platform.sessionStore.updateStatus(id, 'navigating', 'x')).rejects.toBeInstanceOf(CrawlCancelledError);
  });

  it('updateStatus self-aborts (and never resurrects) a session reaped to a terminal status', async () => {
    const id = await newSession();
    // The reaper failed the row out from under the engine. Advancing it must throw,
    // and — the load-bearing invariant — must NOT flip the terminal row back to active.
    await client.query(`update sessions set status = 'failed' where id = $1`, [id]);
    await expect(platform.sessionStore.updateStatus(id, 'navigating', 'x')).rejects.toBeInstanceOf(CrawlCancelledError);
    const s = await getSession(id);
    expect(s.status).toBe('failed'); // not resurrected to 'navigating'
  });

  it('appendStep inserts a step row (idempotent on session+step) with the screenshot ref', async () => {
    const id = await newSession();
    await platform.sessionStore.appendStep(id, { stepNumber: 1, action: 'click', screenshotUrl: 'sessions/x/step-001.jpg' });
    await platform.sessionStore.appendStep(id, { stepNumber: 1, action: 'click-again', screenshotUrl: 'sessions/x/step-001b.jpg' });
    const steps = await client.query<{ step_number: number; screenshot_ref: string; log: Record<string, unknown> }>(
      `select step_number, screenshot_ref, log from session_steps where session_id = $1`, [id]);
    expect(steps.rows).toHaveLength(1); // ON CONFLICT updated, not duplicated
    expect(steps.rows[0].screenshot_ref).toBe('sessions/x/step-001b.jpg');
    expect(steps.rows[0].log.action).toBe('click-again');
  });

  it('complete STAGES extraction and never writes the canonical tables', async () => {
    const id = await newSession();
    await platform.sessionStore.complete(id, true, undefined, {
      accounts: [{ providerAccountId: 'a1', name: 'Checking' }],
      transactions: [{ id: 't1' }, { id: 't2' }],
      positions: [],
      cost: { totalUsd: 0.01 } as never,
      crawlMemory: 'remember-this',
    });

    // A SUCCESS deliberately does NOT flip the status: the control-plane promotes the staged
    // records first and flips to 'completed' itself, so an observable 'completed' always means
    // the canonical data is ready. The outcome (cost/memory) + staging + the done event commit here.
    const s = await getSession(id);
    expect(s.status).toBe('starting'); // unchanged — still whatever the crawl last set
    expect(s.crawl_memory).toBe('remember-this');
    expect(s.cost).toEqual({ totalUsd: 0.01 });
    expect(s.completed_at).toBeNull(); // set by the control-plane at promotion
    expect(s.promotion_ready_at).not.toBeNull();

    const staged = await client.query<{ kind: string; n: number }>(
      `select kind, count(*)::int as n from staged_records where session_id = $1 group by kind order by kind`, [id]);
    expect(staged.rows).toEqual([
      { kind: 'account', n: 1 },
      { kind: 'transaction', n: 2 },
    ]); // positions empty → no rows

    // The staging boundary: the engine adapter must NOT write final tables.
    const acct = await client.query<{ n: number }>(`select count(*)::int as n from accounts`);
    const txn = await client.query<{ n: number }>(`select count(*)::int as n from transactions`);
    expect(acct.rows[0].n).toBe(0);
    expect(txn.rows[0].n).toBe(0);

    const done = await client.query<{ type: string }>(`select type from session_events where session_id = $1 order by seq desc limit 1`, [id]);
    expect(done.rows[0].type).toBe('done');
  });

  it('complete commits the staged extraction and the done summary event together (success)', async () => {
    const id = await newSession();
    await platform.sessionStore.complete(id, true, undefined, {
      accounts: [{ providerAccountId: 'a1', name: 'Checking' }],
      transactions: [{ id: 't1' }],
      positions: [{ id: 'p1' }],
    });

    // Invariant: whenever the done event is observable, the staged records (and counts) are already
    // durable — they're written in one transaction, so the control-plane's watcher can never see the
    // 'done' signal without the extraction it is about to promote.
    const done = await client.query<{ data: { success: boolean; counts: { accounts: number; transactions: number; positions: number } } }>(
      `select data from session_events where session_id = $1 and type = 'done'`, [id]);
    expect(done.rows).toHaveLength(1);
    expect(done.rows[0].data.success).toBe(true);
    expect(done.rows[0].data.counts).toEqual({ accounts: 1, transactions: 1, positions: 1 });
    const staged = await client.query<{ n: number }>(`select count(*)::int as n from staged_records where session_id = $1`, [id]);
    expect(staged.rows[0].n).toBe(3);
  });

  it('complete flips the status directly on FAILURE (nothing to promote)', async () => {
    const id = await newSession();
    await platform.sessionStore.complete(id, false, 'bank login failed', { failureReason: 'bank_login_failed' } as never);
    const s = await getSession(id);
    expect(s.status).toBe('failed');
    expect(s.error).toBe('bank login failed');
    expect(s.completed_at).not.toBeNull();
  });

  it('complete on a cancelled session keeps the cancelled status and discards late extraction', async () => {
    const id = await newSession();
    await client.query(`update sessions set status = 'cancelled' where id = $1`, [id]);
    await platform.sessionStore.complete(id, false, 'aborted', { accounts: [{ providerAccountId: 'a1' }] });
    const s = await getSession(id);
    expect(s.status).toBe('cancelled'); // not overwritten with 'failed'
    const staged = await client.query<{ n: number }>(`select count(*)::int as n from staged_records where session_id = $1`, [id]);
    expect(staged.rows[0].n).toBe(0);
  });

  it('complete cannot overwrite or publish extraction from a two-phase cancelling session', async () => {
    const id = await newSession();
    await client.query(`update sessions set status = 'cancelling' where id = $1`, [id]);
    await platform.sessionStore.complete(
      id,
      true,
      'browser context closed',
      { accounts: [{ providerAccountId: 'late' }] } as never,
    );
    const s = await getSession(id);
    expect(s.status).toBe('cancelling');
    expect(s.promotion_ready_at).toBeNull();
    const staged = await client.query<{ n: number }>(
      `select count(*)::int as n from staged_records where session_id = $1`,
      [id],
    );
    expect(staged.rows[0].n).toBe(0);
    const done = await client.query<{ data: { success: boolean; counts: { accounts: number } } }>(
      `select data from session_events where session_id = $1 and type = 'done'`,
      [id],
    );
    expect(done.rows[0].data.success).toBe(false);
    expect(done.rows[0].data.counts.accounts).toBe(0);
  });

  it('complete propagates a rejected authoritative write and never revives a failed session', async () => {
    const id = await newSession();
    await client.query(
      `update sessions set status = 'failed', error = 'reaped' where id = $1`,
      [id],
    );
    await expect(platform.sessionStore.complete(
      id,
      true,
      undefined,
      { accounts: [{ providerAccountId: 'late' }] } as never,
    )).rejects.toBeInstanceOf(CrawlCancelledError);
    const session = await getSession(id);
    expect(session.status).toBe('failed');
    expect(session.error).toBe('reaped');
    const staged = await client.query<{ n: number }>(
      `select count(*)::int as n from staged_records where session_id = $1`,
      [id],
    );
    expect(staged.rows[0].n).toBe(0);
    const done = await client.query<{ n: number }>(
      `select count(*)::int as n from session_events where session_id = $1 and type = 'done'`,
      [id],
    );
    expect(done.rows[0].n).toBe(0);
  });

  it('OTP: prepare signals otp_requested; waitForOtp returns the code the UI writes', async () => {
    const id = await newSession();
    wakeMocks.notifyCompanionOtpWake.mockReset().mockResolvedValue(true);
    const prepareWithReadyCompanion = async (expectedEpoch: number): Promise<void> => {
      const preparing = platform.otp.prepare(id, 1000, 1000, 50);
      await expect.poll(async () =>
        Number((await getSession(id)).otp_request_epoch)
      ).toBe(expectedEpoch);
      await client.query(
        `update sessions set otp_relay_online = true, otp_relay_online_at = now() where id = $1`,
        [id],
      );
      await client.query(
        `update sessions set otp_relay_ready = true, otp_relay_ready_at = now() where id = $1`,
        [id],
      );
      await preparing;
    };

    await prepareWithReadyCompanion(1);
    let s = await getSession(id);
    expect(s.otp_requested).toBe(true);
    expect(Number(s.otp_request_epoch)).toBe(1);

    // A duplicate prepare while the same episode is already ready is a no-op:
    // it neither bumps the epoch, emits another event, nor asks for another wake.
    await platform.otp.prepare(id, 1000, 1000, 50);
    s = await getSession(id);
    expect(Number(s.otp_request_epoch)).toBe(1);
    expect(wakeMocks.notifyCompanionOtpWake).toHaveBeenCalledTimes(1);
    let requestedEvents = await client.query<{ n: number }>(
      `select count(*)::int as n from session_events where session_id = $1 and type = 'otp_requested'`,
      [id],
    );
    expect(requestedEvents.rows[0].n).toBe(1);

    // Simulate the web UI / relay POSTing the code after prepare.
    setTimeout(() => { void client.query(`update sessions set otp = '654321' where id = $1`, [id]); }, 100);
    const code = await platform.otp.waitForOtp(id, 5000, 50);
    expect(code).toBe('654321');

    s = await getSession(id);
    expect(s.otp).toBeNull();          // consumed
    expect(s.otp_requested).toBe(false);
    expect(s.status).toBe('logging_in');

    // Consuming the code closes the episode. A later prepare is a genuinely new
    // episode, so it atomically increments the epoch and emits exactly one wake.
    await prepareWithReadyCompanion(2);
    expect(wakeMocks.notifyCompanionOtpWake).toHaveBeenCalledTimes(2);
    requestedEvents = await client.query<{ n: number }>(
      `select count(*)::int as n from session_events where session_id = $1 and type = 'otp_requested'`,
      [id],
    );
    expect(requestedEvents.rows[0].n).toBe(2);
  });

  it('OTP: prepare stops waiting once the control-plane says no phone can relay', async () => {
    const id = await newSession();
    wakeMocks.notifyCompanionOtpWake.mockReset().mockImplementation(async () => {
      // The control-plane decides the mode while arming the episode — it is the only side that can see
      // the paired devices — and records it before the wake call returns.
      await client.query(`update sessions set otp_relay_mode = 'manual' where id = $1`, [id]);
      return true;
    });

    // Would otherwise sit out the full offline window waiting for a confirmation nothing can send.
    await expect(platform.otp.prepare(id, 60_000, 60_000, 50)).resolves.toBeUndefined();

    const session = await getSession(id);
    expect(session.otp_requested).toBe(true);
    expect(session.otp_relay_ready).toBe(false); // no phone confirmed anything; we simply stopped waiting
    expect(session.otp_relay_mode).toBe('manual');

    // The code the operator types into the console is picked up exactly as a relayed one would be.
    setTimeout(() => { void client.query(`update sessions set otp = '135791' where id = $1`, [id]); }, 50);
    expect(await platform.otp.waitForOtp(id, 5000, 50)).toBe('135791');
  });

  it('OTP: a new episode never inherits the previous episode\'s manual decision', async () => {
    const id = await newSession();
    wakeMocks.notifyCompanionOtpWake.mockReset().mockResolvedValue(true);
    await client.query(
      `update sessions set otp_requested = true, otp_relay_mode = 'manual' where id = $1`,
      [id],
    );
    // Consume the episode the way waitForOtp does, leaving the stale decision behind.
    await client.query(`update sessions set otp_requested = false where id = $1`, [id]);

    const preparing = platform.otp.prepare(id, 60_000, 60_000, 50);
    await expect.poll(async () => (await getSession(id)).otp_relay_mode).toBeNull();
    // A phone is paired again, so this episode waits for it rather than reusing the old answer.
    await client.query(
      `update sessions set otp_relay_online = true, otp_relay_ready = true where id = $1`,
      [id],
    );
    await expect(preparing).resolves.toBeUndefined();
  });

  it('OTP: concurrent duplicate prepare waits on the same active episode without another wake', async () => {
    const id = await newSession();
    wakeMocks.notifyCompanionOtpWake.mockReset().mockResolvedValue(true);
    const first = platform.otp.prepare(id, 1000, 1000, 20);
    await expect.poll(async () => Number((await getSession(id)).otp_request_epoch)).toBe(1);

    const duplicateLogger = {
      log: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      getLines: () => [],
    };
    const duplicate = platform.otp.prepare(id, 1000, 1000, 20, duplicateLogger);
    await expect.poll(() => duplicateLogger.log.mock.calls.length).toBeGreaterThan(0);

    expect(Number((await getSession(id)).otp_request_epoch)).toBe(1);
    expect(wakeMocks.notifyCompanionOtpWake).toHaveBeenCalledTimes(1);
    const requestedEvents = await client.query<{ n: number }>(
      `select count(*)::int as n from session_events where session_id = $1 and type = 'otp_requested'`,
      [id],
    );
    expect(requestedEvents.rows[0].n).toBe(1);

    await client.query(
      `update sessions set otp_relay_online = true, otp_relay_online_at = now(),
        otp_relay_ready = true, otp_relay_ready_at = now() where id = $1`,
      [id],
    );
    await Promise.all([first, duplicate]);
  });

  it('OTP: a failed wake request leaves the durable episode armed', async () => {
    const id = await newSession();
    wakeMocks.notifyCompanionOtpWake.mockReset().mockResolvedValue(false);
    const preparing = platform.otp.prepare(id, 1000, 1000, 20);
    await expect.poll(async () => Number((await getSession(id)).otp_request_epoch)).toBe(1);
    await client.query(
      `update sessions set otp_relay_online = true, otp_relay_online_at = now(),
        otp_relay_ready = true, otp_relay_ready_at = now() where id = $1`,
      [id],
    );
    await preparing;

    const state = await getSession(id);
    expect(state.otp_requested).toBe(true);
    expect(Number(state.otp_request_epoch)).toBe(1);
    expect(wakeMocks.notifyCompanionOtpWake).toHaveBeenCalledTimes(1);
  });

  it('OTP: waitForOtp throws CrawlCancelledError if the session is cancelled mid-wait', async () => {
    const id = await newSession();
    setTimeout(() => { void client.query(`update sessions set status = 'cancelled' where id = $1`, [id]); }, 100);
    await expect(platform.otp.waitForOtp(id, 5000, 50)).rejects.toBeInstanceOf(CrawlCancelledError);
  });

  it('OTP: cancelling cannot be advanced back into an active state', async () => {
    const prepareId = await newSession();
    await client.query(`update sessions set status = 'cancelling' where id = $1`, [prepareId]);
    await expect(platform.otp.prepare(prepareId, 1000, 1000, 50))
      .rejects.toBeInstanceOf(CrawlCancelledError);

    const waitId = await newSession();
    await client.query(
      `update sessions set status = 'cancelling', otp = '654321' where id = $1`,
      [waitId],
    );
    await expect(platform.otp.waitForOtp(waitId, 1000, 50))
      .rejects.toBeInstanceOf(CrawlCancelledError);
    const s = await getSession(waitId);
    expect(s.status).toBe('cancelling');
    expect(s.otp).toBe('654321');
  });

  it('assigns gap-free, contiguous event seqs across many appends', async () => {
    const id = await newSession();
    // The observable invariant: N appends → seqs 1..N with no gap/dup. (The UNIQUE(session_id,seq)
    // + retry guards the real-Postgres concurrent-writer race; the in-process serial harness can't
    // reproduce that race, so this asserts the sequencing itself is correct.)
    const N = 12;
    for (let i = 0; i < N; i++) {
      await platform.sessionStore.updateStatus(id, 'navigating', `step ${i}`, i);
    }
    const ev = await client.query<{ seq: number }>(
      `select seq from session_events where session_id = $1 and type = 'status' order by seq`, [id]);
    expect(ev.rows.map((r) => r.seq)).toEqual(Array.from({ length: N }, (_, i) => i + 1));
  });

  it('cipher is identity (control-plane decrypts; engine never sees ciphertext)', async () => {
    expect(await platform.cipher.decrypt('plaintext-value')).toBe('plaintext-value');
  });

  describe('loadTunnelContext (atomic single-use device-proxy claim)', () => {
    it('claims a requested tunnel exactly once; a second call reports claimed=false', async () => {
      const id = await newSession();
      // The control-plane marks the session as awaiting a tunnel.
      await client.query(
        `update sessions set tunnel_requested = true, tunnel_device_id = $2 where id = $1`,
        [id, DEVICE_ID],
      );

      const first = await platform.tunnel.loadTunnelContext(id, DEVICE_ID);
      expect(first).toEqual({ sessionId: id, status: 'starting', tunnelRequested: true, claimed: true });
      // The claim persisted the timestamp (the single-use ledger).
      const s = await getSession(id);
      expect(s.tunnel_claimed_at).not.toBeNull();

      // A second connection for the same session loses the CAS — already claimed.
      const second = await platform.tunnel.loadTunnelContext(id, DEVICE_ID);
      expect(second).toEqual({ sessionId: id, status: 'starting', tunnelRequested: true, claimed: false });
    });

    it('does not claim a session that never requested a tunnel (claimed=false, no timestamp written)', async () => {
      const id = await newSession(); // tunnel_requested defaults to false
      const ctx = await platform.tunnel.loadTunnelContext(id, DEVICE_ID);
      expect(ctx).toEqual({ sessionId: id, status: 'starting', tunnelRequested: false, claimed: false });
      const s = await getSession(id);
      expect(s.tunnel_claimed_at).toBeNull();
    });

    it('does not claim a terminal session', async () => {
      const id = await newSession();
      await client.query(
        `update sessions set tunnel_requested = true, tunnel_device_id = $2, status = 'failed' where id = $1`,
        [id, DEVICE_ID],
      );
      const ctx = await platform.tunnel.loadTunnelContext(id, DEVICE_ID);
      expect(ctx?.status).toBe('failed');
      expect(ctx?.claimed).toBe(false);
      const s = await getSession(id);
      expect(s.tunnel_claimed_at).toBeNull();
    });

    it('does not claim a two-phase cancelling session', async () => {
      const id = await newSession();
      await client.query(
        `update sessions set tunnel_requested = true, tunnel_device_id = $2, status = 'cancelling' where id = $1`,
        [id, DEVICE_ID],
      );
      const ctx = await platform.tunnel.loadTunnelContext(id, DEVICE_ID);
      expect(ctx).toEqual({ sessionId: id, status: 'cancelling', tunnelRequested: true, claimed: false });
      const s = await getSession(id);
      expect(s.tunnel_claimed_at).toBeNull();
    });

    it('returns null for a session that does not exist', async () => {
      expect(await platform.tunnel.loadTunnelContext(
        '00000000-0000-0000-0000-000000000000',
        DEVICE_ID,
      )).toBeNull();
    });

    it('does not let a different paired device claim the session', async () => {
      const id = await newSession();
      await client.query(
        `update sessions set tunnel_requested = true, tunnel_device_id = $2 where id = $1`,
        [id, DEVICE_ID],
      );
      const wrongDevice = await platform.tunnel.loadTunnelContext(id, OTHER_DEVICE_ID);
      expect(wrongDevice).toEqual({
        sessionId: id,
        status: 'starting',
        tunnelRequested: true,
        claimed: false,
      });
      expect((await getSession(id)).tunnel_claimed_at).toBeNull();
    });
  });
});
