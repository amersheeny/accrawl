import {
  HOSTED_COPY,
  type CrawlRequest,
  type CrawlResponse,
} from '@accrawl/contracts';
import type { BrowserContext } from 'playwright';
import { CrawlCleanupError } from './crawl-executor';
import {
  OwnershipFenceError,
  startOwnershipMonitor,
  type OwnershipMonitor,
  type OwnershipMonitorOptions,
} from './job-worker';
import {
  RemoteBrokerClient,
  RemoteWorkerFenceError,
} from './platform/remote-broker-client';
import { configureRemotePlatform } from './platform/remote';
import { loadSecretEnvironment } from './utils/secret-environment';
import { CrawlCancelledError } from './agent/session-updater';

const WORK_TEARDOWN_MS = 10_000;

export interface RemoteJobWorkerDependencies {
  claim: () => Promise<{ client: RemoteBrokerClient; request: CrawlRequest }>;
  execute: (request: CrawlRequest, signal?: AbortSignal) => Promise<CrawlResponse>;
  activeContexts: Map<string, BrowserContext>;
  closeBrowser: () => Promise<void>;
  installSignalHandlers: boolean;
  terminate: (code: number) => never;
  startOwnershipMonitor: (
    options: OwnershipMonitorOptions,
  ) => OwnershipMonitor;
  workTeardownMs: number;
}

async function positiveFence(
  dependencies: RemoteJobWorkerDependencies,
): Promise<void> {
  const results = await Promise.allSettled([
    ...[...dependencies.activeContexts.values()].map((context) => context.close()),
    dependencies.closeBrowser(),
  ]);
  const failures = results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : []);
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      'one or more remote crawl paths could not be fenced',
    );
  }
}

async function awaitWorkTeardown(
  work: Promise<CrawlResponse>,
  timeoutMs: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      work.then(
        () => undefined,
        () => undefined,
      ),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('fenced remote crawl did not stop')),
          timeoutMs,
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function runRemoteJobWorker(
  overrides: Partial<RemoteJobWorkerDependencies> & Pick<
    RemoteJobWorkerDependencies,
    'execute' | 'activeContexts' | 'closeBrowser'
  >,
): Promise<void> {
  const dependencies: RemoteJobWorkerDependencies = {
    claim: () => RemoteBrokerClient.claim(),
    installSignalHandlers: true,
    terminate: (code) => process.exit(code),
    startOwnershipMonitor,
    workTeardownMs: WORK_TEARDOWN_MS,
    ...overrides,
  };
  const abort = new AbortController();
  let client: RemoteBrokerClient | undefined;
  let monitor: OwnershipMonitor | undefined;
  let stopping = false;

  const stop = async (signal: NodeJS.Signals): Promise<void> => {
    if (stopping) return;
    stopping = true;
    abort.abort(new Error(`remote worker received ${signal}`));
    try {
      await positiveFence(dependencies);
    } catch (error) {
      console.error('[job-worker] remote signal fence failed:', error);
      dependencies.terminate(1);
    }
  };
  if (dependencies.installSignalHandlers) {
    process.once('SIGTERM', () => void stop('SIGTERM'));
    process.once('SIGINT', () => void stop('SIGINT'));
  }

  try {
    const claimStartedAt = Date.now();
    let claimed: { client: RemoteBrokerClient; request: CrawlRequest };
    try {
      claimed = await dependencies.claim();
    } catch (error) {
      if (error instanceof RemoteWorkerFenceError) return;
      throw error;
    }
    client = claimed.client;
    if (claimed.request.useDeviceProxy) {
      throw new Error('remote workers cannot execute a device-proxy crawl');
    }
    loadSecretEnvironment('GEMINI_API_KEY');
    configureRemotePlatform(claimed);

    monitor = dependencies.startOwnershipMonitor({
      confirmedAt: claimStartedAt,
      heartbeat: () => client!.heartbeat(),
      fence: async (reason) => {
        abort.abort(new Error(reason));
        await positiveFence(dependencies);
        if (reason.includes('cancel_requested')) {
          await client!.acknowledgeCancellation();
        }
      },
    });

    const work = (async () => {
      abort.signal.throwIfAborted();
      return dependencies.execute(claimed.request, abort.signal);
    })();
    const outcome = await Promise.race([
      work.then((response) => ({ kind: 'work' as const, response })),
      monitor.fenced.then((reason) => ({ kind: 'fenced' as const, reason })),
    ]);
    if (outcome.kind === 'fenced') {
      await awaitWorkTeardown(work, dependencies.workTeardownMs);
      return;
    }
    monitor.stop();
    if (!outcome.response.success) process.exitCode = 1;
  } catch (error) {
    if (error instanceof OwnershipFenceError || error instanceof CrawlCleanupError) {
      console.error('[job-worker] remote ownership fence failed:', error);
      dependencies.terminate(1);
    }
    if (error instanceof CrawlCancelledError || error instanceof RemoteWorkerFenceError) {
      abort.abort(error);
      try {
        await positiveFence(dependencies);
      } catch (fenceError) {
        console.error('[job-worker] remote cancellation fence failed:', fenceError);
        dependencies.terminate(1);
      }
      await client?.acknowledgeCancellation().catch((acknowledgementError) => {
        console.error(
          '[job-worker] could not acknowledge remote cancellation:',
          acknowledgementError,
        );
      });
      return;
    }
    console.error('[job-worker] remote crawl failed:', error);
    abort.abort(error);
    try {
      await positiveFence(dependencies);
    } catch (fenceError) {
      console.error('[job-worker] remote failure fence failed:', fenceError);
      dependencies.terminate(1);
    }
    if (client) {
      await client.persistFailure(HOSTED_COPY.refreshUnexpectedFailure)
        .catch((persistError) => {
          console.error(
            '[job-worker] could not persist remote failure:',
            persistError,
          );
        });
    }
    process.exitCode = 1;
  } finally {
    monitor?.stop();
    await dependencies.closeBrowser().catch((error) => {
      console.warn('[job-worker] remote browser shutdown failed:', error);
    });
  }
}
