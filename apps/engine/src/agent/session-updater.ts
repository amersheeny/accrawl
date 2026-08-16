/**
 * Session Updater
 *
 * Records crawl session telemetry (status, step logs, results, console logs,
 * heartbeat) for real-time monitoring. The actual persistence is delegated to the
 * active platform (see ../platform): a hosted adapter writes documents,
 * the local adapter writes run artifacts to disk. This module keeps the stable
 * function surface the engine calls, plus the pure helpers used by the adapters.
 */

import type { SessionLogger, LogLine } from '../utils/logger';
import type { CrawlFailureReason } from '../types';
import type { CompletionResults } from '../platform/types';
import type { WorkerSessionClaim } from '../platform/types';
import { getPlatform } from '../platform';

/** Strip undefined values from an object, which a document store rejects. */
function stripUndefined<T extends Record<string, unknown>>(obj: T): T {
  const clean = {} as T;
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) {
      (clean as Record<string, unknown>)[key] = value;
    }
  }
  return clean;
}

export function sanitizeDocumentArrayItems(items?: unknown[]): unknown[] | undefined {
  return items?.map(item => (
    typeof item === 'object' && item !== null
      ? stripUndefined(item as Record<string, unknown>)
      : item
  ));
}

/** Thrown when a crawl session has been cancelled by an external controller. */
export class CrawlCancelledError extends Error {
  constructor(sessionId: string) {
    super(`Crawl session ${sessionId} was cancelled`);
    this.name = 'CrawlCancelledError';
  }
}

/** Claim durable worker ownership before the HTTP route ACKs dispatch. */
export async function claimSessionWorker(
  sessionId: string,
  worker: WorkerSessionClaim | undefined,
): Promise<'claimed' | 'duplicate'> {
  return getPlatform().sessionStore.claimWorker(sessionId, worker);
}

export function getCompletionMetadata(
  success: boolean,
  error?: string,
): {
  status: 'completed' | 'failed';
  clearLastError: boolean;
  lastError?: string;
} {
  if (success) {
    return { status: 'completed', clearLastError: true };
  }
  return {
    status: 'failed',
    clearLastError: false,
    ...(error && { lastError: error }),
  };
}

/**
 * Build the failureReason patch for the session doc. Only written on a failed
 * crawl that carries a classified reason — a successful crawl (or an
 * unclassified failure) writes nothing.
 */
export function buildFailureReasonUpdate(
  success: boolean,
  failureReason?: CrawlFailureReason,
): Record<string, CrawlFailureReason> {
  if (success || !failureReason) return {};
  return { failureReason };
}

/** Fail closed unless the durable session still owns an active crawl. */
export async function assertSessionActive(sessionId: string): Promise<void> {
  return getPlatform().sessionStore.assertActive(sessionId);
}

/**
 * Update a crawler session's status.
 * Throws CrawlCancelledError if an external controller has cancelled the session.
 */
export async function updateSessionStatus(
  sessionId: string,
  status: string,
  currentStep: string,
  stepCount?: number,
  logger?: SessionLogger,
): Promise<void> {
  return getPlatform().sessionStore.updateStatus(sessionId, status, currentStep, stepCount, logger);
}

/** Write a step log for real-time visibility. */
export async function appendStepLog(
  sessionId: string,
  stepLog: unknown,
  logger?: SessionLogger,
): Promise<void> {
  return getPlatform().sessionStore.appendStep(sessionId, stepLog, logger);
}

/** Mark a session as completed and store extracted results. */
export async function completeSession(
  sessionId: string,
  success: boolean,
  error?: string,
  results?: CompletionResults,
  logger?: SessionLogger,
): Promise<void> {
  return getPlatform().sessionStore.complete(sessionId, success, error, results, logger);
}

/** Start a background liveness heartbeat. Returns a stop() to clear it. */
export function startHeartbeat(sessionId: string, intervalMs = 30_000): () => void {
  return getPlatform().sessionStore.startHeartbeat(sessionId, intervalMs);
}

/** Flush accumulated console logs (truncated to the last 2000 lines). */
export async function flushSessionLogs(
  sessionId: string,
  lines: LogLine[],
): Promise<void> {
  return getPlatform().sessionStore.flushLogs(sessionId, lines);
}
