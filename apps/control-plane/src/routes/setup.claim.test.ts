/**
 * Claiming this deployment requires the code produced where it was installed.
 *
 * Setting the first password is one unauthenticated write, and until it happens the deployment belongs to
 * nobody. Whoever arrived first used to win it permanently, and the person who installed it was told it
 * was already set up. Every deployment with a domain is reachable while it waits, because obtaining a
 * certificate requires being reachable, so the window is not hypothetical.
 *
 * Location cannot stand in for the code: behind the bundled proxy every caller shares its address, so a
 * check on where a request came from reads the proxy and admits everyone.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';

const CODE = 'a3f8c1d0e9b2a3f8c1d0e9b2a3f8c1d0e9b2a3f8c1d0e9b2a3f8c1d0e9b2a3f8';

vi.mock('../db/client', () => ({ db: {} }));
vi.mock('../auth/operator', () => ({
  mintOperatorToken: async () => 'operator-token',
  clearOperatorAuthCache: () => {},
}));

const initialize = vi.fn(async () => {});
vi.mock('../data/operator-credential', () => ({
  isOperatorInitialized: async () => false,
  initializeOperator: (...args: unknown[]) => initialize(...(args as [])),
  OperatorAlreadyInitializedError: class extends Error {},
  OperatorSetupError: class extends Error {},
}));

vi.mock('../config', () => ({ config: { get setupClaimToken() { return process.env.SETUP_CLAIM_TOKEN; } } }));

async function server() {
  const { setupRoutes } = await import('./setup');
  const app = Fastify();
  await app.register(setupRoutes);
  return app;
}

describe('claiming a deployment that has no operator yet', () => {
  beforeEach(() => {
    initialize.mockClear();
    process.env.SETUP_CLAIM_TOKEN = CODE;
  });
  afterEach(() => {
    delete process.env.SETUP_CLAIM_TOKEN;
    vi.resetModules();
  });

  it('refuses a password offered without the code', async () => {
    const app = await server();
    const response = await app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: { password: 'a-strangers-password' },
    });
    expect(response.statusCode).toBe(403);
    // The credential is never written, so the person who installed this can still claim it.
    expect(initialize).not.toHaveBeenCalled();
    await app.close();
  });

  it('refuses a password offered with the wrong code', async () => {
    const app = await server();
    const response = await app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: { password: 'a-strangers-password', setupCode: CODE.replace(/8$/u, '9') },
    });
    expect(response.statusCode).toBe(403);
    expect(initialize).not.toHaveBeenCalled();
    await app.close();
  });

  it('accepts the password offered with the code', async () => {
    const app = await server();
    const response = await app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: { password: 'the-owners-password', setupCode: CODE },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toHaveProperty('token');
    expect(initialize).toHaveBeenCalledOnce();
    await app.close();
  });

  it('cannot be claimed at all when no code was configured', async () => {
    // A deployment nobody can claim is recoverable by whoever runs it. One a stranger has claimed is not.
    delete process.env.SETUP_CLAIM_TOKEN;
    const app = await server();
    const response = await app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: { password: 'anyones-password', setupCode: CODE },
    });
    expect(response.statusCode).toBe(403);
    expect(initialize).not.toHaveBeenCalled();
    await app.close();
  });
});
