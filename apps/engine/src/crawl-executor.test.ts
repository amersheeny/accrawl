import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { CrawlRequest, CrawlResponse } from './types';

// ESM hoists imports above top-level statements, so the executor reads
// WATCHDOG_GRACE_MS at load with its default (30s). With fake timers the wall
// clock is irrelevant — we just advance past the full hard deadline
// (timeoutSeconds*1000 + default grace). HARD_DEADLINE_MS mirrors that math.
const DEFAULT_GRACE_MS = 30_000;
const HARD_DEADLINE_MS = 10 * 1000 + DEFAULT_GRACE_MS;

const mocks = vi.hoisted(() => ({
  runAgentLoop: vi.fn(),
  classifyCrawlFailure: vi.fn(() => 'internal_error' as const),
  createContext: vi.fn(),
  createPage: vi.fn(),
  completeSession: vi.fn().mockResolvedValue(undefined),
  assertSessionActive: vi.fn().mockResolvedValue(undefined),
  startHeartbeat: vi.fn(() => vi.fn()),
  flushSessionLogs: vi.fn().mockResolvedValue(undefined),
  contextClose: vi.fn().mockResolvedValue(undefined),
  pageClose: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./agent/agent-loop', () => ({
  runAgentLoop: mocks.runAgentLoop,
  classifyCrawlFailure: mocks.classifyCrawlFailure,
}));

vi.mock('./browser/browser-pool', () => ({
  createContext: mocks.createContext,
  createPage: mocks.createPage,
}));

vi.mock('./agent/session-updater', () => ({
  assertSessionActive: mocks.assertSessionActive,
  completeSession: mocks.completeSession,
  startHeartbeat: mocks.startHeartbeat,
  flushSessionLogs: mocks.flushSessionLogs,
}));

import {
  activeSessions,
  cancelExecution,
  CrawlCleanupError,
  executeCrawl,
  hasActiveExecution,
} from './crawl-executor';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, reject, resolve };
}

const baseRequest: CrawlRequest = {
  sessionId: 'watchdog-test',
  loginUrl: 'https://example.com/login',
  username: 'u',
  password: 'p',
  requires2fa: false,
  maxSteps: 50,
  timeoutSeconds: 10,
};

beforeEach(() => {
  mocks.runAgentLoop.mockReset();
  mocks.createContext.mockReset();
  mocks.createPage.mockReset();
  mocks.completeSession.mockClear();
  mocks.assertSessionActive.mockReset().mockResolvedValue(undefined);
  mocks.startHeartbeat.mockClear();
  mocks.contextClose.mockReset().mockResolvedValue(undefined);
  mocks.pageClose.mockReset().mockResolvedValue(undefined);
  activeSessions.clear();
  // `route` + `addInitScript` are stubbed so the §1 egress guard (request pin + WebRTC denial) installs
  // harmlessly on the fake context.
  const fakeContext = { close: mocks.contextClose, route: vi.fn(), addInitScript: vi.fn() };
  mocks.createContext.mockResolvedValue(fakeContext);
  mocks.createPage.mockResolvedValue({ close: mocks.pageClose });
});

afterEach(() => {
  vi.useRealTimers();
  activeSessions.clear();
});

describe('executeCrawl watchdog', () => {
  it('resolves with a timeout response and closes the context when the agent loop never resolves', async () => {
    vi.useFakeTimers();
    // Agent loop hangs forever — simulates a Playwright op stuck inside an iteration.
    mocks.runAgentLoop.mockReturnValue(new Promise<CrawlResponse>(() => {}));

    const resultPromise = executeCrawl(baseRequest);

    // Advance past the hard deadline so the watchdog fires.
    await vi.advanceTimersByTimeAsync(HARD_DEADLINE_MS);

    const result = await resultPromise;
    expect(result.success).toBe(false);
    expect(result.failureReason).toBe('crawl_watchdog');
    expect(result.error).toMatch(/exceeded hard deadline/i);
    // Context was closed (this rejects any in-flight Playwright op).
    expect(mocks.contextClose).toHaveBeenCalled();
  });

  it('returns no partial financial data when the hard deadline fires', async () => {
    vi.useFakeTimers();
    mocks.runAgentLoop.mockReturnValue(new Promise<CrawlResponse>(() => {}));

    const resultPromise = executeCrawl(baseRequest);
    await vi.advanceTimersByTimeAsync(HARD_DEADLINE_MS);
    const result = await resultPromise;

    expect(result.failureReason).toBe('crawl_watchdog');
    expect(result.accounts).toBeUndefined();
    expect(result.transactions).toBeUndefined();
    expect(result.positions).toBeUndefined();
    expect(result.stepsExecuted).toBe(0);
  });

  it('closes the context exactly once even though both watchdog and finally run', async () => {
    vi.useFakeTimers();
    mocks.runAgentLoop.mockReturnValue(new Promise<CrawlResponse>(() => {}));

    const resultPromise = executeCrawl(baseRequest);
    await vi.advanceTimersByTimeAsync(HARD_DEADLINE_MS);
    await resultPromise;

    expect(mocks.contextClose).toHaveBeenCalledTimes(1);
  });

  it('returns the agent loop result and does not fire the watchdog on a fast successful crawl', async () => {
    vi.useFakeTimers();
    mocks.runAgentLoop.mockResolvedValue({
      success: true,
      stepsExecuted: 3,
    });

    const resultPromise = executeCrawl(baseRequest);
    await vi.advanceTimersByTimeAsync(0);
    const result = await resultPromise;

    expect(result.success).toBe(true);
    expect(result.stepsExecuted).toBe(3);
    // Completed normally — context closed once in finally, never by the watchdog.
    expect(mocks.contextClose).toHaveBeenCalledTimes(1);
    expect(mocks.completeSession).toHaveBeenCalledWith(
      'watchdog-test',
      true,
      undefined,
      expect.objectContaining({ stepsExecuted: 3 }),
      expect.anything(),
    );
  });

  it('closes setup that finishes after cancellation and never starts the agent loop', async () => {
    const request = {
      ...baseRequest,
      sessionId: 'cancel-during-setup',
    };
    const creating = deferred<{
      close: typeof mocks.contextClose;
      route: ReturnType<typeof vi.fn>;
      addInitScript: ReturnType<typeof vi.fn>;
    }>();
    mocks.createContext.mockReturnValueOnce(creating.promise);
    const resultPromise = executeCrawl(request);
    await vi.waitFor(() => expect(mocks.createContext).toHaveBeenCalledOnce());
    expect(hasActiveExecution(request.sessionId)).toBe(true);

    const cancellation = cancelExecution(
      request.sessionId,
      'crawl cancelled by control plane',
    );
    creating.resolve({
      close: mocks.contextClose,
      route: vi.fn(),
      addInitScript: vi.fn(),
    });

    await expect(cancellation).resolves.toBe(true);
    await expect(resultPromise).resolves.toMatchObject({
      success: false,
      error: 'crawl cancelled by control plane',
    });
    expect(mocks.contextClose).toHaveBeenCalledOnce();
    expect(mocks.runAgentLoop).not.toHaveBeenCalled();
    expect(activeSessions.has(request.sessionId)).toBe(false);
    expect(hasActiveExecution(request.sessionId)).toBe(false);
  });

  it('fences cancellation before dispatch and never creates browser work for the late request', async () => {
    const request = {
      ...baseRequest,
      sessionId: 'cancel-before-dispatch',
    };

    await expect(cancelExecution(
      request.sessionId,
      'crawl cancelled by control plane',
    )).resolves.toBe(false);
    await expect(executeCrawl(request)).resolves.toEqual({
      success: false,
      error: 'crawl cancelled by control plane',
      failureReason: 'instance_died',
      stepsExecuted: 0,
    });

    expect(mocks.createContext).not.toHaveBeenCalled();
    expect(mocks.startHeartbeat).not.toHaveBeenCalled();
    expect(mocks.completeSession).not.toHaveBeenCalled();
  });

  it('creates no browser work when the durable session owner is already terminal', async () => {
    const request = {
      ...baseRequest,
      sessionId: 'durably-cancelled',
    };
    mocks.assertSessionActive.mockRejectedValueOnce(
      new Error('crawl session is no longer active'),
    );

    await expect(executeCrawl(request)).resolves.toMatchObject({
      success: false,
      error: 'crawl session is no longer active',
      stepsExecuted: 0,
    });
    expect(mocks.createContext).not.toHaveBeenCalled();
    expect(mocks.startHeartbeat).not.toHaveBeenCalled();
  });

  it('does not acknowledge cancellation when its positive browser cleanup fence fails', async () => {
    const request = {
      ...baseRequest,
      sessionId: 'cancel-cleanup-failed',
    };
    const creating = deferred<{
      close: typeof mocks.contextClose;
      route: ReturnType<typeof vi.fn>;
      addInitScript: ReturnType<typeof vi.fn>;
    }>();
    mocks.createContext.mockReturnValueOnce(creating.promise);
    mocks.contextClose.mockRejectedValue(new Error('context still active'));
    const resultPromise = executeCrawl(request);
    await vi.waitFor(() => expect(mocks.createContext).toHaveBeenCalledOnce());
    const cancellation = cancelExecution(
      request.sessionId,
      'crawl cancelled by control plane',
    );
    creating.resolve({
      close: mocks.contextClose,
      route: vi.fn(),
      addInitScript: vi.fn(),
    });

    await expect(resultPromise).rejects.toBeInstanceOf(CrawlCleanupError);
    await expect(cancellation).rejects.toBeInstanceOf(CrawlCleanupError);
    expect(activeSessions.has(request.sessionId)).toBe(true);
  });

  it('rejects a replacement execution while a cleanup-failed context remains live', async () => {
    const request = {
      ...baseRequest,
      sessionId: 'cleanup-failed-duplicate',
    };
    mocks.contextClose.mockRejectedValue(new Error('context still active'));
    mocks.runAgentLoop.mockResolvedValue({
      success: false,
      error: 'crawl failed',
      stepsExecuted: 2,
    });

    await expect(executeCrawl(request)).rejects.toBeInstanceOf(CrawlCleanupError);
    expect(activeSessions.has(request.sessionId)).toBe(true);
    mocks.createContext.mockClear();

    await expect(executeCrawl(request)).rejects.toThrow(
      `Crawl session ${request.sessionId} is already executing`,
    );
    expect(mocks.createContext).not.toHaveBeenCalled();
  });

  it('rejects a duplicate execution without attaching to its caller signal', async () => {
    const request = {
      ...baseRequest,
      sessionId: 'duplicate-execution',
    };
    const creating = deferred<{
      close: typeof mocks.contextClose;
      route: ReturnType<typeof vi.fn>;
      addInitScript: ReturnType<typeof vi.fn>;
    }>();
    mocks.createContext.mockReturnValueOnce(creating.promise);
    const firstResult = executeCrawl(request);
    const duplicateSignal = new AbortController();
    const addEventListener = vi.spyOn(duplicateSignal.signal, 'addEventListener');

    await expect(executeCrawl(request, undefined, {
      signal: duplicateSignal.signal,
    })).rejects.toThrow(`Crawl session ${request.sessionId} is already executing`);
    expect(addEventListener).not.toHaveBeenCalled();

    const cancellation = cancelExecution(
      request.sessionId,
      'crawl cancelled by control plane',
    );
    creating.resolve({
      close: mocks.contextClose,
      route: vi.fn(),
      addInitScript: vi.fn(),
    });
    await cancellation;
    await firstResult;
  });

  it('persists no terminal outcome until browser context teardown succeeds', async () => {
    const closing = deferred<void>();
    mocks.contextClose.mockReturnValue(closing.promise);
    mocks.runAgentLoop.mockResolvedValue({
      success: true,
      stepsExecuted: 3,
    });

    const resultPromise = executeCrawl(baseRequest);
    await vi.waitFor(() => expect(mocks.contextClose).toHaveBeenCalledOnce());
    expect(mocks.completeSession).not.toHaveBeenCalled();
    expect(activeSessions.has(baseRequest.sessionId)).toBe(true);

    closing.resolve();
    await expect(resultPromise).resolves.toMatchObject({ success: true });
    expect(mocks.completeSession).toHaveBeenCalledOnce();
    expect(activeSessions.has(baseRequest.sessionId)).toBe(false);
  });

  it('keeps the session active and refuses terminal persistence when context teardown fails', async () => {
    mocks.contextClose.mockRejectedValue(new Error('context still active'));
    mocks.runAgentLoop.mockResolvedValue({
      success: false,
      error: 'crawl failed',
      stepsExecuted: 2,
    });

    await expect(executeCrawl(baseRequest)).rejects.toBeInstanceOf(CrawlCleanupError);
    expect(mocks.completeSession).not.toHaveBeenCalled();
    expect(activeSessions.has(baseRequest.sessionId)).toBe(true);
  });

  it('holds terminal persistence until the caller transport fence succeeds', async () => {
    const transportFence = deferred<void>();
    const beforeSessionCompletion = vi.fn(() => transportFence.promise);
    mocks.runAgentLoop.mockResolvedValue({
      success: true,
      stepsExecuted: 4,
    });

    const resultPromise = executeCrawl(baseRequest, undefined, { beforeSessionCompletion });
    await vi.waitFor(() => expect(beforeSessionCompletion).toHaveBeenCalledOnce());

    expect(mocks.contextClose).toHaveBeenCalledOnce();
    expect(activeSessions.has(baseRequest.sessionId)).toBe(false);
    expect(mocks.completeSession).not.toHaveBeenCalled();

    transportFence.resolve();
    await expect(resultPromise).resolves.toMatchObject({ success: true, stepsExecuted: 4 });
    expect(mocks.completeSession).toHaveBeenCalledOnce();
  });

  it('refuses terminal persistence when the caller transport fence fails', async () => {
    mocks.runAgentLoop.mockResolvedValue({
      success: true,
      stepsExecuted: 4,
    });

    await expect(executeCrawl(baseRequest, undefined, {
      beforeSessionCompletion: async () => {
        throw new Error('SOCKS listener remained open');
      },
    })).rejects.toBeInstanceOf(CrawlCleanupError);

    expect(mocks.contextClose).toHaveBeenCalledOnce();
    expect(activeSessions.has(baseRequest.sessionId)).toBe(false);
    expect(mocks.completeSession).not.toHaveBeenCalled();
  });
});
