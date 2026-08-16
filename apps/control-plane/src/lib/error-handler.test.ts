import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { apiErrorHandler } from './error-handler';

describe('apiErrorHandler', () => {
  it('a 5xx never leaks the internal error message (generic body only)', async () => {
    const app = Fastify({ logger: false });
    app.setErrorHandler(apiErrorHandler);
    app.get('/boom', async () => { throw new Error('column "password_ct" of relation ... / read ECONNRESET'); });
    const res = await app.inject({ method: 'GET', url: '/boom' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'internal error' });
    expect(res.body).not.toContain('password_ct');
    expect(res.body).not.toContain('ECONNRESET');
    await app.close();
  });

  it('a 4xx keeps its (safe) message in the default Fastify shape', async () => {
    const app = Fastify({ logger: false });
    app.setErrorHandler(apiErrorHandler);
    app.get('/bad', async () => {
      const e = new Error('name is required') as Error & { statusCode?: number };
      e.statusCode = 400;
      throw e;
    });
    const res = await app.inject({ method: 'GET', url: '/bad' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ statusCode: 400, error: 'Bad Request', message: 'name is required' });
    await app.close();
  });
});
