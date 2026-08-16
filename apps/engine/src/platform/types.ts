/**
 * Platform abstraction
 *
 * The crawl engine (browser automation + LLM agent + extraction) is fully
 * self-contained and has no cloud dependencies. Everything *around* the crawl —
 * persisting session telemetry, hosting screenshots, sourcing 2FA codes, and
 * decrypting stored credentials — is infrastructure that differs between
 * deployments. Those concerns are captured by the interfaces below.
 *
 * Two implementations are provided:
 *   - `local`    — zero external dependencies. Run artifacts are written to the
 *                  filesystem, OTP codes are read from a watched file, and
 *                  credentials are assumed already-plaintext. This is the
 *                  default and is all a self-hoster needs (just GEMINI_API_KEY).
 *
 * The active implementation is selected by the PLATFORM env var (default 'local') via getPlatform()
 * in ./index, which resolves each one lazily — so the local crawl path loads nothing but itself, and
 * a deployment that registers its own platform costs the others nothing.
 */

import type { SessionLogger, LogLine } from '../utils/logger';
import type { CrawlCost, CrawlFailureReason, CrawlRequest } from '../types';

export type WorkerSessionClaim = NonNullable<
  CrawlRequest['workerContext']
> & {
  /** Unique to one live process claim, unlike attemptId which survives retries. */
  claimOwnerId: string;
};

/** Heavy + summary data handed to SessionStore.complete() at the end of a crawl. */
export interface CompletionResults {
  accounts?: unknown[];
  transactions?: unknown[];
  positions?: unknown[];
  stepsExecuted?: number;
  stepLogs?: unknown[];
  crawlMemory?: string;
  failureReason?: CrawlFailureReason;
  cost?: CrawlCost;
}

export interface ScreenshotUploadResult {
  path: string;
  url?: string;
}

/**
 * Sink for per-session crawl telemetry: status transitions, step logs, the final
 * extracted payload, console logs, and a liveness heartbeat. All methods are
 * best-effort — an implementation must never let a telemetry failure abort a crawl
 * (a hosted adapter wraps every write in try/catch, the local adapter writes
 * to disk). The one exception is cancellation: updateStatus may throw
 * CrawlCancelledError when an external controller has marked the session cancelled.
 */
export interface SessionStore {
  /**
   * Atomically claim this session before the HTTP handler acknowledges it.
   * `duplicate` means the same durable dispatch was already claimed, so the
   * handler must ACK without starting a second browser execution.
   */
  claimWorker(
    sessionId: string,
    worker: WorkerSessionClaim | undefined,
  ): Promise<'claimed' | 'duplicate'>;
  /**
   * Fail closed unless this session still owns an active crawl. Called before
   * browser allocation so a cancelled delayed dispatch cannot recreate work
   * after an engine restart or on another replica.
   */
  assertActive(sessionId: string): Promise<void>;
  updateStatus(
    sessionId: string,
    status: string,
    currentStep: string,
    stepCount?: number,
    logger?: SessionLogger,
  ): Promise<void>;
  appendStep(sessionId: string, stepLog: unknown, logger?: SessionLogger): Promise<void>;
  complete(
    sessionId: string,
    success: boolean,
    error: string | undefined,
    results: CompletionResults | undefined,
    logger?: SessionLogger,
  ): Promise<void>;
  /** Start a background liveness heartbeat. Returns a stop() to clear it. */
  startHeartbeat(sessionId: string, intervalMs: number): () => void;
  flushLogs(sessionId: string, lines: LogLine[]): Promise<void>;
}

export interface ScreenshotSink {
  upload(
    sessionId: string,
    stepNumber: number,
    base64Screenshot: string,
    logger?: SessionLogger,
  ): Promise<ScreenshotUploadResult | null>;
}

/**
 * Source of out-of-band 2FA codes. prepare() is called before navigation so the
 * code source can arm itself; waitForOtp() blocks until a code is available.
 */
export interface OtpProvider {
  prepare(
    sessionId: string,
    offlineTimeoutMs: number,
    busyTimeoutMs: number,
    pollIntervalMs: number,
    logger?: SessionLogger,
  ): Promise<void>;
  waitForOtp(
    sessionId: string,
    timeoutMs: number,
    pollIntervalMs: number,
    logger?: SessionLogger,
  ): Promise<string>;
}

/** Decrypts stored credential ciphertext. Local default treats input as plaintext. */
export interface SecretCipher {
  decrypt(ciphertext: string): Promise<string>;
}

/** What an atomic single-use tunnel claim resolved to for a session. */
export interface TunnelContext {
  sessionId: string;
  /** The session's current status (e.g. 'starting' for an active, awaiting-tunnel crawl). */
  status: string;
  /** Whether the session was minted with a device-proxy tunnel (sessions.tunnel_requested). */
  tunnelRequested: boolean;
  /** True iff THIS call won the atomic single-use claim (CAS on tunnel_claimed_at). A later
   *  call on the same session — or one for a session that never requested a tunnel — gets false. */
  claimed: boolean;
}

/**
 * Resolves + atomically single-use-claims a session's device-proxy tunnel. Used by the engine's
 * /tunnel WS handler to gate a companion connection: only the call that wins the claim
 * (`claimed===true`) may bridge the tunnel and run the crawl. A second connection for the same
 * session — replay or a double-dial — gets `claimed===false` (the row is already claimed) so it's
 * rejected. Returns null when the session does not exist.
 *
 * The claim is the single-use enforcement the tunnel token (TTL + jti) defers to.
 */
export interface TunnelStore {
  loadTunnelContext(sessionId: string, deviceId: string): Promise<TunnelContext | null>;
  /**
   * Release a claim won by `loadTunnelContext` (reset tunnel_claimed_at back to NULL) so the session can
   * be claimed again. Called ONLY when a companion won the CAS but there is no parked crawl to run yet —
   * the control-plane sets tunnel_requested before it dispatches/parks the crawl, so a fast companion can
   * win the claim in that gap. Releasing (instead of burning the one-time claim) lets the companion's next
   * poll reclaim once the parked crawl exists. A no-op if the session isn't currently claimed.
   */
  releaseTunnelClaim(sessionId: string): Promise<void>;
}

export interface Platform {
  readonly name: string;
  readonly sessionStore: SessionStore;
  readonly screenshots: ScreenshotSink;
  readonly otp: OtpProvider;
  readonly cipher: SecretCipher;
  readonly tunnel: TunnelStore;
}
