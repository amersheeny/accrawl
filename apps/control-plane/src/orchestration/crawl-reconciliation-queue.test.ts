import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runAsTenant, type TenantRuntime } from '../tenancy/context';
import {
  enqueueHostedCrawlReconciliation,
  enqueueHostedScheduledConnection,
  registerDeferredCallbackQueue,
  resetDeferredCallbackQueueForTest,
  type DeferredCallback,
} from './crawl-reconciliation-queue';

const SESSION_ID = '00000000-0000-4000-8000-000000000001';
const GENERATION = '00000000-0000-4000-8000-000000000002';
const NOW = Date.parse('2026-07-27T12:00:00.000Z');
const now = () => NOW;

const tenant = {
  id: 'accrawl',
  hosts: ['ACCRAWL.EXAMPLE'],
  databaseUrl: '',
  engineUrl: '',
} as unknown as TenantRuntime;

let queued: DeferredCallback[];
let enqueue: ReturnType<typeof vi.fn>;

beforeEach(() => {
  process.env.NODE_ENV = 'test';
  queued = [];
  enqueue = vi.fn(async (callback: DeferredCallback) => {
    queued.push(callback);
  });
  registerDeferredCallbackQueue(() => ({ enqueue }));
});

afterEach(() => {
  resetDeferredCallbackQueueForTest();
});

function asTenant<T>(fn: () => Promise<T>): Promise<T> {
  return runAsTenant(tenant, fn);
}

describe('looking in on a crawl later', () => {
  it('describes one callback: when, for whom, and carrying what', async () => {
    await asTenant(() => enqueueHostedCrawlReconciliation(
      SESSION_ID,
      new Date(NOW + 125_000),
      7,
      'cancellation',
      GENERATION,
      now,
    ));

    expect(enqueue).toHaveBeenCalledOnce();
    const callback = queued[0]!;
    expect(callback.id).toBe(
      'crawl-cancellation-00000000-0000-4000-8000-000000000002-'
      + '00000000-0000-4000-8000-000000000001-7',
    );
    expect(callback.notBefore).toBe(NOW + 125_000);
    expect(callback.deadlineSeconds).toBe(300);
    expect(callback.headers).toEqual({
      'content-type': 'application/json',
      'x-accrawl-tenant-host': 'accrawl.example',
    });
    expect(JSON.parse(callback.body)).toEqual({
      version: 1,
      sessionId: SESSION_ID,
      sequence: 7,
      lane: 'cancellation',
      generation: GENERATION,
    });
  });

  it('refuses malformed input before anything is queued', async () => {
    await expect(asTenant(() => enqueueHostedCrawlReconciliation('not-a-session')))
      .rejects.toThrow(/session id/);
    await expect(asTenant(() => enqueueHostedCrawlReconciliation(
      SESSION_ID,
      new Date(NOW + 31 * 24 * 60 * 60 * 1_000),
      0,
      'lifecycle',
      GENERATION,
      now,
    ))).rejects.toThrow(/schedule/);
    await expect(asTenant(() => enqueueHostedCrawlReconciliation(
      SESSION_ID, new Date(NOW), -1, 'lifecycle', GENERATION, now,
    ))).rejects.toThrow(/sequence/);
    await expect(asTenant(() => enqueueHostedCrawlReconciliation(
      SESSION_ID, new Date(NOW), 0, 'lifecycle', 'not-a-generation', now,
    ))).rejects.toThrow(/generation/);
    await expect(runAsTenant(
      { ...tenant, hosts: ['accrawl.example:443'] },
      () => enqueueHostedCrawlReconciliation(SESSION_ID, new Date(NOW), 0, 'lifecycle', GENERATION, now),
    )).rejects.toThrow(/tenant host/);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('gives a re-armed lane a fresh identity, so it is not mistaken for the old one', async () => {
    // The identity is what makes a duplicate delivery harmless. Re-arming the same lane needs a NEW
    // callback, so it must not collide with the name the previous one already spent.
    const second = '00000000-0000-4000-8000-000000000003';
    await asTenant(() => enqueueHostedCrawlReconciliation(
      SESSION_ID, new Date(NOW), 0, 'recovery', GENERATION, now,
    ));
    await asTenant(() => enqueueHostedCrawlReconciliation(
      SESSION_ID, new Date(NOW), 0, 'recovery', second, now,
    ));

    expect(new Set(queued.map((callback) => callback.id)).size).toBe(2);
    expect(queued[0]!.id).toContain(GENERATION);
    expect(queued[1]!.id).toContain(second);
  });

  it('lets a queue failure reach the caller, because it is the durability boundary', async () => {
    enqueue.mockRejectedValueOnce(new Error('queue unavailable'));
    await expect(asTenant(() => enqueueHostedCrawlReconciliation(
      SESSION_ID, new Date(NOW), 0, 'lifecycle', GENERATION, now,
    ))).rejects.toThrow('queue unavailable');
  });

  it('says what to register when this deployment has no queue', async () => {
    resetDeferredCallbackQueueForTest();
    await expect(asTenant(() => enqueueHostedCrawlReconciliation(
      SESSION_ID, new Date(NOW), 0, 'lifecycle', GENERATION, now,
    ))).rejects.toThrow(/registerDeferredCallbackQueue/);
  });
});

describe('crawling a scheduled connection when it falls due', () => {
  it('wakes at the due instant, carrying the occurrence it is for', async () => {
    const dueAt = new Date(NOW + 60_000);
    await asTenant(() => enqueueHostedScheduledConnection(SESSION_ID, dueAt, 3, 0, now));

    const callback = queued[0]!;
    expect(callback.notBefore).toBe(dueAt.getTime());
    expect(callback.id).toContain(`schedule-${SESSION_ID}-3-`);
    expect(JSON.parse(callback.body)).toEqual({
      version: 1,
      kind: 'scheduled-connection',
      connectionId: SESSION_ID,
      scheduleRevision: 3,
      dueAt: dueAt.toISOString(),
      sequence: 0,
    });
  });

  it('wakes early for a distant occurrence rather than trusting a queue to hold it', async () => {
    // A monthly schedule is further out than a queue will keep a callback; the intermediary wake-up
    // re-arms it, and the payload still names the real due time.
    for (const days of [31, 366]) {
      queued = [];
      const dueAt = new Date(NOW + days * 24 * 60 * 60 * 1_000);
      await asTenant(() => enqueueHostedScheduledConnection(SESSION_ID, dueAt, 0, 0, now));
      expect(queued[0]!.notBefore).toBe(NOW + 29 * 24 * 60 * 60 * 1_000);
      expect(JSON.parse(queued[0]!.body).dueAt).toBe(dueAt.toISOString());
    }
  });

  it('catches up immediately on an occurrence that came due while nothing was running', async () => {
    await asTenant(() => enqueueHostedScheduledConnection(
      SESSION_ID,
      new Date(NOW - 7 * 24 * 60 * 60 * 1_000),
      0,
      0,
      now,
    ));
    expect(queued[0]!.notBefore).toBe(NOW);
  });

  it('refuses malformed input before anything is queued', async () => {
    await expect(asTenant(() => enqueueHostedScheduledConnection('nope', new Date(NOW), 0, 0, now)))
      .rejects.toThrow(/connection id/);
    await expect(asTenant(() => enqueueHostedScheduledConnection(SESSION_ID, new Date(NOW), -1, 0, now)))
      .rejects.toThrow(/revision/);
    await expect(asTenant(() => enqueueHostedScheduledConnection(SESSION_ID, new Date(NaN), 0, 0, now)))
      .rejects.toThrow(/due time/);
    expect(enqueue).not.toHaveBeenCalled();
  });
});
