/**
 * What a hosted deployment must supply for a crawl to be run by a worker somewhere else.
 *
 * The product decides what a worker may do — that lives in data/worker-ownership.ts and
 * data/hosted-dispatch-decisions.ts — and the routes that speak to workers are the product too. What
 * changes between deployments is only the machinery underneath: how a worker is started, how its identity
 * is proved, where its one-use claim secret comes from, how a reconciliation is scheduled, and where a
 * screenshot is kept. That machinery is described here as an interface and supplied by whoever composes
 * the deployment, so the open source product never has to name a particular provider to run.
 *
 * Nothing in this file may make a product decision. An implementation maps shapes and calls its provider;
 * the moment it starts choosing what is legal, that choice belongs in the decision modules instead.
 */
import type { CrawlRequest, WorkerCompleteRequest, WorkerLogsRequest, WorkerStatusRequest, WorkerStepRequest } from '@accrawl/contracts';

/**
 * A worker execution whose identity has been proved against the record of what was started — the exact
 * attempt, tenant and one-use claim secret it was launched with. A deployment that cannot prove this must
 * refuse, never assume.
 */
export interface AttestedWorkerExecution {
  name: string;
  uid: string;
  /** The record partition this worker was started against. The crawl envelope must name the same one:
   *  an envelope written for another partition is not this execution's work. */
  namespace: string;
  tenantId: string;
  tenantHost: string;
  sessionId: string;
  attemptId: string;
  claimSecretVersion: string;
}

/** The identity a request carries, once proved. */
export interface WorkerIdentity {
  subject: string;
  email: string;
  expiresAt: number;
}

export interface WorkerClaimInput {
  execution: AttestedWorkerExecution;
  claimFactor: Buffer;
  sessionBearerDigest: string;
}

export interface WorkerClaimPayload {
  encryptedPayload: string;
  encryptedHistoryChunks: string[];
}

export interface WorkerRequestContext {
  execution: string;
  sessionId: string;
  attemptId: string;
}

/**
 * The durable record of one crawl attempt, as the worker-facing routes need it. Every method is fenced on
 * the ownership rule in data/worker-ownership.ts, and each is one atomic read-modify-write: an
 * implementation may not split one into steps another writer could interleave with.
 */
export interface WorkerBrokerStore {
  claim(input: WorkerClaimInput): Promise<WorkerClaimPayload>;
  assertActive(context: WorkerRequestContext, bearer: string): Promise<void>;
  /** Renews the lease AND tells the worker whether it has been asked to stop — the only signal a worker
   *  gets that a cancellation is waiting for it. */
  heartbeat(
    context: WorkerRequestContext,
    bearer: string,
  ): Promise<'running' | 'cancel_requested'>;
  updateStatus(request: WorkerStatusRequest, bearer: string): Promise<void>;
  appendStep(request: WorkerStepRequest, bearer: string): Promise<void>;
  flushLogs(request: WorkerLogsRequest, bearer: string): Promise<void>;
  complete(request: WorkerCompleteRequest, bearer: string): Promise<void>;
  otpPrepare(
    context: WorkerRequestContext,
    bearer: string,
    mode: 'begin' | 'poll',
  ): Promise<{ state: 'offline' | 'online' | 'ready' | 'manual'; transitioned: boolean }>;
  consumeOtp(
    context: WorkerRequestContext,
    bearer: string,
  ): Promise<{ state: 'pending' } | { state: 'received'; code: string }>;
  acknowledgeCancellation(context: WorkerRequestContext, bearer: string): Promise<void>;
  /** Fail an attempt whose envelope was claimed but could never be handed over. */
  failClaimedEnvelope(
    input: Pick<WorkerClaimInput, 'execution' | 'sessionBearerDigest'>,
    safeError: string,
  ): Promise<void>;
  /** Record a failure reported before the worker ever claimed the attempt. The callback fires only once the
   *  report has been authorized, so a caller can act on a genuine failure and ignore an unauthorized one. */
  persistPreExecutionFailure(
    request: WorkerCompleteRequest,
    bearer: string,
    onAuthorizedFailure?: () => void,
  ): Promise<void>;
  outputGeneration(context: WorkerRequestContext, bearer: string): Promise<string>;
  crawlRequest?(context: WorkerRequestContext): Promise<CrawlRequest | null>;
}

/**
 * Everything a hosted deployment supplies so the worker-facing routes can run. A self-contained deployment
 * that runs its crawls in-process registers nothing and the routes stay unmounted.
 */
export interface HostedWorkerPlane {
  /** Prove the caller is the worker runtime this deployment starts crawls with. */
  verifyWorker(authorization: string | string[] | undefined): Promise<WorkerIdentity>;
  /** Prove the caller is the scheduler allowed to ask for reconciliation. */
  verifyReconciler(authorization: string | string[] | undefined): Promise<WorkerIdentity>;
  /** Prove a named execution really is the one that was started for this attempt. */
  attestExecution(
    executionName: string,
    expectedCoreOrigin: string,
  ): Promise<AttestedWorkerExecution>;
  /** Destroy a one-use claim secret once it has been spent. */
  deleteClaimSecret(versionName: string): Promise<void>;
  /** The durable record of the attempt, scoped to the tenant of the current request. */
  store(): WorkerBrokerStore;
}

let registered: (() => HostedWorkerPlane) | undefined;

/**
 * Register the hosted machinery. A deployment does this once, before the server is built; the open source
 * product itself registers nothing, which is why it runs with no provider present.
 */
export function registerHostedWorkerPlane(factory: () => HostedWorkerPlane): void {
  registered = factory;
}

/** The registered machinery, or undefined when this deployment runs its crawls itself. */
export function hostedWorkerPlane(): HostedWorkerPlane | undefined {
  return registered?.();
}

/** Test-only reset so a case can compose a different deployment. */
export function resetHostedWorkerPlaneForTest(): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('resetHostedWorkerPlaneForTest is available only under NODE_ENV=test');
  }
  registered = undefined;
}
