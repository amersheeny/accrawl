/**
 * Device Tunnel Server
 *
 * Manages WebSocket connections from the companion device and bridges them to a local SOCKS5 server
 * so Playwright can route browser traffic through the user's device (residential IP).
 *
 * Self-host (park-and-wait) crawl flow:
 *   1. The control-plane mints a session+device-bound tunnel token (HMAC, derived from the shared
 *      ENGINE_SHARED_SECRET) and dispatches the CrawlRequest to the engine's POST /crawl.
 *   2. /crawl sees `useDeviceProxy && tunnelToken` and PARKS the parsed request (keyed by sessionId,
 *      bounded TTL) instead of running the browser immediately. Orchestrated mode ACKs immediately;
 *      standalone mode keeps the HTTP response pending.
 *   3. The companion connects to /tunnel?sessionId=X with the tunnel token (Authorization: Bearer or
 *      ?token=). This handler verifies the token, binds it to the session (payload.sid === sessionId),
 *      then atomically single-use-claims the tunnel via platform.loadTunnelContext (CAS on the DB).
 *   4. On a winning claim it pulls the PARKED request, starts SOCKS5, and runs executeCrawl(request,
 *      { proxyUrl }). The durable session outcome resolves the orchestrated run; standalone mode
 *      returns the CrawlResponse on the parked /crawl HTTP response.
 *   5. SOCKS5 + WebSocket are torn down on completion.
 *
 * Auth is the tunnel token, not an identity service: the engine never reads one, nor the devices table —
 * the token + the DB claim are the whole gate. The wire protocol (the {connect|data|close} /
 * {connected|data|close|error} JSON framing) and the SOCKS5↔WS bridge below are the byte-for-byte
 * contract with the companion and are unchanged.
 */

import type { Server as HttpServer } from 'http';
import type { Socket as NetSocket } from 'net';
import { WebSocketServer, WebSocket } from 'ws';
import { deriveTunnelKey, verifyTunnelToken } from '@accrawl/contracts';
import { createSocks5Server, type Socks5Server, type Socks5Connection } from './socks5-server';
import { CrawlCleanupError, executeCrawl } from '../crawl-executor';
import { getPlatform } from '../platform';
import { completeSession } from '../agent/session-updater';
import type { CrawlRequest, CrawlResponse } from '../types';

// ─── Wire Protocol ──────────────────────────────────────────────────

type TunnelMessage =
  | { type: 'connect'; connId: number; host: string; port: number }
  | { type: 'connected'; connId: number }
  | { type: 'data'; connId: number; data: string } // base64
  | { type: 'close'; connId: number }
  | { type: 'error'; connId: number; message: string };

// ─── Tunnel State ───────────────────────────────────────────────────

interface SocksConnectionEntry {
  socket: NetSocket;
  sendSuccess: () => void;
  sendFailure: () => void;
  /** The SOCKS socket's 'data' listener, kept so {close}/teardown can detach it (fix: a deleted conn
   *  whose FD lingers half-open must not keep relaying for a connId no longer in the map). */
  onSocketData?: (chunk: Buffer) => void;
  /** True while conn.socket is paused for engine→phone backpressure (ws.bufferedAmount over HIGH_WATER),
   *  so the drain poller never double-resumes and 'data' never double-pauses. */
  paused: boolean;
  /** True while THIS conn's connId is in tunnel.wsBackpressuredConns (its target SOCKS socket's write()
   *  returned false and hasn't drained). Guards the refcount against a second {data} frame re-adding the
   *  same connId (write() keeps returning false until 'drain') and against a stale 'drain' double-removing
   *  after teardown already cleared it. The single 'drain' listener that flips this off also removes the
   *  connId from the set. */
  wsBackpressured: boolean;
}

// ── Backpressure thresholds ─────────────────────────────────────────
//
// `ws` exposes no 'drain' event, so we watch ws.bufferedAmount (bytes still queued in the WS send
// buffer) and gate the SOCKS read side against it:
//   • engine→phone: when a conn's writes push bufferedAmount past HIGH_WATER we pause THAT conn's SOCKS
//     socket; a poller resumes it once bufferedAmount falls below LOW_WATER. Bounds engine memory when
//     Chrome uploads faster than the WS can flush to the phone.
const WS_HIGH_WATER_BYTES = 1024 * 1024; // 1 MiB queued → pause the SOCKS read side
const WS_LOW_WATER_BYTES = 256 * 1024;   // back under 256 KiB → resume
const WS_DRAIN_POLL_MS = 25;             // ws has no 'drain'; poll the send-buffer at this cadence

interface ActiveTunnel {
  ws: WebSocket;
  socks5: Socks5Server;
  /** SOCKS5 client sockets keyed by connId, for routing companion responses back */
  connections: Map<number, SocksConnectionEntry>;
  /** connIds whose target SOCKS socket write() returned false and has NOT drained yet — i.e. the set of
   *  connections currently exerting phone→engine backpressure. The single shared WS receive path is paused
   *  while this set is non-empty and resumed only when it empties, so the WS stays throttled while ANY
   *  connection is backpressured (a single tunnel-wide boolean lost this: one conn's drain/close resumed the
   *  WS while another conn's socket was still full → unbounded buffering, the OOM vector). Pausing the shared
   *  underlying TCP socket throttles the whole tunnel, which is correct: it must not advance past the slowest
   *  reader. Add/remove are the pause/resume transitions; see addWsBackpressure / removeWsBackpressure. */
  wsBackpressuredConns: Set<number>;
}

const activeTunnels = new Map<string, ActiveTunnel>();
const closingTunnels = new Map<string, Promise<void>>();
/** Every authenticated WebSocket, including claim/bind windows before an active tunnel is published. */
const pendingWebSockets = new Map<string, Set<WebSocket>>();
/** SOCKS binds that passed the ownership check but have not yet been published into activeTunnels. */
const pendingBinds = new Map<string, Set<Promise<void>>>();

function trackPendingWebSocket(sessionId: string, ws: WebSocket): void {
  const sockets = pendingWebSockets.get(sessionId) ?? new Set<WebSocket>();
  sockets.add(ws);
  pendingWebSockets.set(sessionId, sockets);
  const remove = (): void => {
    sockets.delete(ws);
    if (sockets.size === 0 && pendingWebSockets.get(sessionId) === sockets) {
      pendingWebSockets.delete(sessionId);
    }
  };
  ws.once('close', remove);
  ws.once('error', remove);
}

function beginPendingBind(sessionId: string): () => void {
  let complete!: () => void;
  const bind = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const binds = pendingBinds.get(sessionId) ?? new Set<Promise<void>>();
  binds.add(bind);
  pendingBinds.set(sessionId, binds);
  let completed = false;
  return (): void => {
    if (completed) return;
    completed = true;
    binds.delete(bind);
    if (binds.size === 0 && pendingBinds.get(sessionId) === binds) {
      pendingBinds.delete(sessionId);
    }
    complete();
  };
}

// ─── Park-and-wait registry ─────────────────────────────────────────
//
// A device-proxy crawl can't run the browser until the companion's tunnel WS is up: SOCKS5 +
// Playwright must live on the same instance as the inbound WS. So POST /crawl parks the request
// here; the WS claim pulls it and runs the crawl. Orchestrated platforms ACK the HTTP dispatch
// immediately and observe the durable session outcome, while standalone mode awaits this promise.
// If no WS connects within the shared allowance, the session is failed closed.

/**
 * A proxy crawl waits for its companion for the configured crawl timeout.
 * The same request field governs the orchestrator's completion poll.
 */
export function parkedCrawlConnectTimeoutMs(request: CrawlRequest): number {
  return request.timeoutSeconds * 1000;
}

interface ParkedCrawl {
  request: CrawlRequest;
  /** Resolves the pending POST /crawl HTTP response with the crawl's outcome. */
  resolve: (response: CrawlResponse) => void;
  /** Rejects the worker wait when a positive execution fence cannot be established. */
  reject: (error: CrawlCleanupError) => void;
  /** TTL timer — fires if no companion WS claims the tunnel in time. */
  timer: ReturnType<typeof setTimeout>;
  /** True once a companion has WON the claim and the crawl is running. The connect-wait TTL must NOT
   *  fire after this — the crawl now governs its own lifetime via the executor's watchdog/timeoutSeconds.
   *  Without this, a crawl that runs longer than the connect-wait period gets
   *  killed mid-flight by the stale timer. */
  claimed: boolean;
  /** Guards against double-settle (TTL vs WS claim racing). */
  settled: boolean;
}

const parkedCrawls = new Map<string, ParkedCrawl>();
/**
 * Permanent, process-local ownership tombstones. A hosted worker is one-shot
 * and a session id is never reusable, so retaining the tombstone is both
 * bounded and necessary: an async SOCKS bind or a late HTTP dispatch must not
 * recreate work after the first ownership-loss cleanup sweep.
 */
const fencedCrawls = new Map<string, string>();

interface CrawlLifecycle {
  controller: AbortController;
  done: Promise<void>;
}

const crawlLifecycles = new Map<string, CrawlLifecycle>();

function beginCrawlLifecycle(sessionId: string): {
  lifecycle: CrawlLifecycle;
  finish: () => void;
} {
  const controller = new AbortController();
  let resolveDone!: () => void;
  const lifecycle: CrawlLifecycle = {
    controller,
    done: new Promise<void>((resolve) => {
      resolveDone = resolve;
    }),
  };
  crawlLifecycles.set(sessionId, lifecycle);
  let finished = false;
  return {
    lifecycle,
    finish: () => {
      if (finished) return;
      finished = true;
      if (crawlLifecycles.get(sessionId) === lifecycle) {
        crawlLifecycles.delete(sessionId);
      }
      resolveDone();
    },
  };
}

function fencedResponse(reason: string): CrawlResponse {
  return {
    success: false,
    error: reason,
    failureReason: 'instance_died',
    stepsExecuted: 0,
  };
}

/**
 * Park a device-proxy CrawlRequest until the companion's tunnel WS connects + claims it. Returns a
 * promise that resolves with the crawl's CrawlResponse (run after the WS claim) or, on TTL expiry
 * with no companion, a failure CrawlResponse (after the session is marked failed). Replacing an
 * existing park for the same session fails the old one first so a caller is never left hanging.
 */
export function parkCrawlRequest(
  request: CrawlRequest,
  ttlMs: number = parkedCrawlConnectTimeoutMs(request),
): Promise<CrawlResponse> {
  const sessionId = request.sessionId;
  const fencedReason = fencedCrawls.get(sessionId);
  if (fencedReason) {
    return Promise.resolve(fencedResponse(fencedReason));
  }
  // A stale park for the same session (e.g. a retried dispatch) must not orphan the prior waiter.
  const existing = parkedCrawls.get(sessionId);
  if (existing) {
    settleParked(existing, sessionId, {
      success: false,
      error: 'superseded by a newer crawl dispatch for this session',
      failureReason: 'internal_error',
      stepsExecuted: 0,
    });
  }

  return new Promise<CrawlResponse>((resolve, reject) => {
    const timer = setTimeout(() => {
      const parked = parkedCrawls.get(sessionId);
      // Once a companion has CLAIMED the tunnel the crawl is running on its own watchdog — the connect-wait
      // TTL no longer applies and must never tear down a live crawl. (claimParked also clears this timer, so
      // this is belt-and-suspenders against a clear/fire race.)
      if (!parked || parked.settled || parked.claimed) return;
      console.warn(`[Tunnel] No companion connected within ${Math.round(ttlMs / 1000)}s for session ${sessionId}; failing crawl.`);
      const failure: CrawlResponse = {
        success: false,
        error: `device proxy tunnel was not established within ${Math.round(ttlMs / 1000)}s (no companion connected)`,
        failureReason: 'internal_error',
        stepsExecuted: 0,
      };
      // Best-effort: write the terminal status via the platform's SessionStore so the control-plane's
      // poller/reaper sees the failure (the parked response also returns it to the dispatch caller).
      completeSession(sessionId, false, failure.error)
        .catch((err) => console.warn(`[Tunnel] Failed to mark parked session ${sessionId} as failed:`, err))
        .finally(() => settleParked(parked, sessionId, failure));
    }, ttlMs);
    if (typeof timer.unref === 'function') timer.unref();
    parkedCrawls.set(sessionId, {
      request,
      resolve,
      reject,
      timer,
      claimed: false,
      settled: false,
    });
  });
}

/**
 * Mark a parked crawl as CLAIMED and cancel its connect-wait TTL: a companion has won the tunnel and the
 * crawl is about to run, so the only remaining lifetime bound is the crawl executor's own watchdog. Keeps
 * the registry entry (still un-settled) so settleParked resolves the parked HTTP response on completion.
 * Returns the parked entry, or undefined if it's gone, already settled, or already claimed (the caller bails).
 */
function claimParked(sessionId: string): ParkedCrawl | undefined {
  const parked = parkedCrawls.get(sessionId);
  // Reject if gone, already settled, OR already claimed: the platform's single-use CAS (postgres) is the
  // primary duplicate guard, but make the in-memory registry itself reject a double-claim too, so a store
  // that does NOT enforce single-use (the dev-only local adapter, a test double, or a future/broken
  // platform) can never run executeCrawl twice for one parked request.
  if (!parked || parked.settled || parked.claimed) return undefined;
  parked.claimed = true;
  clearTimeout(parked.timer);
  return parked;
}

/** Resolve a parked crawl's HTTP response exactly once, clearing its TTL timer + registry entry. */
function settleParked(parked: ParkedCrawl, sessionId: string, response: CrawlResponse): void {
  if (parked.settled) return;
  parked.settled = true;
  clearTimeout(parked.timer);
  parkedCrawls.delete(sessionId);
  parked.resolve(response);
}

/**
 * Propagate a failed positive fence to the one-shot worker. Logging the
 * WebSocket handler rejection alone would leave its parked worker promise
 * pending and heartbeating forever, so rejection is part of the fence.
 */
function rejectParked(parked: ParkedCrawl, sessionId: string, error: CrawlCleanupError): void {
  if (parked.settled) return;
  parked.settled = true;
  clearTimeout(parked.timer);
  parkedCrawls.delete(sessionId);
  parked.reject(error);
}

/** Test/shutdown helper: whether a session currently has a parked (unclaimed) crawl. */
export function hasParkedCrawl(sessionId: string): boolean {
  return parkedCrawls.has(sessionId);
}

// ─── Public API ─────────────────────────────────────────────────────

/**
 * Tear down a tunnel (SOCKS5 server + WebSocket).
 */
export async function closeTunnel(sessionId: string): Promise<void> {
  const existingClose = closingTunnels.get(sessionId);
  if (existingClose) return existingClose;
  const active = activeTunnels.get(sessionId);
  const pending = [...(pendingWebSockets.get(sessionId) ?? [])];
  if (!active && pending.length === 0) return;

  const closing = (async (): Promise<void> => {
    const failures: unknown[] = [];
    // Close all tracked SOCKS5 client sockets (detaching their 'data' relay listeners first, so no
    // half-open FD keeps relaying after teardown).
    for (const [connId, entry] of active?.connections ?? []) {
      try {
        destroySocksConn(entry);
        entry.wsBackpressured = false;
        removeWsBackpressure(active!, connId);
        active!.connections.delete(connId);
      } catch (error) {
        console.warn(`[Tunnel] Failed to destroy socket for session ${sessionId}:`, error);
        // Keep the entry registered so a later ownership/signal fence can
        // retry it. Deleting a failed close would make a retry report a false
        // positive while an untracked bank connection remained live.
        failures.push(error);
      }
    }
    const webSockets = new Set(pending);
    if (active) webSockets.add(active.ws);
    for (const ws of webSockets) {
      try {
        // A graceful WebSocket close returns before the peer acknowledges it.
        // terminate() destroys the underlying socket synchronously.
        ws.terminate();
        pendingWebSockets.get(sessionId)?.delete(ws);
      } catch (error) {
        console.warn(`[Tunnel] Failed to close websocket for session ${sessionId}:`, error);
        failures.push(error);
      }
    }
    if (pendingWebSockets.get(sessionId)?.size === 0) {
      pendingWebSockets.delete(sessionId);
    }
    if (active) {
      try {
        await active.socks5.close();
      } catch (error) {
        console.warn(`[Tunnel] Failed to close SOCKS5 server for session ${sessionId}:`, error);
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `Tunnel teardown was incomplete for session ${sessionId}`,
      );
    }
    if (active && activeTunnels.get(sessionId) === active) {
      activeTunnels.delete(sessionId);
    }
    console.log(`[Tunnel] Closed tunnel for session ${sessionId}`);
  })();
  closingTunnels.set(sessionId, closing);
  try {
    await closing;
  } finally {
    if (closingTunnels.get(sessionId) === closing) {
      closingTunnels.delete(sessionId);
    }
  }
}

/**
 * Fence every device-proxy path owned by one crawl. This is stronger than
 * closeTunnel alone: it also resolves a request that is still parked (or whose
 * companion has claimed it) so the one-shot worker cannot remain blocked after
 * its durable job lease is cancelled or lost.
 */
export async function fenceCrawl(sessionId: string, reason: string): Promise<void> {
  // Record the fence before sweeping current resources. Awaited setup that
  // resumes after this point must observe the tombstone and tear itself down.
  fencedCrawls.set(sessionId, reason);
  const parked = parkedCrawls.get(sessionId);
  const lifecycle = crawlLifecycles.get(sessionId);
  lifecycle?.controller.abort(new Error(reason));
  await closeTunnel(sessionId);
  // A handler can be inside createSocks5Server(): it has passed its last
  // ownership check but cannot publish the listener until that await returns.
  // Wait for every such bind to either fail or register itself, then sweep
  // again. Late upgrades are rejected by the tombstone before handleUpgrade.
  const binds = [...(pendingBinds.get(sessionId) ?? [])];
  if (binds.length > 0) {
    await Promise.all(binds);
  }
  // Always rescan: a bind may have completed (and removed its pending marker)
  // in the microtask between the first close and the snapshot above.
  await closeTunnel(sessionId);
  // Resolving the park wakes the worker's `work` promise, so do it only after
  // tunnel teardown and any claimed execution lifecycle has finished closing
  // its browser context and cancellation-safe durable completion.
  if (lifecycle) {
    await lifecycle.done;
  }
  if (parked) {
    settleParked(parked, sessionId, fencedResponse(reason));
  }
}

/**
 * Attach the WebSocket upgrade handler to an HTTP server.
 */
export function attachTunnelHandler(server: HttpServer): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    // Parse only the path + query from req.url. The Host header is irrelevant here, and a malformed one
    // (e.g. `Host: [`) would make `new URL` throw — and this runs OUTSIDE the WS handler's try/catch, on the
    // externally-reachable /tunnel upgrade, so the throw would crash the process (DoS). Use a fixed base and
    // guard the parse so a malformed request line just drops the socket.
    let url: URL;
    try {
      url = new URL(req.url || '/', 'http://localhost');
    } catch {
      socket.destroy();
      return;
    }

    if (url.pathname !== '/tunnel') {
      socket.destroy();
      return;
    }

    const sessionId = url.searchParams.get('sessionId');

    // Tunnel token from Authorization: Bearer <token>, falling back to ?token= for clients that
    // can't set WS headers. (Not an identity-service token — the engine verifies it with the derived key.)
    const authHeader = req.headers['authorization'] as string | undefined;
    const token = authHeader?.startsWith('Bearer ')
      ? authHeader.slice(7)
      : url.searchParams.get('token');

    if (!sessionId || !token) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }

    // Verify the tunnel token (HMAC over the derived key) BEFORE upgrading.
    const secret = process.env.ENGINE_SHARED_SECRET;
    if (!secret) {
      console.error('[Tunnel] ENGINE_SHARED_SECRET is not set; cannot verify tunnel token. Rejecting.');
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    const payload = verifyTunnelToken(deriveTunnelKey(secret), token);
    if (!payload) {
      console.warn(`[Tunnel] Tunnel token verification failed for session ${sessionId}. Rejecting.`);
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    // Bind the WS to the session: the token's sid MUST match the connection's sessionId, so a token
    // for session A can never open a tunnel for session B.
    if (payload.sid !== sessionId) {
      console.warn(`[Tunnel] Token sid '${payload.sid}' does not match WS sessionId '${sessionId}'. Rejecting.`);
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    // Once an ownership fence exists, reject before upgrading. This makes it
    // impossible for a new authenticated WebSocket to appear after the fence
    // has snapshotted the registry.
    if (fencedCrawls.has(sessionId)) {
      socket.write('HTTP/1.1 409 Conflict\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      // handleUpgrade and this callback run in the same event-loop turn as the
      // tombstone check above. Register before the async handler reaches its
      // first await, so any later fence sees this transport.
      trackPendingWebSocket(sessionId, ws);
      handleCompanionConnection(sessionId, payload.did, ws).catch((err) => {
        console.error(`[Tunnel] Unhandled error for session ${sessionId}:`, err);
      });
    });
  });

  console.log('[Tunnel] WebSocket upgrade handler attached');
}

// ─── Internal ───────────────────────────────────────────────────────

/**
 * Handle an authenticated companion WebSocket connection. The token was already verified + bound to
 * the session in attachTunnelHandler; here we atomically single-use-claim the tunnel, then (on a
 * winning claim) pull the PARKED CrawlRequest, start SOCKS5, and run the crawl with the proxy.
 */
async function handleCompanionConnection(sessionId: string, deviceId: string, ws: WebSocket): Promise<void> {
  console.log(`[Tunnel] Companion connected for session ${sessionId}`);

  const existingFence = fencedCrawls.get(sessionId);
  if (existingFence) {
    ws.terminate();
    return;
  }

  // 1. Atomic single-use claim. Only the connection that WINS the CAS may bridge the tunnel; a null
  // context (no such session), a non-active status, or claimed===false (already claimed / never
  // requested) all reject. This — not the token alone — is the single-use enforcement.
  let claimed = false;
  try {
    const context = await getPlatform().tunnel.loadTunnelContext(sessionId, deviceId);
    if (!context) {
      console.warn(`[Tunnel] No session '${sessionId}' for tunnel claim. Rejecting.`);
      ws.close(1008, 'Unknown session');
      return;
    }
    if (!ACTIVE_TUNNEL_STATUSES.has(context.status)) {
      console.warn(`[Tunnel] Session '${sessionId}' is not active (status='${context.status}'). Rejecting.`);
      ws.close(1008, 'Session not active');
      return;
    }
    if (!context.claimed) {
      console.warn(`[Tunnel] Tunnel for session '${sessionId}' was not claimable (tunnelRequested=${context.tunnelRequested}). Rejecting.`);
      ws.close(1008, 'Tunnel already claimed or not requested');
      return;
    }
    claimed = true;
  } catch (err) {
    console.error(`[Tunnel] Failed to load tunnel context for session ${sessionId}:`, err);
    ws.close(1011, 'Tunnel claim failed');
    return;
  }

  // Ownership can be revoked while the durable claim query is in flight.
  const postClaimFence = fencedCrawls.get(sessionId);
  if (postClaimFence) {
    ws.terminate();
    return;
  }

  // 2. Pull the PARKED CrawlRequest dispatched via POST /crawl. We do NOT rebuild it from any store —
  // the request (credentials, scope, hints, existing data) arrived over the trusted dispatch.
  const parked = parkedCrawls.get(sessionId);
  if (!parked) {
    // Won the CAS but POST /crawl hasn't parked the request yet. The control-plane sets tunnel_requested
    // BEFORE it dispatches/parks, so a fast companion can win the claim in that gap. Do NOT burn the
    // one-time claim — RELEASE it so the companion's next poll reclaims once the parked crawl exists.
    console.warn(`[Tunnel] Claim won but no parked crawl yet for session ${sessionId}; releasing claim for retry.`);
    await getPlatform().tunnel.releaseTunnelClaim(sessionId).catch((err) =>
      console.error(`[Tunnel] Failed to release tunnel claim for session ${sessionId}:`, err));
    ws.close(1013, 'No parked crawl yet — retry');
    return;
  }
  // Claim the park: cancel the connect-wait TTL NOW (before the long crawl) so it can never tear down the
  // live run; the crawl executor's own watchdog/timeoutSeconds is the lifetime bound from here on. Returns
  // undefined if the entry vanished or was already settled — then bail without re-running a finished crawl.
  const claimedParked = claimParked(sessionId);
  if (!claimedParked) {
    // Defensive: settleParked deletes the map entry as it flips `settled` (same synchronous tick), so a
    // present-yet-settled entry shouldn't occur in the normal flow — and a genuine duplicate connection is
    // already rejected earlier at the CAS (claimed=false). Guard anyway so a future refactor that retains
    // settled entries can never re-run a completed crawl: don't release the claim, just close.
    console.warn(`[Tunnel] Parked crawl for session ${sessionId} already settled; closing.`);
    ws.close(1000, 'Crawl already handled');
    return;
  }
  const request = claimedParked.request;
  const { lifecycle, finish: finishLifecycle } = beginCrawlLifecycle(sessionId);

  try {
    let socks5: Socks5Server | undefined;
    let response!: CrawlResponse;
    let fatalCleanupError: CrawlCleanupError | undefined;
    try {
      // 3. Start the SOCKS5 server and wire the SOCKS5 ↔ WebSocket bridge.
      const completeBind = beginPendingBind(sessionId);
      try {
        socks5 = await createSocks5Server();
        const tunnel: ActiveTunnel = {
          ws,
          socks5,
          connections: new Map(),
          wsBackpressuredConns: new Set(),
        };
        activeTunnels.set(sessionId, tunnel);
      } finally {
        // On success the bound listener is already discoverable through
        // activeTunnels; on failure no listener was returned.
        completeBind();
      }
      // createSocks5Server binds asynchronously. If ownership was lost during
      // that await, fenceCrawl waits for the pending bind and closes the newly
      // published listener before it can be used to start a browser crawl.
      const postBindFence = fencedCrawls.get(sessionId);
      if (postBindFence) {
        return;
      }
      const tunnel = activeTunnels.get(sessionId);
      if (!tunnel || tunnel.socks5 !== socks5) {
        throw new CrawlCleanupError(sessionId, new Error('published tunnel disappeared before browser start'));
      }
      wireSocksBridge(sessionId, tunnel);

      const proxyUrl = `socks5://127.0.0.1:${socks5.port}`;
      console.log(`[Tunnel] SOCKS5 proxy ready at ${proxyUrl} for session ${sessionId}`);

      // 4. Run the crawl with the parked request, routing browser egress through
      // the proxy. The executor first closes its browser context, then invokes
      // this transport fence, and only then terminalizes the durable session.
      // That keeps the connection lock held until neither the browser nor its
      // SOCKS/WebSocket route can reach the institution.
      response = await executeCrawl(request, proxyUrl, {
        beforeSessionCompletion: () => closeTunnel(sessionId),
        signal: lifecycle.controller.signal,
      });
      console.log(`[Tunnel] Crawl completed for session ${sessionId}: success=${response.success}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[Tunnel] Tunnel-triggered crawl failed for session ${sessionId}:`, message);
      if (err instanceof CrawlCleanupError) {
        fatalCleanupError = err;
      }
      // executeCrawl owns terminal session telemetry on its own paths; this catch covers SOCKS5 setup
      // and the rare throw. Settle the parked HTTP response with the failure so the dispatch caller
      // never hangs.
      response = {
        success: false,
        error: message,
        failureReason: 'internal_error',
        stepsExecuted: 0,
      };
    }
    // The successful executor path already closed the tunnel before terminal
    // session persistence. This call handles SOCKS setup failures and retries a
    // failed executor fence. Resolve the worker's parked request only after every
    // tunnel path is positively closed. If teardown fails, leave the park
    // unresolved and the active tunnel registered: the ownership fence retries
    // it, and a repeated failure terminates PID 1 without terminalizing the
    // durable crawl job.
    try {
      await closeTunnel(sessionId);
    } catch (error) {
      const cleanupError = fatalCleanupError ?? new CrawlCleanupError(sessionId, error);
      rejectParked(claimedParked, sessionId, cleanupError);
      throw cleanupError;
    }
    if (fatalCleanupError) {
      rejectParked(claimedParked, sessionId, fatalCleanupError);
      throw fatalCleanupError;
    }
    settleParked(claimedParked, sessionId, response);
  } finally {
    finishLifecycle();
  }
}

/** Session statuses an in-flight, awaiting-tunnel crawl can be in. A device-proxy session is parked
 *  as 'starting' by the control-plane; the engine advances it once the crawl runs. A terminal status
 *  (completed/failed/cancelled) means the tunnel must NOT be (re)opened. */
const ACTIVE_TUNNEL_STATUSES = new Set([
  'starting', 'logging_in', 'navigating', 'waiting_for_otp', 'extracting',
]);

/**
 * Wire the SOCKS5 ↔ WebSocket bridge for bidirectional data relay.
 */
function wireSocksBridge(sessionId: string, tunnel: ActiveTunnel): void {
  const { ws, socks5 } = tunnel;

  // ── SOCKS5 → WebSocket (Playwright → companion) ──

  socks5.onConnect((conn: Socks5Connection) => {
    // The WS can be gone by the time a SOCKS client connects (companion disconnected, server still
    // accepting briefly). sendToApk would silently no-op and the SOCKS socket would hang forever — fail
    // it closed instead so Chrome retries/aborts rather than stalling.
    if (ws.readyState !== WebSocket.OPEN) {
      try { conn.sendFailure(); } catch { /* socket may already be gone */ }
      try { conn.socket.destroy(); } catch { /* already gone */ }
      return;
    }

    const entry: SocksConnectionEntry = {
      socket: conn.socket,
      sendSuccess: conn.sendSuccess,
      sendFailure: conn.sendFailure,
      paused: false,
      wsBackpressured: false,
    };
    tunnel.connections.set(conn.connId, entry);

    // Ask the companion to open a TCP connection to the target
    sendToApk(ws, {
      type: 'connect',
      connId: conn.connId,
      host: conn.host,
      port: conn.port,
    });

    // Forward data from Playwright socket → WebSocket → companion, with engine→phone backpressure: ws.send
    // is fire-and-forget, so when ws.bufferedAmount climbs past HIGH_WATER we pause THIS SOCKS socket and
    // let a poller resume it once the WS send-buffer drains below LOW_WATER. Without this, Chrome uploading
    // faster than the WS can flush would buffer unboundedly in engine memory.
    const onSocketData = (chunk: Buffer) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      sendToApk(ws, {
        type: 'data',
        connId: conn.connId,
        data: chunk.toString('base64'),
      });
      if (!entry.paused && ws.bufferedAmount > WS_HIGH_WATER_BYTES) {
        entry.paused = true;
        conn.socket.pause();
        scheduleDrainResume(ws, entry, conn.socket);
      }
    };
    entry.onSocketData = onSocketData;
    conn.socket.on('data', onSocketData);

    conn.socket.on('close', () => {
      tunnel.connections.delete(conn.connId);
      // If the WS receive path was paused waiting on THIS socket to drain (phone→engine backpressure), a
      // destroyed socket will never emit 'drain' — drop this connId from the backpressure set so the WS can
      // resume once no OTHER connection is still backpressured (removeWsBackpressure resumes only on empty).
      entry.wsBackpressured = false;
      removeWsBackpressure(tunnel, conn.connId);
      if (ws.readyState === WebSocket.OPEN) {
        sendToApk(ws, { type: 'close', connId: conn.connId });
      }
    });

    conn.socket.on('error', () => {
      tunnel.connections.delete(conn.connId);
      entry.wsBackpressured = false;
      removeWsBackpressure(tunnel, conn.connId);
      if (ws.readyState === WebSocket.OPEN) {
        sendToApk(ws, { type: 'close', connId: conn.connId });
      }
    });
  });

  // ── WebSocket → SOCKS5 (companion → Playwright) ──

  ws.on('message', (raw) => {
    // The ENTIRE per-message handler is wrapped: a malformed frame (bad JSON, wrong shape, missing/typed
    // fields) must NEVER throw out of here — an uncaught exception in a ws 'message' listener crashes the
    // process. On any protocol violation we log + ignore the frame.
    try {
      const msg = parseTunnelFrame(raw);
      if (!msg) return; // malformed — already logged

      const entry = tunnel.connections.get(msg.connId);
      if (!entry) return; // Connection already closed

      switch (msg.type) {
        case 'connected':
          // Companion successfully opened TCP connection — tell Playwright SOCKS5 succeeded
          entry.sendSuccess();
          break;

        case 'data': {
          // Companion received data from target — forward to Playwright, with phone→engine backpressure:
          // if the SOCKS socket's write buffer is full (write() returns false) we pause the WHOLE WS
          // receive path (the shared underlying TCP socket) until that socket drains, so a slow Chrome
          // reader can't make the phone's bytes pile up unboundedly in engine memory. The WS is a single
          // shared receive path for ALL connections, so it must stay paused while ANY connection is
          // backpressured — we refcount the backpressured connIds (addWsBackpressure) and resume only when
          // the set empties (the matching 'drain' below). A single tunnel-wide boolean would let conn B's
          // drain resume the WS while conn A's socket was still full, reopening the OOM vector.
          const ok = entry.socket.write(Buffer.from(msg.data, 'base64'));
          if (!ok && !entry.wsBackpressured) {
            entry.wsBackpressured = true;
            addWsBackpressure(tunnel, msg.connId);
            entry.socket.once('drain', () => {
              entry.wsBackpressured = false;
              removeWsBackpressure(tunnel, msg.connId);
            });
          }
          break;
        }

        case 'close':
          // Companion closed the connection. Fully tear the SOCKS socket DOWN (destroy, not end): an
          // end() leaves the FD half-open and its still-attached 'data' handler keeps relaying for a
          // connId we've already deleted. Detach the listener first, then destroy, then delete. Drop this
          // connId from the backpressure set too — a destroyed socket never emits 'drain', so it must not
          // keep the shared WS paused.
          destroySocksConn(entry);
          entry.wsBackpressured = false;
          removeWsBackpressure(tunnel, msg.connId);
          tunnel.connections.delete(msg.connId);
          break;

        case 'error':
          // Companion failed to connect
          entry.sendFailure();
          entry.wsBackpressured = false;
          removeWsBackpressure(tunnel, msg.connId);
          tunnel.connections.delete(msg.connId);
          break;
      }
    } catch (err) {
      // Defensive catch-all: never let an unexpected throw escape the message handler and crash the engine.
      console.warn(`[Tunnel] Error handling companion frame for ${sessionId}:`, err);
    }
  });

  // On WS close/error the companion is gone: fail every pending SOCKS connection so the browser doesn't
  // hang, then tear the WHOLE tunnel down (closeTunnel stops the SOCKS5 server too). Otherwise the SOCKS
  // server keeps accepting connections that can never reach the dead companion (sendToApk no-ops → hang).
  const onWsGone = (reason: string): void => {
    console.log(`[Tunnel] Companion ${reason} for session ${sessionId}`);
    for (const [connId, entry] of tunnel.connections) {
      try {
        entry.sendFailure();
      } catch (error) {
        console.warn(`[Tunnel] Failed to notify SOCKS5 client of companion ${reason} for session ${sessionId}:`, error);
      }
      try {
        destroySocksConn(entry);
        entry.wsBackpressured = false;
        removeWsBackpressure(tunnel, connId);
        tunnel.connections.delete(connId);
      } catch (error) {
        console.warn(`[Tunnel] Failed to destroy SOCKS5 socket after companion ${reason} for session ${sessionId}:`, error);
        // closeTunnel below retries registered entries and rejects its
        // positive-fence promise if they still cannot be destroyed.
      }
    }
    // Stop accepting new SOCKS connections that could never reach the dead companion. closeTunnel is
    // idempotent and serialized with the completion path, so a concurrent
    // teardown joins the same promise instead of double-closing resources.
    void closeTunnel(sessionId).catch((error) => {
      console.error(`[Tunnel] Teardown failed after companion ${reason} for ${sessionId}:`, error);
    });
  };

  ws.on('close', () => onWsGone('disconnected'));
  ws.on('error', (err) => {
    console.error(`[Tunnel] WebSocket error for ${sessionId}:`, err);
    onWsGone('websocket error');
  });
}

/**
 * Resume a SOCKS socket paused for engine→phone backpressure once the WS send-buffer drains below
 * LOW_WATER. `ws` has no 'drain' event, so poll ws.bufferedAmount at WS_DRAIN_POLL_MS. Bails (leaving the
 * socket destroyed/closed elsewhere to clean up) if the WS closes or the socket is gone.
 */
function scheduleDrainResume(ws: WebSocket, entry: SocksConnectionEntry, socket: NetSocket): void {
  const poll = () => {
    if (!entry.paused) return; // already resumed (or torn down) elsewhere
    if (socket.destroyed || ws.readyState !== WebSocket.OPEN) {
      entry.paused = false;
      return;
    }
    if (ws.bufferedAmount <= WS_LOW_WATER_BYTES) {
      entry.paused = false;
      socket.resume();
      return;
    }
    const t = setTimeout(poll, WS_DRAIN_POLL_MS);
    if (typeof t.unref === 'function') t.unref();
  };
  const t = setTimeout(poll, WS_DRAIN_POLL_MS);
  if (typeof t.unref === 'function') t.unref();
}

/**
 * Register `connId` as phone→engine backpressured (its target SOCKS socket's write() returned false). The
 * WS receive path is a SINGLE shared stream for every connection, so we pause it on the empty→non-empty
 * transition (the first backpressured conn) and keep it paused while the set is non-empty. ws.pause() is
 * idempotent, so a second add is safe; the explicit transition check keeps intent clear and avoids redundant
 * pause() calls.
 */
function addWsBackpressure(tunnel: ActiveTunnel, connId: number): void {
  const wasEmpty = tunnel.wsBackpressuredConns.size === 0;
  tunnel.wsBackpressuredConns.add(connId);
  if (wasEmpty) {
    try {
      tunnel.ws.pause();
    } catch {
      // ws already closing/closed — nothing to pause
    }
  }
}

/**
 * Clear `connId`'s phone→engine backpressure (its socket drained, or it died and will never emit 'drain').
 * The shared WS receive path resumes ONLY on the non-empty→empty transition — i.e. once NO connection is
 * still backpressured. Resuming on the first drain (the old single-boolean bug) while another connection's
 * socket is still full would reopen the unbounded-buffering OOM vector. ws.resume() is a no-op on a CLOSED
 * ws, so this is safe anywhere, including teardown.
 */
function removeWsBackpressure(tunnel: ActiveTunnel, connId: number): void {
  if (!tunnel.wsBackpressuredConns.delete(connId)) return; // not backpressured (or already cleared)
  if (tunnel.wsBackpressuredConns.size === 0) {
    try {
      tunnel.ws.resume();
    } catch {
      // ws already closing/closed — nothing to resume
    }
  }
}

/** Detach the 'data' relay listener and fully destroy a SOCKS connection's socket. Used on {close} and
 *  teardown so a half-open FD can never keep relaying for a connId already removed from the map. */
function destroySocksConn(entry: SocksConnectionEntry): void {
  if (entry.onSocketData) {
    entry.socket.removeListener('data', entry.onSocketData);
    entry.onSocketData = undefined;
  }
  entry.socket.destroy();
}

/**
 * Parse + VALIDATE one companion frame. Returns a well-typed TunnelMessage, or null (logged) if the frame
 * is not valid JSON, not an object, has an unknown/missing type, a non-numeric connId, or — for 'data' —
 * a non-string payload. Validating the shape before use is what keeps a malformed frame from throwing
 * deeper in the handler (e.g. Buffer.from(undefined) / reading .connId off null).
 */
function parseTunnelFrame(raw: unknown): TunnelMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(raw));
  } catch {
    console.warn('[Tunnel] Ignoring non-JSON companion frame');
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    console.warn('[Tunnel] Ignoring companion frame that is not an object');
    return null;
  }
  const msg = parsed as Record<string, unknown>;
  if (typeof msg.type !== 'string' || typeof msg.connId !== 'number' || !Number.isFinite(msg.connId)) {
    console.warn('[Tunnel] Ignoring companion frame with missing/invalid type or connId');
    return null;
  }
  switch (msg.type) {
    case 'connected':
      return { type: 'connected', connId: msg.connId };
    case 'data':
      if (typeof msg.data !== 'string') {
        console.warn('[Tunnel] Ignoring companion data frame with non-string payload');
        return null;
      }
      return { type: 'data', connId: msg.connId, data: msg.data };
    case 'close':
      return { type: 'close', connId: msg.connId };
    case 'error':
      return {
        type: 'error',
        connId: msg.connId,
        message: typeof msg.message === 'string' ? msg.message : '',
      };
    default:
      console.warn(`[Tunnel] Ignoring companion frame with unknown type '${msg.type}'`);
      return null;
  }
}

function sendToApk(ws: WebSocket, msg: TunnelMessage): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}
