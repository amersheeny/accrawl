/**
 * Tests for the tunnel server — WebSocket handler, tunnel-token auth, the atomic single-use claim,
 * park-and-wait coordination, and the SOCKS5 ↔ WebSocket relay.
 *
 * Auth is the HMAC tunnel token, not an identity service: we mint real tokens via the shared @accrawl/contracts
 * sign/verify so the engine's verification path runs end-to-end. The platform's tunnel claim and the
 * crawl executor are mocked so the test focuses on auth + the bridge.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import http from 'http';
import net from 'net';
import { WebSocket } from 'ws';
import { deriveTunnelKey, signTunnelToken } from '@accrawl/contracts';

// ---------------------------------------------------------------------------
// Hoisted mocks (accessible inside vi.mock factories)
// ---------------------------------------------------------------------------

const SECRET = 'test-shared-secret-aaaaaaaaaaaaaaaaaaaaaaaa';

const mocks = vi.hoisted(() => ({
  // What platform.tunnel.loadTunnelContext resolves to (overridden per test).
  loadTunnelContext: vi.fn(),
  // CAS-before-park release: the handler calls this only when it wins the claim but finds NO parked
  // crawl, so the companion's next poll can reclaim once the park exists.
  releaseTunnelClaim: vi.fn().mockResolvedValue(undefined),
  completeSession: vi.fn().mockResolvedValue(undefined),
  capturedProxyUrl: undefined as string | undefined,
  capturedCrawlRequest: undefined as Record<string, unknown> | undefined,
  executeCrawlResolve: undefined as ((response: unknown) => void) | undefined,
  executeCrawlReject: undefined as ((error: unknown) => void) | undefined,
  transportFenceCompleted: false,
  createSocks5Server: vi.fn(),
}));

vi.mock('../platform', () => ({
  getPlatform: () => ({
    tunnel: { loadTunnelContext: mocks.loadTunnelContext, releaseTunnelClaim: mocks.releaseTunnelClaim },
  }),
}));

vi.mock('../crawl-executor', () => ({
  CrawlCleanupError: class CrawlCleanupError extends Error {
    constructor(sessionId: string, cause: unknown) {
      super(`Crawl cleanup fence failed for session ${sessionId}`, { cause });
      this.name = 'CrawlCleanupError';
    }
  },
  executeCrawl: vi.fn().mockImplementation(async (
    req: unknown,
    proxyUrl: string,
    options?: {
      beforeSessionCompletion?: () => Promise<void>;
      signal?: AbortSignal;
    },
  ) => {
    mocks.capturedCrawlRequest = req as Record<string, unknown>;
    mocks.capturedProxyUrl = proxyUrl;
    // Keep the tunnel alive until the test signals completion, then mirror the
    // real executor's transport-fence ordering before returning its response.
    return new Promise<unknown>((resolve, reject) => {
      const abort = () => reject(options?.signal?.reason ?? new Error('cancelled'));
      options?.signal?.addEventListener('abort', abort, { once: true });
      mocks.executeCrawlReject = (error) => {
        options?.signal?.removeEventListener('abort', abort);
        reject(error);
      };
      mocks.executeCrawlResolve = (response) => {
        options?.signal?.removeEventListener('abort', abort);
        void Promise.resolve(options?.beforeSessionCompletion?.()).then(
          () => {
            mocks.transportFenceCompleted = true;
            resolve(response);
          },
          reject,
        );
      };
    });
  }),
}));

vi.mock('../agent/session-updater', () => ({
  completeSession: mocks.completeSession,
}));

vi.mock('./socks5-server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./socks5-server')>();
  mocks.createSocks5Server.mockImplementation(actual.createSocks5Server);
  return {
    ...actual,
    createSocks5Server: mocks.createSocks5Server,
  };
});

// Import the module under test AFTER the mocks are registered.
import {
  closeTunnel,
  attachTunnelHandler,
  fenceCrawl,
  parkCrawlRequest,
  parkedCrawlConnectTimeoutMs,
  hasParkedCrawl,
} from './tunnel-server';
import { executeCrawl } from '../crawl-executor';
import { CrawlCleanupError } from '../crawl-executor';
import type { CrawlRequest } from '../types';

/** The mocked executeCrawl (call-count is the oracle for "did a second crawl run?"). */
const executeCrawlMock = vi.mocked(executeCrawl);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let httpServer: http.Server | null = null;
let serverPort: number;

/** A minimal valid CrawlRequest for a device-proxy crawl. */
function makeRequest(sessionId: string): CrawlRequest {
  return {
    sessionId,
    loginUrl: 'https://example.com/login',
    username: 'u',
    password: 'p',
    requires2fa: false,
    maxSteps: 10,
    timeoutSeconds: 60,
    useDeviceProxy: true,
    tunnelToken: 'unused-in-test',
  };
}

/** Mint a real tunnel token bound to (sessionId, deviceId). */
function mintToken(sessionId: string, deviceId = 'device-1'): string {
  return signTunnelToken(deriveTunnelKey(SECRET), { sid: sessionId, did: deviceId });
}

/** Park a request and resolve the claim to a winning single-use claim for this session. */
function parkAndArmClaim(sessionId: string, status = 'starting'): Promise<unknown> {
  mocks.loadTunnelContext.mockResolvedValueOnce({ sessionId, status, tunnelRequested: true, claimed: true });
  return parkCrawlRequest(makeRequest(sessionId));
}

/** Connect a WebSocket presenting the tunnel token via Authorization: Bearer. */
function connectCompanion(sessionId: string, token: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${serverPort}/tunnel?sessionId=${sessionId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    ws.on('open', () => resolve(ws));
    ws.on('error', (err) => reject(err));
  });
}

/** Read the next JSON message from a WebSocket. */
function readMessage(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    ws.once('message', (data) => resolve(JSON.parse(data.toString())));
  });
}

/** Connect to the SOCKS5 proxy (greeting + CONNECT request). */
async function socks5Connect(proxyPort: number, targetHost: string, targetPort: number): Promise<net.Socket> {
  const socket = await new Promise<net.Socket>((resolve) => {
    const s = net.connect(proxyPort, '127.0.0.1', () => resolve(s));
  });
  socket.write(Buffer.from([0x05, 0x01, 0x00])); // greeting (no-auth)
  await new Promise<void>((resolve) => socket.once('data', () => resolve()));
  const domain = Buffer.from(targetHost, 'ascii');
  socket.write(
    Buffer.from([0x05, 0x01, 0x00, 0x03, domain.length, ...domain, (targetPort >> 8) & 0xff, targetPort & 0xff]),
  );
  return socket;
}

/** Wait for the mock executeCrawl to be called (meaning SOCKS5 is ready) and return its port. */
async function waitForSocksReady(): Promise<number> {
  await vi.waitFor(() => expect(mocks.capturedProxyUrl).toBeTruthy(), { timeout: 5000 });
  return parseInt(mocks.capturedProxyUrl!.split(':').pop()!);
}

/** Flood a conn's SOCKS socket (companion→engine) with enough bytes that, against a PAUSED (slow) reader,
 *  the engine's entry.socket.write() returns false → that connId enters the WS backpressure set. The
 *  loopback send+recv buffer threshold is ~0.75 MB; ~3 MB clears it unambiguously regardless of timing
 *  jitter. Only ~1 MB is actually written to the socket before the WS pauses (the surplus stays queued in
 *  the paused WS receive buffer), so on resume the reader drains it promptly. Sent in one tick. */
function floodConn(ws: WebSocket, connId: number): void {
  const frame = Buffer.alloc(256 * 1024, 0x61).toString('base64');
  for (let i = 0; i < 12; i++) ws.send(JSON.stringify({ type: 'data', connId, data: frame })); // ~3 MB
}

/** Resolve once `cond()` is true, polling at 10 ms; reject after `timeoutMs`. */
function until(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const start = Date.now();
    const tick = (): void => {
      if (cond()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('until() timed out'));
      setTimeout(tick, 10);
    };
    tick();
  });
}

/** Wait for a WebSocket to close (or error). */
function waitClosed(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise<void>((resolve) => {
    ws.on('close', () => resolve());
    ws.on('error', () => resolve());
  });
}

/** Wait for a WebSocket to close, resolving with the close CODE the server sent (1013/1000/…). The
 *  handler calls ws.close(code) AFTER the upgrade, so the client receives the real application code. */
function waitCloseCode(ws: WebSocket): Promise<number> {
  return new Promise<number>((resolve) => {
    ws.on('close', (code) => resolve(code));
    ws.on('error', () => resolve(-1));
  });
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeEach(async () => {
  process.env.ENGINE_SHARED_SECRET = SECRET;
  mocks.loadTunnelContext.mockReset();
  mocks.releaseTunnelClaim.mockClear();
  mocks.releaseTunnelClaim.mockResolvedValue(undefined);
  mocks.completeSession.mockClear();
  mocks.capturedProxyUrl = undefined;
  mocks.capturedCrawlRequest = undefined;
  mocks.executeCrawlResolve = undefined;
  mocks.executeCrawlReject = undefined;
  mocks.transportFenceCompleted = false;
  mocks.createSocks5Server.mockClear();
  executeCrawlMock.mockClear();

  httpServer = http.createServer();
  attachTunnelHandler(httpServer);
  await new Promise<void>((resolve) => {
    httpServer!.listen(0, '127.0.0.1', () => {
      serverPort = (httpServer!.address() as net.AddressInfo).port;
      resolve();
    });
  });
});

afterEach(async () => {
  // Release any pending executeCrawl so handleCompanionConnection can finish.
  if (mocks.executeCrawlResolve) {
    mocks.executeCrawlResolve({ success: true, stepsExecuted: 1 });
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
  if (httpServer) {
    await new Promise<void>((resolve) => httpServer!.close(() => resolve()));
    httpServer = null;
  }
  delete process.env.ENGINE_SHARED_SECRET;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('tunnel-server', () => {
  describe('WebSocket auth (tunnel token)', () => {
    it('rejects a connection without sessionId or token', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${serverPort}/tunnel`);
      await waitClosed(ws);
    });

    it('rejects an upgrade to a non-/tunnel path', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${serverPort}/other`);
      await waitClosed(ws);
    });

    it('rejects a connection with a bad (untrusted) token', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${serverPort}/tunnel?sessionId=sess-bad`, {
        headers: { Authorization: 'Bearer actt1.tampered.signature' },
      });
      await waitClosed(ws);
      // Never reached the claim — auth failed at the upgrade gate.
      expect(mocks.loadTunnelContext).not.toHaveBeenCalled();
    });

    it('rejects a connection where the token sid does not match the WS sessionId', async () => {
      // Token is for sess-A but the WS asks for sess-B → bound-session mismatch → reject.
      const token = mintToken('sess-A');
      const ws = new WebSocket(`ws://127.0.0.1:${serverPort}/tunnel?sessionId=sess-B`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      await waitClosed(ws);
      expect(mocks.loadTunnelContext).not.toHaveBeenCalled();
    });

    it('does not crash the process on an upgrade with a malformed Host header', async () => {
      // A malformed Host (e.g. `[`) used to make `new URL(req.url, `http://${host}`)` throw OUTSIDE any
      // try/catch in the upgrade listener, crashing the process (DoS on the externally-reachable /tunnel).
      // The handler must just drop the socket and survive. The ws client always sends a valid Host, so we
      // hand-craft the raw upgrade request.
      const raw = net.connect(serverPort, '127.0.0.1');
      await new Promise<void>((resolve, reject) => {
        raw.once('connect', () => resolve());
        raw.once('error', reject);
      });
      raw.write(
        'GET /tunnel?sessionId=x HTTP/1.1\r\n' +
          'Host: [\r\n' +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
          'Sec-WebSocket-Version: 13\r\n\r\n',
      );
      // Server drops the malformed upgrade (no crash). Wait for the socket to close.
      await new Promise<void>((resolve) => {
        raw.once('close', () => resolve());
        setTimeout(resolve, 500);
      });
      raw.destroy();
      // Prove the server SURVIVED: a subsequent normal upgrade is still handled (would hang/fail if crashed).
      const ws = new WebSocket(`ws://127.0.0.1:${serverPort}/tunnel`);
      await waitClosed(ws);
    });

    it('proceeds with a valid token + matching sid + a winning claim, and runs the parked crawl', async () => {
      const sessionId = 'sess-ok';
      const parked = parkAndArmClaim(sessionId);
      const token = mintToken(sessionId);

      const ws = await connectCompanion(sessionId, token);
      expect(ws.readyState).toBe(WebSocket.OPEN);

      // The claim ran for this session, and the PARKED request reached executeCrawl with the proxy.
      await waitForSocksReady();
      expect(mocks.loadTunnelContext).toHaveBeenCalledWith(sessionId, 'device-1');
      expect(mocks.capturedCrawlRequest?.sessionId).toBe(sessionId);
      expect(mocks.capturedProxyUrl).toMatch(/^socks5:\/\/127\.0\.0\.1:\d+$/);

      // Finishing the crawl resolves the parked POST /crawl response.
      mocks.executeCrawlResolve!({ success: true, stepsExecuted: 3 });
      await expect(parked).resolves.toMatchObject({ success: true, stepsExecuted: 3 });
      expect(mocks.transportFenceCompleted).toBe(true);
      await waitClosed(ws);

      ws.close();
      await closeTunnel(sessionId);
    });

    it('rejects a late companion after ownership has been fenced', async () => {
      const sessionId = 'sess-fenced-before-companion';
      await fenceCrawl(sessionId, 'crawl-job ownership revoked');
      const ws = new WebSocket(`ws://127.0.0.1:${serverPort}/tunnel?sessionId=${sessionId}`, {
        headers: { Authorization: `Bearer ${mintToken(sessionId)}` },
      });

      // The ownership tombstone rejects before WebSocket upgrade, so the
      // client observes an HTTP rejection rather than a graceful WS code.
      await expect(waitCloseCode(ws)).resolves.toBe(-1);
      expect(mocks.loadTunnelContext).not.toHaveBeenCalled();
      expect(mocks.capturedProxyUrl).toBeUndefined();
    });

    it('rejects when the tunnel was already claimed (claimed=false) and does NOT run the crawl', async () => {
      const sessionId = 'sess-already-claimed';
      // A request is parked, but the CAS reports the tunnel was already claimed by an earlier dial.
      mocks.loadTunnelContext.mockResolvedValueOnce({ sessionId, status: 'starting', tunnelRequested: true, claimed: false });
      void parkCrawlRequest(makeRequest(sessionId));
      const token = mintToken(sessionId);

      const ws = await connectCompanion(sessionId, token);
      await waitClosed(ws);

      expect(mocks.loadTunnelContext).toHaveBeenCalledWith(sessionId, 'device-1');
      expect(mocks.capturedProxyUrl).toBeUndefined(); // crawl never started
      // Parked request is left intact (not consumed) by a losing claim.
      expect(hasParkedCrawl(sessionId)).toBe(true);
    });

    it('rejects when the session is unknown (null context)', async () => {
      const sessionId = 'sess-unknown';
      mocks.loadTunnelContext.mockResolvedValueOnce(null);
      const token = mintToken(sessionId);
      const ws = await connectCompanion(sessionId, token);
      await waitClosed(ws);
      expect(mocks.capturedProxyUrl).toBeUndefined();
    });

    it('rejects when the session is no longer active (terminal status)', async () => {
      const sessionId = 'sess-terminal';
      mocks.loadTunnelContext.mockResolvedValueOnce({ sessionId, status: 'failed', tunnelRequested: true, claimed: false });
      const token = mintToken(sessionId);
      const ws = await connectCompanion(sessionId, token);
      await waitClosed(ws);
      expect(mocks.capturedProxyUrl).toBeUndefined();
    });

    it('uses the parked request timeout when starting the crawl', async () => {
      const sessionId = 'sess-effective-timeout';
      mocks.loadTunnelContext.mockResolvedValueOnce({ sessionId, status: 'starting', tunnelRequested: true, claimed: true });
      const req = makeRequest(sessionId);
      req.timeoutSeconds = 840;
      void parkCrawlRequest(req);

      const ws = await connectCompanion(sessionId, mintToken(sessionId));
      await waitForSocksReady();
      expect(mocks.capturedCrawlRequest?.timeoutSeconds).toBe(840);

      ws.close();
      await closeTunnel(sessionId);
    });
  });

  describe('CAS-before-park race (claim won with no parked crawl)', () => {
    it('releases the claim and closes 1013 when the claim is won but NO crawl is parked yet', async () => {
      // The control-plane sets tunnel_requested BEFORE it dispatches/parks, so a fast companion can win
      // the one-time claim in that gap with no parked crawl to run. Burning the claim would time the
      // crawl out; instead the handler RELEASES it (so the next poll reclaims once the park exists) and
      // closes 1013 ("retry"). Arm a WINNING claim but never park a request for this session.
      const sessionId = 'sess-claim-no-park';
      mocks.loadTunnelContext.mockResolvedValueOnce({ sessionId, status: 'starting', tunnelRequested: true, claimed: true });
      expect(hasParkedCrawl(sessionId)).toBe(false); // nothing parked

      const ws = await connectCompanion(sessionId, mintToken(sessionId));
      const code = await waitCloseCode(ws);

      // Claim was won (loadTunnelContext ran), then released exactly once, and the WS closed 1013.
      expect(mocks.loadTunnelContext).toHaveBeenCalledWith(sessionId, 'device-1');
      expect(mocks.releaseTunnelClaim).toHaveBeenCalledTimes(1);
      expect(mocks.releaseTunnelClaim).toHaveBeenCalledWith(sessionId);
      expect(code).toBe(1013);
      // The crawl never started — no SOCKS5, no executeCrawl.
      expect(mocks.capturedProxyUrl).toBeUndefined();
    });

    it('does NOT release the claim during a successful crawl (only the no-park branch releases)', async () => {
      // The fix adds releaseTunnelClaim to exactly ONE path: claim-won-but-no-park. The normal,
      // successful claim→park→run→settle lifecycle must never release (releasing a live/handled crawl
      // would invite a re-run). Drive a real winning claim + park to completion and assert the success
      // path leaves releaseTunnelClaim untouched. (This is the invariant the diff's `parked.settled`
      // branch — "do NOT release a handled crawl" — encodes; it stays a no-release path.)
      const sessionId = 'sess-success-no-release';
      const parked = parkAndArmClaim(sessionId);

      const ws = await connectCompanion(sessionId, mintToken(sessionId));
      await waitForSocksReady(); // first companion won the claim and started the crawl
      expect(mocks.releaseTunnelClaim).not.toHaveBeenCalled(); // running crawl: no release

      // Finish the crawl → settleParked runs → the parked POST /crawl response resolves.
      mocks.executeCrawlResolve!({ success: true, stepsExecuted: 2 });
      await expect(parked).resolves.toMatchObject({ success: true, stepsExecuted: 2 });
      await closeTunnel(sessionId);
      expect(hasParkedCrawl(sessionId)).toBe(false); // park is settled + gone

      // The success/settled lifecycle NEVER releases the claim.
      expect(mocks.releaseTunnelClaim).not.toHaveBeenCalled();

      ws.close();
    });

    it('a DUPLICATE companion connecting AFTER the crawl already ran releases for retry + closes 1013 (was 1000)', async () => {
      // Real "second companion connection" race the fix targets: the first companion already ran + settled
      // the crawl (park removed). A late/duplicate companion that still wins a claim now finds NO park.
      // Pre-fix it closed 1000 and burned the claim (no release); post-fix it RELEASES + closes 1013 so a
      // genuine retry can reclaim once a fresh park exists. This is the observable behaviour change.
      const sessionId = 'sess-duplicate-after-settle';

      // 1. First companion: winning claim + parked crawl, run to completion so the park settles + is removed.
      const parked = parkAndArmClaim(sessionId);
      const ws1 = await connectCompanion(sessionId, mintToken(sessionId));
      await waitForSocksReady();
      mocks.executeCrawlResolve!({ success: true, stepsExecuted: 1 });
      await expect(parked).resolves.toMatchObject({ success: true });
      await closeTunnel(sessionId);
      ws1.close();
      expect(hasParkedCrawl(sessionId)).toBe(false); // settled + gone
      mocks.releaseTunnelClaim.mockClear(); // isolate the duplicate connection's behaviour

      // 2. Duplicate companion: arm another winning claim, but there's no park to run anymore.
      mocks.loadTunnelContext.mockResolvedValueOnce({ sessionId, status: 'starting', tunnelRequested: true, claimed: true });
      const ws2 = await connectCompanion(sessionId, mintToken(sessionId));
      const code = await waitCloseCode(ws2);

      expect(mocks.releaseTunnelClaim).toHaveBeenCalledTimes(1);
      expect(mocks.releaseTunnelClaim).toHaveBeenCalledWith(sessionId);
      expect(code).toBe(1013);
    });

    it('a SECOND companion mid-crawl does NOT start a second crawl, even if the store grants the claim (non-CAS defense)', async () => {
      // Defense-in-depth: the postgres CAS rejects a 2nd WS before claimParked, but the dev-only local
      // adapter (and any test double) returns claimed:true unconditionally. With the in-memory double-claim
      // guard in claimParked, a 2nd companion arriving WHILE the first crawl is still running must NOT start
      // a second executeCrawl for the same parked request (no duplicate crawl, no tunnel overwrite).
      const sessionId = 'sess-concurrent-claim';
      executeCrawlMock.mockClear(); // count only THIS test's crawl runs (mock isn't reset in beforeEach)

      // First companion: winning claim + parked crawl; executeCrawl stays pending (still running).
      const parked = parkAndArmClaim(sessionId);
      const ws1 = await connectCompanion(sessionId, mintToken(sessionId));
      await waitForSocksReady();
      expect(executeCrawlMock).toHaveBeenCalledTimes(1);
      const firstResolve = mocks.executeCrawlResolve;

      // Second companion arrives mid-crawl; arm a store that ALSO grants the claim (the local/non-CAS case).
      mocks.loadTunnelContext.mockResolvedValueOnce({ sessionId, status: 'starting', tunnelRequested: true, claimed: true });
      const ws2 = await connectCompanion(sessionId, mintToken(sessionId));
      await waitClosed(ws2); // the 2nd connection is closed without running a crawl

      // The parked entry was already claimed → no second executeCrawl, and the running crawl is untouched.
      expect(executeCrawlMock).toHaveBeenCalledTimes(1);
      expect(mocks.executeCrawlResolve).toBe(firstResolve); // not overwritten by a second run
      expect(hasParkedCrawl(sessionId)).toBe(true); // first crawl still in flight (claimed, un-settled)

      // Finish the first (only) crawl → settles exactly once.
      mocks.executeCrawlResolve!({ success: true, stepsExecuted: 2 });
      await expect(parked).resolves.toMatchObject({ success: true, stepsExecuted: 2 });
      ws1.close();
      await closeTunnel(sessionId);
    });
  });

  describe('park-and-wait', () => {
    it('uses the configured crawl timeout as the companion connection window', () => {
      expect(parkedCrawlConnectTimeoutMs(makeRequest('sess-budget'))).toBe(60 * 1000);
    });

    it('fails the parked crawl (and marks the session failed) when no companion connects within the TTL', async () => {
      const sessionId = 'sess-ttl';
      const response = await parkCrawlRequest(makeRequest(sessionId), 60); // tiny TTL
      expect(response.success).toBe(false);
      expect(response.error).toMatch(/no companion connected|tunnel was not established/i);
      expect(mocks.completeSession).toHaveBeenCalledWith(sessionId, false, expect.any(String));
      expect(hasParkedCrawl(sessionId)).toBe(false); // cleaned up
    });

    it('fences a parked crawl immediately when durable worker ownership is lost', async () => {
      const sessionId = 'sess-ownership-fenced';
      const parked = parkCrawlRequest(makeRequest(sessionId), 10_000);
      expect(hasParkedCrawl(sessionId)).toBe(true);

      await fenceCrawl(sessionId, 'crawl-job ownership revoked');

      await expect(parked).resolves.toMatchObject({
        success: false,
        error: 'crawl-job ownership revoked',
        failureReason: 'instance_died',
      });
      expect(hasParkedCrawl(sessionId)).toBe(false);
    });

    it('tracks and terminates the authenticated WebSocket while its durable claim is pending', async () => {
      const sessionId = 'sess-fence-during-claim';
      let resolveClaim!: (value: unknown) => void;
      mocks.loadTunnelContext.mockReturnValueOnce(new Promise((resolve) => {
        resolveClaim = resolve;
      }));
      const parked = parkCrawlRequest(makeRequest(sessionId), 10_000);
      const ws = await connectCompanion(sessionId, mintToken(sessionId));
      const closed = waitClosed(ws);

      await fenceCrawl(sessionId, 'crawl-job ownership revoked');
      await closed;
      await expect(parked).resolves.toMatchObject({
        failureReason: 'instance_died',
      });

      resolveClaim({ sessionId, status: 'starting', tunnelRequested: true, claimed: true });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(mocks.createSocks5Server).not.toHaveBeenCalled();
      expect(executeCrawlMock).not.toHaveBeenCalled();
    });

    it('waits for an in-flight SOCKS bind, then closes the published listener before waking work', async () => {
      const sessionId = 'sess-fence-during-bind';
      let resolveBind!: (value: unknown) => void;
      const close = vi.fn().mockResolvedValue(undefined);
      mocks.createSocks5Server.mockImplementationOnce(() => new Promise((resolve) => {
        resolveBind = resolve;
      }));
      const parked = parkAndArmClaim(sessionId);
      const ws = await connectCompanion(sessionId, mintToken(sessionId));
      await vi.waitFor(() => expect(mocks.createSocks5Server).toHaveBeenCalledOnce());

      let fenceSettled = false;
      const fence = fenceCrawl(sessionId, 'crawl-job ownership revoked')
        .then(() => { fenceSettled = true; });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(fenceSettled).toBe(false);

      resolveBind({
        port: 41_234,
        close,
        onConnect: vi.fn(),
      });
      await fence;
      await expect(parked).resolves.toMatchObject({
        failureReason: 'instance_died',
      });
      expect(close).toHaveBeenCalledOnce();
      expect(executeCrawlMock).not.toHaveBeenCalled();
      await waitClosed(ws);
    });

    it('aborts a claimed execution and waits for its cleanup before acknowledging the fence', async () => {
      const sessionId = 'sess-fence-during-execution';
      const parked = parkAndArmClaim(sessionId);
      const ws = await connectCompanion(sessionId, mintToken(sessionId));
      await waitForSocksReady();

      await fenceCrawl(sessionId, 'crawl-job ownership revoked');

      await expect(parked).resolves.toMatchObject({
        success: false,
        error: 'crawl-job ownership revoked',
      });
      expect(executeCrawlMock).toHaveBeenCalledOnce();
      expect(hasParkedCrawl(sessionId)).toBe(false);
      await waitClosed(ws);
    });

    it('rejects the parked worker promise when executor cleanup cannot establish a positive fence', async () => {
      const sessionId = 'sess-cleanup-fence-failed';
      const parked = parkAndArmClaim(sessionId);
      const ws = await connectCompanion(sessionId, mintToken(sessionId));
      await waitForSocksReady();

      const cleanupError = new CrawlCleanupError(
        sessionId,
        new Error('browser or tunnel remained active'),
      );
      mocks.executeCrawlReject!(cleanupError);

      await expect(parked).rejects.toBe(cleanupError);
      expect(hasParkedCrawl(sessionId)).toBe(false);
      await waitClosed(ws);
    });

    it('never recreates a parked crawl after an ownership fence', async () => {
      const sessionId = 'sess-ownership-fence-tombstone';
      await fenceCrawl(sessionId, 'crawl-job ownership revoked');

      await expect(parkCrawlRequest(makeRequest(sessionId), 10_000)).resolves.toMatchObject({
        success: false,
        error: 'crawl-job ownership revoked',
        failureReason: 'instance_died',
      });
      expect(hasParkedCrawl(sessionId)).toBe(false);
    });

    it('does NOT fire the connect-wait TTL once a companion has CLAIMED the tunnel (long crawls survive)', async () => {
      // Regression: the park TTL bounds only how long we wait for a companion to CONNECT. Pre-fix, the timer
      // was cleared only at settle (after executeCrawl resolves), so a crawl that ran longer than the TTL —
      // i.e. every real crawl, where a single LLM step is ~25s vs. the 30s default TTL — was torn down
      // mid-flight: the stale timer marked the live session failed and resolved the parked response with a
      // failure while Chrome was still driving. Surfaced by the device-proxy e2e (the crawl died at step 2
      // with "No companion connected within 30s" AFTER the companion had connected and relayed 20KB).
      const sessionId = 'sess-long-crawl-survives-ttl';
      const ttlMs = 40; // tiny connect-wait TTL
      // Arm a winning claim + park with the tiny TTL; executeCrawl stays pending (a "long" crawl).
      mocks.loadTunnelContext.mockResolvedValueOnce({ sessionId, status: 'starting', tunnelRequested: true, claimed: true });
      const parked = parkCrawlRequest(makeRequest(sessionId), ttlMs);
      let settled = false;
      void parked.then(() => { settled = true; });

      const ws = await connectCompanion(sessionId, mintToken(sessionId));
      await waitForSocksReady(); // companion claimed → crawl started; the claim must have cleared the TTL

      // Wait well past the TTL while the crawl is still running.
      await new Promise((resolve) => setTimeout(resolve, ttlMs * 6));

      // The stale connect-wait timer must NOT have fired: the live session was never marked failed, and the
      // parked response is still pending (the crawl owns its lifetime now via the executor watchdog).
      expect(mocks.completeSession).not.toHaveBeenCalled();
      expect(settled).toBe(false);
      expect(hasParkedCrawl(sessionId)).toBe(true); // claimed, still un-settled

      // The crawl finishing is what finally resolves the parked response (not the TTL).
      mocks.executeCrawlResolve!({ success: true, stepsExecuted: 5 });
      await expect(parked).resolves.toMatchObject({ success: true, stepsExecuted: 5 });
      ws.close();
      await closeTunnel(sessionId);
    });

    it('supersedes an existing park for the same session (the old waiter resolves, not hangs)', async () => {
      const sessionId = 'sess-superseded';
      const first = parkCrawlRequest(makeRequest(sessionId), 10_000);
      // A second park for the same session arrives (e.g. a retried dispatch).
      const second = parkCrawlRequest(makeRequest(sessionId), 10_000);
      await expect(first).resolves.toMatchObject({ success: false });
      expect(hasParkedCrawl(sessionId)).toBe(true); // the second park is now the live one
      // Drain the second so it doesn't outlive the test.
      mocks.completeSession.mockResolvedValue(undefined);
      await expect(parkCrawlRequest(makeRequest(sessionId), 30)).resolves.toBeTruthy(); // supersede again → drains `second`
      await expect(second).resolves.toBeTruthy();
    });
  });

  describe('SOCKS5 ↔ WebSocket bridging', () => {
    it('sends a connect message to the companion when a SOCKS5 client connects', async () => {
      const sessionId = 'sess-bridge-1';
      parkAndArmClaim(sessionId);
      const ws = await connectCompanion(sessionId, mintToken(sessionId));
      const proxyPort = await waitForSocksReady();

      const connectMsg = readMessage(ws);
      const socksSocket = await socks5Connect(proxyPort, 'example.com', 443);

      const msg = await connectMsg;
      expect(msg.type).toBe('connect');
      expect(msg.host).toBe('example.com');
      expect(msg.port).toBe(443);
      expect(typeof msg.connId).toBe('number');

      socksSocket.destroy();
      ws.close();
      await closeTunnel(sessionId);
    });

    it('forwards data from the companion to the SOCKS5 client', async () => {
      const sessionId = 'sess-data-1';
      parkAndArmClaim(sessionId);
      const ws = await connectCompanion(sessionId, mintToken(sessionId));
      const proxyPort = await waitForSocksReady();

      const connectMsg = readMessage(ws);
      const socksSocket = await socks5Connect(proxyPort, 'example.com', 80);
      const connId = (await connectMsg).connId as number;

      ws.send(JSON.stringify({ type: 'connected', connId }));
      await new Promise<void>((resolve) => {
        socksSocket.once('data', (data) => {
          expect(data[1]).toBe(0x00); // SOCKS5 success reply
          resolve();
        });
      });

      const testData = Buffer.from('Hello from companion');
      ws.send(JSON.stringify({ type: 'data', connId, data: testData.toString('base64') }));
      const received = await new Promise<Buffer>((resolve) => {
        socksSocket.once('data', (data) => resolve(Buffer.from(data)));
      });
      expect(received.toString()).toBe('Hello from companion');

      socksSocket.destroy();
      ws.close();
      await closeTunnel(sessionId);
    });

    it('forwards data from the SOCKS5 client to the companion', async () => {
      const sessionId = 'sess-data-2';
      parkAndArmClaim(sessionId);
      const ws = await connectCompanion(sessionId, mintToken(sessionId));
      const proxyPort = await waitForSocksReady();

      const connectMsg = readMessage(ws);
      const socksSocket = await socks5Connect(proxyPort, 'example.com', 80);
      const connId = (await connectMsg).connId as number;

      ws.send(JSON.stringify({ type: 'connected', connId }));
      await new Promise<void>((resolve) => socksSocket.once('data', () => resolve()));

      const dataMsg = readMessage(ws);
      socksSocket.write(Buffer.from('GET / HTTP/1.1\r\n\r\n'));

      const apkReceived = await dataMsg;
      expect(apkReceived.type).toBe('data');
      expect(apkReceived.connId).toBe(connId);
      expect(Buffer.from(apkReceived.data as string, 'base64').toString()).toBe('GET / HTTP/1.1\r\n\r\n');

      socksSocket.destroy();
      ws.close();
      await closeTunnel(sessionId);
    });

    it('ignores malformed companion frames without crashing, and keeps relaying afterwards', async () => {
      // A malformed frame (bad JSON, null, missing/wrong-typed fields) must be IGNORED, never thrown out
      // of the ws 'message' handler — an uncaught throw there crashes the engine process. Proof: after a
      // barrage of malformed frames the tunnel still relays a valid frame end to end.
      const sessionId = 'sess-malformed';
      parkAndArmClaim(sessionId);
      const ws = await connectCompanion(sessionId, mintToken(sessionId));
      const proxyPort = await waitForSocksReady();

      const connectMsg = readMessage(ws);
      const socksSocket = await socks5Connect(proxyPort, 'example.com', 80);
      const connId = (await connectMsg).connId as number;

      ws.send(JSON.stringify({ type: 'connected', connId }));
      await new Promise<void>((resolve) => socksSocket.once('data', () => resolve()));

      // Barrage of malformed frames — none may throw / crash the handler.
      ws.send('not json at all');
      ws.send('null');
      ws.send('123');
      ws.send('"a string"');
      ws.send(JSON.stringify({}));                                   // no type/connId
      ws.send(JSON.stringify({ type: 'data' }));                     // missing connId + data
      ws.send(JSON.stringify({ type: 'data', connId }));             // missing data
      ws.send(JSON.stringify({ type: 'data', connId, data: 42 }));   // data not a string
      ws.send(JSON.stringify({ type: 'data', connId: 'x', data: 'AA==' })); // connId not a number
      ws.send(JSON.stringify({ type: 'bogus', connId }));            // unknown type
      ws.send(JSON.stringify({ connId, data: 'AA==' }));             // missing type

      // The tunnel survived: a valid data frame still reaches the SOCKS client byte-for-byte.
      const payload = Buffer.from('still alive');
      ws.send(JSON.stringify({ type: 'data', connId, data: payload.toString('base64') }));
      const received = await new Promise<Buffer>((resolve) => {
        socksSocket.once('data', (data) => resolve(Buffer.from(data)));
      });
      expect(received.toString()).toBe('still alive');
      expect(ws.readyState).toBe(WebSocket.OPEN); // handler never crashed the connection

      socksSocket.destroy();
      ws.close();
      await closeTunnel(sessionId);
    });

    it('fully destroys the SOCKS socket on a companion {close} (no half-open relay)', async () => {
      // On {close} the SOCKS socket must be DESTROYED (not end()ed): an end() leaves the FD half-open and
      // its 'data' listener attached, so it could keep relaying for a connId already removed. After {close}
      // the SOCKS client must see its socket closed.
      const sessionId = 'sess-close-destroy';
      parkAndArmClaim(sessionId);
      const ws = await connectCompanion(sessionId, mintToken(sessionId));
      const proxyPort = await waitForSocksReady();

      const connectMsg = readMessage(ws);
      const socksSocket = await socks5Connect(proxyPort, 'example.com', 80);
      const connId = (await connectMsg).connId as number;

      ws.send(JSON.stringify({ type: 'connected', connId }));
      await new Promise<void>((resolve) => socksSocket.once('data', () => resolve()));

      const clientClosed = new Promise<void>((resolve) => socksSocket.once('close', () => resolve()));
      ws.send(JSON.stringify({ type: 'close', connId }));
      await clientClosed; // the SOCKS client's socket was torn down by the {close}
      expect(socksSocket.destroyed).toBe(true);

      ws.close();
      await closeTunnel(sessionId);
    });

    it('stays byte-faithful phone→engine even when the SOCKS reader is slow (backpressure)', async () => {
      // Phone→engine backpressure: when the SOCKS socket's write() returns false the WS receive path is
      // paused until it drains. The guarantee that matters is that NO bytes are lost or reordered — flood a
      // large, ordered payload from the companion while the SOCKS client reads slowly, then verify the exact
      // bytes arrive in order. (Exercises the write()=false → ws.pause()/resume() flow under real load.)
      const sessionId = 'sess-backpressure-in';
      parkAndArmClaim(sessionId);
      const ws = await connectCompanion(sessionId, mintToken(sessionId));
      const proxyPort = await waitForSocksReady();

      const connectMsg = readMessage(ws);
      const socksSocket = await socks5Connect(proxyPort, 'example.com', 80);
      const connId = (await connectMsg).connId as number;
      socksSocket.pause(); // slow reader: don't drain the socket's receive buffer yet

      ws.send(JSON.stringify({ type: 'connected', connId }));
      // The success reply is buffered (socket paused) — that's fine; we only assert the data bytes below.

      // Send many ordered chunks; each byte encodes its global index mod 251 so we can verify order + content.
      const CHUNKS = 200;
      const CHUNK_SIZE = 4096;
      const expected = Buffer.alloc(CHUNKS * CHUNK_SIZE);
      for (let i = 0; i < CHUNKS; i++) {
        const buf = Buffer.alloc(CHUNK_SIZE);
        for (let j = 0; j < CHUNK_SIZE; j++) {
          const idx = i * CHUNK_SIZE + j;
          const byte = idx % 251;
          buf[j] = byte;
          expected[idx] = byte;
        }
        ws.send(JSON.stringify({ type: 'data', connId, data: buf.toString('base64') }));
      }

      // Now drain slowly and collect everything (skipping the leading 10-byte SOCKS success reply).
      const collected: Buffer[] = [];
      let total = 0;
      const wantTotal = 10 /* SOCKS reply */ + CHUNKS * CHUNK_SIZE;
      const done = new Promise<void>((resolve) => {
        socksSocket.on('data', (d) => {
          collected.push(Buffer.from(d));
          total += d.length;
          if (total >= wantTotal) resolve();
        });
      });
      socksSocket.resume();
      await done;

      const all = Buffer.concat(collected);
      const payload = all.subarray(10); // drop the SOCKS5 success reply
      expect(payload.length).toBe(CHUNKS * CHUNK_SIZE);
      expect(payload.equals(expected)).toBe(true); // exact bytes, exact order — nothing lost under backpressure

      socksSocket.destroy();
      ws.close();
      await closeTunnel(sessionId);
    });

    it('keeps the shared WS paused until ALL backpressured conns drain (refcount, not a single flag)', async () => {
      // DEFECT-1 regression. The WS receive path is a SINGLE shared stream for every SOCKS connection. With a
      // single tunnel-wide boolean, conn A's write()=false paused the WS but conn B's drain (or any conn's
      // close) cleared the one flag and resumed the WS while A's socket was STILL full — losing backpressure
      // (the OOM vector). The fix refcounts backpressured connIds and resumes ONLY when the set empties.
      //
      // Oracle: while the WS is paused the server stops reading it, so a 'data' frame sent to a FAST-reading
      // probe conn (in a separate batch) is NOT delivered until the WS resumes. We drive two slow-reader conns
      // both into backpressure, then assert the probe stays undelivered after the FIRST drains and only arrives
      // after the SECOND drains too.
      const sessionId = 'sess-bp-refcount';
      parkAndArmClaim(sessionId);
      const ws = await connectCompanion(sessionId, mintToken(sessionId));
      const proxyPort = await waitForSocksReady();

      // Open three SOCKS conns; each emits a 'connect' frame carrying its connId (in connection order).
      const connectA = readMessage(ws);
      const sockA = await socks5Connect(proxyPort, 'a.example.com', 80);
      const connIdA = (await connectA).connId as number;
      const connectB = readMessage(ws);
      const sockB = await socks5Connect(proxyPort, 'b.example.com', 80);
      const connIdB = (await connectB).connId as number;
      const connectC = readMessage(ws);
      const sockC = await socks5Connect(proxyPort, 'c.example.com', 80);
      const connIdC = (await connectC).connId as number;

      // Mark all three connected (companion → success). A and B are SLOW readers (paused) so their write()
      // backs up; C reads fast and is our probe.
      sockA.pause();
      sockB.pause();
      ws.send(JSON.stringify({ type: 'connected', connId: connIdA }));
      ws.send(JSON.stringify({ type: 'connected', connId: connIdB }));
      ws.send(JSON.stringify({ type: 'connected', connId: connIdC }));

      // Drain C's 10-byte SOCKS success reply so the probe assertion below sees only the probe payload.
      await new Promise<void>((resolve) => {
        let got = 0;
        sockC.on('data', function onReply(d) {
          got += d.length;
          if (got >= 10) { sockC.removeListener('data', onReply); resolve(); }
        });
      });

      // A probe collector for C: records whether the probe payload has arrived yet.
      let probeArrived = false;
      const PROBE = Buffer.from('PROBE-AFTER-RESUME');
      sockC.on('data', (d) => { if (Buffer.from(d).includes(PROBE)) probeArrived = true; });

      // Flood A and B in the SAME tick so both write()s return false BEFORE the WS pauses — putting BOTH
      // connIds in the backpressure set. (ws.pause() does not drop already-parsed messages in the batch, so
      // B is still processed and added even though A's frame triggered the pause.)
      floodConn(ws, connIdA);
      floodConn(ws, connIdB);

      // Let the WS pause take effect, then send the probe to C in a SEPARATE batch — it must be blocked.
      await new Promise((r) => setTimeout(r, 80));
      ws.send(JSON.stringify({ type: 'data', connId: connIdC, data: PROBE.toString('base64') }));
      await new Promise((r) => setTimeout(r, 120));
      expect(probeArrived).toBe(false); // WS paused (both A and B backpressured) → probe not yet delivered

      // Drain ONLY A. Set goes {A,B} → {B}; the WS must STAY paused (B still backpressured) — the old single
      // boolean would have wrongly resumed here.
      sockA.resume();
      await new Promise((r) => setTimeout(r, 150));
      expect(probeArrived).toBe(false); // still paused — one conn (B) is still backpressured

      // Drain B too. Set goes {B} → {} → the WS resumes → the buffered probe frame is finally processed.
      sockB.resume();
      await until(() => probeArrived);

      sockA.destroy();
      sockB.destroy();
      sockC.destroy();
      ws.close();
      await closeTunnel(sessionId);
    });

    it('resumes the shared WS as soon as the ONE backpressured conn drains (single-conn refcount)', async () => {
      // The flip side of the refcount: with exactly one backpressured conn, draining it empties the set and
      // resumes the WS immediately — no other conn is keeping it paused. Proves the fix didn't over-correct
      // into "never resume".
      const sessionId = 'sess-bp-single';
      parkAndArmClaim(sessionId);
      const ws = await connectCompanion(sessionId, mintToken(sessionId));
      const proxyPort = await waitForSocksReady();

      const connectA = readMessage(ws);
      const sockA = await socks5Connect(proxyPort, 'a.example.com', 80);
      const connIdA = (await connectA).connId as number;
      const connectC = readMessage(ws);
      const sockC = await socks5Connect(proxyPort, 'c.example.com', 80);
      const connIdC = (await connectC).connId as number;

      sockA.pause(); // slow reader
      ws.send(JSON.stringify({ type: 'connected', connId: connIdA }));
      ws.send(JSON.stringify({ type: 'connected', connId: connIdC }));

      // Drain C's success reply.
      await new Promise<void>((resolve) => {
        let got = 0;
        sockC.on('data', function onReply(d) {
          got += d.length;
          if (got >= 10) { sockC.removeListener('data', onReply); resolve(); }
        });
      });

      let probeArrived = false;
      const PROBE = Buffer.from('PROBE-SINGLE');
      sockC.on('data', (d) => { if (Buffer.from(d).includes(PROBE)) probeArrived = true; });

      floodConn(ws, connIdA); // A backpressured → WS paused

      await new Promise((r) => setTimeout(r, 80));
      ws.send(JSON.stringify({ type: 'data', connId: connIdC, data: PROBE.toString('base64') }));
      await new Promise((r) => setTimeout(r, 120));
      expect(probeArrived).toBe(false); // WS paused while A is backpressured

      sockA.resume(); // set {A} → {} → WS resumes
      await until(() => probeArrived);

      sockA.destroy();
      sockC.destroy();
      ws.close();
      await closeTunnel(sessionId);
    });

    it('a non-backpressured conn closing does NOT resume the WS while another conn is still backpressured', async () => {
      // The precise single-boolean bug: conn A is backpressured (WS paused); conn B — which was never
      // backpressured — closes. The old code's close handler called resumeWsIfPaused unconditionally,
      // clearing the one flag and resuming the WS though A was still full. The refcount makes B's close a
      // no-op on the set (B isn't in it), so the WS stays paused until A actually drains.
      const sessionId = 'sess-bp-other-close';
      parkAndArmClaim(sessionId);
      const ws = await connectCompanion(sessionId, mintToken(sessionId));
      const proxyPort = await waitForSocksReady();

      const connectA = readMessage(ws);
      const sockA = await socks5Connect(proxyPort, 'a.example.com', 80);
      const connIdA = (await connectA).connId as number;
      const connectB = readMessage(ws);
      const sockB = await socks5Connect(proxyPort, 'b.example.com', 80);
      const connIdB = (await connectB).connId as number;
      const connectC = readMessage(ws);
      const sockC = await socks5Connect(proxyPort, 'c.example.com', 80);
      const connIdC = (await connectC).connId as number;

      sockA.pause(); // A: slow reader (will be backpressured). B and C read normally.
      ws.send(JSON.stringify({ type: 'connected', connId: connIdA }));
      ws.send(JSON.stringify({ type: 'connected', connId: connIdB }));
      ws.send(JSON.stringify({ type: 'connected', connId: connIdC }));

      await new Promise<void>((resolve) => {
        let got = 0;
        sockC.on('data', function onReply(d) {
          got += d.length;
          if (got >= 10) { sockC.removeListener('data', onReply); resolve(); }
        });
      });

      let probeArrived = false;
      const PROBE = Buffer.from('PROBE-OTHER-CLOSE');
      sockC.on('data', (d) => { if (Buffer.from(d).includes(PROBE)) probeArrived = true; });

      floodConn(ws, connIdA); // only A backpressures → WS paused

      await new Promise((r) => setTimeout(r, 80));
      ws.send(JSON.stringify({ type: 'data', connId: connIdC, data: PROBE.toString('base64') }));
      await new Promise((r) => setTimeout(r, 120));
      expect(probeArrived).toBe(false); // WS paused (A backpressured)

      // Close the NON-backpressured conn B. Pre-fix this resumed the WS; post-fix it must not (B wasn't in
      // the set), so the probe stays blocked while A is still full.
      ws.send(JSON.stringify({ type: 'close', connId: connIdB }));
      await new Promise((r) => setTimeout(r, 120));
      expect(probeArrived).toBe(false); // B's close did NOT wrongly resume the WS

      // A draining empties the set → WS resumes → probe delivered.
      sockA.resume();
      await until(() => probeArrived);

      sockA.destroy();
      sockB.destroy();
      sockC.destroy();
      ws.close();
      await closeTunnel(sessionId);
    });
  });

  describe('closeTunnel', () => {
    it('cleans up the SOCKS5 server and the WebSocket', async () => {
      const sessionId = 'sess-close-1';
      parkAndArmClaim(sessionId);
      const ws = await connectCompanion(sessionId, mintToken(sessionId));
      const proxyPort = await waitForSocksReady();

      const wsClosed = new Promise<void>((resolve) => ws.on('close', () => resolve()));
      await closeTunnel(sessionId);
      await wsClosed;

      const connectionFailed = await new Promise<boolean>((resolve) => {
        const s = net.connect(proxyPort, '127.0.0.1');
        s.on('error', () => resolve(true));
        s.on('connect', () => {
          s.destroy();
          resolve(false);
        });
      });
      expect(connectionFailed).toBe(true);
    });

    it('is a no-op for unknown sessions', async () => {
      await closeTunnel('nonexistent-session');
    });
  });
});
