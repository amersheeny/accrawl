import { HOSTED_COPY, workerContextOf } from '@accrawl/contracts';
import type { CrawlRequest } from '../types';
import {
  CrawlCancelledError,
} from '../agent/session-updater';
import type { LogLine, SessionLogger } from '../utils/logger';
import type {
  CompletionResults,
  Platform,
  TunnelContext,
  WorkerSessionClaim,
} from './types';
import {
  RemoteBrokerClient,
  RemoteWorkerFenceError,
} from './remote-broker-client';

interface RemotePlatformContext {
  client: RemoteBrokerClient;
  request: CrawlRequest;
}

let configured: RemotePlatformContext | undefined;

export function configureRemotePlatform(context: RemotePlatformContext): void {
  if (configured) throw new Error('remote platform is already configured');
  if (
    context.request.sessionId !== context.client.environment.sessionId
    || workerContextOf(context.request)?.attemptId
      !== context.client.environment.attemptId
  ) {
    throw new Error('remote platform request does not match its broker claim');
  }
  configured = context;
}

export function resetRemotePlatformForTests(): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('remote platform reset is available only under NODE_ENV=test');
  }
  configured = undefined;
}

function remote(): RemotePlatformContext {
  if (!configured) {
    throw new Error('remote platform must be configured by the one-shot worker');
  }
  return configured;
}

function cancellation(error: unknown, sessionId: string): never {
  if (error instanceof RemoteWorkerFenceError) {
    throw new CrawlCancelledError(sessionId);
  }
  throw error;
}

async function bestEffort(
  operation: () => Promise<void>,
  sessionId: string,
  logger: SessionLogger | Console,
  message: string,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    if (error instanceof RemoteWorkerFenceError) cancellation(error, sessionId);
    logger.warn(message, error);
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function createRemotePlatform(): Platform {
  const context = remote();
  const { client, request } = context;

  return {
    name: 'remote',
    sessionStore: {
      async claimWorker(
        sessionId: string,
        worker: WorkerSessionClaim | undefined,
      ): Promise<'claimed'> {
        if (
          sessionId !== request.sessionId
          || worker?.attemptId !== workerContextOf(request)?.attemptId
        ) {
          throw new CrawlCancelledError(sessionId);
        }
        return 'claimed';
      },

      async assertActive(sessionId): Promise<void> {
        if (sessionId !== request.sessionId) {
          throw new CrawlCancelledError(sessionId);
        }
        try {
          await client.assertActive();
        } catch (error) {
          cancellation(error, sessionId);
        }
      },

      async updateStatus(
        sessionId,
        status,
        currentStep,
        stepCount,
        logger,
      ): Promise<void> {
        await bestEffort(
          () => client.updateStatus({ status: status as never, currentStep, stepCount }),
          sessionId,
          logger ?? console,
          `[Session] Failed to update hosted session ${sessionId}:`,
        );
      },

      async appendStep(sessionId, stepLog, logger): Promise<void> {
        const step = typeof stepLog === 'object' && stepLog !== null
          ? stepLog as Record<string, unknown>
          : { value: stepLog };
        await bestEffort(
          () => client.appendStep(step),
          sessionId,
          logger ?? console,
          `[Session] Failed to append hosted step for ${sessionId}:`,
        );
      },

      async complete(
        sessionId: string,
        success: boolean,
        error: string | undefined,
        results: CompletionResults | undefined,
      ): Promise<void> {
        if (sessionId !== request.sessionId) {
          throw new CrawlCancelledError(sessionId);
        }
        if (!success && error) {
          console.error(
            `[Session] Hosted crawl ${sessionId} reported a failure:`,
            error,
          );
        }
        try {
          await client.complete({
            success,
            error: success ? undefined : HOSTED_COPY.refreshUnexpectedFailure,
            results: results as never,
          });
        } catch (caught) {
          cancellation(caught, sessionId);
        }
      },

      // The one-shot remote worker owns the authoritative heartbeat monitor so
      // it can abort and positively fence Chrome when ownership is revoked.
      startHeartbeat(): () => void {
        return () => {};
      },

      async flushLogs(sessionId: string, lines: LogLine[]): Promise<void> {
        await bestEffort(
          () => client.flushLogs(lines),
          sessionId,
          console,
          `[Session] Failed to flush hosted logs for ${sessionId}:`,
        );
      },
    },

    screenshots: {
      async upload(
        sessionId: string,
        stepNumber: number,
        base64Screenshot: string,
        logger?: SessionLogger,
      ) {
        try {
          const path = await client.uploadScreenshot(
            stepNumber,
            base64Screenshot,
          );
          return { path };
        } catch (error) {
          if (error instanceof RemoteWorkerFenceError) {
            cancellation(error, sessionId);
          }
          (logger ?? console).warn(
            `[Screenshot] Failed to upload hosted step ${stepNumber} for ${sessionId}:`,
            error,
          );
          return null;
        }
      },
    },

    otp: {
      async prepare(
        sessionId: string,
        offlineTimeoutMs: number,
        busyTimeoutMs: number,
        pollIntervalMs: number,
        logger?: SessionLogger,
      ): Promise<void> {
        const log = logger ?? console;
        const startedAt = Date.now();
        let state: 'offline' | 'online' | 'ready' | 'manual';
        try {
          state = await client.prepareOtp('begin');
          while (state !== 'ready' && state !== 'manual') {
            const timeout = state === 'online'
              ? busyTimeoutMs
              : offlineTimeoutMs;
            if (Date.now() - startedAt >= timeout) {
              throw new Error(
                state === 'online'
                  ? `OTP relay did not become ready within ${busyTimeoutMs}ms`
                  : `OTP relay did not come online within ${offlineTimeoutMs}ms`,
              );
            }
            await sleep(pollIntervalMs);
            state = await client.prepareOtp('poll');
          }
          if (state === 'manual') {
            // No phone is authorized for this connection, so no confirmation can ever arrive and waiting
            // for one would burn the whole readiness window before failing. Go on to the login page; the
            // code will be entered in the console.
            log.log(
              `[OTP] No Companion is paired for session ${sessionId} — the code will be entered in the console`,
            );
            return;
          }
          log.log(`[OTP] Hosted relay ready for session ${sessionId}`);
        } catch (error) {
          cancellation(error, sessionId);
        }
      },

      async waitForOtp(
        sessionId: string,
        timeoutMs: number,
        pollIntervalMs: number,
        logger?: SessionLogger,
      ): Promise<string> {
        const startedAt = Date.now();
        while (Date.now() - startedAt < timeoutMs) {
          try {
            const result = await client.consumeOtp();
            if (result.state === 'received') {
              (logger ?? console).log(
                `[OTP] Hosted OTP received for session ${sessionId}`,
              );
              return result.code;
            }
          } catch (error) {
            cancellation(error, sessionId);
          }
          await sleep(pollIntervalMs);
        }
        throw new Error(`OTP timeout after ${timeoutMs}ms for session ${sessionId}`);
      },
    },

    // The broker returns an already-decrypted, one-session CrawlRequest. The
    // worker never receives the durable job-encryption key.
    cipher: {
      async decrypt(ciphertext: string): Promise<string> {
        return ciphertext;
      },
    },

    tunnel: {
      async loadTunnelContext(): Promise<TunnelContext | null> {
        throw new Error('device-proxy tunnels are unavailable in remote worker mode');
      },
      async releaseTunnelClaim(): Promise<void> {
        throw new Error('device-proxy tunnels are unavailable in remote worker mode');
      },
    },
  };
}
