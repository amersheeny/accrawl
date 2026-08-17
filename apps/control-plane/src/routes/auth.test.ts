import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import type { FastifyInstance } from 'fastify';

// Operator auth is DB-backed (the admin credential lives in operator_credential, set by first-run setup),
// so these route tests run the real server over a pglite socket — the same harness as the integration test.
const PORT = 54332; // unique per socket-using test file (54330 integration, 54331 engine-grants)
const KEY = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';

describe('auth + setup routes (real server + pglite)', () => {
  let client: PGlite;
  let server: PGLiteSocketServer;
  let app: FastifyInstance;
  let closeDb: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    client = new PGlite();
    const dir = path.resolve(__dirname, '../../migrations');
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
      await client.exec(fs.readFileSync(path.join(dir, f), 'utf8'));
    }
    server = new PGLiteSocketServer({ db: client, port: PORT });
    await server.start();

    process.env.DATABASE_URL = `postgres://localhost:${PORT}/postgres`;
    process.env.CREDENTIAL_ENC_KEY = KEY;
    process.env.SETUP_CLAIM_TOKEN = 'test-setup-code';

    const { sql } = await import('../db/client');
    closeDb = () => sql.end({ timeout: 5 });
    const { buildServer } = await import('../index');
    app = await buildServer();
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await closeDb?.();
    await server?.stop();
    await client?.close();
    delete process.env.DATABASE_URL;
    delete process.env.CREDENTIAL_ENC_KEY;
  });

  it('first run: reports uninitialized, then setup creates the operator and returns a session token', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/setup/status' })).json().initialized).toBe(false);
    const setup = await app.inject({ method: 'POST', url: '/api/setup', payload: { password: 'hunter2-pw', setupCode: 'test-setup-code' } });
    expect(setup.statusCode).toBe(201);
    expect(setup.json().token).toMatch(/^accs1\./);
    expect((await app.inject({ method: 'GET', url: '/api/setup/status' })).json().initialized).toBe(true);
  });

  it('setup is one-shot — a second setup is 409 (does not overwrite the credential)', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/setup', payload: { password: 'a-different-password', setupCode: 'test-setup-code' } });
    expect(res.statusCode).toBe(409);
  });

  it('setup rejects a too-short password (400, schema-validated before any write)', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/setup', payload: { password: 'short', setupCode: 'test-setup-code' } });
    expect(res.statusCode).toBe(400);
  });

  it('revoking all sessions ends a token that was already issued', async () => {
    // The whole point: operator tokens are stateless and live seven days, so a token copied out of the
    // browser cannot be ended by deleting anything. Prove a previously-valid token stops working.
    const token = (await app.inject({
      method: 'POST', url: '/api/auth/login', payload: { password: 'hunter2-pw', setupCode: 'test-setup-code' },
    })).json().token;
    const authed = { authorization: `Bearer ${token}` };
    expect((await app.inject({ method: 'GET', url: '/api/keys', headers: authed })).statusCode).toBe(200);

    const revoked = await app.inject({
      method: 'POST', url: '/api/auth/revoke-all', payload: { password: 'hunter2-pw' },
    });
    expect(revoked.statusCode).toBe(204);

    expect((await app.inject({ method: 'GET', url: '/api/keys', headers: authed })).statusCode).toBe(401);
  });

  it('revoking requires the password, so a stolen token cannot lock the operator out', async () => {
    const token = (await app.inject({
      method: 'POST', url: '/api/auth/login', payload: { password: 'hunter2-pw', setupCode: 'test-setup-code' },
    })).json().token;
    const res = await app.inject({
      method: 'POST', url: '/api/auth/revoke-all',
      headers: { authorization: `Bearer ${token}` },
      payload: { password: 'wrong-password' },
    });
    expect(res.statusCode).toBe(401);
    // The bearer token alone did not authorise it, so the session it belongs to still works.
    expect((await app.inject({
      method: 'GET', url: '/api/keys', headers: { authorization: `Bearer ${token}` },
    })).statusCode).toBe(200);
  });

  it('revoking without a password is rejected before any rotation', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/auth/revoke-all', payload: {} })).statusCode).toBe(400);
  });

  it('a token minted after revocation works', async () => {
    await app.inject({ method: 'POST', url: '/api/auth/revoke-all', payload: { password: 'hunter2-pw' } });
    const fresh = (await app.inject({
      method: 'POST', url: '/api/auth/login', payload: { password: 'hunter2-pw', setupCode: 'test-setup-code' },
    })).json().token;
    expect((await app.inject({
      method: 'GET', url: '/api/keys', headers: { authorization: `Bearer ${fresh}` },
    })).statusCode).toBe(200);
  });

  it('logs in with the correct password and returns a token', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'hunter2-pw', setupCode: 'test-setup-code' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().token).toMatch(/^accs1\./);
  });

  it('rejects a wrong password with 401', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'wrong-password', setupCode: 'test-setup-code' } });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a missing password with 400', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: {} });
    expect(res.statusCode).toBe(400);
  });

  it('a real login token authenticates /api/keys; no token and a forged token are 401', async () => {
    const { token } = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'hunter2-pw', setupCode: 'test-setup-code' } })).json();
    expect((await app.inject({ method: 'GET', url: '/api/keys', headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/keys' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/keys', headers: { authorization: 'Bearer accs1.forged.signature' } })).statusCode).toBe(401);
  });

  it('rate-limits /api/auth/login to defeat brute force (429 after the strict limit)', async () => {
    const limited = await (await import('../index')).buildServer({ rateLimit: true });
    await limited.ready();
    try {
      let got429 = false;
      for (let i = 0; i < 8; i++) {
        const r = await limited.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'wrong-password', setupCode: 'test-setup-code' } });
        if (r.statusCode === 429) { got429 = true; break; }
      }
      expect(got429).toBe(true);
    } finally {
      await limited.close();
    }
  });
});
