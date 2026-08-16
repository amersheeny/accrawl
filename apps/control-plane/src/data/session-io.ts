/**
 * Session read + OTP submit + event replay — what the operator console needs to watch a crawl and
 * supply a 2FA code.
 *
 * The engine's OtpProvider polls sessions.otp; submitOtp writes the operator-entered code there so the
 * waiting crawl picks it up (the manual-entry 2FA floor that works for every self-hoster). Session
 * events carry a per-session sequence so the UI can replay from a `since` cursor (SSE Last-Event-ID).
 * The OTP value itself is never read back out — only that a code is being requested.
 */
import { createHash } from 'node:crypto';
import {
  and, desc, eq, gt, inArray, isNull,
} from 'drizzle-orm';
import type { CrawlCost, CrawlStepLog } from '@accrawl/contracts';
import type { Db } from '../db/client';
import {
  sessions, sessionEvents, sessionSteps, stagedRecords, connections, institutions, devices,
} from '../db/schema';
import { ACTIVE_SESSION_STATUSES } from './sessions';
import type { OtpRelayMode } from './otp-readiness';
import { extractOtpFromSms, type OtpModelCall } from './otp-extract';
import { SELF_HOSTED_OPERATOR_SUBJECT } from '../auth/subjects';
import { refreshDeviceContext, type DeviceContext } from './devices';

type SessionReadDb = Pick<Db, 'select'>;

async function lockActiveDevice(
  db: SessionReadDb,
  id: string,
  ownerSubject: string,
  credentialHash?: string,
): Promise<DeviceContext | null> {
  const [device] = await db
    .select({
      id: devices.id,
      name: devices.name,
      ownerSubject: devices.ownerSubject,
      credentialHash: devices.hashedToken,
      connectionGrants: devices.connectionGrants,
    })
    .from(devices)
    .where(and(
      eq(devices.id, id),
      eq(devices.ownerSubject, ownerSubject),
      credentialHash ? eq(devices.hashedToken, credentialHash) : undefined,
      isNull(devices.revokedAt),
    ))
    .limit(1)
    .for('share');
  return device ?? null;
}

export interface AwaitingOtpSession {
  id: string;
  connectionId: string;
  institutionId: string;
  institutionName: string | null;
  connectionName: string | null;
  /** The institution's learned OTP-sender hint, so the companion can bind the SMS to THIS session by sender
   *  (relay only when the SMS's sender matches) — never relay an unrelated OTP-looking SMS. Null when the
   *  institution hasn't learned one yet, in which case the companion refuses rather than guesses. */
  otpSenderPattern: string | null;
  /** The current OTP-request episode counter (see sessions.otpRequestEpoch). The companion echoes it back in
   *  the relay POST and folds it into its dedupe key, so a fresh request for the same SMS body isn't
   *  suppressed as a duplicate of the previous episode. */
  otpRequestEpoch: number;
  /** `starting` means the phone is being armed before navigation; `waiting_for_otp` means the bank has
   *  actually asked for its code. The companion uses this to distinguish watching from waiting. */
  status: string;
  /** When the engine asked for this code (sessions.otpRequestedAt), so the companion can show how long the
   *  crawl has been waiting. Optional — hosted stores that don't record it simply omit it, and the
   *  companion omits the waiting duration. */
  otpRequestedAt?: Date | null;
}

export interface CompanionOtpWakeContext {
  sessionId: string;
  ownerSubject: string;
  connectionId: string;
  institutionId: string;
  institutionName: string;
  connectionName: string | null;
  otpSenderPattern: string | null;
  otpRequestEpoch: number;
}

/** Resolve one live, armed OTP request to the metadata permitted in its
 * data-only Companion wake-up. */
export async function getCompanionOtpWakeContext(
  db: Db,
  sessionId: string,
): Promise<CompanionOtpWakeContext | null> {
  const [row] = await db
    .select({
      sessionId: sessions.id,
      ownerSubject: connections.ownerSubject,
      connectionId: sessions.connectionId,
      institutionId: connections.institutionId,
      institutionName: institutions.name,
      connectionName: connections.nickname,
      otpSenderPattern: institutions.otpSenderPattern,
      otpRequestEpoch: sessions.otpRequestEpoch,
    })
    .from(sessions)
    .innerJoin(connections, eq(sessions.connectionId, connections.id))
    .innerJoin(institutions, eq(connections.institutionId, institutions.id))
    .where(and(
      eq(sessions.id, sessionId),
      eq(sessions.otpRequested, true),
      inArray(sessions.status, [...ACTIVE_SESSION_STATUSES]),
    ))
    .limit(1);
  return row ?? null;
}

/** Sessions currently awaiting a 2FA code — what the companion device polls to know where to relay one. The
 *  otpSenderPattern + otpRequestEpoch are included so the companion can (a) verify the SMS came from THIS
 *  bank before relaying (a wrong code burns a 2FA attempt) and (b) scope its dedupe to the current request
 *  episode. */
export async function listAwaitingOtpSessions(
  db: Db,
  ownerSubject: string = SELF_HOSTED_OPERATOR_SUBJECT,
  device?: DeviceContext,
): Promise<AwaitingOtpSession[]> {
  const read = async (
    readDb: SessionReadDb,
    activeDevice?: DeviceContext,
  ): Promise<AwaitingOtpSession[]> => {
    if (activeDevice?.connectionGrants.length === 0) return [];
    const filters = [
      eq(sessions.otpRequested, true),
      inArray(sessions.status, [...ACTIVE_SESSION_STATUSES]),
      eq(connections.ownerSubject, ownerSubject),
    ];
    if (activeDevice) {
      filters.push(inArray(connections.id, activeDevice.connectionGrants));
    }
    return readDb
      .select({
        id: sessions.id,
        connectionId: sessions.connectionId,
        institutionId: connections.institutionId,
        institutionName: institutions.name,
        connectionName: connections.nickname,
        otpSenderPattern: institutions.otpSenderPattern,
        otpRequestEpoch: sessions.otpRequestEpoch,
        otpRequestedAt: sessions.otpRequestedAt,
        status: sessions.status,
      })
      .from(sessions)
      .innerJoin(connections, eq(sessions.connectionId, connections.id))
      .innerJoin(institutions, eq(connections.institutionId, institutions.id))
      .where(and(...filters));
  };
  if (!device) return read(db);
  return db.transaction(async (tx) => {
    const active = await lockActiveDevice(
      tx,
      device.id,
      ownerSubject,
      device.credentialHash,
    );
    return active ? read(tx, active) : [];
  });
}

/**
 * Record who is expected to supply the code for one armed OTP episode. The engine clears the mode as part
 * of opening an episode, so a decision can only ever describe the episode it was made for; the epoch guard
 * additionally discards a wake that was already in flight when the previous episode closed.
 */
export async function markOtpRelayMode(
  db: Db,
  sessionId: string,
  otpRequestEpoch: number,
  mode: OtpRelayMode,
): Promise<boolean> {
  const updated = await db
    .update(sessions)
    .set({ otpRelayMode: mode })
    .where(and(
      eq(sessions.id, sessionId),
      eq(sessions.otpRequested, true),
      eq(sessions.otpRequestEpoch, otpRequestEpoch),
      inArray(sessions.status, [...ACTIVE_SESSION_STATUSES]),
    ))
    .returning({ id: sessions.id });
  return updated.length > 0;
}

/** Record a paired phone's OTP-relay presence for one armed crawl. A phone without SMS access proves only
 * that the app is online; readiness is monotonic within the request episode, so a second phone without
 * permission cannot clear readiness already established by a capable phone. */
export async function markOtpRelayStatus(
  db: Db,
  sessionId: string,
  device: DeviceContext,
  smsPermission: boolean,
  ready = true,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const active = await lockActiveDevice(
      tx,
      device.id,
      device.ownerSubject,
      device.credentialHash,
    );
    if (!active || !active.connectionGrants.length) return false;
    const [owned] = await tx
      .select({ id: sessions.id })
      .from(sessions)
      .innerJoin(connections, eq(sessions.connectionId, connections.id))
      .where(and(
        eq(sessions.id, sessionId),
        eq(sessions.otpRequested, true),
        inArray(sessions.status, [...ACTIVE_SESSION_STATUSES]),
        eq(connections.ownerSubject, active.ownerSubject),
        inArray(connections.id, active.connectionGrants),
      ))
      .limit(1)
      .for('update');
    if (!owned) return false;
    const now = new Date();
    await tx.update(sessions).set({
      otpRelayOnline: true,
      otpRelayOnlineAt: now,
      ...(smsPermission && ready ? {
        otpRelayReady: true,
        otpRelayReadyAt: now,
      } : {}),
    }).where(eq(sessions.id, sessionId));
    return true;
  });
}

/** Smallest sender pattern we'll trust to bind a code to a bank — a 1–2 char pattern matches far too many
 *  senders to be a real binding. Mirrors the companion's _minSenderPatternLength / MIN_SENDER_PATTERN_LENGTH. */
const MIN_SENDER_PATTERN_LENGTH = 3;

/**
 * Server-side sender binding (defense in depth — the companion checks this too, but we never trust the
 * device to have). The pattern is a case-insensitive LITERAL that must EXACTLY EQUAL the SMS `sender` (both
 * trimmed) — NOT a substring. A substring/contains test let a spoofed `FAKE-BANKCO` match the institution's
 * `BANKCO` pattern and relay a code from an attacker-controlled sender (a wrong code burns a 2FA attempt); an
 * exact match closes that. It is NEVER a regex — an attacker-supplied pattern could ReDoS. A null/blank
 * pattern, or one shorter than the floor, never matches. Mirrors client.dart's senderMatches /
 * NativeRelay.senderMatches exactly.
 */
export function senderMatches(sender: string, pattern: string | null): boolean {
  const p = pattern?.trim();
  if (!p || p.length < MIN_SENDER_PATTERN_LENGTH) return false;
  const s = sender.trim();
  if (!s) return false;
  return s.toLowerCase() === p.toLowerCase();
}

export interface AwaitingTunnelSession {
  id: string;
  institutionName: string | null;
  /** The connection's operator-chosen nickname, preferred over the institution name when labelling the
   *  crawl on the companion (mirrors the companion's RecentCrawl.label precedence). */
  nickname: string | null;
}

/** Sessions awaiting a device-proxy tunnel claim: tunnel was requested, not yet claimed (the one-time CAS
 *  on tunnel_claimed_at hasn't fired), and the session is still active. What the companion polls to know
 *  which sessions need a tunnel. The token itself is minted by the route, not returned here. */
export async function listAwaitingTunnelSessions(
  db: Db,
  ownerSubject: string = SELF_HOSTED_OPERATOR_SUBJECT,
  deviceId?: string,
  credentialHash?: string,
): Promise<AwaitingTunnelSession[]> {
  const read = (readDb: SessionReadDb): Promise<AwaitingTunnelSession[]> => {
    const filters = [
      eq(sessions.tunnelRequested, true),
      isNull(sessions.tunnelClaimedAt),
      inArray(sessions.status, [...ACTIVE_SESSION_STATUSES]),
      eq(connections.ownerSubject, ownerSubject),
    ];
    if (deviceId) filters.push(eq(sessions.tunnelDeviceId, deviceId));
    return readDb
      .select({
        id: sessions.id,
        institutionName: institutions.name,
        nickname: connections.nickname,
      })
      .from(sessions)
      .innerJoin(connections, eq(sessions.connectionId, connections.id))
      .innerJoin(institutions, eq(connections.institutionId, institutions.id))
      .where(and(...filters));
  };
  if (!deviceId) return read(db);
  return db.transaction(async (tx) => (
    (await lockActiveDevice(tx, deviceId, ownerSubject, credentialHash))
      ? read(tx)
      : []
  ));
}

export interface SessionView {
  id: string;
  connectionId: string;
  status: string;
  currentStep: string | null;
  stepCount: number;
  otpRequested: boolean;
  error: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  /** Engine liveness signal — lets the UI flag a run whose heartbeat has gone stale ("possibly stalled"). */
  heartbeatAt: Date | null;
  /** Token/cost accounting the engine persisted at completion (model, tokens, USD) — null while running. */
  cost: CrawlCost | null;
}

export async function getSessionView(db: Db, id: string): Promise<SessionView | null> {
  const [s] = await db
    .select({
      id: sessions.id, connectionId: sessions.connectionId, status: sessions.status,
      currentStep: sessions.currentStep, stepCount: sessions.stepCount, otpRequested: sessions.otpRequested,
      error: sessions.error, startedAt: sessions.startedAt, completedAt: sessions.completedAt,
      heartbeatAt: sessions.heartbeatAt, cost: sessions.cost,
    })
    .from(sessions)
    .where(eq(sessions.id, id))
    .limit(1);
  return s ?? null;
}

/** One recorded crawl step, summarized for the console (the full CrawlStepLog stays in `log`). */
export interface SessionStepView {
  stepNumber: number;
  action: string;
  description: string | null;
  url: string | null;
  durationMs: number | null;
  error: string | null;
  /** Whether a screenshot was captured for this step (served by GET /api/sessions/:id/steps/:n/screenshot). */
  hasScreenshot: boolean;
  accountsExtracted: number;
  transactionsExtracted: number;
  positionsExtracted: number;
  createdAt: Date | null;
}

/** The recorded steps of a session, in order — the console's step timeline + screenshot index. */
export async function listSessionSteps(db: Db, id: string): Promise<SessionStepView[]> {
  const rows = await db
    .select({ stepNumber: sessionSteps.stepNumber, screenshotRef: sessionSteps.screenshotRef, log: sessionSteps.log, createdAt: sessionSteps.createdAt })
    .from(sessionSteps)
    .where(eq(sessionSteps.sessionId, id))
    .orderBy(sessionSteps.stepNumber);
  return rows.map((r) => {
    const log = (r.log ?? {}) as Partial<CrawlStepLog>;
    return {
      stepNumber: r.stepNumber,
      action: log.action ?? 'step',
      description: log.description ?? null,
      url: log.url ?? null,
      durationMs: log.durationMs ?? null,
      error: log.error ?? null,
      hasScreenshot: !!r.screenshotRef,
      accountsExtracted: log.accountsExtracted ?? 0,
      transactionsExtracted: log.transactionsExtracted ?? 0,
      positionsExtracted: log.positionsExtracted ?? 0,
      createdAt: r.createdAt,
    };
  });
}

/** A session's stored screenshot ref for one step (a relative path under the screenshots dir), or null. */
export async function getStepScreenshotRef(db: Db, id: string, stepNumber: number): Promise<string | null> {
  const [row] = await db
    .select({ screenshotRef: sessionSteps.screenshotRef })
    .from(sessionSteps)
    .where(and(eq(sessionSteps.sessionId, id), eq(sessionSteps.stepNumber, stepNumber)))
    .limit(1);
  return row?.screenshotRef ?? null;
}

/** A connection's recent sessions, newest first — the console's run history + "jump back into a live crawl". */
export interface ConnectionSessionView {
  id: string;
  status: string;
  stepCount: number;
  error: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  cost: CrawlCost | null;
}

export async function listConnectionSessions(db: Db, connectionId: string, limit = 20): Promise<ConnectionSessionView[]> {
  return db
    .select({
      id: sessions.id, status: sessions.status, stepCount: sessions.stepCount,
      error: sessions.error, startedAt: sessions.startedAt, completedAt: sessions.completedAt, cost: sessions.cost,
    })
    .from(sessions)
    .where(eq(sessions.connectionId, connectionId))
    .orderBy(desc(sessions.startedAt))
    .limit(limit);
}

/** A recent session across ALL connections, labeled for the crawl-history page. */
export interface RecentSessionView extends ConnectionSessionView {
  connectionId: string;
  institutionName: string | null;
  nickname: string | null;
}

/** Recent sessions across every connection, newest first — the crawl-history page's list. */
export async function listRecentSessions(
  db: Db,
  limit = 50,
  ownerSubject: string = SELF_HOSTED_OPERATOR_SUBJECT,
  device?: DeviceContext,
): Promise<RecentSessionView[]> {
  const read = (
    readDb: SessionReadDb,
    activeDevice?: DeviceContext,
  ): Promise<RecentSessionView[]> => {
    if (activeDevice?.connectionGrants.length === 0) return Promise.resolve([]);
    const filters = [eq(connections.ownerSubject, ownerSubject)];
    if (activeDevice) {
      filters.push(inArray(connections.id, activeDevice.connectionGrants));
    }
    return readDb
      .select({
        id: sessions.id, connectionId: sessions.connectionId, status: sessions.status,
        stepCount: sessions.stepCount, error: sessions.error, startedAt: sessions.startedAt,
        completedAt: sessions.completedAt, cost: sessions.cost,
        institutionName: institutions.name, nickname: connections.nickname,
      })
      .from(sessions)
      .innerJoin(connections, eq(sessions.connectionId, connections.id))
      .innerJoin(institutions, eq(connections.institutionId, institutions.id))
      .where(and(...filters))
      .orderBy(desc(sessions.startedAt))
      .limit(limit);
  };
  if (!device) return read(db);
  return db.transaction(async (tx) => {
    const active = await lockActiveDevice(
      tx,
      device.id,
      ownerSubject,
      device.credentialHash,
    );
    return active ? read(tx, active) : [];
  });
}

/** What one crawl run extracted, straight from its staged records (raw normalized rows, pre-promotion),
 *  grouped by kind and capped so a huge run can't flood the console. Retained until the session's TTL. */
export interface SessionRecords {
  counts: { accounts: number; transactions: number; positions: number };
  accounts: unknown[];
  transactions: unknown[];
  positions: unknown[];
}

const RECORDS_CAP = 500; // per kind — the console shows this run's data, not an unbounded export

export async function getSessionRecords(db: Db, id: string): Promise<SessionRecords> {
  const rows = await db
    .select({ kind: stagedRecords.kind, data: stagedRecords.data })
    .from(stagedRecords)
    .where(eq(stagedRecords.sessionId, id))
    .orderBy(stagedRecords.createdAt);
  const out: SessionRecords = { counts: { accounts: 0, transactions: 0, positions: 0 }, accounts: [], transactions: [], positions: [] };
  for (const r of rows) {
    const bucket = r.kind === 'account' ? 'accounts' : r.kind === 'transaction' ? 'transactions' : 'positions';
    out.counts[bucket] += 1;
    if (out[bucket].length < RECORDS_CAP) out[bucket].push(r.data);
  }
  return out;
}

export type SubmitOtpResult = 'accepted' | 'not_found' | 'not_active';

/** The connection a session belongs to, or null if the session is unknown. Used for API-key session-ownership
 *  checks: a consumer may submit an OTP only for a session whose connection its key is granted. */
export async function getSessionConnectionId(db: Db, sessionId: string): Promise<string | null> {
  const [row] = await db.select({ connectionId: sessions.connectionId }).from(sessions).where(eq(sessions.id, sessionId)).limit(1);
  return row?.connectionId ?? null;
}

/**
 * Write the operator-entered (or companion-relayed) OTP for the crawl to pick up. Only meaningful while the
 * session is active.
 *
 * `idempotencyKey` (optional) makes a retried/redelivered submit a no-op: a carrier-redelivered SMS or a
 * retried POST carrying the same key returns 'accepted' WITHOUT overwriting the code or burning a second 2FA
 * attempt. The companion's own dedupe ledger is the primary guard; this is the server-side belt-and-braces
 * that also covers an operator double-submit and a companion that lost its ledger across a restart. The key
 * is SCOPED to the OTP-request episode (it includes otpRequestEpoch — see otpSmsIdempotencyKey), so the same
 * SMS body relayed for a genuinely NEW request (a resend, or a fresh code that reads identically) carries a
 * DIFFERENT key and is accepted, while a true in-episode duplicate carries the same key and is a no-op.
 */
export async function submitOtp(
  db: Pick<Db, 'select' | 'update'>,
  id: string,
  code: string,
  idempotencyKey?: string,
): Promise<SubmitOtpResult> {
  const [s] = await db
    .select({ status: sessions.status, otpIdempotencyKey: sessions.otpIdempotencyKey })
    .from(sessions)
    .where(eq(sessions.id, id))
    .limit(1);
  if (!s) return 'not_found';
  // A retry of a submit we already accepted (same key) is a no-op — never a second attempt. We can answer
  // this even after the session has left waiting_for_otp (the engine consumed the first code and advanced),
  // so the duplicate doesn't surface as a spurious 409 to the caller.
  if (idempotencyKey && s.otpIdempotencyKey === idempotencyKey) return 'accepted';
  // Accept a code ONLY while the session is actually awaiting one. The engine sets status='waiting_for_otp'
  // (+ otp_requested) when it needs a code and then polls sessions.otp; a code written in any other active
  // state ('starting'/'logging_in'/…) would be read prematurely and burn a 2FA attempt. Atomic check-and-set
  // so a state change between the read and the write can't slip a stale code in. The key is stored in the
  // SAME update, so a concurrent duplicate that loses the CAS race re-reads it and short-circuits above.
  if (s.status !== 'waiting_for_otp') return 'not_active';
  const updated = await db
    .update(sessions)
    .set({ otp: code, otpIdempotencyKey: idempotencyKey ?? null })
    .where(and(eq(sessions.id, id), eq(sessions.status, 'waiting_for_otp')))
    .returning({ id: sessions.id });
  return updated.length > 0 ? 'accepted' : 'not_active';
}

/**
 * Deterministic, episode-scoped idempotency key for an SMS-relayed OTP. Folds in otpRequestEpoch so the SAME
 * body relayed for a NEW request episode produces a different key (accepted) while a true duplicate within
 * one episode produces the same key (no-op). sha256(body) keeps it bounded + content-addressed. The companion
 * derives an equivalent key independently — they don't have to be byte-identical (each side dedupes against
 * its own prior value), but keeping the same recipe makes a server-side no-op recognise a companion retry.
 */
export function otpSmsIdempotencyKey(sessionId: string, otpRequestEpoch: number, smsBody: string): string {
  const bodyHash = createHash('sha256').update(smsBody, 'utf8').digest('hex');
  return `sms|${sessionId}|${otpRequestEpoch}|${bodyHash}`;
}

export type SubmitOtpFromSmsResult =
  | { status: SubmitOtpResult }      // 'accepted' | 'not_found' | 'not_active'
  | { status: 'unauthorized' }       // the paired device was revoked while this request was in flight
  | { status: 'sender_mismatch' }    // the SMS sender doesn't match the institution's learned pattern
  | { status: 'stale_epoch' }        // the request episode has moved on (a newer code was asked for)
  | { status: 'no_otp' };            // the LLM found no code in the body → do NOT submit; manual entry

export interface SubmitOtpFromSmsInput {
  sessionId: string;
  /** The RAW SMS body the companion relayed (the LLM extracts the code from this — the companion no longer
   *  parses it). */
  smsBody: string;
  /** The SMS sender, validated server-side against the institution's otpSenderPattern (defense in depth). */
  sender: string;
  /** The OTP-request episode the companion saw on awaiting-otp. Must still match the session's current epoch,
   *  or the relay is for a stale request and is rejected (the engine asked again since). */
  otpRequestEpoch: number;
}

/**
 * LLM-FIRST SMS relay: the companion hands us the SMS body (not a parsed code); we validate the sender +
 * request episode server-side, ask Gemini to extract the code, and submit it. Replaces the old regex
 * extractor that lived on the device.
 *
 * Flow:
 *  1. Load the session + its institution (name for LLM context, otpSenderPattern for sender binding).
 *  2. Reject unknown / non-awaiting sessions (not_found / not_active) BEFORE spending an LLM call.
 *  3. Reject a sender that doesn't match the institution's learned pattern (sender_mismatch) — never relay an
 *     unrelated OTP-looking SMS. Literal contains, never regex (senderMatches).
 *  4. Reject a stale epoch (stale_epoch): the companion's view is older than the session's current request.
 *  5. Short-circuit a same-episode duplicate body via the idempotency key (no second LLM call, no re-submit).
 *  6. Extract the code with the LLM. Null → no_otp (do NOT submit; the operator types it). A valid code →
 *     submit via submitOtp with the episode-scoped key.
 *
 * `modelCall` is injectable so tests mock Gemini; production uses the live call.
 */
export async function submitOtpFromSms(
  db: Db,
  input: SubmitOtpFromSmsInput,
  modelCall?: OtpModelCall,
  device?: DeviceContext,
): Promise<SubmitOtpFromSmsResult> {
  const initialDevice = device
    ? await refreshDeviceContext(db, device)
    : undefined;
  if (device && !initialDevice) return { status: 'unauthorized' };
  const [s] = await db
    .select({
      connectionId: sessions.connectionId,
      status: sessions.status,
      otpRequestEpoch: sessions.otpRequestEpoch,
      otpIdempotencyKey: sessions.otpIdempotencyKey,
      institutionName: institutions.name,
      otpSenderPattern: institutions.otpSenderPattern,
    })
    .from(sessions)
    .innerJoin(connections, eq(sessions.connectionId, connections.id))
    .innerJoin(institutions, eq(connections.institutionId, institutions.id))
    .where(and(
      eq(sessions.id, input.sessionId),
      initialDevice
        ? inArray(sessions.connectionId, initialDevice.connectionGrants)
        : undefined,
    ))
    .limit(1);
  if (!s) return { status: 'not_found' };

  const key = otpSmsIdempotencyKey(input.sessionId, input.otpRequestEpoch, input.smsBody);
  // A retry of an SMS we already accepted (same episode + same body) is a no-op — even after the engine
  // consumed the code and advanced. Answered before the status/epoch gates so a redelivery doesn't surface
  // as a spurious not_active/stale_epoch.
  if (s.otpIdempotencyKey === key) return { status: 'accepted' };

  if (s.status !== 'waiting_for_otp') return { status: 'not_active' };
  // Defense in depth: the companion already sender-binds, but we never trust the device. An unrelated
  // OTP-looking SMS forwarded to us must not be relayed.
  if (!senderMatches(input.sender, s.otpSenderPattern)) return { status: 'sender_mismatch' };
  // The companion's view must be the CURRENT request episode. If the engine has re-armed the relay since
  // (a resend / restarted login bumped the epoch), this relay is for a superseded request — refuse it.
  if (s.otpRequestEpoch !== input.otpRequestEpoch) return { status: 'stale_epoch' };

  const code = await extractOtpFromSms(input.smsBody, s.institutionName, modelCall);
  if (!code) return { status: 'no_otp' };

  if (!device) {
    return { status: await submitOtp(db, input.sessionId, code, key) };
  }
  return db.transaction(async (tx) => {
    const active = await lockActiveDevice(
      tx,
      device.id,
      device.ownerSubject,
      device.credentialHash,
    );
    if (!active || !active.connectionGrants.includes(s.connectionId)) {
      return { status: 'unauthorized' };
    }
    return { status: await submitOtp(tx, input.sessionId, code, key) };
  });
}

export interface SessionEvent {
  seq: number;
  type: string;
  data: unknown;
  createdAt: Date | null;
}

/** Events for a session with seq > `sinceSeq`, ordered — for SSE/poll replay from a cursor. */
export async function listSessionEvents(db: Db, id: string, sinceSeq = 0): Promise<SessionEvent[]> {
  return db
    .select({ seq: sessionEvents.seq, type: sessionEvents.type, data: sessionEvents.data, createdAt: sessionEvents.createdAt })
    .from(sessionEvents)
    .where(and(eq(sessionEvents.sessionId, id), gt(sessionEvents.seq, sinceSeq)))
    .orderBy(sessionEvents.seq);
}
