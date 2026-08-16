import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  RemoteBrokerClient,
  RemoteWorkerFenceError,
  readRemoteBrokerEnvironment,
} from './remote-broker-client';
import {
  registerRemoteWorkerCredentials,
  remoteWorkerCredentials,
  resetRemoteWorkerCredentialsForTest,
  type RemoteWorkerCredentials,
} from './remote-credentials';

const sessionId = '00000000-0000-4000-8000-000000000001';
const attemptId = '00000000-0000-4000-8000-000000000002';
const execution = 'accrawl-crawl-worker-abcde';
const environment: NodeJS.ProcessEnv = {
  CORE_ORIGIN: 'https://core.example',
  CORE_AUDIENCE: 'https://accrawl-core.internal',
  ACCRAWL_TENANT_ID: 'accrawl',
  ACCRAWL_TENANT_HOST: 'accrawl.example',
  ENGINE_JOB_ID: sessionId,
  ENGINE_JOB_ATTEMPT_ID: attemptId,
};

const crawlRequest = {
  sessionId,
  workerContext: {
    namespace: 'production',
    runtimePartitionId: 'accrawl',
    attemptId,
  },
  loginUrl: 'https://bank.example/login',
  username: 'alice',
  password: 'credential',
  requires2fa: false,
  maxSteps: 100,
  timeoutSeconds: 900,
};

/** Stands in for whatever started this worker: it knows which execution it is and can read the
 *  factor left for it. What the engine does with those is what these cases are about. */
function credentialsFor(factor: Buffer): RemoteWorkerCredentials {
  return {
    async workerExecution() {
      return { execution, claimSecretReference: 'claim-secret' };
    },
    async authorizedFetch() {
      throw new Error('the case supplies its own authorizedFetch');
    },
    async readClaimFactor() {
      return Buffer.from(factor);
    },
  };
}

describe('remote broker client', () => {
  it('takes which execution it is from the deployment, and checks the rest of its environment', () => {
    expect(readRemoteBrokerEnvironment(environment, execution)).toEqual({
      coreOrigin: 'https://core.example',
      coreAudience: 'https://accrawl-core.internal',
      tenantId: 'accrawl',
      tenantHost: 'accrawl.example',
      sessionId,
      attemptId,
      execution,
    });
    expect(() => readRemoteBrokerEnvironment(environment, 'Not An Execution'))
      .toThrow(/environment is invalid/);
    expect(() => readRemoteBrokerEnvironment({ ...environment, ENGINE_JOB_ID: 'nope' }, execution))
      .toThrow(/environment is invalid/);
    expect(() => readRemoteBrokerEnvironment({ ...environment, CORE_ORIGIN: '' }, execution))
      .toThrow(/CORE_ORIGIN is required/);
  });

  it('refuses to claim when nothing established which execution this worker is', async () => {
    // Without that, a second copy of the worker would claim the same crawl and neither could be
    // told apart from the one the control-plane started. Fail loudly rather than claim unfenced.
    resetRemoteWorkerCredentialsForTest();
    expect(() => remoteWorkerCredentials()).toThrow(/requires worker credentials/);
    await expect(RemoteBrokerClient.claim(environment, {
      authorizedFetch: async () => new Response(null, { status: 200 }),
    })).rejects.toThrow(/requires worker credentials/);
  });

  it('uses the registered credentials when the caller supplies none', async () => {
    const factor = Buffer.alloc(32, 7);
    registerRemoteWorkerCredentials(credentialsFor(factor));
    try {
      const coreFetch = vi.fn<typeof fetch>(async () => new Response(
        JSON.stringify({ request: crawlRequest }),
        { status: 200 },
      ));
      await expect(RemoteBrokerClient.claim(environment, {
        authorizedFetch: coreFetch,
        randomFactor: () => Buffer.alloc(32, 9),
      })).resolves.toEqual(expect.objectContaining({ request: crawlRequest }));
    } finally {
      resetRemoteWorkerCredentialsForTest();
    }
  });

  it('presents the claim factor once and the session bearer thereafter', async () => {
    const factor = Buffer.alloc(32, 7);
    const sessionBytes = Buffer.alloc(32, 9);
    const coreFetch = vi.fn<typeof fetch>(async (url) => {
      if (String(url).endsWith('/internal/worker/claim')) {
        return new Response(JSON.stringify({ request: crawlRequest }), { status: 200 });
      }
      return new Response(null, { status: 204 });
    });

    const { client, request } = await RemoteBrokerClient.claim(environment, {
      credentials: credentialsFor(factor),
      authorizedFetch: coreFetch,
      randomFactor: () => Buffer.from(sessionBytes),
    });
    expect(request).toEqual(crawlRequest);

    const claimInit = coreFetch.mock.calls[0]![1]!;
    const claimHeaders = new Headers(claimInit.headers);
    expect(claimHeaders.get('x-accrawl-worker-claim')).toBe(factor.toString('base64url'));
    expect(claimHeaders.has('x-accrawl-worker-session')).toBe(false);
    expect(JSON.parse(String(claimInit.body))).toEqual({
      execution,
      taskIndex: 0,
      taskAttempt: 0,
      taskCount: 1,
      sessionBearerDigest: createHash('sha256').update(sessionBytes).digest('hex'),
    });

    await client.assertActive();
    const sessionHeaders = new Headers(coreFetch.mock.calls[1]![1]!.headers);
    expect(sessionHeaders.get('x-accrawl-worker-session')).toBe(sessionBytes.toString('base64url'));
    expect(sessionHeaders.has('x-accrawl-worker-claim')).toBe(false);
  });

  it('refuses a claim factor that is not the length the broker stored', async () => {
    const coreFetch = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));
    await expect(RemoteBrokerClient.claim(environment, {
      credentials: credentialsFor(Buffer.alloc(16, 7)),
      authorizedFetch: coreFetch,
      randomFactor: () => Buffer.alloc(32, 9),
    })).rejects.toThrow(/claim factor is the wrong length/);
    expect(coreFetch).not.toHaveBeenCalled();
  });

  it('turns a durable ownership rejection into an immediate fence', async () => {
    await expect(RemoteBrokerClient.claim(environment, {
      credentials: credentialsFor(Buffer.alloc(32, 7)),
      authorizedFetch: async () => new Response(null, { status: 409 }),
      randomFactor: () => Buffer.alloc(32, 9),
    })).rejects.toBeInstanceOf(RemoteWorkerFenceError);
  });
});
