/**
 * Console-monitoring routes: the step timeline, step screenshots (incl. path-safety), and a connection's
 * session history. Real server + real postgres.js over a pglite socket (the auth.test.ts harness).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import type { FastifyInstance } from 'fastify';

const PORT = 54343; // unique per socket-using test file (54330 integration, 54331 engine-grants, 54332 auth, 54341 data)
const KEY = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const CONNECTION_ID = '22222222-2222-4222-8222-222222222222';

describe('session steps + screenshots + connection history (real server + pglite)', () => {
  let client: PGlite;
  let server: PGLiteSocketServer;
  let app: FastifyInstance;
  let closeDb: (() => Promise<void>) | undefined;
  let shotDir: string | undefined;
  let auth: { authorization: string };

  beforeAll(async () => {
    client = new PGlite();
    const dir = path.resolve(__dirname, '../../migrations');
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
      await client.exec(fs.readFileSync(path.join(dir, f), 'utf8'));
    }
    server = new PGLiteSocketServer({ db: client, port: PORT });
    await server.start();

    shotDir = fs.mkdtempSync(path.join(os.tmpdir(), 'accrawl-shots-'));
    process.env.DATABASE_URL = `postgres://localhost:${PORT}/postgres`;
    process.env.CREDENTIAL_ENC_KEY = KEY;
    process.env.SETUP_CLAIM_TOKEN = 'test-setup-code';
    process.env.SCREENSHOT_DIR = shotDir;

    const { sql } = await import('../db/client');
    closeDb = () => sql.end({ timeout: 5 });
    const { buildServer } = await import('../index');
    app = await buildServer();
    await app.ready();

    await app.inject({ method: 'POST', url: '/api/setup', payload: { password: 'operator-pw', setupCode: 'test-setup-code' } });
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'operator-pw', setupCode: 'test-setup-code' } });
    auth = { authorization: `Bearer ${login.json().token}` };

    // Seed an institution → connection → session → two steps (one with a screenshot on disk) directly.
    await client.exec(`
      insert into institutions (id, name, login_url, canonical_domain, type)
        values ('demo', 'Demo Bank', 'https://login.demo.test/', 'demo.test', 'bank');
      insert into connections (id, institution_id, username_ct, password_ct)
        values ('${CONNECTION_ID}', 'demo', 'ct', 'ct');
      insert into sessions (id, connection_id, status, step_count, current_step)
        values ('${SESSION_ID}', '${CONNECTION_ID}', 'extracting', 2, 'Reading accounts');
      insert into session_steps (session_id, step_number, screenshot_ref, log) values
        ('${SESSION_ID}', 1, 'sessions/${SESSION_ID}/step-001.jpg',
         '{"stepNumber":1,"action":"click","description":"Sign in","url":"https://login.demo.test/","durationMs":900,"accountsExtracted":0,"transactionsExtracted":0,"positionsExtracted":0,"timestamp":"2026-01-01T00:00:00Z"}'),
        ('${SESSION_ID}', 2, null,
         '{"stepNumber":2,"action":"extract","description":"Read accounts","url":"https://demo.test/accounts","durationMs":1200,"accountsExtracted":3,"transactionsExtracted":12,"positionsExtracted":0,"timestamp":"2026-01-01T00:00:05Z"}');
    `);
    const refDir = path.join(shotDir, 'sessions', SESSION_ID);
    fs.mkdirSync(refDir, { recursive: true });
    fs.writeFileSync(path.join(refDir, 'step-001.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x01])); // JPEG magic
  });

  afterAll(async () => {
    await app?.close();
    await closeDb?.();
    await server?.stop();
    await client?.close();
    if (shotDir) fs.rmSync(shotDir, { recursive: true, force: true });
    delete process.env.DATABASE_URL;
    delete process.env.CREDENTIAL_ENC_KEY;
    delete process.env.SCREENSHOT_DIR;
  });

  it('GET /api/sessions/:id returns heartbeatAt (stall detection) alongside timing fields', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/sessions/${SESSION_ID}`, headers: auth });
    expect(res.statusCode).toBe(200);
    const v = res.json();
    expect(v).toHaveProperty('heartbeatAt');
    expect(v).toHaveProperty('startedAt');
    expect(v.status).toBe('extracting');
  });

  it('GET /api/sessions/:id/steps returns the summarized timeline with hasScreenshot flags', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/sessions/${SESSION_ID}/steps`, headers: auth });
    expect(res.statusCode).toBe(200);
    const { steps } = res.json();
    expect(steps).toHaveLength(2);
    expect(steps[0]).toMatchObject({ stepNumber: 1, action: 'click', description: 'Sign in', hasScreenshot: true });
    expect(steps[1]).toMatchObject({ stepNumber: 2, action: 'extract', accountsExtracted: 3, transactionsExtracted: 12, hasScreenshot: false });
    // auth is enforced
    expect((await app.inject({ method: 'GET', url: `/api/sessions/${SESSION_ID}/steps` })).statusCode).toBe(401);
  });

  it('serves the step screenshot as image/jpeg, and 404s a step without one', async () => {
    const ok = await app.inject({ method: 'GET', url: `/api/sessions/${SESSION_ID}/steps/1/screenshot`, headers: auth });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['content-type']).toBe('image/jpeg');
    expect(ok.rawPayload[0]).toBe(0xff); // JPEG magic byte round-trips
    expect((await app.inject({ method: 'GET', url: `/api/sessions/${SESSION_ID}/steps/2/screenshot`, headers: auth })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/api/sessions/${SESSION_ID}/steps/abc/screenshot`, headers: auth })).statusCode).toBe(400);
  });

  it('never serves a file outside SCREENSHOT_DIR (traversal / absolute refs are rejected)', async () => {
    if (!shotDir) throw new Error('screenshot test directory was not initialized');
    // Plant a secret OUTSIDE the screenshots dir and point refs at it via traversal + absolute paths.
    const outside = path.join(shotDir, '..', `accrawl-secret-${process.pid}.txt`);
    fs.writeFileSync(outside, 'top-secret');
    try {
      for (const [step, ref] of [[3, `sessions/${SESSION_ID}/../../../${path.basename(outside)}`], [4, outside]] as const) {
        await client.exec(`insert into session_steps (session_id, step_number, screenshot_ref, log)
          values ('${SESSION_ID}', ${step}, '${ref}', '{"stepNumber":${step},"action":"x","url":"u","durationMs":1,"accountsExtracted":0,"transactionsExtracted":0,"positionsExtracted":0,"timestamp":"2026-01-01T00:00:00Z"}')`);
        const res = await app.inject({ method: 'GET', url: `/api/sessions/${SESSION_ID}/steps/${step}/screenshot`, headers: auth });
        expect(res.statusCode).toBe(404);
        expect(res.payload).not.toContain('top-secret');
      }
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });

  it('GET /api/connections/:id/sessions lists the run history newest-first', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/connections/${CONNECTION_ID}/sessions`, headers: auth });
    expect(res.statusCode).toBe(200);
    const { sessions } = res.json();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ id: SESSION_ID, status: 'extracting', stepCount: 2 });
    expect(sessions[0]).toHaveProperty('startedAt');
    expect((await app.inject({ method: 'GET', url: `/api/connections/${CONNECTION_ID}/sessions` })).statusCode).toBe(401);
  });

  it('GET /api/sessions (history) labels runs with institution + carries the cost the engine persisted', async () => {
    await client.exec(`update sessions set
      cost = '{"modelId":"gemini-2.5-flash","inputTokens":120000,"outputTokens":8000,"cacheCreationInputTokens":0,"cacheReadInputTokens":40000,"inputCostUsd":0.03,"outputCostUsd":0.02,"cacheCreationCostUsd":0,"cacheReadCostUsd":0.001,"totalCostUsd":0.051}'
      where id = '${SESSION_ID}'`);
    const res = await app.inject({ method: 'GET', url: '/api/sessions', headers: auth });
    expect(res.statusCode).toBe(200);
    const { sessions } = res.json();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ id: SESSION_ID, institutionName: 'Demo Bank' });
    expect(sessions[0].cost).toMatchObject({ modelId: 'gemini-2.5-flash', totalCostUsd: 0.051 });
    expect((await app.inject({ method: 'GET', url: '/api/sessions' })).statusCode).toBe(401);
  });

  it('GET /api/sessions/:id/records returns what THIS run extracted, grouped and counted', async () => {
    await client.exec(`insert into staged_records (session_id, kind, data) values
      ('${SESSION_ID}', 'account', '{"providerAccountId":"acc-1","name":"Everyday","description":"","currency":"GBP","type":"current","balance":1234.56}'),
      ('${SESSION_ID}', 'transaction', '{"providerAccountId":"acc-1","providerTransactionId":"t1","bookingDate":"2026-06-30","amount":-12.5,"currency":"GBP","description":"Coffee","isPending":false}'),
      ('${SESSION_ID}', 'transaction', '{"providerTransactionId":"t2","bookingDate":"2026-06-29","amount":-9,"currency":"GBP","description":"Lunch","isPending":false}')`);
    const res = await app.inject({ method: 'GET', url: `/api/sessions/${SESSION_ID}/records`, headers: auth });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.counts).toEqual({ accounts: 1, transactions: 2, positions: 0 });
    expect(body.accounts[0]).toMatchObject({ name: 'Everyday', balance: 1234.56 });
  });

  it('Accounts page: lists labeled accounts; per-account transactions join on exact providerAccountId; unattributed stay separate', async () => {
    const acctId = 'acct-row-1';
    await client.exec(`
      insert into accounts (id, connection_id, data) values
        ('${acctId}', '${CONNECTION_ID}', '{"providerAccountId":"acc-1","name":"Everyday","description":"","currency":"GBP","type":"current","balance":1234.56}');
      insert into transactions (id, connection_id, data) values
        ('tx-1', '${CONNECTION_ID}', '{"providerAccountId":"acc-1","providerTransactionId":"t1","bookingDate":"2026-06-30","amount":-12.5,"currency":"GBP","description":"Coffee","isPending":false}'),
        ('tx-2', '${CONNECTION_ID}', '{"providerAccountId":"acc-OTHER","providerTransactionId":"t3","bookingDate":"2026-06-28","amount":-5,"currency":"GBP","description":"Other acct","isPending":false}'),
        ('tx-3', '${CONNECTION_ID}', '{"providerTransactionId":"t2","bookingDate":"2026-06-29","amount":-9,"currency":"GBP","description":"Unassigned lunch","isPending":false}');
    `);
    const list = await app.inject({ method: 'GET', url: '/api/accounts', headers: auth });
    expect(list.statusCode).toBe(200);
    expect(list.json().accounts[0]).toMatchObject({ id: acctId, institutionName: 'Demo Bank' });
    expect(list.json().accounts[0].data).toMatchObject({ name: 'Everyday', balance: 1234.56 });

    // Exact-match join: acc-1's transactions ONLY (not acc-OTHER's, not the unassigned one).
    const txs = await app.inject({ method: 'GET', url: `/api/accounts/${acctId}/transactions`, headers: auth });
    expect(txs.statusCode).toBe(200);
    expect(txs.json().items).toHaveLength(1);
    expect(txs.json().items[0].data.description).toBe('Coffee');

    // The "not linked to an account" bucket is the exact COMPLEMENT of the per-account view: it holds
    // EVERY transaction that matches no account of the connection — both the one with no providerAccountId
    // ("Unassigned lunch") AND the one tagged 'acc-OTHER' which no account row has ("Other acct"). The
    // latter is the real-world crawler bug (transaction tagged with the account NAME while the account was
    // stored under its NUMBER): it must surface here, never vanish into neither view.
    const un = await app.inject({ method: 'GET', url: `/api/connections/${CONNECTION_ID}/unassigned-transactions`, headers: auth });
    expect(un.statusCode).toBe(200);
    const unDescs = un.json().items.map((i: { data: { description: string } }) => i.data.description).sort();
    expect(unDescs).toEqual(['Other acct', 'Unassigned lunch']);

    // The operator can now read the v1 data routes too (the console's holdings source).
    expect((await app.inject({ method: 'GET', url: `/api/v1/connections/${CONNECTION_ID}/holdings`, headers: auth })).statusCode).toBe(200);
    // …and all of it stays auth-gated.
    expect((await app.inject({ method: 'GET', url: '/api/accounts' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: `/api/accounts/${acctId}/transactions` })).statusCode).toBe(401);
  });
});
