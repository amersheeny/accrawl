/**
 * pg-boss transport — the Postgres-native queue + cron that drive the scheduler.
 *
 * Two queues: a 'scheduler-tick' fired every minute (its worker runs schedulerTick, which enqueues due
 * crawls) and a 'crawl' queue whose worker runs a single crawl. Concurrency is still bounded by the
 * per-connection session lock inside runCrawl, so even if the same connection is enqueued twice only
 * one crawl proceeds. This needs a real Postgres (pg-boss owns its own schema), so it is validated at
 * deploy; the scheduling LOGIC it calls is unit-tested separately.
 */
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { PgBoss } from 'pg-boss';
import { db } from '../db/client';
import { schedulerTick } from './scheduler';
import { runCrawl } from '../orchestration/run-crawl';
import { restoreStaleScheduleClaim } from '../data/sessions';
import { connections } from '../db/schema';
import { dispatchCrawlToEngine } from '../orchestration/dispatch-engine';
import { CRAWL_EXPIRE_SECONDS } from '../lib/crawl-budget';
import { currentTenant, runAsTenant, type TenantRuntime } from '../tenancy/context';

const CRAWL_QUEUE = 'crawl';
const TICK_QUEUE = 'scheduler-tick';
const LEASE_OWNER = `${hostname()}:${randomUUID().slice(0, 8)}`;

// The crawl time budget (institution timeout ceiling, job expiry, lock lease) lives in lib/crawl-budget as
// the single source of truth. pg-boss's default 15-minute expiration would expire a longer job mid-login and
// retry it, triggering a redundant concurrent bank login; we size the expiration to CRAWL_EXPIRE_SECONDS so
// it outlives the longest crawl. Retries are owned by the scheduler's own due-row logic — so retryLimit=0.

export interface CrawlJobData {
  connectionId: string;
  scheduleRevision: number;
  scheduleClaim: string;
  priorStatus: (typeof connections.status.enumValues)[number];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Jobs written before schedule occurrence fencing contained only a
 * connectionId. They must be acknowledged as inert after an upgrade, never
 * reinterpreted as manual crawls by passing undefined fence fields onward.
 */
export function isFencedCrawlJobData(value: unknown): value is CrawlJobData {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<Record<keyof CrawlJobData, unknown>>;
  return typeof candidate.connectionId === 'string'
    && UUID.test(candidate.connectionId)
    && typeof candidate.scheduleRevision === 'number'
    && Number.isSafeInteger(candidate.scheduleRevision)
    && candidate.scheduleRevision >= 0
    && typeof candidate.scheduleClaim === 'string'
    && UUID.test(candidate.scheduleClaim)
    && typeof candidate.priorStatus === 'string'
    && connections.status.enumValues.includes(
      candidate.priorStatus as (typeof connections.status.enumValues)[number],
    );
}

export async function startScheduler(tenant: TenantRuntime = currentTenant()): Promise<PgBoss> {
  const boss = new PgBoss(tenant.databaseUrl);
  boss.on('error', (err) => console.error('[pg-boss] error:', err));
  await boss.start();
  // Size the crawl queue's expiration to outlive the longest crawl, and disable pg-boss-level retries
  // (the scheduler re-derives due rows itself) so an expired-then-retried job can't re-login concurrently.
  await boss.createQueue(CRAWL_QUEUE, { expireInSeconds: CRAWL_EXPIRE_SECONDS, retryLimit: 0 });
  await boss.createQueue(TICK_QUEUE);

  // One crawl per job. The session lock inside runCrawl guards against a duplicate enqueue.
  await boss.work<unknown>(CRAWL_QUEUE, async (jobs) => {
    await runAsTenant(tenant, async () => {
      for (const job of jobs) {
        if (!isFencedCrawlJobData(job.data)) {
          console.warn('[scheduler] discarded legacy or malformed unfenced crawl job');
          continue;
        }
        const {
          connectionId, scheduleRevision, scheduleClaim, priorStatus,
        } = job.data;
        const result = await runCrawl(
          db,
          { dispatchCrawl: dispatchCrawlToEngine, leaseOwner: `${tenant.id}:${LEASE_OWNER}` },
          {
            connectionId,
            expectedScheduleRevision: scheduleRevision,
            expectedScheduleClaim: scheduleClaim,
          },
        );
        if (
          result.outcome === 'locked'
        ) {
          await restoreStaleScheduleClaim(db, {
            connectionId,
            expectedScheduleRevision: scheduleRevision,
            expectedScheduleClaim: scheduleClaim,
            priorStatus,
          });
        }
      }
    });
  });

  // The tick: enqueue due crawls (and reap/escalate/self-heal).
  await boss.work(TICK_QUEUE, async () => {
    await runAsTenant(tenant, () => schedulerTick(db, {
      enqueueCrawl: async (connectionId, scheduleRevision, scheduleClaim, priorStatus) => {
        await boss.send(
          CRAWL_QUEUE,
          {
            connectionId, scheduleRevision, scheduleClaim, priorStatus,
          },
          { expireInSeconds: CRAWL_EXPIRE_SECONDS, retryLimit: 0 },
        );
      },
    }));
  });

  await boss.schedule(TICK_QUEUE, '* * * * *'); // every minute
  await boss.send(TICK_QUEUE, {}); // kick one immediately on boot

  console.log(`[scheduler] started for tenant ${tenant.id} — tick every minute, crawl queue active`);
  return boss;
}
