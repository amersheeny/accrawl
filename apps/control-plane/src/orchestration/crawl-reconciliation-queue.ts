/**
 * Waking this service up later, for work no timer in this process can be trusted to remember.
 *
 * Two things need it. A crawl running somewhere else has to be looked in on: if the worker never
 * reports back, something must notice and finish the record. And a connection with a schedule has to
 * be crawled at its due time, which may be days away. A deployment that scales to zero has no live
 * process in between — the 60-second `setInterval` that used to arm schedules died with the container
 * on 2026-08-04 and scheduled crawling simply stopped — so the wake-up has to outlive the process.
 *
 * Everything about *what* is scheduled is decided here: the payload each callback carries, the lane
 * and sequence that order them, the identity that makes a duplicate enqueue a no-op, and the windows
 * outside which a schedule is refused. A deployment supplies only the queue that holds the callback
 * until its time comes, and the address it is delivered to.
 */
import { INTERNAL_TENANT_HOST_HEADER } from '@accrawl/contracts';
import { randomUUID } from 'node:crypto';
import { currentTenant } from '../tenancy/context';

const SESSION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_SCHEDULE_AHEAD_MS = 30 * 24 * 60 * 60 * 1_000;
const TASK_DISPATCH_DEADLINE_SECONDS = 300;
const MAX_RECONCILIATION_SEQUENCE = 10_000;
/** A queue may not hold a callback indefinitely, so a distant occurrence is woken earlier and
 *  re-armed rather than scheduled once, far out, and forgotten. */
const CONNECTION_SCHEDULE_HORIZON_MS = 29 * 24 * 60 * 60 * 1_000;

export type CrawlReconciliationLane =
  | 'lifecycle'
  | 'cancellation'
  | 'recovery';

export interface CrawlReconciliationTask {
  version: 1;
  sessionId: string;
  sequence: number;
  lane: CrawlReconciliationLane;
  generation: string;
}

export interface ScheduledConnectionTask {
  version: 1;
  kind: 'scheduled-connection';
  connectionId: string;
  scheduleRevision: number;
  dueAt: string;
  sequence: number;
}

/** One later call back into this service, fully described. */
export interface DeferredCallback {
  /**
   * What makes this callback the same callback. Enqueuing an id that is already queued — or that has
   * already run — must succeed without producing a second delivery: a callback can be redelivered
   * after it durably created its successor but before its own acknowledgement was seen, and that
   * identical successor is exactly the durability boundary the first one was waiting for.
   */
  id: string;
  /** Do not deliver before this instant (epoch millis). */
  notBefore: number;
  /** How long the receiver has to answer before delivery is considered failed. */
  deadlineSeconds: number;
  headers: Record<string, string>;
  body: string;
}

/** Where deferred callbacks are kept until their time comes. */
export interface DeferredCallbackQueue {
  enqueue(callback: DeferredCallback): Promise<void>;
}

let registered: (() => DeferredCallbackQueue) | undefined;

/** Supply the queue. A deployment that runs its own crawls in-process needs none. */
export function registerDeferredCallbackQueue(factory: () => DeferredCallbackQueue): void {
  registered = factory;
}

/** The registered queue, or undefined when nothing can hold a callback for this deployment. */
export function deferredCallbackQueue(): DeferredCallbackQueue | undefined {
  return registered?.();
}

/** Test-only reset so a case can compose a different deployment. */
export function resetDeferredCallbackQueueForTest(): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('resetDeferredCallbackQueueForTest is available only under NODE_ENV=test');
  }
  registered = undefined;
}

function requireQueue(): DeferredCallbackQueue {
  const queue = registered?.();
  if (!queue) {
    throw new Error(
      'Waking this service up later needs a deferred callback queue, and none is registered. A '
      + 'deployment that runs crawls elsewhere registers one with registerDeferredCallbackQueue().',
    );
  }
  return queue;
}

/** The tenant a callback is delivered on behalf of; a callback carries it because the queue delivers
 *  it to a service that serves several. */
function callbackTenantHost(purpose: string): string {
  const tenantHost = currentTenant().hosts[0];
  if (!tenantHost) throw new Error(`${purpose} requires a tenant host`);
  const normalized = tenantHost.toLowerCase();
  if (
    !normalized
    || normalized.length > 253
    || normalized.includes('/')
    || normalized.includes('@')
    || normalized.includes(':')
  ) {
    throw new Error(`${purpose} tenant host is invalid`);
  }
  return normalized;
}

function callbackHeaders(tenantHost: string): Record<string, string> {
  return {
    'content-type': 'application/json',
    [INTERNAL_TENANT_HOST_HEADER]: tenantHost,
  };
}

/**
 * Look in on a crawl again later.
 *
 * The queue's acknowledgement is the durability boundary: a caller must await this before answering
 * a worker or moving to a state whose only way forward is the wake-up this schedules.
 */
export async function enqueueHostedCrawlReconciliation(
  sessionId: string,
  scheduleAt?: Date,
  sequence = 0,
  lane: CrawlReconciliationLane = 'lifecycle',
  generation: string = randomUUID(),
  now: () => number = Date.now,
): Promise<void> {
  if (!SESSION_ID.test(sessionId)) {
    throw new Error('crawl reconciliation session id is invalid');
  }
  if (
    !Number.isSafeInteger(sequence)
    || sequence < 0
    || sequence > MAX_RECONCILIATION_SEQUENCE
  ) {
    throw new Error('crawl reconciliation sequence is invalid');
  }
  if (!SESSION_ID.test(generation)) {
    throw new Error('crawl reconciliation generation is invalid');
  }
  const tenantHost = callbackTenantHost('hosted crawl reconciliation');
  const currentMs = now();
  const scheduleMs = (scheduleAt ?? new Date(currentMs)).getTime();
  if (
    !Number.isFinite(scheduleMs)
    || scheduleMs < currentMs - 1_000
    || scheduleMs > currentMs + MAX_SCHEDULE_AHEAD_MS
  ) {
    throw new Error('crawl reconciliation schedule is outside the allowed window');
  }
  const payload: CrawlReconciliationTask = {
    version: 1,
    sessionId,
    sequence,
    lane,
    generation,
  };
  await requireQueue().enqueue({
    id: `crawl-${lane}-${generation}-${sessionId}-${sequence}`,
    notBefore: Math.max(currentMs, scheduleMs),
    deadlineSeconds: TASK_DISPATCH_DEADLINE_SECONDS,
    headers: callbackHeaders(tenantHost),
    body: JSON.stringify(payload),
  });
}

/** Crawl a scheduled connection when its next occurrence falls due. */
export async function enqueueHostedScheduledConnection(
  connectionId: string,
  dueAt: Date,
  scheduleRevision: number,
  sequence = 0,
  now: () => number = Date.now,
): Promise<void> {
  if (!SESSION_ID.test(connectionId)) {
    throw new Error('scheduled connection id is invalid');
  }
  if (!Number.isSafeInteger(scheduleRevision) || scheduleRevision < 0) {
    throw new Error('scheduled connection revision is invalid');
  }
  if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence > MAX_RECONCILIATION_SEQUENCE) {
    throw new Error('scheduled connection sequence is invalid');
  }
  const tenantHost = callbackTenantHost('hosted scheduled connection');
  const currentMs = now();
  const dueMs = dueAt.getTime();
  if (!Number.isFinite(dueMs)) {
    throw new Error('scheduled connection due time is outside the allowed window');
  }
  const wakeMs = Math.min(dueMs, currentMs + CONNECTION_SCHEDULE_HORIZON_MS);
  const payload: ScheduledConnectionTask = {
    version: 1,
    kind: 'scheduled-connection',
    connectionId,
    scheduleRevision,
    dueAt: dueAt.toISOString(),
    sequence,
  };
  await requireQueue().enqueue({
    id: `schedule-${connectionId}-${scheduleRevision}-${Math.floor(dueMs / 1_000)}-${sequence}`,
    notBefore: Math.max(currentMs, wakeMs),
    deadlineSeconds: TASK_DISPATCH_DEADLINE_SECONDS,
    headers: callbackHeaders(tenantHost),
    body: JSON.stringify(payload),
  });
}
