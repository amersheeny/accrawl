import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import type { FastifyInstance } from 'fastify';

const PORT = 54335; // unique per socket-using test file (54330 integration, 54331 engine-grants, 54332 auth, 54333 crawl, 54334 sessions)
const KEY = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';

describe('webhook routes (real server + pglite)', () => {
  let client: PGlite;
  let server: PGLiteSocketServer;
  let app: FastifyInstance;
  let closeDb: (() => Promise<void>) | undefined;
  let token: string;

  const auth = () => ({ authorization: `Bearer ${token}` });

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
    token = (await app.inject({ method: 'POST', url: '/api/setup', payload: { password: 'operator-pw-123', setupCode: 'test-setup-code' } })).json().token;
  });

  afterAll(async () => {
    await app?.close();
    await closeDb?.();
    await server?.stop();
    await client?.close();
    delete process.env.DATABASE_URL;
    delete process.env.CREDENTIAL_ENC_KEY;
  });

  it('requires operator auth', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/webhooks' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/webhooks', payload: { url: 'https://x.example/h', events: ['crawl.completed'] } })).statusCode).toBe(401);
  });

  it('creates a webhook, returns the secret ONCE, and never leaks it on list', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/webhooks', headers: auth(), payload: { url: 'https://consumer.example/hook', events: ['crawl.completed', 'crawl.failed'] } });
    expect(created.statusCode).toBe(201);
    const body = created.json();
    expect(body.secret).toMatch(/^whsec_/);
    expect(body.url).toBe('https://consumer.example/hook');
    expect(body.events).toEqual(['crawl.completed', 'crawl.failed']);

    const list = await app.inject({ method: 'GET', url: '/api/webhooks', headers: auth() });
    expect(list.statusCode).toBe(200);
    const rows = list.json().webhooks;
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(body.id);
    expect(rows[0].secret).toBeUndefined(); // NEVER returned on list
  });

  it('rejects a non-https (non-localhost) url', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/webhooks', headers: auth(), payload: { url: 'http://evil.example/h', events: ['crawl.completed'] } });
    expect(res.statusCode).toBe(400);
  });

  it('allows http://localhost for a co-located receiver', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/webhooks', headers: auth(), payload: { url: 'http://localhost:9000/h', events: ['crawl.completed'] } });
    expect(res.statusCode).toBe(201);
  });

  it('rejects empty events and unknown events', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/webhooks', headers: auth(), payload: { url: 'https://x.example/h', events: [] } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/webhooks', headers: auth(), payload: { url: 'https://x.example/h', events: ['crawl.exploded'] } })).statusCode).toBe(400);
  });

  it('deletes a webhook (404 on unknown)', async () => {
    const created = (await app.inject({ method: 'POST', url: '/api/webhooks', headers: auth(), payload: { url: 'https://del.example/h', events: ['crawl.failed'] } })).json();
    expect((await app.inject({ method: 'DELETE', url: `/api/webhooks/${created.id}`, headers: auth() })).statusCode).toBe(204);
    expect((await app.inject({ method: 'DELETE', url: `/api/webhooks/${created.id}`, headers: auth() })).statusCode).toBe(404);
  });
});
