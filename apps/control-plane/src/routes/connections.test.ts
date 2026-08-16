import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../index';

describe('connection routes — auth gate', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildServer();
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  it('requires operator auth on every route (401 without a token)', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/connections' })).statusCode).toBe(401);
    expect((await app.inject({
      method: 'POST', url: '/api/connections',
      payload: { institutionId: 'x', username: 'u', password: 'p' },
    })).statusCode).toBe(401);
    expect((await app.inject({
      method: 'POST', url: '/api/connections/abc/verify-domain', payload: { canonicalDomain: 'x.com' },
    })).statusCode).toBe(401);
  });
});
