import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { internalEngineWakeRoutes } from './internal-engine-wake';

const SESSION_ID = '123e4567-e89b-42d3-a456-426614174000';

describe('internal engine Companion wake route', () => {
  const apps: Array<ReturnType<typeof Fastify>> = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  async function server(secret: string | undefined, wake = vi.fn(async () => undefined)) {
    const app = Fastify();
    apps.push(app);
    await app.register(internalEngineWakeRoutes, { secret, wake });
    return { app, wake };
  }

  it('accepts only the exact shared-secret bearer and wakes the named session', async () => {
    const { app, wake } = await server('internal-secret');
    const response = await app.inject({
      method: 'POST',
      url: '/internal/engine/companion/otp-wake',
      headers: { authorization: 'Bearer internal-secret' },
      payload: { sessionId: SESSION_ID },
    });

    expect(response.statusCode).toBe(204);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(wake).toHaveBeenCalledOnce();
    expect(wake).toHaveBeenCalledWith(SESSION_ID);
  });

  it.each([
    undefined,
    '',
    'Bearer',
    'Bearer wrong-secret',
    'Basic internal-secret',
    'Bearer internal-secret-extra',
  ])('rejects a missing or inexact bearer without waking (%s)', async (authorization) => {
    const { app, wake } = await server('internal-secret');
    const response = await app.inject({
      method: 'POST',
      url: '/internal/engine/companion/otp-wake',
      headers: authorization === undefined ? {} : { authorization },
      payload: { sessionId: SESSION_ID },
    });

    expect(response.statusCode).toBe(401);
    expect(wake).not.toHaveBeenCalled();
  });

  it('fails closed when the tenant has no engine secret', async () => {
    const { app, wake } = await server(undefined);
    const response = await app.inject({
      method: 'POST',
      url: '/internal/engine/companion/otp-wake',
      headers: { authorization: 'Bearer anything' },
      payload: { sessionId: SESSION_ID },
    });
    expect(response.statusCode).toBe(401);
    expect(wake).not.toHaveBeenCalled();
  });

  it('rejects anything except a strict UUID-only body', async () => {
    const { app, wake } = await server('internal-secret');
    for (const payload of [
      {},
      { sessionId: 'not-a-uuid' },
      { sessionId: SESSION_ID, institutionName: 'untrusted' },
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: '/internal/engine/companion/otp-wake',
        headers: { authorization: 'Bearer internal-secret' },
        payload,
      });
      expect(response.statusCode).toBe(400);
    }
    expect(wake).not.toHaveBeenCalled();
  });
});
