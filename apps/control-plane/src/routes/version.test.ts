import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';

// The /version route is DB-free, so this builds the real server (proving the route is wired into
// buildServer) without a Postgres socket. ACCRAWL_VERSION is set BEFORE the dynamic import so config reads
// it at import time (vitest isolates module state per file, so this can't leak into other suites).
const BAKED = 'test-sha-abc123';

describe('GET /version', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    process.env.ACCRAWL_VERSION = BAKED;
    const { buildServer } = await import('../index');
    app = await buildServer({ rateLimit: false });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    delete process.env.ACCRAWL_VERSION;
  });

  it('returns the baked build version, unauthenticated', async () => {
    const res = await app.inject({ method: 'GET', url: '/version' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ version: BAKED });
  });

  it('needs no operator token (it reveals only the SHA)', async () => {
    // Same as an authenticated call — no 401. This is what `./accrawl status` relies on.
    const res = await app.inject({ method: 'GET', url: '/version', headers: { authorization: 'Bearer nonsense' } });
    expect(res.statusCode).toBe(200);
  });
});
