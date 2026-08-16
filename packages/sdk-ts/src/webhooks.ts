/**
 * Verify HMAC-signed Accrawl webhooks (crawl.completed / crawl.failed).
 *
 * The server signs `X-Accrawl-Signature: sha256=<hex(hmac_sha256(secret, `${timestamp}.${rawBody}`))>` with
 * `X-Accrawl-Timestamp` (unix seconds) — the timestamp is bound INTO the MAC so a receiver can reject replays,
 * and the signature is over the RAW request body bytes (verify against the exact bytes you received, before
 * any re-serialization). This mirrors the server's signWebhook exactly.
 *
 * Node-only (uses node:crypto for a timing-safe compare) — webhook receivers run on a server.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { CrawlWebhookPayload, NormalizedWebhookPayload } from './types';

/** The signature string a receiver must reproduce: `sha256=<hex>`. Exposed for testing/symmetry. */
export function computeWebhookSignature(secret: string, timestamp: string, rawBody: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
}

export interface VerifyWebhookOptions {
  /** Your webhook's shared secret. */
  secret: string;
  /** The RAW request body string (exactly as received — do not re-serialize). */
  rawBody: string;
  /** The X-Accrawl-Signature header value. */
  signature: string;
  /** The X-Accrawl-Timestamp header value (unix seconds). */
  timestamp: string;
  /** If set, reject when the timestamp is more than this many seconds from `now` (replay window). */
  toleranceSeconds?: number;
  /** Current unix seconds (injectable for tests). Defaults to Date.now()/1000. */
  nowSeconds?: number;
}

/**
 * Whether a webhook is authentic: a timing-safe match of the recomputed signature, and (if toleranceSeconds
 * is set) within the replay window. Returns false — never throws — on any mismatch or malformed input.
 */
export function verifyWebhookSignature(opts: VerifyWebhookOptions): boolean {
  const { secret, rawBody, signature, timestamp, toleranceSeconds } = opts;
  if (typeof signature !== 'string' || typeof timestamp !== 'string') return false;

  if (toleranceSeconds !== undefined) {
    const ts = Number(timestamp);
    const now = opts.nowSeconds ?? Date.now() / 1000;
    // Fail CLOSED on any non-finite input: a NaN/Infinity tolerance or now/ts would make the comparison
    // below false and SILENTLY disable replay protection (e.g. a caller passing Number(process.env.UNSET)).
    // A malformed replay window must reject, never wave the payload through.
    if (!Number.isFinite(ts) || !Number.isFinite(now) || !Number.isFinite(toleranceSeconds)) return false;
    if (Math.abs(now - ts) > toleranceSeconds) return false;
  }

  const expected = computeWebhookSignature(secret, timestamp, rawBody);
  // timingSafeEqual throws on unequal lengths — guard first (the length of a hex signature is not secret).
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Parse a webhook body into a typed payload. Throws if it isn't a valid crawl webhook shape. Verify the
 *  signature FIRST (with the raw body), then parse. */
export function parseWebhookPayload(rawBody: string): CrawlWebhookPayload {
  let obj: unknown;
  try {
    obj = JSON.parse(rawBody);
  } catch {
    throw new Error('webhook body is not valid JSON');
  }
  const o = obj as Record<string, unknown>;
  const validEvent = !!o && (o.event === 'crawl.completed' || o.event === 'crawl.failed');
  // The server derives status FROM the event (completed↔crawl.completed, failed↔crawl.failed), so a payload
  // whose event and status disagree is malformed — reject it rather than hand back a self-contradictory
  // object that a consumer might branch on inconsistently.
  const statusMatchesEvent = validEvent && o.status === (o.event === 'crawl.completed' ? 'completed' : 'failed');
  const optStr = (v: unknown): boolean => v === undefined || typeof v === 'string'; // optional: absent or a string
  if (
    !o ||
    !validEvent ||
    typeof o.connectionId !== 'string' ||
    typeof o.sessionId !== 'string' ||
    !statusMatchesEvent ||
    typeof o.occurredAt !== 'string' ||
    !optStr(o.error) ||
    !optStr(o.institutionId)
  ) {
    throw new Error('webhook body is not a valid CrawlWebhookPayload');
  }
  return obj as CrawlWebhookPayload;
}

/**
 * Parse a normalized contract webhook body (`sync.succeeded` / `sync.failed` / `transactions.updated` /
 * `connection.status_changed`) into a typed, discriminated payload. Throws if it isn't a valid normalized
 * webhook shape. Verify the signature FIRST (with the raw body), then parse — the same signing scheme and
 * headers apply, so `verifyWebhookSignature` is event-agnostic and works unchanged for these events.
 */
export function parseNormalizedWebhookPayload(rawBody: string): NormalizedWebhookPayload {
  let obj: unknown;
  try {
    obj = JSON.parse(rawBody);
  } catch {
    throw new Error('webhook body is not valid JSON');
  }
  const o = obj as Record<string, unknown>;
  const optStr = (v: unknown): boolean => v === undefined || typeof v === 'string';
  // Every normalized event shares these fields; the server sets syncId on all of them.
  const baseOk = !!o
    && typeof o.connectionId === 'string'
    && typeof o.syncId === 'string'
    && typeof o.occurredAt === 'string';
  if (baseOk) {
    if (o.event === 'sync.succeeded' && o.status === 'succeeded' && optStr(o.error)) return obj as NormalizedWebhookPayload;
    if (o.event === 'sync.failed' && o.status === 'failed' && optStr(o.error)) return obj as NormalizedWebhookPayload;
    if (o.event === 'transactions.updated'
      && typeof o.added === 'number' && typeof o.modified === 'number' && typeof o.removed === 'number') {
      return obj as NormalizedWebhookPayload;
    }
    if (o.event === 'connection.status_changed' && typeof o.from === 'string' && typeof o.to === 'string') {
      return obj as NormalizedWebhookPayload;
    }
  }
  throw new Error('webhook body is not a valid normalized webhook payload');
}
