/**
 * Accrawl — financial account crawler service
 *
 * HTTP service that crawls financial institution websites using Playwright
 * (headless Chrome) guided by a Gemini AI agent, returning normalized accounts,
 * positions, and transactions.
 *
 * Endpoints:
 *   POST /crawl             — Start a crawl (auth-gated). A device-proxy crawl is PARKED until its
 *                             companion tunnel WS connects; a non-proxy crawl runs synchronously.
 *   POST /cancel/:sessionId — Force-kill a running crawl (auth-gated)
 *   WS   /tunnel            — Device proxy tunnel (tunnel-token auth; tunnel/dev + self-host postgres)
 *
 * Authentication:
 *   /crawl, /cancel: OIDC middleware (the control-plane → engine inter-service auth)
 *   /tunnel: a short-lived, session+device-bound HMAC tunnel token (verified by the tunnel handler
 *            against a key derived from ENGINE_SHARED_SECRET — no identity service, no devices-table read)
 *
 * Service mode (SERVICE_MODE env var):
 *   This single codebase backs the hosted split AND the self-host single container. SERVICE_MODE
 *   decides which surface area is exposed so the PUBLIC, allUsers-invokable tunnel service never also
 *   serves the OIDC-protected /crawl + /cancel endpoints:
 *     - 'crawl'  → /crawl + /cancel (IAM-protected service). The tunnel is also served when
 *                  PLATFORM=postgres (self-host), so ONE container serves both /crawl and /tunnel.
 *     - 'tunnel' → /tunnel WebSocket only (public service). No /crawl.
 *     - unset/'development' → everything (local dev convenience).
 *   Health endpoints are always registered.
 *
 * Device-proxy crawls arrive at POST /crawl (carrying useDeviceProxy + a tunnelToken) and are PARKED;
 * the companion's WebSocket connection to /tunnel claims the park and runs the browser. This keeps
 * the SOCKS5 proxy + Playwright on the same instance as the inbound WS.
 */

import express, { type Express } from 'express';
import {
  CrawlRequestTransportSchema,
  HOSTED_COPY,
  RecentTransactionHistoryChunkUploadSchema,
  hydrateCrawlRequestTransactionHistory,
  workerContextOf,
} from '@accrawl/contracts';
import { closeBrowser } from './browser/browser-pool';
import { verifyInboundIdentity, assertInboundAuthConfig } from './middleware/auth';
import {
  activeSessions, cancelExecution, executeCrawl, hasActiveExecution,
} from './crawl-executor';
import type { CrawlAck, CrawlRequest, CrawlResponse } from './types';
import { claimSessionWorker } from './agent/session-updater';
import { TransactionHistoryUploadStore } from './transaction-history-store';

// ─── Service mode ───────────────────────────────────────────────────

export type ServiceMode = 'crawl' | 'tunnel' | 'development';

/**
 * Resolve the effective service mode from the SERVICE_MODE env var.
 * Unset, empty, or 'development' all map to 'development' (local dev: everything on).
 * Any unrecognized value throws — a typo in the deploy script must not silently
 * fall back to exposing every endpoint on a public host.
 */
export function resolveServiceMode(raw: string | undefined): ServiceMode {
  if (!raw || raw === 'development') return 'development';
  if (raw === 'crawl' || raw === 'tunnel') return raw;
  throw new Error(`[index] Invalid SERVICE_MODE="${raw}". Expected 'crawl', 'tunnel', or unset/'development'.`);
}

/** Whether the HTTP /crawl + /cancel endpoints are registered for a given mode. */
export function modeEnablesCrawlRoutes(mode: ServiceMode): boolean {
  return mode === 'crawl' || mode === 'development';
}

/**
 * Whether the WebSocket /tunnel handler is attached.
 *
 * - 'tunnel' / 'development'  → always (the dedicated public tunnel service; local-dev everything-on).
 * - 'crawl' + PLATFORM=postgres → ALSO yes: the self-host single container serves both /crawl and the
 *   companion's /tunnel, so a device-proxy crawl parked at /crawl can be claimed by the WS on the same
 *   instance. (The hosted 'crawl' keeps the tunnel OFF — that was a separate public service.)
 *
 * `platform` defaults to the live PLATFORM env so call sites that only know the mode keep working.
 */
export function modeEnablesTunnel(
  mode: ServiceMode,
  platform: string | undefined = process.env.PLATFORM,
): boolean {
  if (mode === 'tunnel' || mode === 'development') return true;
  return mode === 'crawl' && (platform ?? 'local').toLowerCase() === 'postgres';
}

function registerCancelRoute(
  app: Express,
  transactionHistory: TransactionHistoryUploadStore,
): void {
  app.post('/cancel/:sessionId', verifyInboundIdentity, async (req, res) => {
    const sessionId = req.params.sessionId as string;
    const context = activeSessions.get(sessionId);
    const { fenceCrawl } = await import('./tunnel/tunnel-server.js');
    const reason = 'crawl cancelled by control plane';
    const executionWasActive = hasActiveExecution(sessionId);

    console.log(`[Cancel] Force-killing session ${sessionId}`);
    // Start both permanent fences before awaiting any teardown. Otherwise a
    // context close can let the old execution unwind and unregister itself
    // before the fence is recorded, leaving a window for a delayed dispatch of
    // the same one-shot session id to start new browser work.
    const fenceResultsPromise = Promise.allSettled([
      fenceCrawl(sessionId, reason),
      cancelExecution(sessionId, reason),
    ]);
    try {
      // A registered execution owns its context teardown through its abort
      // handler. An orphaned retry handle can remain after a prior cleanup
      // failure; close that legacy handle directly so cancellation can retry
      // the positive browser fence.
      if (context && !executionWasActive) {
        await context.close();
        console.log(`[Cancel] Browser context closed for session ${sessionId}`);
      }
      const fences = await fenceResultsPromise;
      const failedFence = fences.find(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      );
      if (failedFence) {
        throw failedFence.reason;
      }
    } catch (err) {
      console.warn(`[Cancel] Error fencing session ${sessionId}:`, err);
      // Never acknowledge a positive fence or remove the retry handle while the
      // context may still be active. The control plane keeps the session in
      // `cancelling` and therefore retains its per-connection lock.
      res.status(503).end();
      return;
    }

    activeSessions.delete(sessionId);
    transactionHistory.discard(sessionId);
    res.json({ success: true, sessionId: sessionId as string });
  });
}

// ─── Crawl Endpoint ─────────────────────────────────────────────────
//
// Request validation uses the shared `CrawlRequestSchema` from @accrawl/contracts
// (the single source of truth for the crawl request shape across engine/API/UI).
//
// The RESPONSE CONTRACT depends on who owns completion:
//   - PLATFORM=postgres (the orchestrated self-host stack): ACK immediately (202) and run in the
//     background — the control-plane reads the outcome from the session row + staged_records, never
//     from this response (a held response dies on ~5-minute client/proxy header timeouts, far shorter
//     than a real crawl). Applies to both the plain path (executeCrawl records every outcome via
//     completeSession) and the device-proxy path (the park/claim lifecycle records its own outcome;
//     a park with no companion within the TTL marks the session failed).
//   - PLATFORM=local (standalone engine, no control-plane): the HTTP response IS the delivery channel —
//     run synchronously and return the normalized CrawlResponse, as the quickstart documents. The
//     caller (curl, a script) waits without an intermediary timeout. Every platform keeps this contract.
// The browser is never started on the device-proxy park path — SOCKS5 + Playwright must run on the
// same instance as the inbound WS.

/** The 202-ack contract applies when the platform records completion durably out-of-band (the
 *  orchestrated postgres stack). Standalone platforms deliver the outcome ON the response. Read at
 *  request time so tests can exercise both contracts. */
function ackDispatch(): boolean {
  const platform = (process.env.PLATFORM ?? 'local').toLowerCase();
  return platform === 'postgres';
}

/** A dispatch-time error (couldn't even start the crawl) in the shape that matches the active contract:
 *  a CrawlAck under the ack contract, a failure CrawlResponse under the synchronous standalone contract —
 *  so a caller always gets the same shape on error as it would on success. */
function crawlErrorBody(message: string): CrawlAck | CrawlResponse {
  return ackDispatch()
    ? ({ accepted: false, error: message } satisfies CrawlAck)
    : ({ success: false, error: message, stepsExecuted: 0 } satisfies CrawlResponse);
}

function registerTransactionHistoryRoute(
  app: Express,
  transactionHistory: TransactionHistoryUploadStore,
): void {
  app.post('/crawl/transaction-history', verifyInboundIdentity, (req, res) => {
    const parsed = RecentTransactionHistoryChunkUploadSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid transaction history chunk' });
      return;
    }
    try {
      transactionHistory.put(
        parsed.data.sessionId,
        parsed.data.manifest,
        parsed.data.chunk,
      );
      res.status(204).end();
    } catch (error) {
      console.error(
        '[Crawl] Rejected transaction history chunk:',
        error instanceof Error ? error.message : String(error),
      );
      res.status(409).json({ error: 'Transaction history chunk rejected' });
    }
  });
}

function registerCrawlRoute(
  app: Express,
  transactionHistory: TransactionHistoryUploadStore,
): void {
app.post('/crawl', verifyInboundIdentity, async (req, res) => {
  // Validate the transport shell before consuming any separately uploaded
  // history. The hydrated logical request is validated again below.
  const parsed = CrawlRequestTransportSchema.safeParse(req.body);
  if (!parsed.success) {
    console.error('[Crawl] Invalid request:', parsed.error.message);
    res.status(400).json({ error: 'Invalid request', details: parsed.error.message });
    return;
  }

  let request: CrawlRequest;
  let usedUploadedHistory = false;
  try {
    const hasUploadState = transactionHistory.hasUploadState(parsed.data.sessionId);
    if (hasUploadState && parsed.data.recentTransactions !== undefined) {
      throw new Error('inline transaction history cannot replace an external upload');
    }
    if (hasUploadState && !parsed.data.recentTransactionsManifest) {
      throw new Error('uploaded transaction history requires its exact manifest');
    }
    const historyManifest = parsed.data.recentTransactionsManifest;
    const usesExternalHistory = historyManifest !== undefined
      && parsed.data.recentTransactions === undefined;
    const chunks = usesExternalHistory
      ? transactionHistory.consume(
        parsed.data.sessionId,
        historyManifest,
      )
      : [];
    usedUploadedHistory = hasUploadState && usesExternalHistory;
    request = hydrateCrawlRequestTransactionHistory(parsed.data, chunks);
  } catch (error) {
    console.error(
      '[Crawl] Transaction history integrity validation failed:',
      error instanceof Error ? error.message : String(error),
    );
    res.status(400).json({ error: 'Invalid transaction history' });
    return;
  }
  let workerClaim: 'claimed' | 'duplicate';
  try {
    const workerContext = workerContextOf(request);
    workerClaim = await claimSessionWorker(
      request.sessionId,
      workerContext
        ? { ...workerContext, claimOwnerId: `http:${workerContext.attemptId}` }
        : undefined,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[Crawl] Refused worker claim for session ${request.sessionId}:`, message);
    res.status(409).json(crawlErrorBody(HOSTED_COPY.refreshSessionEnded));
    return;
  }
  if (usedUploadedHistory) transactionHistory.discard(request.sessionId);
  if (workerClaim === 'duplicate') {
    // The original request owns execution. A transport retry receives the same
    // durable ACK but must never allocate a second browser on another replica.
    res.status(202).json({ accepted: true, sessionId: request.sessionId } satisfies CrawlAck);
    return;
  }

  // Device-proxy crawl: park and wait for the companion's tunnel WS rather than running the browser
  // now. Lazy-import the tunnel module so the non-proxy crawl path doesn't pull it in needlessly.
  if (request.useDeviceProxy) {
    if (!request.tunnelToken) {
      // Fail CLOSED. A device-proxy crawl must NEVER run over the engine's (datacenter) IP — that defeats
      // the whole residential-exit guarantee and can trip the bank's datacenter-IP block. Without a token
      // there is no tunnel, so refuse here rather than falling through to the unproxied path below.
      console.error(`[Crawl] useDeviceProxy set but no tunnelToken for session ${request.sessionId}; refusing to run unproxied.`);
      res.status(400).json(crawlErrorBody('useDeviceProxy requires a tunnelToken; refusing to run unproxied'));
      return;
    }
    console.log(`[Crawl] Parking device-proxy crawl for session ${request.sessionId} (awaiting companion tunnel)`);
    try {
      const { parkCrawlRequest } = await import('./tunnel/tunnel-server.js');
      if (ackDispatch()) {
        // ACK now; the park resolves in the background when the WS claims + runs the crawl, or on TTL.
        // Normal outcomes are recorded on the session row. A failed positive-cleanup fence deliberately
        // leaves it active for the control-plane deadline/ownership fence rather than releasing its lock.
        void parkCrawlRequest(request)
          .then((response) => {
            if (!response.success) console.warn(`[Crawl] Device-proxy session ${request.sessionId} ended unsuccessfully: ${response.error ?? 'unknown error'}`);
          })
          .catch((error) => console.error(`[Crawl] Device-proxy session ${request.sessionId} crashed after ack:`, error));
        res.status(202).json({ accepted: true, sessionId: request.sessionId } satisfies CrawlAck);
      } else {
        const response = await parkCrawlRequest(request);
        res.json(response);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[Crawl] Failed to park device-proxy session ${request.sessionId}:`, message);
      res.status(500).json(crawlErrorBody(message));
    }
    return;
  }

  if (ackDispatch()) {
    console.log(`[Crawl] Accepted non-proxy crawl for session ${request.sessionId}`);
    // ACK now, run in the background. executeCrawl records every outcome (success or failure) on the
    // session row via completeSession; the control-plane reads completion from there — never from this
    // response, which would die on ~5-minute client/proxy header timeouts for any real-length crawl.
    res.status(202).json({ accepted: true, sessionId: request.sessionId } satisfies CrawlAck);
    void executeCrawl(request)
      .then((response) => {
        if (!response.success) console.warn(`[Crawl] Session ${request.sessionId} ended unsuccessfully: ${response.error ?? 'unknown error'}`);
      })
      .catch((error) => {
        // Normal outcomes are recorded by executeCrawl. Cleanup-fence rejection deliberately leaves the
        // row active; this is the last-resort log while the control-plane deadline/heartbeat reaper
        // independently fences and reconciles it.
        console.error(`[Crawl] Session ${request.sessionId} crashed after ack:`, error);
      });
    return;
  }

  // Standalone (a platform with no broker): the response is the delivery channel.
  console.log(`[Crawl] Starting crawl for session ${request.sessionId} (synchronous response)`);
  try {
    const response = await executeCrawl(request);
    res.json(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[Crawl] Failed session ${request.sessionId}:`, message);
    res.status(500).json({ success: false, error: message, stepsExecuted: 0 } satisfies CrawlResponse);
  }
});
}

// ─── App factory ────────────────────────────────────────────────────

/**
 * Build the Express app for a given service mode. Routes are registered per mode
 * so the public tunnel service never exposes the OIDC-protected crawl endpoints.
 * Health endpoints are always present.
 */
export function createApp(mode: ServiceMode): Express {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  const transactionHistory = new TransactionHistoryUploadStore();

  // Health check — always available (a host's startup/liveness probes hit both services).
  app.get('/', (_req, res) => {
    res.json({ status: 'ok', service: process.env.SERVICE_NAME || 'accrawl', mode, activeSessions: activeSessions.size });
  });

  if (modeEnablesCrawlRoutes(mode)) {
    registerCancelRoute(app, transactionHistory);
    registerTransactionHistoryRoute(app, transactionHistory);
    registerCrawlRoute(app, transactionHistory);
  }

  return app;
}

// ─── Start Server ───────────────────────────────────────────────────

const SERVER_VERSION = 'v11'; // Bump this on every code change to verify the running server has new code

function startServer(): void {
  const mode = resolveServiceMode(process.env.SERVICE_MODE);
  const PORT = parseInt(process.env.PORT || '8080', 10);

  const crawlRoutes = modeEnablesCrawlRoutes(mode);
  const tunnel = modeEnablesTunnel(mode);

  // Fail closed at boot: refuse to start when the proof this deployment expects from its caller is
  // unusable — but only for services that serve /crawl. The tunnel service authenticates its clients
  // with the tunnel token and must not be blocked from starting.
  assertInboundAuthConfig(crawlRoutes);
  console.log(
    `Crawler service ${SERVER_VERSION} starting: mode=${mode} platform=${(process.env.PLATFORM ?? 'local').toLowerCase()} ` +
    `routes=[${['/', ...(crawlRoutes ? ['/crawl', '/cancel'] : []), ...(tunnel ? ['/tunnel(ws)'] : [])].join(', ')}] ` +
    `(USE_INTERACTIONS_API=${process.env.USE_INTERACTIONS_API !== 'false'})`,
  );

  const app = createApp(mode);
  const server = app.listen(PORT, () => {
    console.log(`Crawler service ${SERVER_VERSION} listening on port ${PORT} (mode=${mode})`);
  });

  // Attach the WebSocket tunnel handler for device-proxy connections. Served in 'tunnel'/'development'
  // and — for the self-host single container — in 'crawl' when PLATFORM=postgres. Loaded lazily: the
  // tunnel module authenticates with the HMAC tunnel token and runs its claim through the active
  // platform, so attaching it pulls in nothing beyond the platform already in use.
  if (tunnel) {
    import('./tunnel/tunnel-server.js')
      .then((m) => m.attachTunnelHandler(server))
      .catch((err) => console.error('[index] Failed to attach tunnel handler:', err));
  }

  // Graceful shutdown
  process.on('SIGTERM', async () => {
    console.log('SIGTERM received, shutting down...');
    await closeBrowser();
    process.exit(0);
  });
}

// Global crash handlers to prevent silent death
process.on('uncaughtException', (err) => {
  console.error('[CRASH] Uncaught exception:', err);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('[CRASH] Unhandled rejection:', reason);
  process.exit(1);
});

// Only start the server when run as the entrypoint, not when imported by tests.
if (process.env.NODE_ENV !== 'test') {
  startServer();
}
