import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import type { Db } from '../db/client';
import type { CrawlStats } from '../db/schema';
import { applyCrawlSuccess, applyCrawlFailure, MAX_CONSECUTIVE_CRAWL_FAILURES } from './crawl-bookkeeping';

const today = new Date('2026-06-28T10:00:00Z');

describe('crawl bookkeeping (pglite)', () => {
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
    await client.exec(`insert into institutions (id,name,login_url,canonical_domain,type) values ('b','B','https://b.com','b.com','bank')`);
    const r = await client.query<{ id: string }>(`insert into connections (institution_id, username_ct, password_ct) values ('b','u','p') returning id`);
    connId = r.rows[0].id;
  });

  const load = async (): Promise<{ status: string; consecutiveFailures: number; safeErrorMessage: string | null; crawlMemory: string | null; crawlStats: CrawlStats }> => {
    const [c] = await db.select().from(schema.connections).where(eq(schema.connections.id, connId));
    return c as never;
  };

  it('success: connected, completed++, streak reset (column+jsonb), watermark = crawl day, memory + cost', async () => {
    await applyCrawlFailure(db, connId, { error: 'x', failureReason: 'bank_login_failed' }); // build a streak first
    await applyCrawlSuccess(db, connId, { crawlMemory: 'remember', costUsd: 0.02, today });

    const c = await load();
    expect(c.status).toBe('connected');
    expect(c.consecutiveFailures).toBe(0);
    expect(c.safeErrorMessage).toBeNull();
    expect(c.crawlMemory).toBe('remember');
    expect(c.crawlStats.completedCount).toBe(1);
    expect(c.crawlStats.consecutiveFailures).toBe(0);
    expect(c.crawlStats.lastSuccessfulTxCrawlDay).toBe('2026-06-28');
    expect(c.crawlStats.recentCosts).toEqual([0.02]);
    expect(c.crawlStats.avgCostUsd).toBeCloseTo(0.02);
    expect(c.crawlStats.lastFailureReason).toBeUndefined();
  });

  it('a successful crawl advances the transaction watermark even when the window is empty', async () => {
    await applyCrawlSuccess(db, connId, { today });
    expect((await load()).crawlStats.lastSuccessfulTxCrawlDay).toBe('2026-06-28');
  });

  it('a crawl with rejected transactions does not advance the watermark', async () => {
    await applyCrawlSuccess(db, connId, { today, transactionsRejected: 1 });
    expect((await load()).crawlStats.lastSuccessfulTxCrawlDay).toBeUndefined(); // held: the window is re-crawled
  });

  it('failure: error status, failed++, streak increments, and an unclassified attempt clears stale classification', async () => {
    const r1 = await applyCrawlFailure(db, connId, { error: 'boom', failureReason: 'bank_login_failed' });
    expect(r1.consecutiveFailures).toBe(1);
    const r2 = await applyCrawlFailure(db, connId, { error: 'boom2' });
    expect(r2.consecutiveFailures).toBe(2);

    const c = await load();
    expect(c.status).toBe('error');
    expect(c.consecutiveFailures).toBe(2);
    expect(c.safeErrorMessage).toBe('boom2');
    expect(c.crawlStats.failedCount).toBe(2);
    expect(c.crawlStats.consecutiveFailures).toBe(2);
    expect(c.crawlStats.lastFailureReason).toBeUndefined();
  });

  it('escalates to needs_reauth only when the threshold-crossing failure is rejected credentials', async () => {
    for (let i = 0; i < MAX_CONSECUTIVE_CRAWL_FAILURES; i++) {
      await applyCrawlFailure(db, connId, { error: `f${i}`, failureReason: 'bank_login_failed' });
      expect((await load()).status).toBe('error'); // still recoverable up to and including the threshold
    }
    const r = await applyCrawlFailure(db, connId, { error: 'final', failureReason: 'bank_login_failed' });
    expect(r.consecutiveFailures).toBe(MAX_CONSECUTIVE_CRAWL_FAILURES + 1);
    expect((await load()).status).toBe('needs_reauth'); // past the threshold -> won't recover on its own
  });

  it('keeps persistent non-auth and unclassified failures in error instead of falsely requesting credentials', async () => {
    for (let i = 0; i < MAX_CONSECUTIVE_CRAWL_FAILURES; i++) {
      await applyCrawlFailure(db, connId, { error: `f${i}`, failureReason: 'site_unavailable' });
    }
    await applyCrawlFailure(db, connId, { error: 'still down', failureReason: 'site_unavailable' });
    expect((await load()).status).toBe('error');

    // An absent classification also clears a previously stored auth reason and
    // cannot inherit it into a false reauthentication request.
    await db.update(schema.connections).set({
      status: 'error',
      consecutiveFailures: MAX_CONSECUTIVE_CRAWL_FAILURES,
      crawlStats: {
        ...((await load()).crawlStats),
        consecutiveFailures: MAX_CONSECUTIVE_CRAWL_FAILURES,
        lastFailureReason: 'bank_login_failed',
      },
    }).where(eq(schema.connections.id, connId));
    await applyCrawlFailure(db, connId, { error: 'unclassified failure' });
    const c = await load();
    expect(c.status).toBe('error');
    expect(c.crawlStats.lastFailureReason).toBeUndefined();
  });

  it('does not resurrect a disconnected (disabled) connection on success', async () => {
    await db.update(schema.connections).set({ status: 'disabled' }).where(eq(schema.connections.id, connId));
    await applyCrawlSuccess(db, connId, { today });
    expect((await load()).status).toBe('disabled'); // stays disabled — a completing crawl must not re-connect it
  });
});
