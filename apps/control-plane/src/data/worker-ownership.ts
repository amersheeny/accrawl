/**
 * Who owns a crawl attempt, and what a worker is allowed to say about it.
 *
 * A hosted crawl is run by a worker the control-plane started for exactly one attempt. Everything that
 * decides whether a given request really comes from that worker — the bearer it must present, the identity
 * of the attempt it claims, whether its lease is still live, and whether a completion it re-sends is the
 * same one already recorded — is product policy, not a property of where the records happen to be stored.
 * It lives here so that any storage implementation reaches the same verdict, and so a wrapper implementing
 * one cannot quietly decide these questions differently.
 *
 * Everything in this module is pure: plain values in, a verdict or a derived string out. Times arrive as
 * epoch milliseconds, so a store that keeps its own timestamp type converts at its boundary rather than
 * pushing that type in here.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { WorkerCompleteRequest } from '@accrawl/contracts';

/** How long a worker may hold a crawl before the control-plane may take it back. */
export const WORKER_LEASE_MS = 120_000;

export const ACTIVE_SESSION_STATUSES = new Set([
  'starting',
  'logging_in',
  'navigating',
  'waiting_for_otp',
  'extracting',
]);

export const TERMINAL_JOB_STATUSES = new Set([
  'succeeded',
  'failed',
  'cancelled',
]);

const SESSION_BEARER = /^[A-Za-z0-9_-]{43}$/;
export const SHA256_HEX = /^[a-f0-9]{64}$/;
const URL_FIELD = /(?:^|[_-])(?:url|uri)$|(?:Url|URL|Uri|URI)$/;
const URL_IN_TEXT =
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"']+|(?<![:/])\/\/[^\s<>"']+/giu;

/** Raised when a request cannot prove it still owns the attempt it names. */
export class WorkerBrokerFenceError extends Error {
  constructor(public readonly durableStatus = 'cancelled') {
    super('worker no longer owns the crawl session');
    this.name = 'WorkerBrokerFenceError';
  }
}

export function safeDigestEqual(expected: string | undefined, actual: string): boolean {
  if (!expected || !SHA256_HEX.test(expected) || !SHA256_HEX.test(actual)) {
    return false;
  }
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(actual, 'hex'));
}

export function decodeSessionBearer(bearer: string): Buffer {
  if (!SESSION_BEARER.test(bearer)) {
    throw new WorkerBrokerFenceError();
  }
  const decoded = Buffer.from(bearer, 'base64url');
  if (
    decoded.length !== 32
    || decoded.toString('base64url') !== bearer
  ) {
    decoded.fill(0);
    throw new WorkerBrokerFenceError();
  }
  return decoded;
}

export function bearerDigest(bearer: string): string {
  const decoded = decodeSessionBearer(bearer);
  try {
    return createHash('sha256').update(decoded).digest('hex');
  } finally {
    decoded.fill(0);
  }
}

export function ownerGeneration(executionUid: string, attemptId: string): string {
  return createHash('sha256')
    .update(`accrawl-worker-output\0${executionUid}\0${attemptId}`)
    .digest('hex');
}

export function completionOutputGeneration(
  assetGeneration: string,
  digest: string,
): string {
  return createHash('sha256')
    .update(`accrawl-worker-completion-output-v1\0${assetGeneration}\0${digest}`)
    .digest('hex');
}

/** Key order and number formatting have to be fixed, or the same completion would hash two ways. */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  }
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) {
        throw new Error('worker completion contains a non-finite number');
      }
      return Object.is(value, -0) ? '0' : String(value);
    case 'string':
      return JSON.stringify(value);
    case 'object': {
      const record = value as Record<string, unknown>;
      const entries = Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
      return `{${entries.join(',')}}`;
    }
    default:
      throw new Error('worker completion contains a non-JSON value');
  }
}

/** The receipt that makes a re-sent completion recognisable as the same one, not a second outcome. */
export function completionDigest(
  request: WorkerCompleteRequest,
  bearer: string,
  safeFailure: string | undefined,
): string {
  const key = decodeSessionBearer(bearer);
  try {
    return createHmac('sha256', key)
      .update('accrawl-worker-completion-v1\0')
      .update(safeFailure ?? '')
      .update('\0')
      .update(canonicalJson(request))
      .digest('hex');
  } finally {
    key.fill(0);
  }
}

export function sanitizeStandaloneUrl(value: string): string {
  try {
    const protocolRelative = value.startsWith('//');
    const url = protocolRelative
      ? new URL(value, 'https://accrawl.invalid')
      : new URL(value);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return protocolRelative
      ? `//${url.host}${url.pathname}`
      : url.toString();
  } catch {
    return value.split(/[?#]/u, 1)[0]!;
  }
}

export function sanitizeTelemetryString(value: string, key?: string): string {
  if (key && URL_FIELD.test(key)) return sanitizeStandaloneUrl(value);
  return value.replace(
    URL_IN_TEXT,
    (candidate) => sanitizeStandaloneUrl(candidate),
  );
}

/** Telemetry a worker sends back is attacker-influenced: a bank page chooses much of it. Credentials and
 *  query strings ride in URLs, so they are stripped before anything is recorded. */
export function sanitizeTelemetryValue(value: unknown, key?: string): unknown {
  if (typeof value === 'string') return sanitizeTelemetryString(value, key);
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeTelemetryValue(entry));
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .map(([entryKey, entry]) => [
          entryKey,
          sanitizeTelemetryValue(entry, entryKey),
        ]),
    );
  }
  return value;
}

/** The attempt a request claims to be acting for. */
export interface WorkerAttemptContext {
  sessionId: string;
  attemptId: string;
  execution: string;
}

/** What a store must read about the job before ownership can be judged. Times are epoch milliseconds. */
export interface WorkerJobFacts {
  id: string;
  sessionId: string;
  status: string;
  expectedAttemptId?: string;
  workerExecutionName?: string;
  workerExecutionUid?: string;
  workerSessionBearerDigest?: string;
  workerAssetGeneration?: string;
  workerOutputGeneration?: string;
  workerCompletionDigest?: string;
  leaseExpiresAtMs?: number;
}

/** What a store must read about the session before ownership can be judged. */
export interface WorkerSessionFacts {
  id: string;
  status: string;
  workerAttemptId?: string;
  workerClaimOwnerId?: string;
  workerOutputGeneration?: string;
  workerCompletionDigest?: string;
  workerClaimLeaseExpiresAtMs?: number;
}

export interface OwnershipAllowances {
  allowCancellation?: boolean;
  allowTerminal?: boolean;
}

/**
 * Whether this request still owns the attempt it names. Every clause has to hold: it is the same session
 * and attempt, started by the same execution, presenting the bearer recorded at claim time, with both the
 * job's and the session's leases still live, and both rows in a state the request is permitted to touch.
 */
export function workerOwnsAttempt(
  context: WorkerAttemptContext,
  bearer: string,
  job: WorkerJobFacts,
  session: WorkerSessionFacts,
  nowMs: number,
  options: OwnershipAllowances = {},
): boolean {
  const ownerMatches =
    job.id === context.sessionId
    && job.sessionId === context.sessionId
    && job.expectedAttemptId === context.attemptId
    && job.workerExecutionName === context.execution
    && session.id === context.sessionId
    && session.workerAttemptId === context.attemptId
    && session.workerClaimOwnerId === job.workerExecutionUid
    && safeDigestEqual(job.workerSessionBearerDigest, bearerDigest(bearer));
  const leaseLive =
    typeof job.leaseExpiresAtMs === 'number'
    && job.leaseExpiresAtMs > nowMs
    && typeof session.workerClaimLeaseExpiresAtMs === 'number'
    && session.workerClaimLeaseExpiresAtMs > nowMs;
  const jobAllowed = job.status === 'running'
    || (options.allowCancellation === true && job.status === 'cancel_requested')
    || (options.allowTerminal === true && TERMINAL_JOB_STATUSES.has(job.status));
  const sessionAllowed = ACTIVE_SESSION_STATUSES.has(session.status)
    || (options.allowCancellation === true && session.status === 'cancelling')
    || (options.allowTerminal === true
      && ['completed', 'failed', 'cancelled'].includes(session.status));
  return ownerMatches && leaseLive && jobAllowed && sessionAllowed;
}

/**
 * Whether a completion being re-sent is exactly the one already recorded, so a lost response can be
 * retried without producing a second outcome.
 *
 * Ownership is deliberately judged more loosely here than for a live request: the terminal job row and its
 * digest are the immutable receipt, and the session may legitimately have moved on and scrubbed its
 * transient worker claim while the control-plane promotes the accepted output — including to `failed` if
 * promotion rejects it.
 */
export function isExactTerminalCompletion(
  request: WorkerCompleteRequest,
  bearer: string,
  digest: string,
  job: WorkerJobFacts,
  session: WorkerSessionFacts,
): boolean {
  const ownerMatches =
    job.id === request.sessionId
    && job.sessionId === request.sessionId
    && job.expectedAttemptId === request.attemptId
    && job.workerExecutionName === request.execution
    && session.id === request.sessionId
    && safeDigestEqual(job.workerSessionBearerDigest, bearerDigest(bearer));
  const outcomeMatches = request.success
    ? job.status === 'succeeded'
    : job.status === 'failed';
  const expectedOutputGeneration = job.workerAssetGeneration
    ? completionOutputGeneration(job.workerAssetGeneration, digest)
    : undefined;
  const acceptedOutputMatches = request.success
    ? expectedOutputGeneration !== undefined
      && job.workerOutputGeneration === expectedOutputGeneration
      && session.workerOutputGeneration === expectedOutputGeneration
    : true;
  return ownerMatches
    && outcomeMatches
    && acceptedOutputMatches
    && safeDigestEqual(job.workerCompletionDigest, digest)
    && safeDigestEqual(session.workerCompletionDigest, digest);
}

/** Whether a cancellation being acknowledged again is the one already recorded. */
export function isExactCancellationAcknowledgement(
  context: WorkerAttemptContext,
  bearer: string,
  job: WorkerJobFacts,
): boolean {
  return job.id === context.sessionId
    && job.sessionId === context.sessionId
    && job.expectedAttemptId === context.attemptId
    && job.workerExecutionName === context.execution
    && job.status === 'cancelled'
    && safeDigestEqual(job.workerSessionBearerDigest, bearerDigest(bearer));
}
