import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from 'fastify';
import { z } from 'zod';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { hostedWorkerPlane } from '../orchestration/hosted-worker-plane';
import {
  enqueueHostedCrawlReconciliation,
  type ScheduledConnectionTask,
} from '../orchestration/crawl-reconciliation-queue';
import { dispatchCrawlToEngine } from '../orchestration/dispatch-engine';
import { getHostedCrawlLifecycleStore } from '../storage';
import type {
  HostedCrawlLifecycleResult,
} from '../storage/hosted-crawl-lifecycle';

const reconciliationRequestSchema = z.object({
  version: z.literal(1),
  sessionId: z.uuid(),
  sequence: z.number().int().min(0).max(10_000),
  lane: z.enum(['lifecycle', 'cancellation', 'recovery']),
  generation: z.uuid(),
}).strict();
const scheduledConnectionRequestSchema = z.object({
  version: z.literal(1),
  kind: z.literal('scheduled-connection'),
  connectionId: z.uuid(),
  scheduleRevision: z.number().int().min(0),
  dueAt: z.iso.datetime({ offset: true }),
  sequence: z.number().int().min(0).max(10_000),
}).strict();
const requestSchema = z.union([
  reconciliationRequestSchema,
  scheduledConnectionRequestSchema,
]);
const SCHEDULE_LEASE_OWNER = `${hostname()}:hosted-schedule:${randomUUID().slice(0, 8)}`;

export interface HostedCrawlLifecycleRouteDependencies {
  verifyTask?: (
    authorization: string | string[] | undefined,
  ) => Promise<unknown>;
  reconcile?: (sessionId: string) => Promise<HostedCrawlLifecycleResult>;
  enqueue?: (
    sessionId: string,
    scheduleAt: Date | undefined,
    sequence: number,
    lane: 'lifecycle' | 'cancellation' | 'recovery',
    generation: string,
  ) => Promise<void>;
  scheduledState?: (
    task: ScheduledConnectionTask,
  ) => Promise<'stale' | 'pending' | 'early' | 'due'>;
  rearmEarly?: (task: ScheduledConnectionTask) => Promise<void>;
  runScheduled?: (task: ScheduledConnectionTask) => Promise<void>;
  advanceScheduled?: (
    task: ScheduledConnectionTask,
  ) => Promise<'dispatch' | 'advanced_without_dispatch' | 'retry' | 'stale'>;
  /** Arming sweep — see the tick route below. */
  ensureScheduled?: () => Promise<number>;
}

/**
 * The deferred callback coming back in, authenticated. No process-resident timer is authoritative:
 * every active or lease-blocked result commits its successor callback before this request returns 204.
 */
export async function hostedCrawlLifecycleRoutes(
  app: FastifyInstance,
  dependencies: HostedCrawlLifecycleRouteDependencies = {},
): Promise<void> {
  const verifyTask = dependencies.verifyTask
    ?? ((authorization: string | string[] | undefined) => {
      const plane = hostedWorkerPlane();
      if (!plane) {
        throw new Error(
          'The deferred-callback route needs hosted worker machinery, and none is registered.',
        );
      }
      return plane.verifyReconciler(authorization);
    });
  const reconcile = dependencies.reconcile
    ?? (async (sessionId) =>
      (await getHostedCrawlLifecycleStore())
        .reconcileCrawlLifecycle(sessionId));
  const enqueue = dependencies.enqueue
    ?? enqueueHostedCrawlReconciliation;
  const scheduledState = dependencies.scheduledState
    ?? (async (task) => (await getHostedCrawlLifecycleStore())
      .scheduledConnectionState(task));
  const rearmEarly = dependencies.rearmEarly
    ?? (async (task) => (await getHostedCrawlLifecycleStore())
      .rearmEarlyScheduledConnection(task));
  const runScheduled = dependencies.runScheduled
    ?? (async (task) => {
      const store = await getHostedCrawlLifecycleStore();
      let signalDispatching!: () => void;
      const dispatching = new Promise<void>((resolve) => { signalDispatching = resolve; });
      const run = store.runCrawl({
        leaseOwner: SCHEDULE_LEASE_OWNER,
        dispatchCrawl: async (crawlRequest) => {
          const acknowledgement = await dispatchCrawlToEngine(crawlRequest);
          if (acknowledgement.accepted) signalDispatching();
          return acknowledgement;
        },
      }, {
        connectionId: task.connectionId,
        expectedScheduleRevision: task.scheduleRevision,
      });
      await Promise.race([dispatching, run.then(() => undefined)]);
      run.catch((error) => {
        console.error('[scheduler] detached hosted scheduled crawl rejected:', error);
      });
    });
  const advanceScheduled = dependencies.advanceScheduled
    ?? (async (task) => (await getHostedCrawlLifecycleStore())
      .advanceScheduledConnection(task));
  const ensureScheduled = dependencies.ensureScheduled
    ?? (async () => (await getHostedCrawlLifecycleStore())
      .ensureScheduledConnections());

  const authenticate = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> => {
    try {
      await verifyTask(request.headers.authorization);
    } catch {
      await reply.code(401).send();
    }
  };

  /**
   * Arming sweep, driven from outside the process.
   *
   * Once a connection is armed, its occurrence rides a Cloud Task scheduled for
   * the due time, which survives the container. Arming is what did not: it ran
   * on a 60-second `setInterval` in this process, and this process runs on Cloud
   * Run with minScale=0 and CPU throttling — so the timer stopped whenever the
   * service scaled to zero, and nothing re-armed a connection that had fallen
   * off the chain. Scheduled crawling stopped on 2026-08-04 and stayed stopped,
   * because the only thing that could have restarted it was the timer that had
   * already died.
   *
   * A request cannot be scaled away. Cloud Scheduler calls this, and the sweep
   * re-arms anything unarmed. It changes no schedule: the per-connection cron
   * and timezone stay authoritative, and this only ensures each connection has
   * a live task for its next occurrence.
   *
   * Idempotent by construction — `ensureScheduledConnections` skips every
   * already-armed connection — so a duplicate tick, an overlapping tick or a
   * Cloud Scheduler retry costs a read and arms nothing twice.
   */
  app.post('/internal/hosted/crawl-schedule-tick', {
    preHandler: authenticate,
  }, async (_request, reply) => {
    reply.header('cache-control', 'no-store');
    const armed = await ensureScheduled();
    // 200 with a body rather than 204: the count is the signal that scheduling
    // is alive, and Cloud Scheduler records it against the job.
    return reply.code(200).send({ armed });
  });

  app.post('/internal/hosted/crawl-reconcile', {
    preHandler: authenticate,
  }, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const parsed = requestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send();
    const body = parsed.data;
    if ('kind' in body) {
      const state = await scheduledState(body);
      if (state === 'stale') return reply.code(204).send();
      if (state === 'pending') return reply.code(503).send();
      if (state === 'early') {
        await rearmEarly(body);
        return reply.code(204).send();
      }
      // Commit the successor before dispatch. Concurrent duplicate callbacks
      // can all observe the old due generation, but only the CAS winner may
      // start the crawl; every loser sees the advanced due document and exits.
      const advanced = await advanceScheduled(body);
      if (advanced === 'retry') return reply.code(503).send();
      if (advanced !== 'dispatch') return reply.code(204).send();
      await runScheduled(body);
      return reply.code(204).send();
    }
    const result = await reconcile(body.sessionId);
    if (
      result.state === 'active'
      || (
        result.state === 'terminal'
        && result.pendingDeliveries
        && result.reconcileAt
      )
    ) {
      await enqueue(
        body.sessionId,
        result.reconcileAt,
        body.sequence + 1,
        body.lane,
        body.generation,
      );
    }
    return reply.code(204).send();
  });
}
