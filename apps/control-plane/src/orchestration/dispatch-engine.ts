/**
 * Hands a crawl to whatever runs it.
 *
 * A deployment that runs its own engine posts the crawl to it directly; one that starts a worker per crawl
 * registers a dispatcher that does that instead. The choice is a property of the deployment, not of the
 * product, so the alternatives are registered rather than named here — which is why this file no longer
 * has to know that any particular provider exists.
 */
import {
  assertRecentTransactionHistory,
  type CrawlAck,
  type CrawlRequest,
} from '@accrawl/contracts';
import { config } from '../config';
import { currentTenant } from '../tenancy/context';
import { REFRESH_START_ERROR } from './refresh-copy';

const ACK_TIMEOUT_MS = 30_000;
const CANCEL_TIMEOUT_MS = 10_000;

/** Hands one crawl over, and reports whether it was accepted. */
export type EngineDispatcher = (request: CrawlRequest) => Promise<CrawlAck>;

const dispatchers = new Map<string, EngineDispatcher>();

/**
 * Register how this deployment hands a crawl over. `http` is built in below, because posting to an engine
 * this deployment runs itself needs nothing from anyone.
 */
export function registerEngineDispatcher(
  mode: string,
  dispatcher: EngineDispatcher,
): void {
  dispatchers.set(mode, dispatcher);
}

/** Test helper: forget a registration so a case can compose a different deployment. */
export function resetEngineDispatchersForTest(): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('resetEngineDispatchersForTest is available only under NODE_ENV=test');
  }
  dispatchers.clear();
  dispatchers.set('http', dispatchCrawlOverHttp);
}

/**
 * Refuse to start when this deployment is configured to dispatch a crawl a way nothing registered.
 *
 * Without this the server boots, reports itself healthy, and fails on the first crawl a person asks
 * for — which is the worst moment to discover a misspelled setting.
 */
export function assertEngineDispatcherRegistered(): void {
  const mode = config.engineDispatchMode || 'http';
  if (!dispatchers.has(mode)) {
    throw new Error(
      `No dispatcher is registered for ENGINE_DISPATCH_MODE="${mode}". `
      + `Registered: ${[...dispatchers.keys()].join(', ') || 'none'}.`,
    );
  }
}

export async function dispatchCrawlToEngine(
  request: CrawlRequest,
): Promise<CrawlAck> {
  // config defaults this to 'http' when unset; mirror that here so an absent value means the same thing.
  const mode = config.engineDispatchMode || 'http';
  const dispatcher = dispatchers.get(mode);
  if (!dispatcher) {
    throw new Error(
      `No dispatcher is registered for ENGINE_DISPATCH_MODE="${mode}". `
      + `Registered: ${[...dispatchers.keys()].join(', ') || 'none'}.`,
    );
  }
  return dispatcher(request);
}

async function dispatchCrawlOverHttp(request: CrawlRequest): Promise<CrawlAck> {
  const tenant = currentTenant();
  if (config.nodeEnv === 'production' && !tenant.engineSharedSecret) {
    return {
      accepted: false,
      error: 'engine dispatch refused: ENGINE_SHARED_SECRET is required in production',
    };
  }

  try {
    const headers = {
      'content-type': 'application/json',
      ...(tenant.engineSharedSecret
        ? { authorization: `Bearer ${tenant.engineSharedSecret}` }
        : {}),
    };
    const post = async (path: string, body: unknown): Promise<Response> => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), ACK_TIMEOUT_MS);
      try {
        return await fetch(`${tenant.engineUrl}${path}`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
    };

    let transportRequest: CrawlRequest = request;
    if (request.recentTransactions !== undefined) {
      if (!request.recentTransactionsManifest) {
        throw new Error('transaction history manifest is missing');
      }
      const history = assertRecentTransactionHistory(
        request.recentTransactions,
        request.recentTransactionsManifest,
      );
      // Keep small histories inline. Larger lists use the bounded transport so
      // the final /crawl body stays comfortably below Express's 1 MiB limit.
      if (history.chunks.length > 1) {
        for (const chunk of history.chunks) {
          const upload = await post('/crawl/transaction-history', {
            sessionId: request.sessionId,
            manifest: history.manifest,
            chunk,
          });
          if (!upload.ok) {
            throw new Error(`transaction history upload returned HTTP ${upload.status}`);
          }
        }
        transportRequest = { ...request };
        delete transportRequest.recentTransactions;
      }
    } else if (request.recentTransactionsManifest) {
      throw new Error('transaction history records are missing');
    }

    const response = await post('/crawl', transportRequest);
    if (!response.ok) {
      console.error(`[dispatch] engine returned HTTP ${response.status}`);
      return { accepted: false, error: REFRESH_START_ERROR };
    }
    const acknowledgement = (await response.json()) as CrawlAck;
    return acknowledgement.accepted
      ? acknowledgement
      : { accepted: false, error: REFRESH_START_ERROR };
  } catch (error) {
    console.error(
      '[dispatch] engine dispatch failed:',
      error instanceof Error ? error.message : String(error),
    );
    return { accepted: false, error: REFRESH_START_ERROR };
  }
}

/**
 * Positively fence a self-hosted crawl before its connection lock is released.
 * Cancelling a crawl that runs elsewhere is the hosted orchestrator's job.
 */
export async function dispatchCancelToEngine(
  sessionId: string,
): Promise<boolean> {
  const tenant = currentTenant();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CANCEL_TIMEOUT_MS);
  try {
    const response = await fetch(`${tenant.engineUrl}/cancel/${sessionId}`, {
      method: 'POST',
      headers: {
        ...(tenant.engineSharedSecret
          ? { authorization: `Bearer ${tenant.engineSharedSecret}` }
          : {}),
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(
        `engine cancellation was not acknowledged (HTTP ${response.status})`,
      );
    }
    return true;
  } catch (error) {
    throw new Error(
      `engine cancellation could not be fenced: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  } finally {
    clearTimeout(timer);
  }
}

// Posting to an engine this deployment runs itself needs no provider, so it is always available.
registerEngineDispatcher('http', dispatchCrawlOverHttp);
