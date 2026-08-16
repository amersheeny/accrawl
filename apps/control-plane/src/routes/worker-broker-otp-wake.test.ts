import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkerBrokerStore } from '../orchestration/hosted-worker-plane';
import { workerBrokerRoutes } from './worker-broker';

const SESSION_ID = '123e4567-e89b-42d3-a456-426614174000';
const ATTEMPT_ID = '123e4567-e89b-42d3-a456-426614174001';
const SESSION_BEARER = Buffer.alloc(32, 7).toString('base64url');

describe('hosted worker OTP wake transition', () => {
  afterEach(() => vi.restoreAllMocks());

  async function server(wakeOtpCompanion: (sessionId: string) => Promise<unknown>) {
    const app = Fastify();
    const otpPrepare = vi.fn();
    await app.register(workerBrokerRoutes, {
      verifyWorker: async () => undefined,
      attestExecution: async () => { throw new Error('unused'); },
      deleteClaimSecret: async () => undefined,
      enqueueReconciliation: async () => undefined,
      wakeOtpCompanion,
      store: () => ({ otpPrepare } as unknown as WorkerBrokerStore),
    });
    return { app, otpPrepare };
  }

  const request = (app: Awaited<ReturnType<typeof server>>['app']) => app.inject({
    method: 'POST',
    url: '/internal/worker/otp/prepare',
    headers: {
      authorization: 'Bearer worker-identity',
      'x-accrawl-worker-session': SESSION_BEARER,
    },
    payload: {
      execution: 'crawl-worker',
      sessionId: SESSION_ID,
      attemptId: ATTEMPT_ID,
      mode: 'begin',
    },
  });

  it('sends one wake only for the committed false-to-true transition', async () => {
    const wake = vi.fn(async () => undefined);
    const { app, otpPrepare } = await server(wake);
    otpPrepare
      .mockResolvedValueOnce({ state: 'offline', transitioned: true })
      .mockResolvedValueOnce({ state: 'offline', transitioned: false });
    try {
      const first = await request(app);
      const duplicate = await request(app);
      expect(first.statusCode).toBe(200);
      expect(first.json()).toEqual({ state: 'offline' });
      expect(duplicate.statusCode).toBe(200);
      expect(duplicate.json()).toEqual({ state: 'offline' });
      expect(wake).toHaveBeenCalledOnce();
      expect(wake).toHaveBeenCalledWith(SESSION_ID);
    } finally {
      await app.close();
    }
  });

  it('keeps the OTP episode armed when wake delivery fails', async () => {
    const { app, otpPrepare } = await server(async () => {
      throw new Error('FCM unavailable');
    });
    otpPrepare.mockResolvedValue({ state: 'offline', transitioned: true });
    try {
      const response = await request(app);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ state: 'offline' });
    } finally {
      await app.close();
    }
  });
});
