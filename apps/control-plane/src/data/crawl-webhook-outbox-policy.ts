/**
 * What a finished crawl tells a subscriber, and how a delivery is retried without ever being duplicated.
 *
 * A webhook delivery is durable because the crawl that produced it is: the events describing an outcome
 * must survive a restart, must be identical no matter how many times the outbox is drained, and must stop
 * being retried at some point rather than hammering a broken endpoint forever. Which events an outcome
 * produces, what makes two deliveries the same delivery, and when a failure becomes permanent are all
 * product policy.
 *
 * Pure: plain values in, a verdict or a payload out.
 */
import { createHash } from 'node:crypto';
import type { WebhookEvent } from './webhooks';

/** How long one delivery attempt may hold a record before another drain may take it. */
export const DELIVERY_LEASE_MS = 60_000;
/** After this many attempts a delivery stops being retried, so one dead endpoint cannot be retried forever. */
export const MAX_DELIVERY_ATTEMPTS = 20;
export const DELIVERY_BUDGET_EXHAUSTED = 'delivery attempt budget exhausted';
/** Errors are echoed back to the subscriber, so the text is capped rather than passed through whole. */
export const MAX_DELIVERY_ERROR_LENGTH = 500;

/**
 * A delivery is identified by what it is about, not by when it was created: the same session, event and
 * webhook always produce the same id. That is what makes draining the outbox twice harmless.
 */
export function deliveryId(
  sessionId: string,
  event: WebhookEvent,
  webhookId: string,
): string {
  return `whd_${createHash('sha256')
    .update(JSON.stringify([sessionId, event, webhookId]))
    .digest('hex')}`;
}

/** The fields of a delivery that may never change once it exists. */
export interface ImmutableDeliveryFacts {
  id: string;
  sessionId: string;
  connectionId: string;
  webhookId: string;
  event: string;
  url: string;
  secret?: string;
  body: string;
  timestamp: string;
  status?: string;
}

/**
 * Whether an existing delivery is the same one being written again, so a re-drain updates nothing.
 *
 * The secret is the one field allowed to differ, and only in one direction: a delivery that has finished
 * has had its secret scrubbed, so an absent secret on a finished record still matches.
 */
export function sameImmutableDelivery(
  existing: ImmutableDeliveryFacts,
  expected: ImmutableDeliveryFacts,
): boolean {
  return existing.id === expected.id
    && existing.sessionId === expected.sessionId
    && existing.connectionId === expected.connectionId
    && existing.webhookId === expected.webhookId
    && existing.event === expected.event
    && existing.url === expected.url
    && (
      existing.secret === expected.secret
      || (
        existing.secret === undefined
        && (
          existing.status === 'delivered'
          || existing.status === 'permanent_failure'
        )
      )
    )
    && existing.body === expected.body
    && existing.timestamp === expected.timestamp;
}

export type DeliveryAttemptOutcome =
  | { outcome: 'delivered'; status?: number }
  | { outcome: 'permanent_failure'; status?: number; detail?: string }
  | { outcome: 'retryable_failure'; status?: number; detail?: string };

export type DeliveryFinishDecision =
  | { kind: 'delivered'; responseStatus?: number }
  /** Stop trying: either the endpoint rejected it for good, or the attempt budget is spent. */
  | { kind: 'permanent'; responseStatus?: number; error?: string }
  /** Return it to the queue for another attempt. */
  | { kind: 'retry'; responseStatus?: number; error?: string };

/**
 * What to record after one delivery attempt. A retryable failure only stays retryable while the budget
 * lasts; once spent it becomes permanent, which is what stops a broken endpoint being retried forever.
 */
export function decideDeliveryFinish(
  result: DeliveryAttemptOutcome,
  attempts: number,
): DeliveryFinishDecision {
  if (result.outcome === 'delivered') {
    return { kind: 'delivered', responseStatus: result.status };
  }
  if (result.outcome === 'permanent_failure') {
    return { kind: 'permanent', responseStatus: result.status, error: result.detail };
  }
  if (attempts >= MAX_DELIVERY_ATTEMPTS) {
    return {
      kind: 'permanent',
      responseStatus: result.status,
      error: DELIVERY_BUDGET_EXHAUSTED,
    };
  }
  return { kind: 'retry', responseStatus: result.status, error: result.detail };
}

/** What a finished crawl looks like to the outbox. */
export interface TerminalCrawlFacts {
  id: string;
  connectionId: string;
  institutionId: string;
  status: string;
  lastError?: string | null;
  syncCounts?: { transactionsAdded?: number; transactionsModified?: number } | null;
  connectionStatusBeforeCrawl?: string | null;
  connectionStatusAfterCrawl?: string | null;
}

export interface EventPayload {
  event: WebhookEvent;
  payload: Record<string, unknown>;
}

/**
 * Every event a finished crawl produces. The set depends on the outcome: a success additionally reports
 * what changed, and either outcome reports a connection whose status moved as a result.
 */
export function terminalCrawlEvents(
  session: TerminalCrawlFacts,
  occurredAt: string,
): EventPayload[] {
  const success = session.status === 'completed';
  const crawlEvent: WebhookEvent = success ? 'crawl.completed' : 'crawl.failed';
  const syncEvent: WebhookEvent = success ? 'sync.succeeded' : 'sync.failed';
  const error = success
    ? undefined
    : (session.lastError ?? undefined)?.slice(0, MAX_DELIVERY_ERROR_LENGTH);
  const base = {
    connectionId: session.connectionId,
    syncId: session.id,
    occurredAt,
  };
  const events: EventPayload[] = [
    {
      event: crawlEvent,
      payload: {
        event: crawlEvent,
        connectionId: session.connectionId,
        institutionId: session.institutionId,
        sessionId: session.id,
        status: success ? 'completed' : 'failed',
        ...(error ? { error } : {}),
        occurredAt,
      },
    },
    {
      event: syncEvent,
      payload: {
        event: syncEvent,
        ...base,
        status: success ? 'succeeded' : 'failed',
        ...(error ? { error } : {}),
      },
    },
  ];
  if (success && session.syncCounts) {
    events.push({
      event: 'transactions.updated',
      payload: {
        event: 'transactions.updated',
        ...base,
        added: session.syncCounts.transactionsAdded ?? 0,
        modified: session.syncCounts.transactionsModified ?? 0,
        removed: 0,
      },
    });
  }
  if (
    session.connectionStatusBeforeCrawl
    && session.connectionStatusAfterCrawl
    && session.connectionStatusAfterCrawl !== session.connectionStatusBeforeCrawl
  ) {
    events.push({
      event: 'connection.status_changed',
      payload: {
        event: 'connection.status_changed',
        ...base,
        from: session.connectionStatusBeforeCrawl,
        to: session.connectionStatusAfterCrawl,
      },
    });
  }
  return events;
}
