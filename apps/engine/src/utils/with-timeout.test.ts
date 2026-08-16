import { describe, it, expect, vi, afterEach } from 'vitest';
import { withTimeout } from './with-timeout';

afterEach(() => {
  vi.useRealTimers();
});

describe('withTimeout', () => {
  it('rejects with a labeled error after ms when the inner promise never resolves', async () => {
    vi.useFakeTimers();
    const never = new Promise<string>(() => {});
    const raced = withTimeout(never, 1000, 'stuck-op');
    const assertion = expect(raced).rejects.toThrow('Operation "stuck-op" timed out after 1000ms');
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
  });

  it('passes through a fast-resolving result without waiting for the timeout', async () => {
    const result = await withTimeout(Promise.resolve('done'), 5000, 'fast');
    expect(result).toBe('done');
  });

  it('passes through an inner rejection unchanged (does not mask it as a timeout)', async () => {
    const inner = Promise.reject(new Error('inner boom'));
    await expect(withTimeout(inner, 5000, 'rejecting')).rejects.toThrow('inner boom');
  });

  it('clears the timeout so it does not keep the event loop alive after success', async () => {
    vi.useFakeTimers();
    const clearSpy = vi.spyOn(global, 'clearTimeout');
    await withTimeout(Promise.resolve(42), 5000, 'cleared');
    expect(clearSpy).toHaveBeenCalled();
  });
});
