/**
 * Integration boot test: the REAL control-plane server (real postgres.js client, real Fastify routes,
 * real HTTP path) against a pglite wire socket — the closest local stand-in for a deployed Postgres.
 *
 * Unit tests exercise the routes/data via the drizzle-pglite shim; this proves the whole server boots
 * and runs an end-to-end operator flow (login -> institution -> connection -> verify-domain -> list)
 * over the actual driver + HTTP, catching anything the shim would mask. buildServer + db/client are
 * dynamically imported AFTER DATABASE_URL is pointed at the socket (db/client connects at import).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import type { FastifyInstance } from 'fastify';
// REAL token verifier — an independent oracle to decode the minted tunnel token's `did`.
import { deriveTunnelKey, verifyTunnelToken } from '@accrawl/contracts';

const PORT = 54330;
const KEY = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
const TUNNEL_SECRET = 'integration-engine-shared-secret-aaaaaaaaaaaa';

describe('control-plane integration (real server + real postgres.js over a pglite socket)', () => {
  let client: PGlite;
  let server: PGLiteSocketServer;
  let app: FastifyInstance;
  let closeDb: (() => Promise<void>) | undefined;
  let rawSql: Awaited<typeof import('./db/client')>['sql'];

  async function pairCompanion(
    auth: Record<string, string>,
    name: string,
    connectionGrants: string[],
  ): Promise<{
    id: string;
    token: string;
    financialToken: string;
  }> {
    const created = await app.inject({
      method: 'POST',
      url: '/api/devices/pairing-intents',
      headers: auth,
      payload: { name, connectionGrants },
    });
    expect(created.statusCode).toBe(201);
    const intent = created.json() as { id: string; pairingCode: string };
    const claim = `acclaim_${randomBytes(32).toString('base64url')}`;
    const claimed = await app.inject({
      method: 'POST',
      url: '/api/devices/pairing/claim',
      payload: { pairingCode: intent.pairingCode, claim },
    });
    expect(claimed.statusCode).toBe(200);
    expect(claimed.json().verificationCode).toMatch(/^\d{6}$/);
    const approved = await app.inject({
      method: 'POST',
      url: `/api/devices/pairing-intents/${intent.id}/approve`,
      headers: auth,
    });
    expect(approved.statusCode).toBe(200);
    const completed = await app.inject({
      method: 'POST',
      url: '/api/devices/pairing/complete',
      payload: { pairingCode: intent.pairingCode, claim },
    });
    expect(completed.statusCode).toBe(201);
    return {
      id: completed.json().deviceId as string,
      token: completed.json().deviceToken as string,
      financialToken: completed.json().financialToken as string,
    };
  }

  beforeAll(async () => {
    client = new PGlite();
    const dir = path.resolve(__dirname, '../migrations');
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
      await client.exec(fs.readFileSync(path.join(dir, f), 'utf8'));
    }
    server = new PGLiteSocketServer({ db: client, port: PORT });
    await server.start();

    process.env.DATABASE_URL = `postgres://localhost:${PORT}/postgres`;
    process.env.CREDENTIAL_ENC_KEY = KEY;
    // The awaiting-tunnel route mints tunnel tokens from this secret (HKDF root) and hands back the WS URL.
    // Both are read into `config` at import time, so they must be set BEFORE ./index (→ ./config) loads.
    process.env.ENGINE_SHARED_SECRET = TUNNEL_SECRET;
    process.env.ENGINE_WS_URL = 'wss://engine.example/tunnel';
    process.env.ACCRAWL_COMPANION_ALLOW_INSECURE_HTTP = '1';
    process.env.SETUP_CLAIM_TOKEN = 'integration-setup-code';

    const { sql } = await import('./db/client'); // connects to the socket via postgres.js
    rawSql = sql;
    closeDb = () => sql.end({ timeout: 5 });
    const { buildServer } = await import('./index');
    app = await buildServer();
    await app.ready();
    // First-run setup: create the operator credential so login works (the admin password is no longer an
    // env var — it lives in operator_credential, set here once).
    await app.inject({ method: 'POST', url: '/api/setup', payload: { password: 'operator-pw', setupCode: 'integration-setup-code' } });
  });

  afterAll(async () => {
    await app?.close();
    await closeDb?.();
    await server?.stop();
    await client?.close();
    delete process.env.DATABASE_URL;
    delete process.env.CREDENTIAL_ENC_KEY;
    delete process.env.ENGINE_SHARED_SECRET;
    delete process.env.ENGINE_WS_URL;
    delete process.env.ACCRAWL_COMPANION_ALLOW_INSECURE_HTTP;
  });

  it('JSON parser tolerates an empty body but keeps prototype-poisoning protection', async () => {
    // A bodyless request carrying a stray `content-type: application/json` (what browsers send on a DELETE)
    // must REACH the route instead of a blanket parser 400 — here it lands on operator auth (401), not 400.
    const emptyDelete = await app.inject({
      method: 'DELETE', url: '/api/devices/00000000-0000-0000-0000-000000000000',
      headers: { 'content-type': 'application/json' },
    });
    expect(emptyDelete.statusCode).toBe(401); // reached auth, not rejected at parse

    // A NON-empty body with a poisoned prototype is still rejected (400) by Fastify's secure parser — the
    // empty-body tolerance must NOT downgrade to a raw JSON.parse that would strip this protection.
    const proto = await app.inject({
      method: 'POST', url: '/api/auth/login',
      headers: { 'content-type': 'application/json' }, payload: '{"__proto__":{"polluted":true}}',
    });
    expect(proto.statusCode).toBe(400);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined(); // no global prototype pollution

    // A whitespace-only body is invalid JSON, not "empty" → 400 (never silently coerced to {}).
    const ws = await app.inject({
      method: 'POST', url: '/api/auth/login',
      headers: { 'content-type': 'application/json' }, payload: '   ',
    });
    expect(ws.statusCode).toBe(400);
  });

  it('end-to-end operator flow over the real driver + HTTP', async () => {
    const health = await app.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);

    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'operator-pw' } });
    expect(login.statusCode).toBe(200);
    const auth = { authorization: `Bearer ${login.json().token}` };

    const inst = await app.inject({
      method: 'POST', url: '/api/institutions', headers: auth,
      payload: { id: 'demo-bank', name: 'Demo', loginUrl: 'https://login.demo-bank.com/', type: 'bank' },
    });
    expect(inst.statusCode).toBe(201);
    expect(inst.json().canonicalDomain).toBe('demo-bank.com'); // derived server-side
    expect(inst.json()).toMatchObject({
      visibility: 'private',
      ownedByViewer: true,
      canPublish: true,
    });

    const conn = await app.inject({
      method: 'POST', url: '/api/connections', headers: auth,
      payload: {
        institutionId: inst.json().id,
        username: 'alice',
        password: 's3cret',
        crawlSchedule: '0 6 * * *',
        crawlTimezone: 'Europe/London',
      },
    });
    expect(conn.statusCode).toBe(201);
    const connId = conn.json().id as string;
    expect(JSON.stringify(conn.json())).not.toContain('s3cret'); // secret-free response

    // unverified at first
    expect(conn.json().loginDomainVerified).toBe(false);
    expect(conn.json()).toMatchObject({
      crawlScheduleEnabled: true,
      crawlSchedule: '0 6 * * *',
      crawlTimezone: 'Europe/London',
      nextCrawlAt: null,
    });
    const verify = await app.inject({
      method: 'POST', url: `/api/connections/${connId}/verify-domain`, headers: auth,
      payload: { canonicalDomain: 'demo-bank.com' },
    });
    expect(verify.statusCode).toBe(200);
    expect(verify.json().loginDomainVerified).toBe(true);
    expect(verify.json().nextCrawlAt).toEqual(expect.any(String));

    const invalidSchedule = await app.inject({
      method: 'PATCH', url: `/api/connections/${connId}`, headers: auth,
      payload: { crawlSchedule: '99 25 * * *' },
    });
    expect(invalidSchedule.statusCode).toBe(400);
    expect(invalidSchedule.json().error)
      .toBe('Choose a valid frequency, time, and time zone.');

    const manualOnly = await app.inject({
      method: 'PATCH', url: `/api/connections/${connId}`, headers: auth,
      payload: { crawlScheduleEnabled: false },
    });
    expect(manualOnly.statusCode).toBe(200);
    expect(manualOnly.json()).toMatchObject({
      crawlScheduleEnabled: false,
      nextCrawlAt: null,
    });

    const automatic = await app.inject({
      method: 'PATCH', url: `/api/connections/${connId}`, headers: auth,
      payload: {
        crawlScheduleEnabled: true,
        crawlSchedule: '30 8 * * 1',
        crawlTimezone: 'Europe/London',
      },
    });
    expect(automatic.statusCode).toBe(200);
    expect(automatic.json()).toMatchObject({
      crawlScheduleEnabled: true,
      crawlSchedule: '30 8 * * 1',
      crawlTimezone: 'Europe/London',
    });
    expect(automatic.json().nextCrawlAt).toEqual(expect.any(String));

    const list = await app.inject({ method: 'GET', url: '/api/connections', headers: auth });
    expect(list.statusCode).toBe(200);
    expect(list.json().connections).toHaveLength(1);

    // auth is enforced on the real HTTP path
    expect((await app.inject({ method: 'GET', url: '/api/connections' })).statusCode).toBe(401);
  });

  it('companion device: operator pairs a device, and the device token authenticates the OTP-relay path', async () => {
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'operator-pw' } });
    const auth = { authorization: `Bearer ${login.json().token}` };

    const rInst = await app.inject({
      method: 'POST', url: '/api/institutions', headers: auth,
      payload: { id: 'recent-bank', name: 'Recent Bank', loginUrl: 'https://login.recent-bank.com/', type: 'bank' },
    });
    expect(rInst.statusCode).toBe(201);
    const rConn = await app.inject({
      method: 'POST', url: '/api/connections', headers: auth,
      payload: { institutionId: rInst.json().id, username: 'bob', password: 'pw' },
    });
    expect(rConn.statusCode).toBe(201);
    const pair = await pairCompanion(auth, 'Pixel', [rConn.json().id as string]);
    const deviceToken = pair.token;
    const deviceId = pair.id;
    expect(deviceToken.startsWith('acdv_')).toBe(true);

    const devices = await app.inject({ method: 'GET', url: '/api/devices', headers: auth });
    expect(devices.json().devices).toHaveLength(1);
    expect(JSON.stringify(devices.json())).not.toContain('acdv_'); // the list never exposes the token

    // The device token authenticates the OTP route (operator-or-device). The MANUAL { code } branch is
    // operator-only, so a device on it is rejected 403 (auth was ACCEPTED — preHandler set req.device — but
    // the manual-branch authz refuses a device; it must relay the SMS body instead). NOT 401. A bogus device
    // token IS 401 (auth rejected).
    const dAuth = { authorization: `Bearer ${deviceToken}` };
    const noSession = '00000000-0000-0000-0000-000000000000';
    const manualByDevice = await app.inject({ method: 'POST', url: `/api/sessions/${noSession}/otp`, headers: dAuth, payload: { code: '123456' } });
    expect(manualByDevice.statusCode).toBe(403); // device may not type a raw code — it must relay the SMS
    // The device's legitimate path is the SMS relay branch; that auth IS accepted (not 401/403): with no such
    // session it is a 404 (the route logic ran past the preHandler + the manual-branch gate).
    const smsByDevice = await app.inject({ method: 'POST', url: `/api/sessions/${noSession}/otp`, headers: dAuth, payload: { smsBody: 'Your code is 123456', sender: 'BANKCO', otpRequestEpoch: 0 } });
    expect(smsByDevice.statusCode).not.toBe(401);
    expect(smsByDevice.statusCode).not.toBe(403);
    expect([202, 404, 409, 200]).toContain(smsByDevice.statusCode);
    const bogus = await app.inject({ method: 'POST', url: `/api/sessions/${noSession}/otp`, headers: { authorization: 'Bearer acdv_bogus' }, payload: { code: '1' } });
    expect(bogus.statusCode).toBe(401);

    // Before it can register anything, the device asks which push project THIS deployment sends
    // through — the answer that used to be built into the app, welding one build to one deployment.
    // This test deployment sends no wakes, and says so rather than handing back a half-configuration
    // the app would try and fail to register with.
    const pushConfig = await app.inject({ method: 'GET', url: '/api/devices/push-config', headers: dAuth });
    expect(pushConfig.statusCode).toBe(404);
    expect(pushConfig.json().code).toBe('push_not_configured');
    // …and it is not answerable to a stranger, even though none of its four values is a secret.
    expect((await app.inject({ method: 'GET', url: '/api/devices/push-config' })).statusCode).toBe(401);

    // The device registers its push token (device-authenticated).
    expect((await app.inject({ method: 'POST', url: '/api/devices/push', headers: dAuth, payload: { pushTransport: 'fcm', pushToken: 'fcm-xyz' } })).statusCode).toBe(204);

    // The device polls for sessions awaiting a code. The STATIC /awaiting-otp path must win over
    // /api/sessions/:id (else it would be a 404 'session not found').
    const awaiting = await app.inject({ method: 'GET', url: '/api/sessions/awaiting-otp', headers: dAuth });
    expect(awaiting.statusCode).toBe(200);
    expect(Array.isArray(awaiting.json().sessions)).toBe(true);

    // The device reads recent crawl outcomes for its in-app history view (device auth accepted; STATIC
    // /recent path wins over /:id). Give it a real completed crawl to read back.
    await rawSql`insert into sessions (connection_id, status, completed_at)
                 values (${rConn.json().id as string}, 'completed', now())`;

    const recent = await app.inject({ method: 'GET', url: '/api/sessions/recent', headers: dAuth });
    expect(recent.statusCode).toBe(200);
    const recentRows = recent.json().sessions as Array<Record<string, unknown>>;
    const recentRow = recentRows.find((r) => r.institutionName === 'Recent Bank');
    expect(recentRow).toBeTruthy(); // the device sees the crawl outcome…
    expect(recentRow!.status).toBe('completed'); // …with its safe status metadata
    // …and the payload is SAFE metadata only: no financial records (accounts/transactions/positions), and
    // no operational fields beyond the documented safe set — in particular no step_count.
    const recentBlob = JSON.stringify(recent.json());
    for (const key of ['"accounts"', '"transactions"', '"positions"', '"stepCount"', '"cost"']) {
      expect(recentBlob).not.toContain(key);
    }

    await rawSql`
      insert into accounts (id, connection_id, data)
      values (
        'integration-companion-account',
        ${rConn.json().id as string},
        ${JSON.stringify({
          providerAccountId: 'provider-current',
          name: 'Current account',
          description: '',
          currency: 'GBP',
          type: 'current',
          balance: 432.1,
        })}::jsonb
      )`;
    await rawSql`
      insert into transactions (id, connection_id, data)
      values (
        'integration-companion-transaction',
        ${rConn.json().id as string},
        ${JSON.stringify({
          providerAccountId: 'provider-current',
          providerTransactionId: 'provider-tx',
          bookingDate: '2030-01-02',
          amount: -12.34,
          currency: 'GBP',
          merchant: 'Cafe',
          description: 'Coffee',
          isPending: false,
        })}::jsonb
      )`;
    const financialAuth = { authorization: `Bearer ${pair.financialToken}` };
    const companionAccounts = await app.inject({
      method: 'GET',
      url: '/api/companion/accounts',
      headers: financialAuth,
    });
    expect(companionAccounts.statusCode).toBe(200);
    expect(companionAccounts.headers['cache-control']).toBe('no-store');
    expect(companionAccounts.json().items).toMatchObject([
      {
        id: 'integration-companion-account',
        balance: { current: 432.1 },
      },
    ]);
    const companionTransactions = await app.inject({
      method: 'GET',
      url: '/api/companion/transactions',
      headers: financialAuth,
    });
    expect(companionTransactions.statusCode).toBe(200);
    expect(companionTransactions.headers['cache-control']).toBe('no-store');
    expect(companionTransactions.json().items).toMatchObject([
      {
        id: 'integration-companion-transaction',
        accountId: 'integration-companion-account',
        amount: -12.34,
      },
    ]);

    // The same screen-lock-gated financial credential opens crawl evidence for
    // a granted connection: status, step logs, screenshots, and extracted
    // results. The relay-only device token remains insufficient for these
    // financially sensitive routes.
    const recentSessionId = recentRow!.id as string;
    const companionSession = await app.inject({
      method: 'GET',
      url: `/api/sessions/${recentSessionId}`,
      headers: financialAuth,
    });
    expect(companionSession.statusCode).toBe(200);
    expect(companionSession.json()).toMatchObject({
      id: recentSessionId,
      status: 'completed',
    });
    expect((await app.inject({
      method: 'GET',
      url: `/api/sessions/${recentSessionId}/steps`,
      headers: financialAuth,
    })).statusCode).toBe(200);
    expect((await app.inject({
      method: 'GET',
      url: `/api/sessions/${recentSessionId}/records`,
      headers: financialAuth,
    })).statusCode).toBe(200);
    expect((await app.inject({
      method: 'GET',
      url: `/api/sessions/${recentSessionId}`,
      headers: dAuth,
    })).statusCode).toBe(401);

    // The local QA escape hatch is ignored in production. A financial bearer credential must never cross
    // cleartext HTTP even when the permissive environment variable was accidentally left configured.
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const insecureProduction = await app.inject({
        method: 'GET',
        url: '/api/companion/accounts',
        headers: financialAuth,
      });
      expect(insecureProduction.statusCode).toBe(426);
      expect(insecureProduction.json().error).toContain('HTTPS');
    } finally {
      if (previousNodeEnv == null) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
    }

    // Revoke -> the device token no longer authenticates.
    expect((await app.inject({ method: 'DELETE', url: `/api/devices/${deviceId}`, headers: auth })).statusCode).toBe(204);
    expect((await app.inject({ method: 'POST', url: '/api/devices/push', headers: dAuth, payload: { pushTransport: 'fcm', pushToken: 'x' } })).statusCode).toBe(401);
    expect((await app.inject({
      method: 'GET',
      url: '/api/companion/accounts',
      headers: financialAuth,
    })).statusCode).toBe(401);
  });

  it('awaiting-tunnel: binds the minted token `did` to the AUTHENTICATED device, not the newest paired one', async () => {
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'operator-pw' } });
    const auth = { authorization: `Bearer ${login.json().token}` };

    const inst = await app.inject({
      method: 'POST', url: '/api/institutions', headers: auth,
      payload: { id: 'tunnel-bank', name: 'Tunnel Bank', loginUrl: 'https://login.tunnel-bank.com/', type: 'bank' },
    });
    expect(inst.statusCode).toBe(201);
    const conn = await app.inject({
      method: 'POST', url: '/api/connections', headers: auth,
      payload: { institutionId: inst.json().id, username: 'bob', password: 'pw' },
    });
    expect(conn.statusCode).toBe(201);
    const connId = conn.json().id as string;

    // Pair TWO devices. D2 is paired strictly AFTER D1, so pickPairedDevice (ORDER BY paired_at DESC)
    // would pick D2 — the wrong, pre-fix binding when D1 is the one actually polling.
    const pair1 = await pairCompanion(auth, 'D1', [connId]);
    const d1Id = pair1.id;
    const d1Token = pair1.token;
    const pair2 = await pairCompanion(auth, 'D2', [connId]);
    const d2Id = pair2.id;
    expect(d1Id).not.toBe(d2Id);
    // Make D2 deterministically the newest, so pickPairedDevice can ONLY ever return D2 (no tie on paired_at).
    await rawSql`update devices set paired_at = now() + interval '1 hour' where id = ${d2Id}`;
    // Sanity: the pre-fix selector (newest paired) is D2, NOT the device that will authenticate (D1).
    const [newest] = await rawSql<{ id: string }[]>`select id from devices where revoked_at is null order by paired_at desc limit 1`;
    expect(newest.id).toBe(d2Id);

    // A session in the awaiting-tunnel state, durably bound to D1.
    const [sess] = await rawSql<{ id: string }[]>`
      insert into sessions (connection_id, status, tunnel_requested, tunnel_device_id)
      values (${connId}, 'starting', true, ${d1Id})
      returning id`;

    // D1 (the authenticated device) polls awaiting-tunnel.
    const d1Auth = { authorization: `Bearer ${d1Token}` };
    const res = await app.inject({ method: 'GET', url: '/api/sessions/awaiting-tunnel', headers: d1Auth });
    expect(res.statusCode).toBe(200);
    const entry = res.json().sessions.find((s: { sessionId: string }) => s.sessionId === sess.id);
    expect(entry).toBeTruthy();

    // Decode the minted token with the REAL verifier (independent oracle) — its `did` must be the
    // AUTHENTICATED device D1, NOT the newest paired device D2.
    const decoded = verifyTunnelToken(deriveTunnelKey(TUNNEL_SECRET), entry.tunnelToken as string);
    expect(decoded).not.toBeNull();
    expect(decoded!.sid).toBe(sess.id);
    expect(decoded!.did).toBe(d1Id);
    expect(decoded!.did).not.toBe(d2Id);

    // Operator polling falls back to D2, but a D1-bound session is not exposed
    // and no token can be minted for the wrong phone.
    const opRes = await app.inject({ method: 'GET', url: '/api/sessions/awaiting-tunnel', headers: auth });
    expect(opRes.statusCode).toBe(200);
    const opEntry = opRes.json().sessions.find((s: { sessionId: string }) => s.sessionId === sess.id);
    expect(opEntry).toBeUndefined();

    // Cleanup so a leftover active session doesn't trip the one-active-per-connection unique index later.
    await rawSql`delete from sessions where id = ${sess.id}`;
    await app.inject({ method: 'DELETE', url: `/api/devices/${d1Id}`, headers: auth });
    await app.inject({ method: 'DELETE', url: `/api/devices/${d2Id}`, headers: auth });
  });

  it('awaiting-otp: surfaces the institution otpSenderPattern so the companion can bind the SMS by sender', async () => {
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'operator-pw' } });
    const auth = { authorization: `Bearer ${login.json().token}` };

    // An institution with a learned OTP-sender pattern, plus a connection + a session actually waiting for a code.
    const inst = await app.inject({
      method: 'POST', url: '/api/institutions', headers: auth,
      payload: {
        id: 'sender-bank', name: 'Sender Bank', loginUrl: 'https://login.sender-bank.com/', type: 'bank',
        requires2fa: true, otpSenderPattern: '^SENDERBANK$',
      },
    });
    expect(inst.statusCode).toBe(201);
    const conn = await app.inject({
      method: 'POST', url: '/api/connections', headers: auth,
      payload: { institutionId: inst.json().id, username: 'carol', password: 'pw' },
    });
    expect(conn.statusCode).toBe(201);
    const connId = conn.json().id as string;
    const [sess] = await rawSql<{ id: string }[]>`
      insert into sessions (connection_id, status, otp_requested)
      values (${connId}, 'waiting_for_otp', true)
      returning id`;

    const pair = await pairCompanion(auth, 'SenderPhone', [connId]);
    const dAuth = { authorization: `Bearer ${pair.token}` };
    const res = await app.inject({ method: 'GET', url: '/api/sessions/awaiting-otp', headers: dAuth });
    expect(res.statusCode).toBe(200);
    const entry = res.json().sessions.find((s: { id: string }) => s.id === sess.id);
    expect(entry).toBeTruthy();
    expect(entry.connectionId).toBe(connId);
    expect(entry.institutionName).toBe('Sender Bank');
    expect(entry.otpSenderPattern).toBe('^SENDERBANK$'); // the additive field the companion matches the SMS sender against

    await rawSql`delete from sessions where id = ${sess.id}`;
    await app.inject({ method: 'DELETE', url: `/api/devices/${pair.id}`, headers: auth });
  });

  it('otp submit: an idempotency-key retry is a no-op, never a second 2FA attempt', async () => {
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'operator-pw' } });
    const auth = { authorization: `Bearer ${login.json().token}` };

    const inst = await app.inject({
      method: 'POST', url: '/api/institutions', headers: auth,
      payload: { id: 'idem-bank', name: 'Idem Bank', loginUrl: 'https://login.idem-bank.com/', type: 'bank' },
    });
    expect(inst.statusCode).toBe(201);
    const conn = await app.inject({
      method: 'POST', url: '/api/connections', headers: auth,
      payload: { institutionId: inst.json().id, username: 'dave', password: 'pw' },
    });
    const connId = conn.json().id as string;
    const [sess] = await rawSql<{ id: string }[]>`
      insert into sessions (connection_id, status)
      values (${connId}, 'waiting_for_otp')
      returning id`;

    const key = 'idem-key-abc';
    // First submit with the key → accepted, code stored.
    const first = await app.inject({
      method: 'POST', url: `/api/sessions/${sess.id}/otp`, headers: { ...auth, 'idempotency-key': key }, payload: { code: '111111' },
    });
    expect(first.statusCode).toBe(202);
    expect((await rawSql<{ otp: string | null }[]>`select otp from sessions where id = ${sess.id}`)[0].otp).toBe('111111');

    // Simulate the engine consuming the code + advancing (the session leaves waiting_for_otp). A RAW retry
    // (no key) would now be a 409 — but a retry WITH THE SAME KEY is recognised as already-done → 202 no-op,
    // and it must NOT overwrite the (already consumed) otp with a different code.
    await rawSql`update sessions set status = 'extracting' where id = ${sess.id}`;
    const noKeyRetry = await app.inject({
      method: 'POST', url: `/api/sessions/${sess.id}/otp`, headers: auth, payload: { code: '999999' },
    });
    expect(noKeyRetry.statusCode).toBe(409); // not awaiting input anymore
    const keyRetry = await app.inject({
      method: 'POST', url: `/api/sessions/${sess.id}/otp`, headers: { ...auth, 'idempotency-key': key }, payload: { code: '999999' },
    });
    expect(keyRetry.statusCode).toBe(202); // recognised as the same submit → no-op
    expect((await rawSql<{ otp: string | null }[]>`select otp from sessions where id = ${sess.id}`)[0].otp).toBe('111111'); // unchanged

    await rawSql`delete from sessions where id = ${sess.id}`;
  });
});
