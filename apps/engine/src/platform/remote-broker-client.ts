import {
  WorkerClaimResponseSchema,
  WorkerHeartbeatResponseSchema,
  WorkerOtpConsumeResponseSchema,
  WorkerOtpPrepareResponseSchema,
  WorkerScreenshotResponseSchema,
  type CrawlRequest,
  type ReviewedHostedCopy,
  type WorkerBrokerContext,
  type WorkerCompleteRequest,
  type WorkerLogsRequest,
  type WorkerStatusRequest,
  type WorkerStepRequest,
} from '@accrawl/contracts';
import { createHash, randomBytes } from 'node:crypto';
import {
  remoteWorkerCredentials,
  type RemoteWorkerCredentials,
} from './remote-credentials';

/** The factor is a 32-byte secret: the broker compares it against what it stored, so a value of any
 *  other length cannot be the one it left and is refused before it reaches the wire. */
const CLAIM_FACTOR_BYTES = 32;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TENANT_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const TENANT_HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const EXECUTION = /^[a-z][a-z0-9-]{0,62}$/;

export class RemoteWorkerFenceError extends Error {
  constructor() {
    super('hosted worker ownership was revoked');
    this.name = 'RemoteWorkerFenceError';
  }
}

export interface RemoteBrokerEnvironment {
  coreOrigin: string;
  coreAudience: string;
  tenantId: string;
  tenantHost: string;
  sessionId: string;
  attemptId: string;
  /** Which single execution of the worker this process is; supplied by the deployment that started
   *  it, because only that deployment knows how it names one. */
  execution: string;
}

export interface RemoteBrokerClientDependencies {
  credentials?: RemoteWorkerCredentials;
  authorizedFetch?: typeof fetch;
  randomFactor?: (size: number) => Buffer;
}

function required(
  environment: NodeJS.ProcessEnv,
  name: string,
): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required for PLATFORM=remote`);
  return value;
}

/**
 * The part of a remote worker's environment the engine reads for itself: where the control-plane is,
 * whose crawl this is, and which crawl. Which execution this process is comes from the deployment's
 * registered credentials, since only it knows how its workers are named.
 */
export function readRemoteBrokerEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
  execution = '',
): RemoteBrokerEnvironment {
  const origin = required(environment, 'CORE_ORIGIN');
  const parsedOrigin = new URL(origin);
  if (
    parsedOrigin.protocol !== 'https:'
    || parsedOrigin.username
    || parsedOrigin.password
    || parsedOrigin.search
    || parsedOrigin.hash
    || (parsedOrigin.pathname !== '/' && parsedOrigin.pathname !== '')
  ) {
    throw new Error('CORE_ORIGIN must be an HTTPS origin');
  }
  const result = {
    coreOrigin: parsedOrigin.origin,
    coreAudience: required(environment, 'CORE_AUDIENCE'),
    tenantId: required(environment, 'ACCRAWL_TENANT_ID'),
    tenantHost: required(environment, 'ACCRAWL_TENANT_HOST').toLowerCase(),
    sessionId: required(environment, 'ENGINE_JOB_ID'),
    attemptId: required(environment, 'ENGINE_JOB_ATTEMPT_ID'),
    execution,
  };
  if (
    !result.coreAudience.startsWith('https://')
    || !TENANT_ID.test(result.tenantId)
    || !TENANT_HOST.test(result.tenantHost)
    || !SESSION_ID.test(result.sessionId)
    || !SESSION_ID.test(result.attemptId)
    || !EXECUTION.test(result.execution)
  ) {
    throw new Error('remote-worker environment is invalid');
  }
  return result;
}

export class RemoteBrokerClient {
  private constructor(
    readonly environment: RemoteBrokerEnvironment,
    private readonly sessionBearer: string,
    private readonly authorizedFetch: typeof fetch,
  ) {}

  static async claim(
    environment: NodeJS.ProcessEnv = process.env,
    dependencies: RemoteBrokerClientDependencies = {},
  ): Promise<{ client: RemoteBrokerClient; request: CrawlRequest }> {
    const credentials = dependencies.credentials ?? remoteWorkerCredentials();
    const identity = await credentials.workerExecution(environment);
    const resolved = readRemoteBrokerEnvironment(environment, identity.execution);
    const authorizedFetch = dependencies.authorizedFetch
      ?? await credentials.authorizedFetch(resolved.coreAudience);
    const random = dependencies.randomFactor ?? randomBytes;
    const bearerBytes = random(32);
    if (bearerBytes.length !== 32) {
      bearerBytes.fill(0);
      throw new Error('worker session bearer generator returned the wrong length');
    }
    const sessionBearer = bearerBytes.toString('base64url');
    const sessionBearerDigest = createHash('sha256')
      .update(bearerBytes)
      .digest('hex');
    bearerBytes.fill(0);

    const factor = await credentials.readClaimFactor(identity.claimSecretReference);
    if (factor.length !== CLAIM_FACTOR_BYTES) {
      factor.fill(0);
      throw new Error('worker claim factor is the wrong length');
    }
    try {
      const response = await authorizedFetch(
        `${resolved.coreOrigin}/internal/worker/claim`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-accrawl-tenant-host': resolved.tenantHost,
            'x-accrawl-worker-claim': factor.toString('base64url'),
          },
          body: JSON.stringify({
            execution: resolved.execution,
            taskIndex: 0,
            taskAttempt: 0,
            taskCount: 1,
            sessionBearerDigest,
          }),
        },
      );
      if (response.status === 409) throw new RemoteWorkerFenceError();
      if (!response.ok) {
        throw new Error(`hosted worker claim returned HTTP ${response.status}`);
      }
      const parsed = WorkerClaimResponseSchema.parse(await response.json());
      const client = new RemoteBrokerClient(
        resolved,
        sessionBearer,
        authorizedFetch,
      );
      return { client, request: parsed.request };
    } finally {
      factor.fill(0);
    }
  }

  context(): WorkerBrokerContext {
    return {
      execution: this.environment.execution,
      sessionId: this.environment.sessionId,
      attemptId: this.environment.attemptId,
    };
  }

  private async post(
    path: string,
    body: unknown,
  ): Promise<Response> {
    const response = await this.authorizedFetch(
      `${this.environment.coreOrigin}${path}`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-accrawl-tenant-host': this.environment.tenantHost,
          'x-accrawl-worker-session': this.sessionBearer,
        },
        body: JSON.stringify(body),
      },
    );
    if (response.status === 409) throw new RemoteWorkerFenceError();
    if (!response.ok) {
      throw new Error(`hosted worker broker returned HTTP ${response.status}`);
    }
    return response;
  }

  async assertActive(): Promise<void> {
    await this.post('/internal/worker/assert', this.context());
  }

  async heartbeat(): Promise<
    'running' | 'cancel_requested' | 'cancelled' | 'failed' | 'succeeded'
  > {
    const response = await this.post(
      '/internal/worker/heartbeat',
      this.context(),
    );
    return WorkerHeartbeatResponseSchema.parse(await response.json()).status;
  }

  async updateStatus(
    request: Omit<WorkerStatusRequest, keyof WorkerBrokerContext>,
  ): Promise<void> {
    await this.post('/internal/worker/status', {
      ...this.context(),
      ...request,
    });
  }

  async appendStep(step: WorkerStepRequest['step']): Promise<void> {
    await this.post('/internal/worker/step', {
      ...this.context(),
      step,
    });
  }

  async flushLogs(lines: WorkerLogsRequest['lines']): Promise<void> {
    await this.post('/internal/worker/logs', {
      ...this.context(),
      lines,
    });
  }

  async complete(
    request: Omit<WorkerCompleteRequest, keyof WorkerBrokerContext>,
  ): Promise<void> {
    await this.post('/internal/worker/complete', {
      ...this.context(),
      ...request,
    });
  }

  async persistFailure(error: ReviewedHostedCopy): Promise<void> {
    await this.post('/internal/worker/failure', {
      ...this.context(),
      success: false,
      error,
      results: { failureReason: 'internal_error' },
    });
  }

  async acknowledgeCancellation(): Promise<void> {
    await this.post('/internal/worker/cancel-ack', this.context());
  }

  async uploadScreenshot(
    stepNumber: number,
    jpegBase64: string,
  ): Promise<string> {
    const response = await this.post('/internal/worker/screenshot', {
      ...this.context(),
      stepNumber,
      jpegBase64,
    });
    return WorkerScreenshotResponseSchema.parse(await response.json()).path;
  }

  async prepareOtp(mode: 'begin' | 'poll'): Promise<
    'offline' | 'online' | 'ready' | 'manual'
  > {
    const response = await this.post('/internal/worker/otp/prepare', {
      ...this.context(),
      mode,
    });
    return WorkerOtpPrepareResponseSchema.parse(await response.json()).state;
  }

  async consumeOtp(): Promise<
    { state: 'pending' } | { state: 'received'; code: string }
  > {
    const response = await this.post(
      '/internal/worker/otp/consume',
      this.context(),
    );
    return WorkerOtpConsumeResponseSchema.parse(await response.json());
  }
}
