import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../index';

describe('institution routes — auth gate', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildServer();
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  it('requires operator auth on every route (401 without a token)', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/institutions' })).statusCode).toBe(401);
    expect((await app.inject({
      method: 'POST', url: '/api/institutions',
      payload: { id: 'x', name: 'X', loginUrl: 'https://x.com', type: 'bank' },
    })).statusCode).toBe(401);
    expect((await app.inject({ method: 'DELETE', url: '/api/institutions/x' })).statusCode).toBe(401);
    // The community-config gate routes are operator-only too (no api-key/device path can import or rescan a config).
    expect((await app.inject({
      method: 'POST', url: '/api/institutions/import',
      payload: { id: 'y', name: 'Y', loginUrl: 'https://y.com', type: 'bank' },
    })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/institutions/x/rescan' })).statusCode).toBe(401);
    expect((await app.inject({
      method: 'POST', url: '/api/institutions/draft',
      payload: { name: 'Z', loginUrl: 'https://z.com', type: 'bank' },
    })).statusCode).toBe(401);
  });
});
