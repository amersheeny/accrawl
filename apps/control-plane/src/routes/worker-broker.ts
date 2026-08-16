/**
 * The routes a worker running somewhere else talks to.
 *
 * A worker that is not this process has no database of its own: it claims its crawl here, reports
 * every step here, and finishes here. Each route is the product's — what a worker may say, when it is
 * still the owner of its attempt, and what happens when it is not, is decided in
 * data/worker-ownership.ts and applied by the durable store behind the port.
 *
 * What this file never contains is how a worker is started or how it proves itself. Those are
 * supplied by whoever composed the deployment (orchestration/hosted-worker-plane.ts); a deployment
 * that runs its crawls in this process registers nothing and these routes are never mounted.
 */
import {
  WorkerBrokerContextSchema,
  WorkerClaimRequestSchema,
  WorkerClaimResponseSchema,
  WorkerCompleteRequestSchema,
  WorkerLogsRequestSchema,
  WorkerOtpConsumeResponseSchema,
  WorkerOtpPrepareRequestSchema,
  WorkerOtpPrepareResponseSchema,
  WorkerScreenshotRequestSchema,
  WorkerScreenshotResponseSchema,
  WorkerStatusRequestSchema,
  WorkerStepRequestSchema,
  decryptCrawlJobHistoryChunk,
  decryptCrawlJobPayload,
  hydrateCrawlRequestTransactionHistory,
  workerContextOf,
} from '@accrawl/contracts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { WorkerBrokerFenceError } from '../data/worker-ownership';
import {
  hostedWorkerPlane,
  type AttestedWorkerExecution,
  type WorkerBrokerStore,
} from '../orchestration/hosted-worker-plane';
import { enqueueHostedCrawlReconciliation } from '../orchestration/crawl-reconciliation-queue';
import { REFRESH_START_ERROR } from '../orchestration/refresh-copy';
import { saveImmutableScreenshot, screenshotArchive } from '../storage/screenshot-archive';
import { currentTenant } from '../tenancy/context';
import { db } from '../db/client';
import { armOtpRelayEpisode } from '../notifications/companion-wake';

const CLAIM_FACTOR = /^[A-Za-z0-9_-]{43}$/;
const SESSION_BEARER = /^[A-Za-z0-9_-]{43}$/;
const CLAIM_HEADER = 'x-accrawl-worker-claim';
const SESSION_HEADER = 'x-accrawl-worker-session';
const MAX_SCREENSHOT_BYTES = 7_500_000;

/** Overrides for tests, which drive these routes against a store they can inspect. A deployment does
 *  not use them: it registers its machinery once, and every route below reads it from there. */
export interface WorkerBrokerRouteDependencies {
  verifyWorker?: (
    authorization: string | string[] | undefined,
  ) => Promise<unknown>;
  attestExecution?: (
    executionName: string,
    expectedCoreOrigin: string,
  ) => Promise<AttestedWorkerExecution>;
  deleteClaimSecret?: (versionName: string) => Promise<void>;
  enqueueReconciliation?: (sessionId: string) => Promise<void>;
  wakeOtpCompanion?: (sessionId: string) => Promise<unknown>;
  store?: () => WorkerBrokerStore;
}

/** The machinery this deployment supplied, for the parts a caller did not override. Asked for lazily,
 *  so a test that overrides everything never needs one. */
function requirePlane() {
  const plane = hostedWorkerPlane();
  if (!plane) {
    throw new Error(
      'The worker-facing routes need hosted worker machinery, and none is registered. A deployment '
      + 'that runs crawls elsewhere registers it with registerHostedWorkerPlane() before the server '
      + 'is built.',
    );
  }
  return plane;
}

function header(
  request: FastifyRequest,
  name: typeof CLAIM_HEADER | typeof SESSION_HEADER,
  pattern: RegExp,
): string {
  const value = request.headers[name];
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new WorkerBrokerFenceError();
  }
  return value;
}

function decodeClaimFactor(request: FastifyRequest): Buffer {
  const encoded = header(request, CLAIM_HEADER, CLAIM_FACTOR);
  const factor = Buffer.from(encoded, 'base64url');
  if (
    factor.length !== 32
    || factor.toString('base64url') !== encoded
  ) {
    factor.fill(0);
    throw new WorkerBrokerFenceError();
  }
  return factor;
}

function contextBody(value: unknown) {
  return WorkerBrokerContextSchema.parse(value);
}

function noStore(reply: FastifyReply): void {
  reply.header('cache-control', 'no-store');
}

function jpeg(value: string): Buffer {
  const bytes = Buffer.from(value, 'base64');
  if (
    bytes.length === 0
    || bytes.length > MAX_SCREENSHOT_BYTES
    || bytes.toString('base64') !== value
    || bytes[0] !== 0xff
    || bytes[1] !== 0xd8
    || bytes[2] !== 0xff
    || bytes.at(-2) !== 0xff
    || bytes.at(-1) !== 0xd9
  ) {
    bytes.fill(0);
    throw new Error('worker screenshot is not a canonical JPEG');
  }
  return bytes;
}

export async function workerBrokerRoutes(
  app: FastifyInstance,
  dependencies: WorkerBrokerRouteDependencies = {},
): Promise<void> {
  const verifier = dependencies.verifyWorker
    ?? ((authorization) => requirePlane().verifyWorker(authorization));
  const attest = dependencies.attestExecution
    ?? ((execution, origin) => requirePlane().attestExecution(execution, origin));
  const deleteClaimSecret = dependencies.deleteClaimSecret
    ?? ((version) => requirePlane().deleteClaimSecret(version));
  const enqueueReconciliation = dependencies.enqueueReconciliation
    ?? ((sessionId: string) => enqueueHostedCrawlReconciliation(sessionId));
  const wakeOtpCompanion = dependencies.wakeOtpCompanion
    ?? ((sessionId: string) => armOtpRelayEpisode(db, sessionId));

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof WorkerBrokerFenceError) {
      void reply.code(409).send();
      return;
    }
    if (error instanceof ZodError) {
      void reply.code(400).send();
      return;
    }
    request.log.error({ err: error }, 'hosted worker broker request failed');
    void reply.code(500).send();
  });

  const authenticate = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> => {
    try {
      await verifier(request.headers.authorization);
    } catch {
      await reply.code(401).send();
    }
  };
  const store = dependencies.store ?? (() => requirePlane().store());
  const sessionBearer = (request: FastifyRequest): string =>
    header(request, SESSION_HEADER, SESSION_BEARER);

  app.post('/internal/worker/claim', {
    preHandler: authenticate,
  }, async (request, reply) => {
    noStore(reply);
    const body = WorkerClaimRequestSchema.parse(request.body);
    let execution: AttestedWorkerExecution;
    try {
      const host = request.headers.host;
      if (typeof host !== 'string' || !host) {
        throw new Error('worker broker Host header is unavailable');
      }
      execution = await attest(body.execution, `https://${host}`);
    } catch (error) {
      request.log.warn({ err: error }, 'worker execution attestation failed');
      throw new WorkerBrokerFenceError();
    }
    const tenant = currentTenant();
    if (
      execution.tenantId !== tenant.id
      || !tenant.hosts.includes(execution.tenantHost)
      || !tenant.jobEncryptionKey
    ) {
      throw new WorkerBrokerFenceError();
    }
    const factor = decodeClaimFactor(request);
    let claimedPayload;
    try {
      claimedPayload = await store().claim({
        execution,
        claimFactor: factor,
        sessionBearerDigest: body.sessionBearerDigest,
      });
    } finally {
      factor.fill(0);
    }

    let crawlRequest;
    try {
      const transportRequest = decryptCrawlJobPayload(
        tenant.jobEncryptionKey,
        execution.tenantId,
        execution.sessionId,
        claimedPayload.encryptedPayload,
      );
      const historyChunks = claimedPayload.encryptedHistoryChunks.map(
        (encryptedChunk, index) => decryptCrawlJobHistoryChunk(
          tenant.jobEncryptionKey!,
          execution.tenantId,
          execution.sessionId,
          index,
          encryptedChunk,
        ),
      );
      if (
        !transportRequest.recentTransactionsManifest
        && historyChunks.length !== 0
      ) {
        throw new Error('crawl envelope has transaction history without a manifest');
      }
      crawlRequest = hydrateCrawlRequestTransactionHistory(
        transportRequest,
        historyChunks,
      );
      if (
        crawlRequest.sessionId !== execution.sessionId
        || workerContextOf(crawlRequest)?.namespace !== execution.namespace
        || workerContextOf(crawlRequest)?.runtimePartitionId !== execution.tenantId
        || workerContextOf(crawlRequest)?.attemptId !== execution.attemptId
        || crawlRequest.useDeviceProxy === true
      ) {
        throw new Error('crawl envelope does not match the attested execution');
      }
    } catch (error) {
      await store().failClaimedEnvelope(
        { execution, sessionBearerDigest: body.sessionBearerDigest },
        REFRESH_START_ERROR,
      );
      throw error;
    } finally {
      await deleteClaimSecret(execution.claimSecretVersion).catch((error) => {
        request.log.warn({ err: error }, 'worker claim-secret cleanup failed');
      });
    }
    return WorkerClaimResponseSchema.parse({ request: crawlRequest });
  });

  app.post('/internal/worker/assert', {
    preHandler: authenticate,
  }, async (request, reply) => {
    noStore(reply);
    await store().assertActive(
      contextBody(request.body),
      sessionBearer(request),
    );
    return reply.code(204).send();
  });

  app.post('/internal/worker/heartbeat', {
    preHandler: authenticate,
  }, async (request, reply) => {
    noStore(reply);
    const status = await store().heartbeat(
      contextBody(request.body),
      sessionBearer(request),
    );
    return { status };
  });

  app.post('/internal/worker/status', {
    preHandler: authenticate,
  }, async (request, reply) => {
    noStore(reply);
    await store().updateStatus(
      WorkerStatusRequestSchema.parse(request.body),
      sessionBearer(request),
    );
    return reply.code(204).send();
  });

  app.post('/internal/worker/step', {
    preHandler: authenticate,
  }, async (request, reply) => {
    noStore(reply);
    await store().appendStep(
      WorkerStepRequestSchema.parse(request.body),
      sessionBearer(request),
    );
    return reply.code(204).send();
  });

  app.post('/internal/worker/logs', {
    preHandler: authenticate,
  }, async (request, reply) => {
    noStore(reply);
    await store().flushLogs(
      WorkerLogsRequestSchema.parse(request.body),
      sessionBearer(request),
    );
    return reply.code(204).send();
  });

  app.post('/internal/worker/complete', {
    preHandler: authenticate,
    bodyLimit: 32 * 1024 * 1024,
  }, async (request, reply) => {
    noStore(reply);
    const body = WorkerCompleteRequestSchema.parse(request.body);
    await store().complete(body, sessionBearer(request));
    // Completion is not acknowledged until the durable scale-to-zero
    // reconciler task exists. An exact worker retry is a broker no-op and may
    // safely retry this enqueue if a prior response was lost.
    await enqueueReconciliation(body.sessionId);
    return reply.code(204).send();
  });

  app.post('/internal/worker/cancel-ack', {
    preHandler: authenticate,
  }, async (request, reply) => {
    noStore(reply);
    const body = contextBody(request.body);
    await store().acknowledgeCancellation(body, sessionBearer(request));
    await enqueueReconciliation(body.sessionId);
    return reply.code(204).send();
  });

  app.post('/internal/worker/failure', {
    preHandler: authenticate,
  }, async (request, reply) => {
    noStore(reply);
    const body = WorkerCompleteRequestSchema.parse(request.body);
    if (body.success) throw new Error('worker failure endpoint requires success=false');
    const bearer = sessionBearer(request);
    await store().persistPreExecutionFailure(
      body,
      bearer,
      () => {
        request.log.error({
          diagnostic: body.error ?? null,
          execution: body.execution,
          sessionId: body.sessionId,
          attemptId: body.attemptId,
        }, 'hosted worker failed before crawl execution');
      },
    );
    await enqueueReconciliation(body.sessionId);
    return reply.code(204).send();
  });

  app.post('/internal/worker/otp/prepare', {
    preHandler: authenticate,
  }, async (request, reply) => {
    noStore(reply);
    const body = WorkerOtpPrepareRequestSchema.parse(request.body);
    const prepared = await store().otpPrepare(
      body,
      sessionBearer(request),
      body.mode,
    );
    if (prepared.transitioned) {
      try {
        await wakeOtpCompanion(body.sessionId);
      } catch (error) {
        // The pending-session endpoint is the missed-push recovery path. Keep
        // the authoritative OTP episode armed; a failed wake must not cause a
        // worker retry to manufacture a second false→true transition.
        request.log.error({ err: error, sessionId: body.sessionId },
          'companion OTP wake delivery failed');
      }
    }
    return WorkerOtpPrepareResponseSchema.parse({ state: prepared.state });
  });

  app.post('/internal/worker/otp/consume', {
    preHandler: authenticate,
  }, async (request, reply) => {
    noStore(reply);
    const result = await store().consumeOtp(
      contextBody(request.body),
      sessionBearer(request),
    );
    return WorkerOtpConsumeResponseSchema.parse(result);
  });

  app.post('/internal/worker/screenshot', {
    preHandler: authenticate,
    bodyLimit: 10 * 1024 * 1024,
  }, async (request, reply) => {
    noStore(reply);
    const body = WorkerScreenshotRequestSchema.parse(request.body);
    const archive = screenshotArchive();
    if (!archive) {
      throw new Error('this deployment has nowhere to keep a worker screenshot');
    }
    const broker = store();
    const bearer = sessionBearer(request);
    const generation = await broker.outputGeneration(body, bearer);
    const bytes = jpeg(body.jpegBase64);
    // The generation is what makes this path belong to one attempt: a reclaimed worker writes under a
    // different one and can never reach a step somebody has already read.
    const relativePath =
      `sessions/${body.sessionId}/${generation}`
      + `/step-${String(body.stepNumber).padStart(3, '0')}.jpg`;
    try {
      await saveImmutableScreenshot(archive, relativePath, bytes);
    } finally {
      bytes.fill(0);
    }
    // A reclaim during the upload leaves an unreachable generation-scoped
    // object. Recheck before returning a path that the worker can publish.
    await broker.assertActive(body, bearer);
    return WorkerScreenshotResponseSchema.parse({ path: relativePath });
  });
}

export function isWorkerBrokerFence(error: unknown): error is WorkerBrokerFenceError {
  return error instanceof WorkerBrokerFenceError;
}
