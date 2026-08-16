/**
 * Crawl Executor
 *
 * Shared crawl execution logic used by both:
 * - /crawl HTTP handler (non-proxy crawls, called by the control-plane)
 * - /tunnel WebSocket handler (proxy crawls, triggered by APK connection)
 *
 * Owns browser lifecycle, agent loop execution, session completion,
 * and registration in the activeSessions map for cancel support.
 */

import type { BrowserContext } from 'playwright';
import { createContext, createPage } from './browser/browser-pool';
import { installEgressGuard } from './browser/egress-guard';
import { WriteGate } from './browser/write-gate';
import { createRequestVet } from './ai/request-vet';
import { runAgentLoop, classifyCrawlFailure } from './agent/agent-loop';
import {
  assertSessionActive, completeSession, startHeartbeat,
} from './agent/session-updater';
import { createSessionLogger } from './utils/logger';
import { flushSessionLogs } from './agent/session-updater';
import type { CrawlRequest, CrawlResponse } from './types';

export interface CrawlExecutionOptions {
  /**
   * An execution fence that must be positive before the durable session is
   * terminalized. Device-proxy crawls use this to close the SOCKS/WebSocket
   * tunnel after browser teardown but before releasing the connection lock.
   */
  beforeSessionCompletion?: () => Promise<void>;
  /** Cancellation fence for work that has been claimed but has not registered
   * its browser context yet. Once aborted, no setup await may publish a page or
   * begin the agent loop. */
  signal?: AbortSignal;
}

/** Active crawl sessions — maps sessionId → browser context for force-kill */
export const activeSessions = new Map<string, BrowserContext>();

interface ActiveExecution {
  controller: AbortController;
  done: Promise<
    | { succeeded: true }
    | { succeeded: false; error: unknown }
  >;
}

const activeExecutions = new Map<string, ActiveExecution>();
/**
 * Permanent, process-local cancellation tombstones. Session ids are one-shot:
 * once ownership has been revoked, a delayed or retried dispatch for that id
 * must never recreate browser work.
 */
const fencedExecutions = new Map<string, string>();

export function hasActiveExecution(sessionId: string): boolean {
  return activeExecutions.has(sessionId);
}

/** Abort setup or agent work and wait until cleanup and durable completion
 * have finished. The positive result is safe for the control plane to use as
 * its cancellation fence. */
export async function cancelExecution(
  sessionId: string,
  reason: string,
): Promise<boolean> {
  // Record the fence before inspecting current work. A cancellation can arrive
  // before POST /crawl reaches this process; executeCrawl must reject that late
  // dispatch even though there is no active execution to abort yet.
  fencedExecutions.set(sessionId, reason);
  const execution = activeExecutions.get(sessionId);
  if (!execution) return false;
  execution.controller.abort(new Error(reason));
  const outcome = await execution.done;
  if (!outcome.succeeded) throw outcome.error;
  return true;
}

export class CrawlCleanupError extends Error {
  constructor(sessionId: string, cause: unknown) {
    super(`Crawl cleanup fence failed for session ${sessionId}`, { cause });
    this.name = 'CrawlCleanupError';
  }
}

/**
 * Grace added on top of the crawl's own timeout before the hard watchdog fires.
 * The agent loop checks its deadline between iterations and stops cleanly at
 * timeoutSeconds; the watchdog is the backstop for a hang INSIDE an iteration.
 */
export const WATCHDOG_GRACE_MS = Number(process.env.WATCHDOG_GRACE_MS ?? '30000');

/**
 * Execute a crawl: create browser, run agent loop, complete session.
 *
 * @param request - The crawl request (credentials, config, etc.)
 * @param proxyUrl - Optional SOCKS5 proxy URL (e.g. "socks5://127.0.0.1:PORT")
 * @param options - Optional execution fence that must complete before terminal persistence
 * @returns The crawl response with extracted data
 */
export async function executeCrawl(
  request: CrawlRequest,
  proxyUrl?: string,
  options: CrawlExecutionOptions = {},
): Promise<CrawlResponse> {
  const fencedReason = fencedExecutions.get(request.sessionId);
  if (fencedReason) {
    return {
      success: false,
      error: fencedReason,
      failureReason: 'instance_died',
      stepsExecuted: 0,
    };
  }
  if (
    activeExecutions.has(request.sessionId)
    || activeSessions.has(request.sessionId)
  ) {
    throw new Error(`Crawl session ${request.sessionId} is already executing`);
  }
  const controller = new AbortController();
  const forwardAbort = (): void => {
    controller.abort(options.signal?.reason);
  };
  if (options.signal?.aborted) {
    forwardAbort();
  } else {
    options.signal?.addEventListener('abort', forwardAbort, { once: true });
  }
  let resolveDone!: (
    outcome:
      | { succeeded: true }
      | { succeeded: false; error: unknown },
  ) => void;
  const execution: ActiveExecution = {
    controller,
    done: new Promise((resolve) => {
      resolveDone = resolve;
    }),
  };
  activeExecutions.set(request.sessionId, execution);
  let executionOutcome:
    | { succeeded: true }
    | { succeeded: false; error: unknown } = { succeeded: true };
  try {
    return await executeCrawlImpl(request, proxyUrl, {
      ...options,
      signal: controller.signal,
    });
  } catch (error) {
    executionOutcome = { succeeded: false, error };
    throw error;
  } finally {
    options.signal?.removeEventListener('abort', forwardAbort);
    if (activeExecutions.get(request.sessionId) === execution) {
      activeExecutions.delete(request.sessionId);
    }
    resolveDone(executionOutcome);
  }
}

async function executeCrawlImpl(
  request: CrawlRequest,
  proxyUrl?: string,
  options: CrawlExecutionOptions = {},
): Promise<CrawlResponse> {
  let context: BrowserContext | undefined;
  let page;
  let contextClosed = false;
  let contextClosePromise: Promise<void> | undefined;

  const sessionId = request.sessionId;
  const log = createSessionLogger(sessionId, (lines) => {
    flushSessionLogs(sessionId, lines).catch(() => {});
  });
  let stopHeartbeat = (): void => {};

  // Close the browser context at most once — the watchdog and the finally both
  // try to close it, and the watchdog's close is what unblocks an in-flight
  // Playwright op so the agent loop can unwind.
  const closeContextOnce = async (): Promise<void> => {
    if (contextClosed || !context) return;
    contextClosePromise ??= context.close().then(
      () => {
        contextClosed = true;
      },
      (error: unknown) => {
        // Permit the final cleanup path (or an explicit cancel) to retry a
        // transient close failure. The session remains registered until one
        // close positively succeeds.
        contextClosePromise = undefined;
        throw error;
      },
    );
    await contextClosePromise;
  };
  const abortError = (): Error => (
    options.signal?.reason instanceof Error
      ? options.signal.reason
      : new Error(`Crawl session ${sessionId} was cancelled`)
  );
  const throwIfAborted = (): void => {
    if (options.signal?.aborted) throw abortError();
  };
  const closeOnAbort = (): void => {
    void closeContextOnce().catch((error) => {
      log.warn('[Crawl] Cancellation context close failed:', error);
    });
  };

  // Hard watchdog timer — armed only once the agent loop starts. Resolves to a
  // timeout CrawlResponse so the crawl ALWAYS terminates within deadline+grace
  // and the instance is never left heart-beating on a hung Playwright op.
  let watchdogTimer: ReturnType<typeof setTimeout> | undefined;
  const hardDeadlineMs = request.timeoutSeconds * 1000 + WATCHDOG_GRACE_MS;

  let response!: CrawlResponse;
  try {
    throwIfAborted();
    // The process-local tombstone closes same-instance dispatch races. This
    // durable preflight closes restart and cross-replica races before any
    // browser process or context is allocated.
    await assertSessionActive(request.sessionId);
    throwIfAborted();
    stopHeartbeat = startHeartbeat(request.sessionId);
    // Create browser context and page (pass country for locale/timezone, optional proxy)
    context = await createContext(request.country, proxyUrl);
    // Register as soon as a live context exists. Setup can fail before page
    // creation; retaining this handle is what lets cancellation retry a failed
    // teardown instead of orphaning a browser that was never registered.
    activeSessions.set(request.sessionId, context);
    options.signal?.addEventListener('abort', closeOnAbort, { once: true });
    if (options.signal?.aborted) {
      await closeContextOnce();
      throw abortError();
    }
    // §1 egress guard: pin the browser to the institution's domain(s) BEFORE any navigation,
    // so a malicious/buggy config can't exfiltrate credentials/data off-domain.
    // §2 write gate: the same interception point refuses state-changing requests once login is done.
    // It starts in the login phase because authentication genuinely needs to post credentials; the
    // agent loop closes it on loginComplete.
    const writeGate = new WriteGate({ vet: createRequestVet({ logger: log }), logger: log });
    await installEgressGuard(context, request.loginUrl, request.allowedDomains, log, writeGate);
    throwIfAborted();
    page = await createPage(context);
    throwIfAborted();

    // Run the AI agent loop, raced against the hard watchdog. If a Playwright
    // op hangs inside an iteration (the deadline is only checked between
    // iterations), the watchdog fires at hardDeadlineMs, closes the context to
    // reject the in-flight op, and resolves to a timeout response.
    const watchdog = new Promise<CrawlResponse>((resolve) => {
      watchdogTimer = setTimeout(() => {
        log.error(
          `[Crawl] WATCHDOG FIRED for session ${request.sessionId}: crawl exceeded hard deadline ` +
          `(${request.timeoutSeconds}s + ${Math.round(WATCHDOG_GRACE_MS / 1000)}s grace). ` +
          `Closing browser context to abort any hung operation.`,
        );
        closeContextOnce()
          .catch((e) => log.warn('[Crawl] Watchdog context close failed:', e))
          .finally(() => {
            resolve({
              success: false,
              error: `Crawl exceeded hard deadline (${request.timeoutSeconds}s)`,
              failureReason: 'crawl_watchdog',
              stepsExecuted: 0,
            });
          });
      }, hardDeadlineMs);
    });

    response = await Promise.race([
      runAgentLoop(page, request, log, undefined, writeGate),
      watchdog,
    ]);
    if (watchdogTimer) clearTimeout(watchdogTimer);
  } catch (error) {
    if (watchdogTimer) clearTimeout(watchdogTimer);
    const message = error instanceof Error ? error.message : String(error);
    const failureReason = classifyCrawlFailure(error);
    log.error(`[Crawl] Failed session ${request.sessionId} (reason=${failureReason}):`, message);

    response = {
      success: false,
      error: message,
      failureReason,
      stepsExecuted: 0,
    };
  } finally {
    options.signal?.removeEventListener('abort', closeOnAbort);
    if (watchdogTimer) clearTimeout(watchdogTimer);
    stopHeartbeat();
    // Clean up browser resources. The context may already be closed by the
    // watchdog — closeContextOnce guards against a double-close. A page-close
    // failure is harmless if the containing context then closes successfully.
    if (page && !contextClosed) {
      try { await page.close(); } catch (e) { log.warn('[Crawl] Error closing page:', e); }
    }
    try {
      await closeContextOnce();
      activeSessions.delete(request.sessionId);
    } catch (error) {
      // Do not publish any terminal session outcome while a browser context
      // may remain live. Keep it registered so cancellation can retry; the
      // one-shot worker treats this as a fatal fence failure and exits PID 1.
      throw new CrawlCleanupError(request.sessionId, error);
    }
  }

  // Terminal persistence is deliberately AFTER every positive execution
  // fence. Browser teardown is always required; callers can add transports
  // such as the device-proxy SOCKS/WebSocket tunnel. A replacement crawl
  // cannot observe a terminal session while any old path can still reach a
  // bank.
  try {
    await options.beforeSessionCompletion?.();
  } catch (error) {
    throw new CrawlCleanupError(request.sessionId, error);
  }
  await completeSession(request.sessionId, response.success, response.error, {
    accounts: response.accounts,
    transactions: response.transactions,
    positions: response.positions,
    stepsExecuted: response.stepsExecuted,
    stepLogs: response.stepLogs,
    cost: response.cost,
    crawlMemory: response.crawlMemory,
    failureReason: response.failureReason,
  }, log);

  log.log(`[Crawl] Completed session ${request.sessionId}: success=${response.success}, steps=${response.stepsExecuted}`);
  return response;
}
