import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../db/client';
import type { EmailOtpConfigWithPassword } from '../data/email-otp-config';
import { startEmailOtpWatcher } from './watcher';

const enabledConfig: EmailOtpConfigWithPassword = {
  host: 'imap.example.com',
  port: 993,
  secure: true,
  username: 'operator@example.com',
  password: 'secret',
  folder: 'INBOX',
  enabled: true,
  updatedAt: new Date(),
};

afterEach(() => {
  vi.useRealTimers();
});

describe('email OTP watcher lifecycle', () => {
  it('observes a config enabled after startup without restarting the process', async () => {
    vi.useFakeTimers();
    const getConfig = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValue(enabledConfig);
    const poll = vi.fn().mockResolvedValue({ processed: 0, submitted: 0, skipped: 0 });
    const watcher = await startEmailOtpWatcher({} as Db, {
      pollMs: 100,
      log: vi.fn(),
      getConfig,
      poll,
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(poll).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(poll).toHaveBeenCalledOnce();
    await watcher.stop();
  });

  it('polls only while it owns the HA lease and releases it on shutdown', async () => {
    vi.useFakeTimers();
    const poll = vi.fn().mockResolvedValue({ processed: 0, submitted: 0, skipped: 0 });
    const release = vi.fn().mockResolvedValue(undefined);
    const tryAcquireLease = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValue({
        isHeld: vi.fn().mockResolvedValue(true),
        release,
      });
    const watcher = await startEmailOtpWatcher({} as Db, {
      pollMs: 100,
      log: vi.fn(),
      getConfig: vi.fn().mockResolvedValue(enabledConfig),
      poll,
      tryAcquireLease,
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(poll).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(poll).toHaveBeenCalledOnce();
    await watcher.stop();
    expect(release).toHaveBeenCalledOnce();
  });
});
