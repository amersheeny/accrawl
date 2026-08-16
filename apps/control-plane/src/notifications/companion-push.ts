import type { Db } from '../db/client';
import {
  FcmSendError,
  sendFcmDataMessage,
  type FcmDataMessage,
} from './fcm-v1';
import {
  clearDevicePushToken,
  listCompanionPushTargets,
  type CompanionPushTarget,
} from '../data/devices';

export interface CompanionWakeInput {
  ownerSubject: string;
  connectionId: string;
  deviceId?: string;
  /** FCM data messages permit string values only. */
  data: Record<string, string>;
}

export interface CompanionWakeResult {
  attempted: number;
  delivered: number;
  invalidated: number;
}

export interface CompanionPushDeps {
  listTargets?: (
    db: Db,
    ownerSubject: string,
    connectionId: string,
    deviceId?: string,
  ) => Promise<CompanionPushTarget[]>;
  clearRejectedToken?: (
    db: Db,
    deviceId: string,
    ownerSubject: string,
    rejectedToken: string,
  ) => Promise<boolean>;
  sendFcm?: (message: FcmDataMessage) => Promise<unknown>;
  warn?: (message: string, error?: unknown) => void;
}

/** The two answers that mean this registration is gone for good. Everything else — an outage, a
 *  rejected sender identity, a network fault — is a fault to report, never a reason to unregister a
 *  device that is very likely still there. */
const DEAD_REGISTRATION = new Set(['unregistered', 'invalid-token']);

/** What to log about a failure: the transport's own word for it when it has one. */
function describe(error: unknown): unknown {
  return error instanceof FcmSendError ? error.failure : error;
}

function isDeadRegistration(error: unknown): boolean {
  return error instanceof FcmSendError && DEAD_REGISTRATION.has(error.failure);
}

/**
 * Deliver a silent, high-priority wake-up to every currently authorized
 * Companion registration for one connection. Delivery failure never changes
 * crawl state: the app's one-shot pending-session recovery is the missed-push
 * fallback. Invalid registrations are removed with a compare-and-clear so a
 * concurrent token refresh is never lost.
 */
export async function sendCompanionWake(
  db: Db,
  input: CompanionWakeInput,
  deps: CompanionPushDeps = {},
): Promise<CompanionWakeResult> {
  const listTargets = deps.listTargets ?? listCompanionPushTargets;
  const clearRejectedToken = deps.clearRejectedToken ?? clearDevicePushToken;
  const sendFcm = deps.sendFcm ?? ((message: FcmDataMessage) => sendFcmDataMessage(message));
  const warn = deps.warn ?? ((message: string, error?: unknown) => {
    // eslint-disable-next-line no-console
    console.warn(message, error);
  });
  const targets = await listTargets(
    db,
    input.ownerSubject,
    input.connectionId,
    input.deviceId,
  );
  let attempted = 0;
  let delivered = 0;
  let invalidated = 0;
  for (const target of targets) {
    if (target.pushTransport !== 'fcm') continue;
    attempted += 1;
    try {
      await sendFcm({
        token: target.pushToken,
        data: input.data,
        android: { priority: 'high' },
      });
      delivered += 1;
    } catch (error) {
      if (isDeadRegistration(error)) {
        if (await clearRejectedToken(
          db,
          target.id,
          input.ownerSubject,
          target.pushToken,
        )) invalidated += 1;
      }
      warn(
        `[companion-push] delivery failed for device ${target.id}`,
        describe(error),
      );
    }
  }
  if (attempted > 0 && delivered === 0) {
    // Not one wake left the server: unless the Companion happens to be alive on
    // its own, this session's relay can never come online, and the crawl will
    // sit out its whole readiness window before failing with a generic error.
    // Say so once, loudly, at the moment it is knowable — a rejected send here
    // is an operator-actionable fault (revoked token, sender misconfiguration,
    // or a runtime identity that FCM refuses), never routine noise.
    // eslint-disable-next-line no-console
    console.error(
      `[companion-push] NO wake was delivered for connection ${input.connectionId} `
      + `(${attempted} attempted, ${invalidated} invalidated) — the Companion will not `
      + 'come online for this session unless it is already running',
    );
  }
  return { attempted, delivered, invalidated };
}
