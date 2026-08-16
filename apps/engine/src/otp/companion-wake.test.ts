import { afterEach, describe, expect, it, vi } from 'vitest';
import { notifyCompanionOtpWake } from './companion-wake';

const ENV_KEYS = [
  'CONTROL_PLANE_INTERNAL_ORIGIN',
  'ENGINE_SHARED_SECRET',
] as const;

describe('notifyCompanionOtpWake', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    for (const key of ENV_KEYS) delete process.env[key];
  });

  it('posts only the session id to the authenticated internal wake endpoint', async () => {
    process.env.CONTROL_PLANE_INTERNAL_ORIGIN = 'http://control-plane:3000/base/path';
    process.env.ENGINE_SHARED_SECRET = 'engine-secret';
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    const warn = vi.fn();

    await expect(notifyCompanionOtpWake(
      '11111111-1111-4111-8111-111111111111',
      { warn },
      { fetchImpl: fetchImpl as typeof fetch },
    )).resolves.toBe(true);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://control-plane:3000/internal/engine/companion/otp-wake',
      expect.objectContaining({
        method: 'POST',
        headers: {
          authorization: 'Bearer engine-secret',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ sessionId: '11111111-1111-4111-8111-111111111111' }),
      }),
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it('logs a sanitized failure and keeps the active OTP episode armed', async () => {
    process.env.CONTROL_PLANE_INTERNAL_ORIGIN = 'http://control-plane:3000';
    process.env.ENGINE_SHARED_SECRET = 'must-never-reach-logs';
    const fetchImpl = vi.fn().mockRejectedValue(
      new Error('Authorization: Bearer must-never-reach-logs'),
    );
    const warn = vi.fn();

    await expect(notifyCompanionOtpWake(
      '22222222-2222-4222-8222-222222222222',
      { warn },
      { fetchImpl: fetchImpl as typeof fetch },
    )).resolves.toBe(false);

    expect(warn).toHaveBeenCalledTimes(1);
    const logged = warn.mock.calls.flat().join(' ');
    expect(logged).toContain('Companion wake request failed');
    expect(logged).not.toContain('must-never-reach-logs');
    expect(logged).not.toContain('Authorization');
  });

  it('does not issue an unauthenticated request when configuration is incomplete', async () => {
    process.env.CONTROL_PLANE_INTERNAL_ORIGIN = 'http://control-plane:3000';
    const fetchImpl = vi.fn();
    const warn = vi.fn();

    await expect(notifyCompanionOtpWake(
      '33333333-3333-4333-8333-333333333333',
      { warn },
      { fetchImpl: fetchImpl as typeof fetch },
    )).resolves.toBe(false);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ENGINE_SHARED_SECRET'));
  });
});
