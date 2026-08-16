/**
 * Deliver crawl-outcome webhooks (Accrawl as a provider).
 *
 * On a terminal crawl we POST an HMAC-signed JSON body to every active endpoint subscribed to the event.
 * Delivery is BEST-EFFORT + fire-and-forget: a slow or failing receiver must NEVER block or fail the crawl
 * (the outcome is already durably recorded; `GET /api/sessions/:id` + the data API are the reliable
 * poll-fallback the design mandates for a missed delivery). We retry a couple of times with backoff and log
 * the final failure — never silently.
 *
 * Signature header: `X-Accrawl-Signature: sha256=<hex(hmac_sha256(secret, `${timestamp}.${body}`))>`, with
 * `X-Accrawl-Timestamp` (unix seconds). Binding the timestamp INTO the MAC lets the receiver reject replays;
 * signing the raw body (not a re-serialization) lets it verify the exact bytes it received.
 */
import { createHmac } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { connections, oauthGrants } from '../db/schema';
import { activeWebhooksForEvent, type WebhookEvent } from '../data/webhooks';
import { postJsonToPublicHttps } from '../lib/ssrf';
import { hostedCell } from '../tenancy/directory';
import {
  hostedWebhookStore,
  usesHostedWebhookStore,
} from '../data/webhook-store';
import {
  hostedOauthStore,
  usesHostedOauthStore,
} from '../auth/oauth-store';

const DELIVERY_TIMEOUT_MS = 5000;
const MAX_ATTEMPTS = 3;

/** `sha256=<hex>` HMAC over `${timestamp}.${body}` — the exact string a receiver must reproduce to verify. */
export function signWebhook(secret: string, timestamp: string, body: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

interface CrawlWebhookPayload {
  event: WebhookEvent;
  connectionId: string;
  institutionId?: string;
  sessionId: string;
  status: 'completed' | 'failed';
  error?: string;
  occurredAt: string;
}

export interface DispatchInput {
  connectionId: string;
  sessionId: string;
  event: WebhookEvent;
  error?: string;
  /** Injectable for deterministic tests. */
  now?: Date;
  fetchImpl?: typeof fetch;
}

async function connectionContext(
  db: Db,
  connectionId: string,
): Promise<{
  institutionId: string;
  ownerSubject: string;
  status: string;
} | null> {
  if (usesHostedWebhookStore()) {
    return (await hostedWebhookStore()).getConnectionContext(
      connectionId,
    );
  }
  const [connection] = await db
    .select({
      institutionId: connections.institutionId,
      ownerSubject: connections.ownerSubject,
      status: connections.status,
    })
    .from(connections)
    .where(eq(connections.id, connectionId))
    .limit(1);
  return connection ?? null;
}

/**
 * Fire `crawl.completed` / `crawl.failed` to every subscribed endpoint. The caller does NOT await this in
 * the crawl path (a webhook receiver must never gate a crawl); it resolves once all deliveries settle so a
 * test can await it. No subscribers → a single cheap query and return.
 */
export async function dispatchCrawlWebhook(db: Db, input: DispatchInput): Promise<void> {
  const conn = await connectionContext(db, input.connectionId);
  if (!conn) return;
  const now = input.now ?? new Date();
  const payload: CrawlWebhookPayload = {
    event: input.event,
    connectionId: input.connectionId,
    ...(conn?.institutionId ? { institutionId: conn.institutionId } : {}),
    sessionId: input.sessionId,
    status: input.event === 'crawl.completed' ? 'completed' : 'failed',
    ...(input.error ? { error: input.error.slice(0, 500) } : {}),
    occurredAt: now.toISOString(),
  };
  await fanOut(db, input.event, payload, now, input.fetchImpl, conn.ownerSubject);
}

/** Sign + deliver one JSON payload to every active subscriber of `event`. The generic core behind every
 *  webhook family. No subscribers → a single cheap query and return. */
async function fanOut(
  db: Db,
  event: WebhookEvent,
  payload: object,
  now: Date,
  doFetch: typeof fetch | undefined,
  ownerSubject: string,
): Promise<void> {
  const hooks = await activeWebhooksForEvent(db, event, ownerSubject);
  if (hooks.length === 0) return;
  const body = JSON.stringify(payload);
  const timestamp = String(Math.floor(now.getTime() / 1000));
  await Promise.all(hooks.map((h) => deliver(doFetch, h, event, body, timestamp)));
}

export interface SyncOutcomeInput {
  connectionId: string;
  syncId: string;
  success: boolean;
  error?: string;
  /** Status the connection held BEFORE this run's bookkeeping — to emit connection.status_changed. */
  statusBefore?: string;
  /** Change counts from the store (success only) — to emit transactions.updated. */
  counts?: { added: number; modified: number };
  now?: Date;
  fetchImpl?: typeof fetch;
}

/**
 * Fire the normalized, crawl-free contract webhooks for one refresh run (docs/spec-data-api.md §13):
 *  - `sync.succeeded` / `sync.failed` (always),
 *  - `transactions.updated` with {added, modified, removed:0} (success + counts; transactions are never
 *     hard-deleted, so removed is always 0),
 *  - `connection.status_changed` (only when the connection's status actually changed).
 * Fire-and-forget like the crawl webhook; a receiver must never gate a run.
 */
export async function dispatchSyncOutcomeWebhooks(db: Db, input: SyncOutcomeInput): Promise<void> {
  const now = input.now ?? new Date();
  const doFetch = input.fetchImpl;
  const connection = await connectionContext(db, input.connectionId);
  if (!connection) return;
  const base = { connectionId: input.connectionId, syncId: input.syncId, occurredAt: now.toISOString() };

  const outcomeEvent: WebhookEvent = input.success ? 'sync.succeeded' : 'sync.failed';
  await fanOut(db, outcomeEvent, {
    event: outcomeEvent, ...base,
    status: input.success ? 'succeeded' : 'failed',
    ...(input.error ? { error: input.error.slice(0, 500) } : {}),
  }, now, doFetch, connection.ownerSubject);

  if (input.success && input.counts) {
    await fanOut(db, 'transactions.updated', {
      event: 'transactions.updated', ...base,
      added: input.counts.added, modified: input.counts.modified, removed: 0,
    }, now, doFetch, connection.ownerSubject);
  }

  if (input.statusBefore) {
    if (connection.status !== input.statusBefore) {
      await fanOut(db, 'connection.status_changed', {
        event: 'connection.status_changed', ...base,
        from: input.statusBefore, to: connection.status,
      }, now, doFetch, connection.ownerSubject);
    }
  }
}

export interface GrantWebhookInput {
  grantId: string;
  /** The public client_id (accl_…) of the app whose grant this is, when known. */
  clientId?: string | null;
  now?: Date;
  fetchImpl?: typeof fetch;
}

/**
 * Fire `grant.revoked` to every subscribed endpoint when the operator (or a compromise response) revokes a
 * connected app's grant, so a consumer learns its access is gone rather than only discovering it on the next
 * 401. Fire-and-forget like the other families; a receiver must never gate the revoke.
 */
export async function dispatchGrantWebhook(db: Db, input: GrantWebhookInput): Promise<void> {
  const now = input.now ?? new Date();
  const ownerSubject = usesHostedOauthStore()
    ? await (await hostedOauthStore()).getGrantOwnerSubject(
        input.grantId,
      )
    : (
        await db
          .select({ ownerSubject: oauthGrants.ownerSubject })
          .from(oauthGrants)
          .where(eq(oauthGrants.id, input.grantId))
          .limit(1)
      )[0]?.ownerSubject ?? null;
  if (!ownerSubject) return;
  await fanOut(db, 'grant.revoked', {
    event: 'grant.revoked',
    grantId: input.grantId,
    // Omit `clientId` only when genuinely unknown (null/undefined), per the `string | null` contract — a
    // nullish (not truthy) guard, so a value is carried through as-is rather than being dropped by falsiness.
    ...(input.clientId != null ? { clientId: input.clientId } : {}),
    occurredAt: now.toISOString(),
  }, now, input.fetchImpl, ownerSubject);
}

async function deliver(
  doFetch: typeof fetch | undefined,
  hook: { id: string; url: string; secret: string },
  event: string,
  body: string,
  timestamp: string,
): Promise<void> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const result = await deliverWebhookOnce({
      fetchImpl: doFetch,
      hook,
      event,
      body,
      timestamp,
    });
    if (result.outcome === 'delivered') return;
    if (result.outcome === 'permanent_failure') {
      console.warn(
        `[webhooks] ${hook.id} -> ${result.detail} `
        + '(permanent redirect/client error; giving up)',
      );
      return;
    }
    console.warn(
      `[webhooks] ${hook.id} delivery failed `
      + `(attempt ${attempt}/${MAX_ATTEMPTS}): ${result.detail}`,
    );
    if (attempt < MAX_ATTEMPTS) await sleep(250 * attempt);
  }
  console.error(`[webhooks] ${hook.id} FAILED after ${MAX_ATTEMPTS} attempts — the receiver should poll GET /api/sessions/:id`);
}

export type WebhookDeliveryAttemptResult =
  | { outcome: 'delivered'; status: number }
  | { outcome: 'permanent_failure'; detail: string; status: number }
  | { outcome: 'retryable_failure'; detail: string; status?: number };

export interface WebhookDeliveryAttempt {
  fetchImpl?: typeof fetch;
  hook: { id: string; url: string; secret: string };
  event: string;
  body: string;
  timestamp: string;
  /**
   * Stable outbox identity. Receivers can use this header as an idempotency
   * key when a network failure happens after they commit but before Accrawl
   * receives their response.
   */
  deliveryId?: string;
}

/**
 * Perform exactly one signed delivery attempt and classify the result. The
 * durable hosted outbox owns retry timing; the legacy/self-hosted fan-out uses
 * this primitive inside its bounded in-process retry loop.
 */
export async function deliverWebhookOnce(
  input: WebhookDeliveryAttempt,
): Promise<WebhookDeliveryAttemptResult> {
  const signature = signWebhook(input.hook.secret, input.timestamp, input.body);
  const headers = {
    'content-type': 'application/json',
    'user-agent': 'Accrawl-Webhook/1',
    'x-accrawl-event': input.event,
    'x-accrawl-timestamp': input.timestamp,
    'x-accrawl-signature': signature,
    ...(input.deliveryId
      ? { 'x-accrawl-delivery': input.deliveryId }
      : {}),
  };
  try {
    // Hosted delivery uses a guarded HTTPS socket whose DNS lookup rejects
    // private/loopback/mixed answers. Self-hosted deployments retain localhost
    // delivery for co-located receivers. Tests may inject a deterministic fetch.
    const status = input.fetchImpl
      ? (await input.fetchImpl(input.hook.url, {
          method: 'POST',
          headers,
          body: input.body,
          redirect: 'manual',
          signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
        })).status
      : hostedCell
        ? await postJsonToPublicHttps(
            input.hook.url,
            input.body,
            headers,
            { timeoutMs: DELIVERY_TIMEOUT_MS },
          )
        : (await fetch(input.hook.url, {
            method: 'POST',
            headers,
            body: input.body,
            redirect: 'manual',
            signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
          })).status;
    if (status >= 200 && status < 300) {
      return { outcome: 'delivered', status };
    }
    // Redirects are never followed. Other client errors except 429 are
    // permanent endpoint/configuration failures.
    if (status >= 300 && status < 500 && status !== 429) {
      return {
        outcome: 'permanent_failure',
        detail: `HTTP ${status}`,
        status,
      };
    }
    return {
      outcome: 'retryable_failure',
      detail: `HTTP ${status}`,
      status,
    };
  } catch (error) {
    return {
      outcome: 'retryable_failure',
      detail: error instanceof Error
        ? error.message.slice(0, 500)
        : String(error).slice(0, 500),
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
