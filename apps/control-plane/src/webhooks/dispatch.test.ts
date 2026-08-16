import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { createHmac } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import * as schema from '../db/schema';
import type { Db } from '../db/client';
import { createWebhook } from '../data/webhooks';
import { dispatchCrawlWebhook, dispatchGrantWebhook } from './dispatch';

/** A receiver's INDEPENDENT verification: recompute the MAC from the received timestamp + raw body + secret.
 *  Written with raw crypto (not the code under test) so a bug in signWebhook can't validate itself. */
function receiverVerifies(secret: string, timestamp: string, body: string, signatureHeader: string): boolean {
  const expected = 'sha256=' + createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return expected === signatureHeader;
}

interface Captured { url: string; headers: Record<string, string>; body: string }

/** A fake fetch that records every call and returns a scripted sequence of statuses (default 200). */
function makeFetch(statuses: number[] = [200]): { impl: typeof fetch; calls: Captured[] } {
  const calls: Captured[] = [];
  let i = 0;
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
    calls.push({ url: String(url), headers, body: String(init?.body ?? '') });
    const status = statuses[Math.min(i++, statuses.length - 1)];
    return { ok: status >= 200 && status < 300, status } as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const NOW = new Date('2026-07-01T12:00:00Z');
const EXPECTED_TS = String(Math.floor(NOW.getTime() / 1000));

describe('webhook dispatch (pglite)', () => {
  let client: PGlite;
  let db: Db;
  let connId: string;

  beforeAll(async () => {
    client = new PGlite();
    db = drizzle(client, { schema }) as unknown as Db;
    const dir = path.resolve(__dirname, '../../migrations');
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
      await client.exec(fs.readFileSync(path.join(dir, f), 'utf8'));
    }
  });
  afterAll(async () => { await client.close(); });
  beforeEach(async () => {
    await client.exec('truncate institutions cascade');
    await client.exec('truncate oauth_clients cascade');
    await client.exec('truncate webhooks cascade');
    await client.exec(`insert into institutions (id,name,login_url,canonical_domain,type) values ('bk','Bank','https://bk.com','bk.com','bank')`);
    const r = await client.query<{ id: string }>(`insert into connections (institution_id, username_ct, password_ct) values ('bk','u','p') returning id`);
    connId = r.rows[0].id;
  });

  async function insertGrant(): Promise<{ grantId: string; clientId: string }> {
    const clientId = 'accl_webhook_test';
    const clientRows = await client.query<{ id: string }>(`
      insert into oauth_clients (client_id, name, is_public, redirect_uris, allowed_scopes)
      values ($1, 'Webhook test app', true, '["https://consumer.example/callback"]', '["read:data"]')
      returning id
    `, [clientId]);
    const grant = await client.query<{ id: string }>(`
      insert into oauth_grants (client_id, scopes, connection_grants, expires_at)
      values ($1, '["read:data"]', $2, now() + interval '1 day')
      returning id
    `, [clientRows.rows[0].id, JSON.stringify([connId])]);
    return { grantId: grant.rows[0].id, clientId };
  }

  it('delivers a completed event with a receiver-verifiable HMAC and the correct payload', async () => {
    const { secret } = await createWebhook(db, { url: 'https://consumer.example/hook', events: ['crawl.completed', 'crawl.failed'] });
    const { impl, calls } = makeFetch();

    await dispatchCrawlWebhook(db, { connectionId: connId, sessionId: 'sess-1', event: 'crawl.completed', now: NOW, fetchImpl: impl });

    expect(calls).toHaveLength(1);
    const c = calls[0];
    expect(c.url).toBe('https://consumer.example/hook');
    expect(c.headers['x-accrawl-event']).toBe('crawl.completed');
    expect(c.headers['x-accrawl-timestamp']).toBe(EXPECTED_TS);
    // The signature a real receiver would independently reproduce from the raw bytes it got.
    expect(receiverVerifies(secret, c.headers['x-accrawl-timestamp'], c.body, c.headers['x-accrawl-signature'])).toBe(true);

    const payload = JSON.parse(c.body);
    expect(payload).toMatchObject({
      event: 'crawl.completed',
      connectionId: connId,
      institutionId: 'bk',
      sessionId: 'sess-1',
      status: 'completed',
      occurredAt: NOW.toISOString(),
    });
    expect(payload.error).toBeUndefined();
  });

  it('a tampered body fails the receiver check (the signature is over the exact bytes)', async () => {
    const { secret } = await createWebhook(db, { url: 'https://c.example/h', events: ['crawl.completed'] });
    const { impl, calls } = makeFetch();
    await dispatchCrawlWebhook(db, { connectionId: connId, sessionId: 's', event: 'crawl.completed', now: NOW, fetchImpl: impl });
    const c = calls[0];
    expect(receiverVerifies(secret, c.headers['x-accrawl-timestamp'], c.body + 'x', c.headers['x-accrawl-signature'])).toBe(false);
  });

  it('includes the error + status:failed on a crawl.failed event', async () => {
    await createWebhook(db, { url: 'https://c.example/h', events: ['crawl.failed'] });
    const { impl, calls } = makeFetch();
    await dispatchCrawlWebhook(db, { connectionId: connId, sessionId: 's2', event: 'crawl.failed', error: 'bank login failed', now: NOW, fetchImpl: impl });
    const payload = JSON.parse(calls[0].body);
    expect(payload.status).toBe('failed');
    expect(payload.error).toBe('bank login failed');
  });

  it('only delivers to endpoints subscribed to the event', async () => {
    await createWebhook(db, { url: 'https://only-failed.example/h', events: ['crawl.failed'] });
    const { impl, calls } = makeFetch();
    await dispatchCrawlWebhook(db, { connectionId: connId, sessionId: 's3', event: 'crawl.completed', now: NOW, fetchImpl: impl });
    expect(calls).toHaveLength(0); // subscribed to crawl.failed only → gets nothing for completed
  });

  it('does nothing (no fetch) when there are no webhooks', async () => {
    const { impl, calls } = makeFetch();
    await dispatchCrawlWebhook(db, { connectionId: connId, sessionId: 's4', event: 'crawl.completed', now: NOW, fetchImpl: impl });
    expect(calls).toHaveLength(0);
  });

  it('does not deliver to a disabled webhook', async () => {
    await createWebhook(db, { url: 'https://c.example/h', events: ['crawl.completed'] });
    await client.exec('update webhooks set disabled_at = now()');
    const { impl, calls } = makeFetch();
    await dispatchCrawlWebhook(db, { connectionId: connId, sessionId: 's5', event: 'crawl.completed', now: NOW, fetchImpl: impl });
    expect(calls).toHaveLength(0);
  });

  it('delivers over REAL HTTP (global fetch) to a live receiver that verifies the signature', async () => {
    // Start a real receiver, capture exactly what arrives on the wire.
    let received: { headers: http.IncomingHttpHeaders; body: string } | null = null;
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => { received = { headers: req.headers, body }; res.writeHead(200).end('ok'); });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const { secret } = await createWebhook(db, { url: `http://localhost:${port}/hook`, events: ['crawl.completed'] });
      // No fetchImpl → the real global fetch makes a real HTTP request.
      await dispatchCrawlWebhook(db, { connectionId: connId, sessionId: 'live-1', event: 'crawl.completed', now: NOW });
      expect(received).not.toBeNull();
      const got = received!;
      const ts = got.headers['x-accrawl-timestamp'] as string;
      const sig = got.headers['x-accrawl-signature'] as string;
      expect(receiverVerifies(secret, ts, got.body, sig)).toBe(true);
      expect(JSON.parse(got.body)).toMatchObject({ event: 'crawl.completed', connectionId: connId, sessionId: 'live-1', status: 'completed', institutionId: 'bk' });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('does NOT follow a redirect (a receiver cannot 302 the signed POST to an internal/plaintext target)', async () => {
    // Second server = the redirect TARGET. If fetch followed the 302, this would receive the signed POST.
    let internalHits = 0;
    const internal = http.createServer((_req, res) => { internalHits += 1; res.writeHead(200).end('ok'); });
    await new Promise<void>((r) => internal.listen(0, '127.0.0.1', r));
    const internalPort = (internal.address() as { port: number }).port;
    // First server = the registered endpoint, which maliciously 302s to the internal target.
    let firstHits = 0;
    const first = http.createServer((_req, res) => { firstHits += 1; res.writeHead(302, { location: `http://127.0.0.1:${internalPort}/steal` }).end(); });
    await new Promise<void>((r) => first.listen(0, '127.0.0.1', r));
    const firstPort = (first.address() as { port: number }).port;
    try {
      await createWebhook(db, { url: `http://localhost:${firstPort}/hook`, events: ['crawl.completed'] });
      await dispatchCrawlWebhook(db, { connectionId: connId, sessionId: 'redir', event: 'crawl.completed', now: NOW });
      expect(firstHits).toBeGreaterThanOrEqual(1); // the registered endpoint was hit
      expect(internalHits).toBe(0); // the redirect was NEVER followed to the internal target
    } finally {
      await new Promise<void>((r) => first.close(() => r()));
      await new Promise<void>((r) => internal.close(() => r()));
    }
  });

  it('retries a 5xx and succeeds; gives up immediately on a permanent 4xx', async () => {
    await createWebhook(db, { url: 'https://flaky.example/h', events: ['crawl.completed'] });
    const retry = makeFetch([500, 200]); // fail once, then succeed
    await dispatchCrawlWebhook(db, { connectionId: connId, sessionId: 's6', event: 'crawl.completed', now: NOW, fetchImpl: retry.impl });
    expect(retry.calls.length).toBe(2);

    const perm = makeFetch([400]); // permanent client error → one attempt, no retry
    await dispatchCrawlWebhook(db, { connectionId: connId, sessionId: 's6', event: 'crawl.completed', now: NOW, fetchImpl: perm.impl });
    expect(perm.calls.length).toBe(1);
  });

  it('delivers a grant.revoked event with the client_id and a receiver-verifiable HMAC', async () => {
    const { secret } = await createWebhook(db, { url: 'https://consumer.example/hook', events: ['grant.revoked'] });
    const { impl, calls } = makeFetch();
    const grant = await insertGrant();

    await dispatchGrantWebhook(db, { grantId: grant.grantId, clientId: grant.clientId, now: NOW, fetchImpl: impl });

    expect(calls).toHaveLength(1);
    const c = calls[0];
    expect(c.headers['x-accrawl-event']).toBe('grant.revoked');
    expect(receiverVerifies(secret, c.headers['x-accrawl-timestamp'], c.body, c.headers['x-accrawl-signature'])).toBe(true);
    expect(JSON.parse(c.body)).toMatchObject({
      event: 'grant.revoked',
      grantId: grant.grantId,
      clientId: grant.clientId,
      occurredAt: NOW.toISOString(),
    });
  });

  it('omits clientId from grant.revoked when it is unknown', async () => {
    await createWebhook(db, { url: 'https://c.example/h', events: ['grant.revoked'] });
    const { impl, calls } = makeFetch();
    const grant = await insertGrant();
    await dispatchGrantWebhook(db, { grantId: grant.grantId, clientId: null, now: NOW, fetchImpl: impl });
    const payload = JSON.parse(calls[0].body);
    expect(payload.grantId).toBe(grant.grantId);
    expect('clientId' in payload).toBe(false);
  });

  it('does not deliver grant.revoked to a crawl-only subscriber', async () => {
    await createWebhook(db, { url: 'https://c.example/h', events: ['crawl.completed', 'sync.succeeded'] });
    const { impl, calls } = makeFetch();
    const grant = await insertGrant();
    await dispatchGrantWebhook(db, { grantId: grant.grantId, clientId: grant.clientId, now: NOW, fetchImpl: impl });
    expect(calls).toHaveLength(0);
  });
});
