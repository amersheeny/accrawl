import { describe, it, expect } from 'vitest';
import { computeWebhookSignature, verifyWebhookSignature, parseWebhookPayload, parseNormalizedWebhookPayload } from './webhooks';

const secret = 'whsec_test';
const body = JSON.stringify({ event: 'crawl.completed', connectionId: 'c1', sessionId: 's1', status: 'completed', occurredAt: '2026-07-01T10:00:00Z' });
const ts = '1782000000';

describe('computeWebhookSignature', () => {
  it('is `sha256=<hex>` over `${timestamp}.${body}`', () => {
    const sig = computeWebhookSignature(secret, ts, body);
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
    // Deterministic: same inputs → same signature.
    expect(computeWebhookSignature(secret, ts, body)).toBe(sig);
    // The timestamp is bound in: changing it changes the signature.
    expect(computeWebhookSignature(secret, '1782000001', body)).not.toBe(sig);
  });
});

describe('verifyWebhookSignature', () => {
  const sig = computeWebhookSignature(secret, ts, body);

  it('accepts an authentic signature', () => {
    expect(verifyWebhookSignature({ secret, rawBody: body, signature: sig, timestamp: ts })).toBe(true);
  });

  it('rejects a tampered body, wrong secret, and altered timestamp', () => {
    expect(verifyWebhookSignature({ secret, rawBody: body + ' ', signature: sig, timestamp: ts })).toBe(false);
    expect(verifyWebhookSignature({ secret: 'other', rawBody: body, signature: sig, timestamp: ts })).toBe(false);
    expect(verifyWebhookSignature({ secret, rawBody: body, signature: sig, timestamp: '1782000001' })).toBe(false);
  });

  it('rejects a wrong-length / malformed signature without throwing (length guard on timingSafeEqual)', () => {
    expect(verifyWebhookSignature({ secret, rawBody: body, signature: 'sha256=deadbeef', timestamp: ts })).toBe(false);
    expect(verifyWebhookSignature({ secret, rawBody: body, signature: '', timestamp: ts })).toBe(false);
    // @ts-expect-error — a non-string signature (defensive) returns false, never throws.
    expect(verifyWebhookSignature({ secret, rawBody: body, signature: undefined, timestamp: ts })).toBe(false);
  });

  it('enforces the replay window when toleranceSeconds is set', () => {
    const now = 1782000000;
    expect(verifyWebhookSignature({ secret, rawBody: body, signature: sig, timestamp: ts, toleranceSeconds: 300, nowSeconds: now + 100 })).toBe(true);
    expect(verifyWebhookSignature({ secret, rawBody: body, signature: sig, timestamp: ts, toleranceSeconds: 300, nowSeconds: now + 3600 })).toBe(false); // stale
    expect(verifyWebhookSignature({ secret, rawBody: body, signature: sig, timestamp: 'not-a-number', toleranceSeconds: 300, nowSeconds: now })).toBe(false);
  });

  it('FAIL-CLOSED: a non-finite toleranceSeconds or nowSeconds does not silently disable replay protection', () => {
    const now = 1782000000;
    // A stale (1hr old) but correctly-signed payload must be REJECTED even when the window inputs are NaN/Inf
    // (a NaN comparison is false and would otherwise wave it through).
    const sig = computeWebhookSignature(secret, ts, body); // ts = now
    const stale = { secret, rawBody: body, signature: sig, timestamp: ts };
    expect(verifyWebhookSignature({ ...stale, toleranceSeconds: Number.NaN, nowSeconds: now + 3600 })).toBe(false);
    expect(verifyWebhookSignature({ ...stale, toleranceSeconds: 300, nowSeconds: Number.NaN })).toBe(false);
    expect(verifyWebhookSignature({ ...stale, toleranceSeconds: Number.POSITIVE_INFINITY, nowSeconds: now + 3600 })).toBe(false);
  });
});

describe('parseWebhookPayload', () => {
  it('parses a valid payload', () => {
    const p = parseWebhookPayload(body);
    expect(p.event).toBe('crawl.completed');
    expect(p.sessionId).toBe('s1');
  });
  it('throws on invalid JSON and on a wrong shape', () => {
    expect(() => parseWebhookPayload('{not json')).toThrow(/not valid JSON/);
    expect(() => parseWebhookPayload(JSON.stringify({ event: 'nope', connectionId: 'c', sessionId: 's', status: 'completed', occurredAt: 'x' }))).toThrow(/valid CrawlWebhookPayload/);
    expect(() => parseWebhookPayload(JSON.stringify({ event: 'crawl.completed', sessionId: 's', status: 'completed', occurredAt: 'x' }))).toThrow(); // missing connectionId
  });
  it('rejects a payload whose event and status disagree (the server never emits one)', () => {
    expect(() => parseWebhookPayload(JSON.stringify({ event: 'crawl.completed', connectionId: 'c', sessionId: 's', status: 'failed', occurredAt: 'x' }))).toThrow(/valid CrawlWebhookPayload/);
    expect(() => parseWebhookPayload(JSON.stringify({ event: 'crawl.failed', connectionId: 'c', sessionId: 's', status: 'completed', occurredAt: 'x' }))).toThrow(/valid CrawlWebhookPayload/);
    // The correlated pairs still parse.
    expect(parseWebhookPayload(JSON.stringify({ event: 'crawl.failed', connectionId: 'c', sessionId: 's', status: 'failed', occurredAt: 'x' })).status).toBe('failed');
  });
  it('rejects non-string optional fields (error / institutionId)', () => {
    const base = { event: 'crawl.failed', connectionId: 'c', sessionId: 's', status: 'failed', occurredAt: 'x' };
    expect(() => parseWebhookPayload(JSON.stringify({ ...base, error: 123 }))).toThrow(/valid CrawlWebhookPayload/);
    expect(() => parseWebhookPayload(JSON.stringify({ ...base, institutionId: 456 }))).toThrow(/valid CrawlWebhookPayload/);
    expect(parseWebhookPayload(JSON.stringify(base)).status).toBe('failed'); // absent optionals are fine
  });
});

describe('parseNormalizedWebhookPayload', () => {
  const base = { connectionId: 'c1', syncId: 'sync_1', occurredAt: '2026-07-01T10:00:00Z' };

  it('parses each of the four normalized events', () => {
    const succ = parseNormalizedWebhookPayload(JSON.stringify({ ...base, event: 'sync.succeeded', status: 'succeeded' }));
    expect(succ.event).toBe('sync.succeeded');
    const fail = parseNormalizedWebhookPayload(JSON.stringify({ ...base, event: 'sync.failed', status: 'failed', error: 'boom' }));
    if (fail.event === 'sync.failed') expect(fail.error).toBe('boom');
    const upd = parseNormalizedWebhookPayload(JSON.stringify({ ...base, event: 'transactions.updated', added: 3, modified: 1, removed: 0 }));
    if (upd.event === 'transactions.updated') expect(upd.added).toBe(3);
    const chg = parseNormalizedWebhookPayload(JSON.stringify({ ...base, event: 'connection.status_changed', from: 'connected', to: 'needs_reauth' }));
    if (chg.event === 'connection.status_changed') expect(chg.to).toBe('needs_reauth');
  });

  it('rejects a sync event whose status disagrees with the event, and non-number counts', () => {
    expect(() => parseNormalizedWebhookPayload(JSON.stringify({ ...base, event: 'sync.succeeded', status: 'failed' }))).toThrow(/normalized webhook/);
    expect(() => parseNormalizedWebhookPayload(JSON.stringify({ ...base, event: 'transactions.updated', added: '3', modified: 1, removed: 0 }))).toThrow(/normalized webhook/);
  });

  it('throws on a missing base field, a crawl event, and invalid JSON', () => {
    expect(() => parseNormalizedWebhookPayload(JSON.stringify({ event: 'sync.succeeded', status: 'succeeded', connectionId: 'c', occurredAt: 'x' }))).toThrow(/normalized webhook/); // no syncId
    expect(() => parseNormalizedWebhookPayload(JSON.stringify({ ...base, event: 'crawl.completed', status: 'completed' }))).toThrow(/normalized webhook/);
    expect(() => parseNormalizedWebhookPayload('{nope')).toThrow(/not valid JSON/);
  });
});
