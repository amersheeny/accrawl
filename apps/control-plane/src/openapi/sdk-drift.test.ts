import { describe, it, expect } from 'vitest';
import { ACCRAWL_ENDPOINTS, verifyWebhookSignature, computeWebhookSignature } from '@accrawl/sdk';
import { DOCUMENTED_CONSUMER_ENDPOINTS } from './spec';
import { signWebhook } from '../webhooks/dispatch';

/**
 * Cross-checks the first-party @accrawl/sdk against the API it targets, so the SDK can't silently drift from
 * the server:
 *  1. Endpoint surface: the SDK implements EXACTLY the documented consumer endpoints (no missing, no phantom).
 *  2. Webhook signing compatibility: a body signed by the SERVER (signWebhook) is accepted by the SDK's
 *     verifyWebhookSignature, and any tamper is rejected — proving the two agree on the exact MAC construction.
 */

const key = (e: { method: string; path: string }) => `${e.method.toLowerCase()} ${e.path}`;

describe('SDK ↔ API drift', () => {
  it('the SDK implements exactly the documented consumer endpoints', () => {
    const sdk = [...ACCRAWL_ENDPOINTS].map(key).sort();
    const spec = [...DOCUMENTED_CONSUMER_ENDPOINTS].map(key).sort();
    expect(sdk).toEqual(spec);
  });
});

describe('SDK webhook verify ↔ server sign compatibility', () => {
  const secret = 'whsec_cross';
  const ts = '1782000000';
  const body = JSON.stringify({ event: 'crawl.completed', connectionId: 'c1', sessionId: 's1', status: 'completed', occurredAt: '2026-07-01T10:00:00Z' });

  it('the SDK verifies a signature the SERVER produced (identical MAC construction)', () => {
    const serverSig = signWebhook(secret, ts, body);
    // The SDK computes the same signature...
    expect(computeWebhookSignature(secret, ts, body)).toBe(serverSig);
    // ...and accepts it.
    expect(verifyWebhookSignature({ secret, rawBody: body, signature: serverSig, timestamp: ts })).toBe(true);
  });

  it('the SDK rejects a body/timestamp tampered after the server signed it', () => {
    const serverSig = signWebhook(secret, ts, body);
    expect(verifyWebhookSignature({ secret, rawBody: body + 'x', signature: serverSig, timestamp: ts })).toBe(false);
    expect(verifyWebhookSignature({ secret, rawBody: body, signature: serverSig, timestamp: '1782000009' })).toBe(false);
  });
});
