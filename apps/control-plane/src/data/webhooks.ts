/**
 * Outgoing webhooks — Accrawl as a data provider.
 *
 * The operator registers an endpoint URL + a set of crawl events; on each matching terminal crawl outcome,
 * `../webhooks/dispatch` POSTs an HMAC-signed notification. Only the event + IDs are sent — never balances or
 * PII — so a consumer treats the webhook as a nudge and reads the details from the authenticated data API
 * (which, together with `GET /api/sessions/:id`, is also the poll-fallback for a missed delivery).
 *
 * The signing `secret` is generated here and shown to the operator ONCE at registration. It is stored so we
 * can sign with it; it is a shared HMAC secret (not an outbound credential), so a DB leak of it only lets an
 * attacker forge notifications to the operator's OWN receiver — which conveys no data the receiver can't
 * already fetch from the API.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from '../db/client';
import { webhooks } from '../db/schema';
import { SELF_HOSTED_OPERATOR_SUBJECT } from '../auth/subjects';
import {
  hostedWebhookStore,
  usesHostedWebhookStore,
} from './webhook-store';

/**
 * The events a webhook can subscribe to. Two families delivered together:
 *  - Legacy crawl outcomes (`crawl.completed` / `crawl.failed`) — the original provider webhooks.
 *  - The normalized, retrieval-neutral contract events (docs/spec-data-api.md §13): `sync.succeeded`,
 *    `sync.failed`, `transactions.updated`, `connection.status_changed`. These carry a `syncId`
 *    (never a "session"/"crawl") so the public contract stays crawl-free.
 */
export const WEBHOOK_EVENTS = [
  'crawl.completed', 'crawl.failed',
  'sync.succeeded', 'sync.failed', 'transactions.updated', 'connection.status_changed',
  'grant.revoked',
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export interface WebhookView {
  id: string;
  url: string;
  events: string[];
  createdAt: Date;
  disabledAt: Date | null;
}

const SECRET_PREFIX = 'whsec_';

export function generateWebhookSecret(): string {
  return SECRET_PREFIX + randomBytes(32).toString('base64url');
}

function toView(row: typeof webhooks.$inferSelect): WebhookView {
  return { id: row.id, url: row.url, events: row.events ?? [], createdAt: row.createdAt, disabledAt: row.disabledAt };
}

export async function createWebhook(
  db: Db,
  input: { url: string; events: string[] },
  ownerSubject: string = SELF_HOSTED_OPERATOR_SUBJECT,
): Promise<{ id: string; secret: string; view: WebhookView }> {
  const secret = generateWebhookSecret();
  if (usesHostedWebhookStore()) {
    const id = randomUUID();
    const view = await (await hostedWebhookStore()).createWebhook({
      id,
      ownerSubject,
      url: input.url,
      secret,
      events: input.events,
      createdAt: new Date(),
    });
    return { id, secret, view };
  }
  const [row] = await db.insert(webhooks).values({
    ownerSubject,
    url: input.url,
    secret,
    events: input.events,
  }).returning();
  return { id: row.id, secret, view: toView(row) };
}

/** Operator-facing list — deliberately NEVER selects the signing secret. */
export async function listWebhooks(
  db: Db,
  ownerSubject: string = SELF_HOSTED_OPERATOR_SUBJECT,
): Promise<WebhookView[]> {
  if (usesHostedWebhookStore()) {
    return (await hostedWebhookStore()).listWebhooks(ownerSubject);
  }
  const rows = await db.select().from(webhooks).where(eq(webhooks.ownerSubject, ownerSubject));
  return rows.map(toView);
}

export async function deleteWebhook(
  db: Db,
  id: string,
  ownerSubject: string = SELF_HOSTED_OPERATOR_SUBJECT,
): Promise<boolean> {
  if (usesHostedWebhookStore()) {
    return (await hostedWebhookStore()).deleteWebhook(
      id,
      ownerSubject,
    );
  }
  const deleted = await db.delete(webhooks).where(and(
    eq(webhooks.id, id),
    eq(webhooks.ownerSubject, ownerSubject),
  )).returning({ id: webhooks.id });
  return deleted.length > 0;
}

/** Active (not disabled) webhooks subscribed to `event`, WITH their signing secret — dispatch-only. Events
 *  is a jsonb array; we filter in-process (the set is tiny) rather than relying on a jsonb-contains operator. */
export async function activeWebhooksForEvent(
  db: Db,
  event: string,
  ownerSubject: string = SELF_HOSTED_OPERATOR_SUBJECT,
): Promise<{ id: string; url: string; secret: string }[]> {
  if (usesHostedWebhookStore()) {
    return (await hostedWebhookStore()).activeWebhooksForEvent(
      event,
      ownerSubject,
    );
  }
  const rows = await db
    .select({ id: webhooks.id, url: webhooks.url, secret: webhooks.secret, events: webhooks.events })
    .from(webhooks)
    .where(and(
      eq(webhooks.ownerSubject, ownerSubject),
      isNull(webhooks.disabledAt),
    ));
  return rows.filter((r) => (r.events ?? []).includes(event)).map((r) => ({ id: r.id, url: r.url, secret: r.secret }));
}
