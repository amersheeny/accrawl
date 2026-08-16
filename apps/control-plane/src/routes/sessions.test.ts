import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';

// The OTP-submit route is a discriminated union: { code } (operator web console) vs
// { smsBody, sender, otpRequestEpoch } (paired companion relaying a RAW SMS body for the control-plane to
// LLM-extract). We mock the LLM extractor so the route's live-Gemini path is replaced by a deterministic
// stub — these tests assert the HTTP wiring (auth → body discrimination → submitOtpFromSms → status codes),
// not the model itself (the model + its guard are unit-tested in data/otp-extract.test.ts).
const extractMock = vi.fn<(body: string, name: string | null) => Promise<string | null>>();
vi.mock('../data/otp-extract', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../data/otp-extract')>();
  return { ...actual, extractOtpFromSms: (body: string, name: string | null) => extractMock(body, name) };
});

const DB_PORT = 54334; // unique per socket-using test file
const KEY = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';

describe('OTP-submit route — manual code + SMS relay (real server + pglite)', () => {
  let client: PGlite;
  let dbServer: PGLiteSocketServer;
  let app: FastifyInstance;
  let closeDb: (() => Promise<void>) | undefined;
  let dbRef: import('../db/client').Db;
  let operatorToken: string;
  let deviceToken: string;
  let deviceId: string;
  let sessionId: string;
  let connectionId: string;

  beforeAll(async () => {
    client = new PGlite();
    const dir = path.resolve(__dirname, '../../migrations');
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
      await client.exec(fs.readFileSync(path.join(dir, f), 'utf8'));
    }
    dbServer = new PGLiteSocketServer({ db: client, port: DB_PORT });
    await dbServer.start();

    process.env.DATABASE_URL = `postgres://localhost:${DB_PORT}/postgres`;
    process.env.CREDENTIAL_ENC_KEY = KEY;
    process.env.SETUP_CLAIM_TOKEN = 'test-setup-code';
    process.env.DB_POOL_MAX = '1'; // pin the pglite socket to one connection so background writes don't race foreground queries

    const { db, sql } = await import('../db/client');
    dbRef = db;
    closeDb = () => sql.end({ timeout: 5 });
    const { buildServer } = await import('../index');
    app = await buildServer();
    await app.ready();

    await app.inject({ method: 'POST', url: '/api/setup', payload: { password: 'hunter2-pw', setupCode: 'test-setup-code' } });
    operatorToken = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'hunter2-pw', setupCode: 'test-setup-code' } })).json().token;

    await client.exec(
      `insert into institutions (id,name,login_url,canonical_domain,type,otp_sender_pattern)
       values ('b','BankCo','https://b.com','b.com','bank','BANKCO')`,
    );

    const { pairDevice } = await import('../data/devices');
    const device = await pairDevice(db, { name: 'phone' });
    deviceId = device.id;
    deviceToken = device.plaintext;
  });

  afterAll(async () => {
    await app?.close();
    await closeDb?.();
    await dbServer?.stop();
    await client?.close();
    delete process.env.DATABASE_URL;
    delete process.env.CREDENTIAL_ENC_KEY;
    delete process.env.DB_POOL_MAX;
  });

  beforeEach(async () => {
    extractMock.mockReset();
    // A FRESH connection per test: the sessions table has a one-active-per-connection unique index, so each
    // test gets its own connection to hold an active waiting_for_otp session without colliding with the
    // previous test's (non-terminal) session.
    const c = await client.query<{ id: string }>(`insert into connections (institution_id, username_ct, password_ct) values ('b','u','p') returning id`);
    connectionId = c.rows[0].id;
    await client.query(
      'update devices set connection_grants = $1::jsonb where id = $2',
      [JSON.stringify([connectionId]), deviceId],
    );
    const s = await client.query<{ id: string }>(
      `insert into sessions (connection_id, status, current_step, otp_request_epoch) values ($1,'waiting_for_otp','Waiting for OTP',1) returning id`,
      [connectionId],
    );
    sessionId = s.rows[0].id;
  });

  const otpUrl = () => `/api/sessions/${sessionId}/otp`;

  it('operator manual { code } path still works (202, code reaches the engine poll field)', async () => {
    const res = await app.inject({
      method: 'POST', url: otpUrl(), payload: { code: '654321' },
      headers: { authorization: `Bearer ${operatorToken}` },
    });
    expect(res.statusCode).toBe(202);
    const { sessions } = await import('../db/schema');
    const [s] = await dbRef.select().from(sessions).where(eq(sessions.id, sessionId));
    expect(s.otp).toBe('654321');
    expect(extractMock).not.toHaveBeenCalled(); // manual path never invokes the LLM
  });

  it('a DEVICE on the manual { code } branch is rejected (403) — it must relay the SMS body, not a raw code', async () => {
    // The manual code path bypasses sender-binding + LLM extraction + grounding, so a device must NOT use it.
    // It must go through the validated SMS relay. The route accepts operator-OR-device, but the manual branch
    // is operator-only.
    const res = await app.inject({
      method: 'POST', url: otpUrl(), payload: { code: '654321' },
      headers: { authorization: `Bearer ${deviceToken}` },
    });
    expect(res.statusCode).toBe(403);
    const { sessions } = await import('../db/schema');
    const [s] = await dbRef.select().from(sessions).where(eq(sessions.id, sessionId));
    expect(s.otp).toBeNull(); // nothing was submitted — the device-supplied raw code never reached the engine
  });

  it('SMS relay { smsBody, sender, otpRequestEpoch }: LLM-extracted code is submitted (202)', async () => {
    extractMock.mockResolvedValue('12345678');
    const res = await app.inject({
      method: 'POST', url: otpUrl(),
      payload: { smsBody: 'Your code is 1234-5678', sender: 'BANKCO', otpRequestEpoch: 1 },
      headers: { authorization: `Bearer ${deviceToken}` },
    });
    expect(res.statusCode).toBe(202);
    expect(extractMock).toHaveBeenCalledWith('Your code is 1234-5678', 'BankCo');
    const { sessions } = await import('../db/schema');
    const [s] = await dbRef.select().from(sessions).where(eq(sessions.id, sessionId));
    expect(s.otp).toBe('12345678');
  });

  it('SMS relay is bounded per session: a flood is refused before it reaches the model', async () => {
    // A stolen device token could otherwise relay unique bodies without limit. Each one reached the model
    // and could overwrite a code the session was still waiting for. Distinct bodies on purpose: the
    // idempotency key covers the whole body, so repeating one is already deduplicated and proves nothing.
    extractMock.mockResolvedValue(undefined);
    const before = extractMock.mock.calls.length;
    let refused = 0;
    for (let i = 0; i < 14; i += 1) {
      const res = await app.inject({
        method: 'POST', url: otpUrl(),
        payload: { smsBody: `marketing message ${i}`, sender: 'BANKCO', otpRequestEpoch: 1 },
        headers: { authorization: `Bearer ${deviceToken}` },
      });
      if (res.statusCode === 429) refused += 1;
    }
    expect(refused).toBeGreaterThan(0);
    // Refused before extraction, so the flood costs no model calls.
    expect(extractMock.mock.calls.length - before).toBeLessThanOrEqual(10);
  });

  it('SMS relay with no code in the body → 200 no_otp, nothing submitted (session stays waiting)', async () => {
    extractMock.mockResolvedValue(null);
    const res = await app.inject({
      method: 'POST', url: otpUrl(),
      payload: { smsBody: 'Your statement is ready', sender: 'BANKCO', otpRequestEpoch: 1 },
      headers: { authorization: `Bearer ${deviceToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('no_otp');
    const { sessions } = await import('../db/schema');
    const [s] = await dbRef.select().from(sessions).where(eq(sessions.id, sessionId));
    expect(s.otp).toBeNull();
  });

  it('SMS relay from a non-matching sender → 409, LLM never called', async () => {
    const res = await app.inject({
      method: 'POST', url: otpUrl(),
      payload: { smsBody: 'Your code is 482910', sender: 'SCAMMER', otpRequestEpoch: 1 },
      headers: { authorization: `Bearer ${deviceToken}` },
    });
    expect(res.statusCode).toBe(409);
    expect(extractMock).not.toHaveBeenCalled();
    const { sessions } = await import('../db/schema');
    const [s] = await dbRef.select().from(sessions).where(eq(sessions.id, sessionId));
    expect(s.otp).toBeNull();
  });

  it('SMS relay idempotency: redelivered same body in the SAME episode is a no-op; a NEW epoch is accepted', async () => {
    extractMock.mockResolvedValue('246810');
    const body = 'Your verification code: 246810';
    const post = (epoch: number) => app.inject({
      method: 'POST', url: otpUrl(), payload: { smsBody: body, sender: 'BANKCO', otpRequestEpoch: epoch },
      headers: { authorization: `Bearer ${deviceToken}` },
    });
    const { sessions } = await import('../db/schema');

    expect((await post(1)).statusCode).toBe(202);
    expect(extractMock).toHaveBeenCalledTimes(1);

    // Engine consumed + advanced; redelivery of the same body in the same episode is a no-op (no 2nd extract).
    await dbRef.update(sessions).set({ status: 'extracting' }).where(eq(sessions.id, sessionId));
    expect((await post(1)).statusCode).toBe(202);
    expect(extractMock).toHaveBeenCalledTimes(1); // short-circuited before the LLM

    // A genuinely new request episode (engine re-armed, epoch bumped) accepts the same body again.
    extractMock.mockResolvedValue('135790');
    await dbRef.update(sessions).set({ status: 'waiting_for_otp', otpRequestEpoch: 2 }).where(eq(sessions.id, sessionId));
    expect((await post(2)).statusCode).toBe(202);
    const [s] = await dbRef.select().from(sessions).where(eq(sessions.id, sessionId));
    expect(s.otp).toBe('135790');
  });

  it('rejects an unauthenticated relay (401)', async () => {
    const res = await app.inject({
      method: 'POST', url: otpUrl(), payload: { smsBody: 'x 1234', sender: 'BANKCO', otpRequestEpoch: 1 },
    });
    expect(res.statusCode).toBe(401);
  });

  it('400s a body that is neither a code nor a complete SMS relay', async () => {
    const res = await app.inject({
      method: 'POST', url: otpUrl(), payload: { sender: 'BANKCO' }, // missing smsBody + code
      headers: { authorization: `Bearer ${deviceToken}` },
    });
    expect(res.statusCode).toBe(400);
  });

  // ── The crawl surface belongs to the owner, not to API credentials ──────────────────────────────────
  // A one-time passcode is part of HOW a crawl gets in, and a session is the record of that. Neither is
  // reachable with an API key: not with the only scope a key can hold, not with a wildcard grant.
  async function mintKey(scopes: string[], connectionGrants: string[]): Promise<string> {
    const res = await app.inject({ method: 'POST', url: '/api/keys', headers: { authorization: `Bearer ${operatorToken}` }, payload: { name: 'consumer', scopes, connectionGrants } });
    expect(res.statusCode).toBe(201);
    return res.json().key as string;
  }

  it('an API key cannot submit an OTP (401), and nothing reaches the session', async () => {
    const key = await mintKey(['read:data'], ['*']);
    const res = await app.inject({ method: 'POST', url: otpUrl(), payload: { code: '111222' }, headers: { authorization: `Bearer ${key}` } });
    expect(res.statusCode).toBe(401);
    const { sessions } = await import('../db/schema');
    const [s] = await dbRef.select().from(sessions).where(eq(sessions.id, sessionId));
    expect(s.otp).toBeNull();
  });

  it('an API key cannot relay an SMS body either (401)', async () => {
    const key = await mintKey(['read:data'], ['*']);
    const res = await app.inject({ method: 'POST', url: otpUrl(), payload: { smsBody: 'code 111222', sender: 'BANKCO', otpRequestEpoch: 1 }, headers: { authorization: `Bearer ${key}` } });
    expect(res.statusCode).toBe(401);
  });

  it('write:otp is not a scope a key can even be minted with', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/keys', headers: { authorization: `Bearer ${operatorToken}` }, payload: { name: 'consumer', scopes: ['write:otp'], connectionGrants: ['*'] } });
    expect(res.statusCode).toBe(400);
  });

  it('a read:data key cannot read session status (403) — the data API sees no crawls', async () => {
    const key = await mintKey(['read:data'], [connectionId]);
    const res = await app.inject({ method: 'GET', url: `/api/sessions/${sessionId}`, headers: { authorization: `Bearer ${key}` } });
    expect(res.statusCode).toBe(403);
  });

  it('the operator reads the session, and the view never carries the OTP code', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/sessions/${sessionId}`, headers: { authorization: `Bearer ${operatorToken}` } });
    expect(res.statusCode).toBe(200);
    const view = res.json();
    expect(view.status).toBe('waiting_for_otp');
    expect(view.otp).toBeUndefined();
  });

  it('reading session status with no credentials → 401', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/sessions/${sessionId}` });
    expect(res.statusCode).toBe(401);
  });
});
