/**
 * One-shot hosted-cell worker.
 *
 * A Kubernetes Job starts this entrypoint with a tenant-scoped database URL, a
 * job-envelope key, and a one-job claim token. It atomically claims one durable
 * job, executes the public Accrawl crawler, records the outcome, and exits. It
 * never starts the shared HTTP service and owns no work after process exit.
 */
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import postgres, { type Sql } from 'postgres';
import { decryptCrawlJobPayload, type CrawlRequest, type CrawlResponse } from '@accrawl/contracts';
import { CrawlCleanupError, executeCrawl, activeSessions } from './crawl-executor';
import { closeBrowser } from './browser/browser-pool';
import { createServer, type Server } from 'node:http';
import { attachTunnelHandler, fenceCrawl, parkCrawlRequest } from './tunnel/tunnel-server';
import type { BrowserContext } from 'playwright';
import { workerDatabaseConnectionParameters } from './platform/worker-database-scope';
import {
  loadSecretEnvironment,
  requiredEnvironment,
} from './utils/secret-environment';

const LEASE_SECONDS = 120;
const HEARTBEAT_MS = 30_000;
const SELF_FENCE_GRACE_MS = 5_000;
const CLAIM_OWNER_POLL_MS = 1_000;
const TERMINAL_JOB_STATUSES = new Set(['succeeded', 'failed', 'cancelled']);
const TERMINAL_SESSION_STATUSES = new Set(['completed', 'failed', 'cancelled']);

type TerminalJobStatus = 'succeeded' | 'failed' | 'cancelled';

export interface OwnershipMonitor {
  /** Resolves only after every supplied fencing action succeeds; rejects otherwise. */
  fenced: Promise<string>;
  stop: () => void;
}

export interface OwnershipMonitorOptions {
  heartbeat: () => Promise<string | null>;
  fence: (reason: string) => Promise<void> | void;
  leaseMs?: number;
  heartbeatMs?: number;
  /** Stop external activity this long before the database lease can expire. */
  fenceGraceMs?: number;
  /** The instant the last durable claim/heartbeat attempt began. */
  confirmedAt?: number;
  now?: () => number;
}

export class OwnershipFenceError extends Error {
  constructor(
    public readonly fenceReason: string,
    cause: unknown,
  ) {
    super(`crawl-job ownership fence failed (${fenceReason})`, { cause });
    this.name = 'OwnershipFenceError';
  }
}

/**
 * Maintain the worker's local ownership fence.
 *
 * Only an exact `running` heartbeat response renews ownership. A cancellation,
 * failed/reaped row, or NULL response fences immediately. Transport failures do
 * not extend the lease, and a separate deadline timer fences even when a
 * heartbeat query never resolves. Deadlines are measured from the start of the
 * successful database attempt—not response receipt—so network delay can never
 * make the worker outlive the database lease it is mirroring.
 */
export function startOwnershipMonitor(options: OwnershipMonitorOptions): OwnershipMonitor {
  const leaseMs = options.leaseMs ?? LEASE_SECONDS * 1_000;
  const heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;
  const fenceGraceMs = Math.max(
    0,
    Math.min(options.fenceGraceMs ?? SELF_FENCE_GRACE_MS, leaseMs),
  );
  const now = options.now ?? Date.now;
  let stopped = false;
  let polling = false;
  let leaseTimer: ReturnType<typeof setTimeout> | undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let resolveFenced!: (reason: string) => void;
  let rejectFenced!: (error: OwnershipFenceError) => void;
  const fenced = new Promise<string>((resolve, reject) => {
    resolveFenced = resolve;
    rejectFenced = reject;
  });

  const clearTimers = (): void => {
    if (leaseTimer) clearTimeout(leaseTimer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    leaseTimer = undefined;
    heartbeatTimer = undefined;
  };

  const trigger = (reason: string): void => {
    if (stopped) return;
    stopped = true;
    clearTimers();
    void Promise.resolve(options.fence(reason)).then(
      () => resolveFenced(reason),
      (error: unknown) => rejectFenced(new OwnershipFenceError(reason, error)),
    );
  };

  const armLease = (confirmedAt: number): void => {
    if (stopped) return;
    if (leaseTimer) clearTimeout(leaseTimer);
    const remaining = Math.max(0, confirmedAt + leaseMs - fenceGraceMs - now());
    // setTimeout(0) still yields to the caller. If claiming/decryption already
    // consumed the local ownership window, fence synchronously so runJobWorker
    // observes its AbortSignal before it can invoke execute() or park().
    if (remaining === 0) {
      trigger('crawl-job ownership lease expired');
      return;
    }
    leaseTimer = setTimeout(
      () => trigger('crawl-job ownership lease expired'),
      remaining,
    );
    leaseTimer.unref?.();
  };

  const poll = async (): Promise<void> => {
    if (stopped || polling) return;
    polling = true;
    const attemptStartedAt = now();
    try {
      const status = await options.heartbeat();
      if (stopped) return;
      if (status !== 'running') {
        trigger(`crawl-job ownership revoked (status: ${status ?? 'missing'})`);
        return;
      }
      armLease(attemptStartedAt);
    } catch (error) {
      // The independently armed lease remains authoritative. In particular,
      // never "retry by renewal": a transport error provides no ownership fact.
      console.warn('[job-worker] job heartbeat failed:', error);
    } finally {
      polling = false;
    }
  };

  armLease(options.confirmedAt ?? now());
  heartbeatTimer = setInterval(() => void poll(), heartbeatMs);
  heartbeatTimer.unref?.();

  return {
    fenced,
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearTimers();
    },
  };
}

export function isSuccessfulFinalization(
  response: CrawlResponse,
  finalStatus: string | null | undefined,
): boolean {
  return response.success === true && finalStatus === 'succeeded';
}

export interface JobWorkerDependencies {
  connect: (databaseUrl: string, connection: Record<string, string>) => Sql;
  execute: (request: CrawlRequest, signal?: AbortSignal) => Promise<CrawlResponse>;
  park: (request: CrawlRequest) => Promise<CrawlResponse>;
  activeContexts: Map<string, BrowserContext>;
  closeBrowser: () => Promise<void>;
  installSignalHandlers: boolean;
  /** Immediate PID-1 termination; the container runtime then kills every Chrome child. */
  terminate: (code: number) => never;
}

const defaultDependencies: JobWorkerDependencies = {
  connect: (databaseUrl, connection) => postgres(databaseUrl, {
    max: 1,
    idle_timeout: 20,
    connection,
  }),
  execute: (request, signal) => executeCrawl(
    request,
    undefined,
    signal ? { signal } : {},
  ),
  park: parkCrawlRequest,
  activeContexts: activeSessions,
  closeBrowser,
  installSignalHandlers: true,
  terminate: (code) => process.exit(code),
};

async function requirePositiveFence(actions: Array<Promise<unknown>>): Promise<void> {
  const results = await Promise.allSettled(actions);
  const failures = results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : []);
  if (failures.length > 0) {
    throw new AggregateError(failures, 'one or more crawl execution paths could not be fenced');
  }
}

/**
 * Kubernetes documents that even a non-parallel Job can rarely start the pod
 * template more than once. A pod that loses the irreversible database claim
 * must not exit successfully while the owning pod is still crawling: one
 * successful pod would make the whole Job complete and Kubernetes could kill
 * the owner. Keep the loser non-terminal until both the owning crawl-job row
 * and its session reach terminal results. The owner scrubs its encrypted
 * envelope in the job transition, while the session transition proves that
 * promotion/bookkeeping also finished; both happen-before a duplicate can
 * complete the Kubernetes Job.
 */
export async function waitForOwningJob(
  sql: Sql,
  jobId: string,
  claimToken: string,
  pause: (milliseconds: number) => Promise<void> =
    (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
): Promise<TerminalJobStatus | null> {
  for (;;) {
    let rows: Array<{
      job_status: string | null;
      session_status: string | null;
    }>;
    try {
      rows = await sql`
        select
          job_status,
          observed_session_status as session_status
        from accrawl_observe_crawl_job(${jobId}::uuid, ${claimToken})`;
    } catch (error) {
      // A claim loser must never fail the Kubernetes Job while its owner may
      // still be live. Keep it non-terminal through transient or configuration
      // errors; activeDeadlineSeconds remains the outer bound.
      console.warn('[job-worker] could not observe owning job; retrying:', error);
      await pause(CLAIM_OWNER_POLL_MS);
      continue;
    }
    const jobStatus = rows[0]?.job_status;
    const sessionStatus = rows[0]?.session_status;
    if (!jobStatus || !sessionStatus) return null;
    if (TERMINAL_JOB_STATUSES.has(jobStatus)
      && TERMINAL_SESSION_STATUSES.has(sessionStatus)) {
      // The session is the externally authoritative crawl outcome. The job
      // status proves only that payload cleanup/worker reconciliation is done:
      // an owner can finish and be promoted, then die before finalizing its job
      // row, which the reaper correctly scrubs as failed.
      if (sessionStatus === 'completed') return 'succeeded';
      if (sessionStatus === 'cancelled') return 'cancelled';
      return 'failed';
    }
    await pause(CLAIM_OWNER_POLL_MS);
  }
}

export async function runJobWorker(
  overrides: Partial<JobWorkerDependencies> = {},
): Promise<void> {
  const dependencies = { ...defaultDependencies, ...overrides };
  if ((process.env.PLATFORM ?? 'postgres').toLowerCase() === 'remote') {
    const { runRemoteJobWorker } = await import('./remote-job-worker');
    await runRemoteJobWorker({
      execute: dependencies.execute,
      activeContexts: dependencies.activeContexts,
      closeBrowser: dependencies.closeBrowser,
      installSignalHandlers: dependencies.installSignalHandlers,
      terminate: dependencies.terminate,
    });
    return;
  }
  const databaseUrl = loadSecretEnvironment('ENGINE_DATABASE_URL');
  const jobEncryptionKey = loadSecretEnvironment('JOB_ENCRYPTION_KEY');
  loadSecretEnvironment('GEMINI_API_KEY');
  loadSecretEnvironment('ENGINE_SHARED_SECRET');
  const jobId = requiredEnvironment('ENGINE_JOB_ID');
  const claimToken = requiredEnvironment('ENGINE_JOB_TOKEN');
  const tenantId = requiredEnvironment('ACCRAWL_TENANT_ID');
  const workerName = `${hostname()}:${randomUUID().slice(0, 8)}`;
  process.env.ACCRAWL_WORKER_NAME = workerName;
  const sql = dependencies.connect(
    databaseUrl,
    workerDatabaseConnectionParameters('accrawl-job-worker'),
  );
  const workAbort = new AbortController();

  let ownership: OwnershipMonitor | undefined;
  let tunnelServer: Server | undefined;
  let stopping = false;
  const stop = async (signal: NodeJS.Signals): Promise<void> => {
    if (stopping) return;
    stopping = true;
    workAbort.abort(new Error(`worker received ${signal}`));
    console.warn(`[job-worker] ${signal} received; fencing active crawl paths`);
    try {
      await requirePositiveFence([
        ...[...dependencies.activeContexts.values()].map((context) => context.close()),
        dependencies.closeBrowser(),
      ]);
      // Settling a parked device-proxy request can resolve `work`. Do it only
      // after browser/context teardown, so work can never win the race before
      // the positive execution fence exists.
      await fenceCrawl(jobId, `worker received ${signal}`);
    } catch (error) {
      console.error('[job-worker] signal fence failed; terminating the worker container:', error);
      dependencies.terminate(1);
    }
  };
  if (dependencies.installSignalHandlers) {
    process.once('SIGTERM', () => void stop('SIGTERM'));
    process.once('SIGINT', () => void stop('SIGINT'));
  }

  try {
    const claimStartedAt = Date.now();
    const claimed = await sql<Array<{ encrypted_payload: string; job_status: string }>>`
      select encrypted_payload, job_status
      from accrawl_claim_crawl_job(
        ${jobId}::uuid,
        ${claimToken},
        ${workerName},
        ${LEASE_SECONDS}
      )`;
    if (claimed.length !== 1) {
      console.warn(`[job-worker] job ${jobId} was not claimable; waiting for its durable owner`);
      const ownerStatus = await waitForOwningJob(sql, jobId, claimToken);
      if (ownerStatus !== 'succeeded') process.exitCode = 1;
      return;
    }

    const request = decryptCrawlJobPayload(
      jobEncryptionKey,
      tenantId,
      jobId,
      claimed[0].encrypted_payload,
    );
    if (request.sessionId !== jobId) {
      throw new Error('crawl-job payload session does not match the claimed job');
    }

    const fenceActiveWork = async (reason: string): Promise<void> => {
      workAbort.abort(new Error(reason));
      console.warn(`[job-worker] fencing job ${jobId}: ${reason}`);
      await requirePositiveFence([
        ...[...dependencies.activeContexts.values()].map((context) => context.close()),
        dependencies.closeBrowser(),
      ]);
      await fenceCrawl(jobId, reason);
    };
    ownership = startOwnershipMonitor({
      confirmedAt: claimStartedAt,
      heartbeat: async () => {
        const [row] = await sql<Array<{ status: string | null }>>`
          select accrawl_heartbeat_crawl_job(
          ${jobId}::uuid,
          ${claimToken},
          ${workerName},
          ${LEASE_SECONDS}
          ) as status`;
        return row?.status ?? null;
      },
      fence: fenceActiveWork,
    });

    const work = (async (): Promise<CrawlResponse> => {
      workAbort.signal.throwIfAborted();
      if (request.useDeviceProxy) {
        tunnelServer = createServer((_req, res) => {
          res.writeHead(404);
          res.end();
        });
        attachTunnelHandler(tunnelServer);
        await new Promise<void>((resolve, reject) => {
          tunnelServer!.once('error', reject);
          tunnelServer!.listen(8080, '0.0.0.0', resolve);
        });
        // Ownership may be revoked while the socket is binding. Do not create a
        // fresh parked request after fenceCrawl already swept the registry.
        workAbort.signal.throwIfAborted();
        return dependencies.park(request);
      }
      workAbort.signal.throwIfAborted();
      return dependencies.execute(request, workAbort.signal);
    })();
    const outcome = await Promise.race([
      work.then((response) => ({ kind: 'work' as const, response })),
      ownership.fenced.then((reason) => ({ kind: 'fenced' as const, reason })),
    ]);
    if (outcome.kind === 'fenced') {
      void work.catch((error: unknown) => {
        console.warn('[job-worker] fenced crawl unwound with:', error);
      });
      throw new Error(outcome.reason);
    }

    const finish = sql<Array<{ status: string | null }>>`
      select accrawl_finish_crawl_job(
        ${jobId}::uuid,
        ${claimToken},
        ${workerName},
        ${outcome.response.success},
        ${outcome.response.error ?? ''}
      ) as status`;
    const finalized = await Promise.race([
      finish.then((rows) => ({ kind: 'finish' as const, status: rows[0]?.status })),
      ownership.fenced.then((reason) => ({ kind: 'fenced' as const, reason })),
    ]);
    if (finalized.kind === 'fenced') throw new Error(finalized.reason);
    ownership.stop();
    if (!isSuccessfulFinalization(outcome.response, finalized.status)) {
      process.exitCode = 1;
    }
  } catch (error) {
    if (error instanceof OwnershipFenceError || error instanceof CrawlCleanupError) {
      // Never mark the durable job terminal after a teardown failure: a
      // terminal row would let the control plane release the connection lock.
      // Exiting PID 1 is the final positive fence; the container runtime kills
      // every remaining Chrome/socket process, while the still-live DB lease
      // prevents replacement work until that termination is externally true.
      console.error(`[job-worker] ${error.message}; terminating the worker container:`, error.cause);
      dependencies.terminate(1);
    }
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[job-worker] job ${jobId} failed:`, message);
    try {
      await sql`
        select accrawl_finish_crawl_job(
          ${jobId}::uuid,
          ${claimToken},
          ${workerName},
          false,
          ${message}
        )`;
    } catch (finishError) {
      console.error(`[job-worker] could not persist failure for job ${jobId}:`, finishError);
    }
    process.exitCode = 1;
  } finally {
    ownership?.stop();
    if (tunnelServer) {
      await new Promise<void>((resolve) => tunnelServer!.close(() => resolve()));
    }
    await dependencies.closeBrowser()
      .catch((error) => console.warn('[job-worker] browser shutdown failed:', error));
    await sql.end({ timeout: 5 });
  }
}
