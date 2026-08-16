/**
 * Tests for the OTP providers.
 *
 * The local adapter reads the code from an env var or a file, which is what a deployment running its own
 * engine uses. The relay coordination a remote worker uses is covered where that worker lives.
 */

import { describe, it, expect } from 'vitest';
import { createLocalPlatform } from '../platform/local';


// ---------------------------------------------------------------------------
// Local OTP adapter — code supplied via env var (no store, no relay).
// ---------------------------------------------------------------------------

describe('otp local adapter', () => {
  const otp = createLocalPlatform().otp;

  it('prepare() is a no-op that resolves', async () => {
    await expect(otp.prepare('sess-local', 1_000, 1_000, 50)).resolves.toBeUndefined();
  });

  it('returns the code supplied via the OTP_<sessionId> env var', async () => {
    process.env.OTP_sesslocal = '424242';
    try {
      const code = await otp.waitForOtp('sesslocal', 5_000, 20);
      expect(code).toBe('424242');
    } finally {
      delete process.env.OTP_sesslocal;
    }
  });

  it('throws OTP timeout when no code is supplied', async () => {
    await expect(otp.waitForOtp('sess-none', 150, 30)).rejects.toThrow('OTP timeout');
  });
});
