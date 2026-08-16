import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { hostedCrawlLifecycleRoutes } from './hosted-crawl-lifecycle';

const SESSION_ID = '00000000-0000-4000-8000-000000000001';
const GENERATION = '00000000-0000-4000-8000-000000000002';
const SCHEDULED_TASK = {
  version: 1,
  kind: 'scheduled-connection',
  connectionId: SESSION_ID,
  scheduleRevision: 2,
  dueAt: '2026-08-01T06:00:00.000Z',
  sequence: 0,
} as const;

describe('hosted crawl lifecycle callback', () => {
  it('rejects missing identity and malformed payloads before reconciliation', async () => {
    const app = Fastify();
    const reconcile = vi.fn(async () => ({ state: 'missing' as const }));
    await app.register(hostedCrawlLifecycleRoutes, {
      verifyTask: async (authorization) => {
        if (authorization !== 'Bearer task-identity') {
          throw new Error('wrong caller');
        }
      },
      reconcile,
      enqueue: vi.fn(async () => {}),
    });

    expect((await app.inject({
      method: 'POST',
      url: '/internal/hosted/crawl-reconcile',
      payload: {
        version: 1,
        sessionId: SESSION_ID,
        sequence: 0,
        lane: 'lifecycle',
        generation: GENERATION,
      },
    })).statusCode).toBe(401);
    expect((await app.inject({
      method: 'POST',
      url: '/internal/hosted/crawl-reconcile',
      headers: { authorization: 'Bearer task-identity' },
      payload: {
        version: 1,
        sessionId: 'wrong',
        sequence: 0,
        lane: 'lifecycle',
        generation: GENERATION,
        extra: true,
      },
    })).statusCode).toBe(400);
    expect(reconcile).not.toHaveBeenCalled();
    await app.close();
  });

  it('does not acknowledge active work until the successor task is durable', async () => {
    const app = Fastify();
    let acknowledge!: () => void;
    const queued = new Promise<void>((resolve) => {
      acknowledge = resolve;
    });
    const enqueue = vi.fn(async () => queued);
    const reconcileAt = new Date('2026-07-27T12:02:00.000Z');
    await app.register(hostedCrawlLifecycleRoutes, {
      verifyTask: async () => {},
      reconcile: async () => ({ state: 'active', reconcileAt }),
      enqueue,
    });

    let settled = false;
    const response = app.inject({
      method: 'POST',
      url: '/internal/hosted/crawl-reconcile',
      headers: { authorization: 'Bearer task-identity' },
      payload: {
        version: 1,
        sessionId: SESSION_ID,
        sequence: 4,
        lane: 'cancellation',
        generation: GENERATION,
      },
    }).then((value) => {
      settled = true;
      return value;
    });
    await vi.waitFor(() => {
      expect(enqueue).toHaveBeenCalledWith(
        SESSION_ID,
        reconcileAt,
        5,
        'cancellation',
        GENERATION,
      );
    });
    expect(settled).toBe(false);
    acknowledge();
    expect((await response).statusCode).toBe(204);
    await app.close();
  });

  it('lets the callback queue retry a failed successor enqueue and stops at terminal completion', async () => {
    const failed = Fastify();
    await failed.register(hostedCrawlLifecycleRoutes, {
      verifyTask: async () => {},
      reconcile: async () => ({
        state: 'active',
        reconcileAt: new Date('2026-07-27T12:02:00.000Z'),
      }),
      enqueue: async () => {
        throw new Error('queue unavailable');
      },
    });
    expect((await failed.inject({
      method: 'POST',
      url: '/internal/hosted/crawl-reconcile',
      headers: { authorization: 'Bearer task-identity' },
      payload: {
        version: 1,
        sessionId: SESSION_ID,
        sequence: 0,
        lane: 'lifecycle',
        generation: GENERATION,
      },
    })).statusCode).toBe(500);
    await failed.close();

    const terminal = Fastify();
    const enqueue = vi.fn(async () => {});
    await terminal.register(hostedCrawlLifecycleRoutes, {
      verifyTask: async () => {},
      reconcile: async () => ({
        state: 'terminal',
        pendingDeliveries: false,
      }),
      enqueue,
    });
    expect((await terminal.inject({
      method: 'POST',
      url: '/internal/hosted/crawl-reconcile',
      headers: { authorization: 'Bearer task-identity' },
      payload: {
        version: 1,
        sessionId: SESSION_ID,
        sequence: 0,
        lane: 'lifecycle',
        generation: GENERATION,
      },
    })).statusCode).toBe(204);
    expect(enqueue).not.toHaveBeenCalled();
    await terminal.close();
  });

  it('ignores stale schedule deliveries and re-arms early horizon wake-ups', async () => {
    for (const state of ['stale', 'early'] as const) {
      const app = Fastify();
      const rearmEarly = vi.fn(async () => {});
      const runScheduled = vi.fn(async () => {});
      const advanceScheduled = vi.fn(async () => 'dispatch' as const);
      await app.register(hostedCrawlLifecycleRoutes, {
        verifyTask: async () => {},
        scheduledState: async () => state,
        rearmEarly,
        runScheduled,
        advanceScheduled,
      });
      expect((await app.inject({
        method: 'POST',
        url: '/internal/hosted/crawl-reconcile',
        headers: { authorization: 'Bearer task-identity' },
        payload: SCHEDULED_TASK,
      })).statusCode).toBe(204);
      expect(rearmEarly).toHaveBeenCalledTimes(state === 'early' ? 1 : 0);
      expect(runScheduled).not.toHaveBeenCalled();
      expect(advanceScheduled).not.toHaveBeenCalled();
      await app.close();
    }
  });

  it('asks the callback queue to retry while a due generation is still being armed', async () => {
    const app = Fastify();
    await app.register(hostedCrawlLifecycleRoutes, {
      verifyTask: async () => {},
      scheduledState: async () => 'pending',
    });
    expect((await app.inject({
      method: 'POST',
      url: '/internal/hosted/crawl-reconcile',
      headers: { authorization: 'Bearer task-identity' },
      payload: SCHEDULED_TASK,
    })).statusCode).toBe(503);
    await app.close();
  });

  it('durably advances a due schedule before starting only the CAS winner', async () => {
    const app = Fastify();
    const order: string[] = [];
    await app.register(hostedCrawlLifecycleRoutes, {
      verifyTask: async () => {},
      scheduledState: async () => 'due',
      runScheduled: async () => { order.push('run'); },
      advanceScheduled: async () => { order.push('advance'); return 'dispatch'; },
    });
    expect((await app.inject({
      method: 'POST',
      url: '/internal/hosted/crawl-reconcile',
      headers: { authorization: 'Bearer task-identity' },
      payload: SCHEDULED_TASK,
    })).statusCode).toBe(204);
    expect(order).toEqual(['advance', 'run']);
    await app.close();
  });

  it('does not start a scheduled crawl when another callback already advanced it', async () => {
    const app = Fastify();
    const runScheduled = vi.fn(async () => {});
    await app.register(hostedCrawlLifecycleRoutes, {
      verifyTask: async () => {},
      scheduledState: async () => 'due',
      advanceScheduled: async () => 'stale',
      runScheduled,
    });
    expect((await app.inject({
      method: 'POST',
      url: '/internal/hosted/crawl-reconcile',
      headers: { authorization: 'Bearer task-identity' },
      payload: SCHEDULED_TASK,
    })).statusCode).toBe(204);
    expect(runScheduled).not.toHaveBeenCalled();
    await app.close();
  });

  it('advances a backed-off schedule without dispatching a crawl', async () => {
    const app = Fastify();
    const runScheduled = vi.fn(async () => {});
    await app.register(hostedCrawlLifecycleRoutes, {
      verifyTask: async () => {},
      scheduledState: async () => 'due',
      advanceScheduled: async () => 'advanced_without_dispatch',
      runScheduled,
    });
    expect((await app.inject({
      method: 'POST',
      url: '/internal/hosted/crawl-reconcile',
      headers: { authorization: 'Bearer task-identity' },
      payload: SCHEDULED_TASK,
    })).statusCode).toBe(204);
    expect(runScheduled).not.toHaveBeenCalled();
    await app.close();
  });

  it('asks the callback queue to retry when scheduling state changes during advancement', async () => {
    const app = Fastify();
    const runScheduled = vi.fn(async () => {});
    await app.register(hostedCrawlLifecycleRoutes, {
      verifyTask: async () => {},
      scheduledState: async () => 'due',
      advanceScheduled: async () => 'retry',
      runScheduled,
    });
    expect((await app.inject({
      method: 'POST',
      url: '/internal/hosted/crawl-reconcile',
      headers: { authorization: 'Bearer task-identity' },
      payload: SCHEDULED_TASK,
    })).statusCode).toBe(503);
    expect(runScheduled).not.toHaveBeenCalled();
    await app.close();
  });
});

/**
 * The arming sweep is what stopped. Occurrences ride the callback queue and survive the
 * container, but arming ran on a 60-second interval inside a scale-to-zero service
 * with minScale=0, so it died whenever the service scaled to zero and nothing
 * re-armed a connection that had fallen off the chain. Scheduled crawling
 * stopped on 2026-08-04 and could not restart itself.
 *
 * These pin the properties that make an external caller a safe replacement.
 */
describe('hosted crawl schedule tick', () => {
  const tick = (payload: unknown = {}, authorization = 'Bearer task-identity') =>
    ({ method: 'POST' as const, url: '/internal/hosted/crawl-schedule-tick',
       headers: { authorization }, payload });

  it('arms unarmed connections and reports how many', async () => {
    const app = Fastify();
    const ensureScheduled = vi.fn(async () => 3);
    await app.register(hostedCrawlLifecycleRoutes, {
      verifyTask: async () => {}, ensureScheduled,
    });

    const response = await app.inject(tick());
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ armed: 3 });
    expect(ensureScheduled).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('refuses a caller without the reconciler identity', async () => {
    // The endpoint arms real crawls against real credentials. It carries the
    // same identity check as the reconcile callback, not a weaker one.
    const app = Fastify();
    const ensureScheduled = vi.fn(async () => 0);
    await app.register(hostedCrawlLifecycleRoutes, {
      verifyTask: async (authorization) => {
        if (authorization !== 'Bearer task-identity') throw new Error('wrong caller');
      },
      ensureScheduled,
    });

    expect((await app.inject(tick({}, 'Bearer someone-else'))).statusCode).toBe(401);
    expect((await app.inject(tick({}, ''))).statusCode).toBe(401);
    expect(ensureScheduled).not.toHaveBeenCalled();
    await app.close();
  });

  it('is safe to call repeatedly', async () => {
    // Cloud Scheduler retries, and ticks can overlap a slow sweep. Arming is
    // per-connection and skips anything already armed, so repeats must not
    // double-arm — the count simply falls to zero once everything is armed.
    const app = Fastify();
    let remaining = 2;
    const ensureScheduled = vi.fn(async () => {
      const armed = remaining;
      remaining = 0;
      return armed;
    });
    await app.register(hostedCrawlLifecycleRoutes, {
      verifyTask: async () => {}, ensureScheduled,
    });

    expect((await app.inject(tick())).json()).toEqual({ armed: 2 });
    expect((await app.inject(tick())).json()).toEqual({ armed: 0 });
    expect((await app.inject(tick())).json()).toEqual({ armed: 0 });
    await app.close();
  });
});
