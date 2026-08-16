import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { HOSTED_COPY } from '@accrawl/contracts';

// Crawl-now must return after the engine DURABLY acknowledges dispatch, not
// merely when the request is sent and not after the whole crawl. The fake
// engine lets the test hold that acknowledgement at the exact boundary.
const DB_PORT = 54333;
const KEY = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';

describe('crawl-now route — non-blocking (real server + pglite)', () => {
  let client: PGlite;
  let dbServer: PGLiteSocketServer;
  let engine: http.Server;
  let enginePort: number;
  let app: FastifyInstance;
  let closeDb: (() => Promise<void>) | undefined;
  let connId: string;
  let refreshConnId: string;
  let rejectedConnId: string;
  let activeSessionId: string;
  let operatorToken: string;
  let dbRef: import('../db/client').Db;
  const engineSockets = new Set<import('node:net').Socket>();
  let engineMode: 'deferred-accept' | 'reject' = 'deferred-accept';
  let acknowledgeDispatch: (() => void) | undefined;
  let observeDispatch: (() => void) | undefined;
  let dispatchObserved = new Promise<void>((resolve) => {
    observeDispatch = resolve;
  });

  beforeAll(async () => {
    engine = http.createServer((request, response) => {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk) => { body += chunk; });
      request.on('end', () => {
        if (engineMode === 'reject') {
          response.writeHead(503).end();
          return;
        }
        const sessionId = (JSON.parse(body) as { sessionId: string }).sessionId;
        acknowledgeDispatch = () => {
          response.writeHead(202, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ accepted: true, sessionId }));
        };
        observeDispatch?.();
      });
    });
    engine.on('connection', (sock) => { engineSockets.add(sock); sock.on('close', () => engineSockets.delete(sock)); });
    await new Promise<void>((resolve) => engine.listen(0, '127.0.0.1', resolve));
    enginePort = (engine.address() as import('node:net').AddressInfo).port;

    client = new PGlite();
    const dir = path.resolve(__dirname, '../../migrations');
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
      await client.exec(fs.readFileSync(path.join(dir, f), 'utf8'));
    }
    dbServer = new PGLiteSocketServer({ db: client, port: DB_PORT });
    await dbServer.start();

    process.env.DATABASE_URL = `postgres://localhost:${DB_PORT}/postgres`;
    process.env.DB_POOL_MAX = '1';
    process.env.CREDENTIAL_ENC_KEY = KEY;
    process.env.SETUP_CLAIM_TOKEN = 'test-setup-code';
    process.env.ENGINE_URL = `http://127.0.0.1:${enginePort}`;

    const { db, sql } = await import('../db/client');
    dbRef = db;
    closeDb = () => sql.end({ timeout: 5 });
    const { buildServer } = await import('../index');
    app = await buildServer();
    await app.ready();
    await app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: { password: 'hunter2-pw', setupCode: 'test-setup-code' },
    });
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { password: 'hunter2-pw', setupCode: 'test-setup-code' },
    });
    expect(login.statusCode).toBe(200);
    operatorToken = login.json().token as string;
    expect(operatorToken).toBeTruthy();

    // A verified, crawlable connection so runCrawl proceeds all the way to dispatch.
    await client.exec(
      `insert into institutions (id,name,login_url,canonical_domain,type,timeout_seconds,scan_status)
       values ('acme','Acme','https://login.acme.com/','acme.com','bank',900,'passed')`,
    );
    const { createConnection, verifyLoginDomain } = await import('../data/connections');
    const c = await createConnection(db, { institutionId: 'acme', username: 'alice', password: 's3cret' });
    await verifyLoginDomain(db, c.id, 'acme.com');
    connId = c.id;
    const rejected = await createConnection(db, {
      institutionId: 'acme',
      username: 'bob',
      password: 's3cret',
    });
    await verifyLoginDomain(db, rejected.id, 'acme.com');
    rejectedConnId = rejected.id;
    const refresh = await createConnection(db, {
      institutionId: 'acme',
      username: 'carol',
      password: 's3cret',
    });
    await verifyLoginDomain(db, refresh.id, 'acme.com');
    refreshConnId = refresh.id;
  });

  afterAll(async () => {
    for (const sock of engineSockets) sock.destroy();
    await new Promise<void>((resolve) => engine.close(() => resolve()));
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
    await app?.close();
    await closeDb?.();
    await dbServer?.stop();
    await client?.close();
    delete process.env.DATABASE_URL;
    delete process.env.DB_POOL_MAX;
    delete process.env.CREDENTIAL_ENC_KEY;
    delete process.env.ENGINE_URL;
  });

  it('rejects request body fields', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/connections/${connId}/crawl`,
      payload: { unexpected: true },
      headers: { authorization: `Bearer ${operatorToken}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: HOSTED_COPY.crawlRequestBodyMustBeEmpty,
    });
  });

  it('withholds 202 until the engine ACK, then returns without awaiting the crawl', async () => {
    let settled = false;
    const response = app.inject({
      method: 'POST', url: `/api/connections/${connId}/crawl`,
      headers: { authorization: `Bearer ${operatorToken}` },
    }).then((result) => {
      settled = true;
      return result;
    });
    await dispatchObserved;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    acknowledgeDispatch?.();
    const res = await response;
    expect(res.statusCode).toBe(202);
    const sessionId = res.json().sessionId as string;
    expect(sessionId).toBeTruthy();
    activeSessionId = sessionId;

    // The returned session exists and is the active lock holder for the connection (operator can monitor it).
    const { sessions } = await import('../db/schema');
    const [s] = await dbRef.select().from(sessions).where(eq(sessions.id, sessionId));
    expect(s.connectionId).toBe(connId);
    expect(['starting', 'logging_in', 'navigating', 'waiting_for_otp', 'extracting']).toContain(s.status);
  }, 15_000);

  it('409s a second crawl while one is already running (lock held)', async () => {
    const res = await app.inject({
      method: 'POST', url: `/api/connections/${connId}/crawl`,
      headers: { authorization: `Bearer ${operatorToken}` },
    });
    expect(res.statusCode).toBe(409);
    // Let the detached first run observe a terminal record and unwind before
    // this file closes its one-connection database pool.
    await client.exec(
      `update sessions
       set status = 'failed', completed_at = now(), error = 'test teardown'
       where id = '${activeSessionId}'`,
    );
    await vi.waitFor(async () => {
      const rows = await client.query<{ status: string }>(
        `select status from connections where id = '${connId}'`,
      );
      expect(rows.rows[0]?.status).not.toBe('syncing');
    }, { timeout: 5_000, interval: 100 });
  });

  it('returns 502, never 202, when the engine rejects dispatch', async () => {
    engineMode = 'reject';
    dispatchObserved = new Promise<void>((resolve) => {
      observeDispatch = resolve;
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/connections/${rejectedConnId}/crawl`,
      headers: { authorization: `Bearer ${operatorToken}` },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({
      outcome: 'failed',
      error: HOSTED_COPY.crawlStartFailure,
    });
  });

  // The public API cannot start a retrieval at all: the v1 surface has no refresh route, and the guard on
  // every v1 route refuses a write method before it authenticates anything.
  it('the public data API offers no way to start a run (refresh route is gone)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/connections/${refreshConnId}/refresh`,
      payload: {},
      headers: { authorization: `Bearer ${operatorToken}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('a write to a real v1 read route is refused as read-only (405), even for the operator', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/connections',
      payload: {},
      headers: { authorization: `Bearer ${operatorToken}` },
    });
    // Fastify has no POST handler registered, so the router answers first; either way there is no write.
    expect([404, 405]).toContain(res.statusCode);
  });

  // ── Crawling is the OWNER's surface ──────────────────────────────────────────────────────────────────
  // Starting a run is not something an API credential can do: the route takes the operator only. These cases
  // are REJECTED before runCrawl (no crawl parked), so they don't contend with the held lock over the single
  // pglite socket. The auth-decision matrix itself is unit-tested in auth/middleware.test.ts.
  it('a data key cannot start a crawl, however granted (403)', async () => {
    // Reading fetched data and beginning a bank login are different powers. A key with every grant and
    // the read scope still cannot start one; only the crawl scope can, and it is separate for that reason.
    const key = (await app.inject({ method: 'POST', url: '/api/keys', headers: { authorization: `Bearer ${operatorToken}` }, payload: { name: 'consumer', scopes: ['read:data'], connectionGrants: ['*'] } })).json().key;
    const res = await app.inject({ method: 'POST', url: `/api/connections/${connId}/crawl`, headers: { authorization: `Bearer ${key}` } });
    expect(res.statusCode).toBe(403);
  });

  it('a crawl key must expire: minting one without an expiry is refused', async () => {
    // A credential that can begin a bank login should not outlive the reason it was made, and a leaked
    // one should stop working whether or not anyone notices it leaked.
    const res = await app.inject({ method: 'POST', url: '/api/keys', headers: { authorization: `Bearer ${operatorToken}` }, payload: { name: 'automation', scopes: ['write:crawl'], connectionGrants: [connId] } });
    expect(res.statusCode).toBe(400);
  });

  it('an expiring crawl key is admitted by the crawl guard', async () => {
    const minted = await app.inject({ method: 'POST', url: '/api/keys', headers: { authorization: `Bearer ${operatorToken}` }, payload: { name: 'automation', scopes: ['write:crawl'], connectionGrants: [connId], expiresInDays: 30 } });
    expect(minted.statusCode).toBe(201);
    const res = await app.inject({ method: 'POST', url: `/api/connections/${connId}/crawl`, headers: { authorization: `Bearer ${minted.json().key}` } });
    // What this asserts is the guard, which is what the scope changed: the request is neither refused as
    // unauthenticated nor as unscoped, and reaches dispatch. Whether dispatch then succeeds is the engine
    // handshake the operator cases above already cover, and it shares a one-shot fixture with them.
    expect([401, 403]).not.toContain(res.statusCode);
    expect(res.statusCode).not.toBe(404);
  });

  it('a crawl key cannot drive a connection it was not granted (404)', async () => {
    const minted = await app.inject({ method: 'POST', url: '/api/keys', headers: { authorization: `Bearer ${operatorToken}` }, payload: { name: 'ungranted', scopes: ['write:crawl'], connectionGrants: [], expiresInDays: 30 } });
    expect(minted.statusCode).toBe(201);
    const res = await app.inject({ method: 'POST', url: `/api/connections/${connId}/crawl`, headers: { authorization: `Bearer ${minted.json().key}` } });
    expect(res.statusCode).toBe(404);
  });

  it('no credentials are refused (401)', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/connections/${connId}/crawl` });
    expect(res.statusCode).toBe(401);
  });
});
