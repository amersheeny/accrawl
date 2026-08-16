import type { Db } from '../db/client';
import {
  getCompanionOtpWakeContext,
  markOtpRelayMode,
  type CompanionOtpWakeContext,
} from '../data/session-io';
import { deviceSessionStore } from '../data/device-session-store';
import {
  hostedCredentialStore,
  usesHostedCredentials,
} from '../auth/credential-store';
import { countRelayAuthorizedDevices } from '../data/devices';
import { otpRelayModeFor, type OtpRelayMode } from '../data/otp-readiness';
import {
  sendCompanionWake,
  type CompanionWakeInput,
  type CompanionWakeResult,
} from './companion-push';

export type OtpWakeResult =
  | { state: 'not_pending' }
  | { state: 'manual' }
  | ({ state: 'sent'; mode: OtpRelayMode } & CompanionWakeResult);

export interface OtpWakeDeps {
  resolveContext?: (
    db: Db,
    sessionId: string,
  ) => Promise<CompanionOtpWakeContext | null>;
  countDevices?: (
    db: Db,
    ownerSubject: string,
    connectionId: string,
  ) => Promise<number>;
  recordMode?: (
    db: Db,
    sessionId: string,
    otpRequestEpoch: number,
    mode: OtpRelayMode,
  ) => Promise<boolean>;
  sendWake?: (
    db: Db,
    input: CompanionWakeInput,
  ) => Promise<CompanionWakeResult>;
}

async function resolveContext(
  db: Db,
  sessionId: string,
): Promise<CompanionOtpWakeContext | null> {
  const hostedSessions = deviceSessionStore();
  return hostedSessions
    ? (await hostedSessions()).getCompanionOtpWakeContext(sessionId)
    : getCompanionOtpWakeContext(db, sessionId);
}

async function countDevices(
  db: Db,
  ownerSubject: string,
  connectionId: string,
): Promise<number> {
  return usesHostedCredentials()
    ? (await hostedCredentialStore())
      .countRelayAuthorizedDevices(ownerSubject, connectionId)
    : countRelayAuthorizedDevices(db, ownerSubject, connectionId);
}

async function recordMode(
  db: Db,
  sessionId: string,
  otpRequestEpoch: number,
  mode: OtpRelayMode,
): Promise<boolean> {
  const hostedSessions = deviceSessionStore();
  return hostedSessions
    ? (await hostedSessions()).markOtpRelayMode(sessionId, otpRequestEpoch, mode)
    : markOtpRelayMode(db, sessionId, otpRequestEpoch, mode);
}

/**
 * Settle one armed OTP episode: decide who will supply the code, record it so the waiting crawl can act on
 * it, and wake the phone when there is one to wake.
 *
 * The decision has to happen here because the control-plane is the only side that can see which devices are
 * paired — the engine deliberately holds no access to them. Recording the mode BEFORE sending any push is
 * what makes the crawl's wait bounded by fact rather than by a timer: with no authorized phone the crawl
 * stops waiting immediately and asks the operator instead, and with one it keeps the strict handshake, where
 * a wake that fails to deliver still leaves the episode armed for the app's own recovery poll.
 *
 * A wake-up is sent only while the authoritative session is both active and armed. Native code rechecks the
 * same live state before starting a service, closing the delayed/stale-FCM race.
 */
export async function armOtpRelayEpisode(
  db: Db,
  sessionId: string,
  deps: OtpWakeDeps = {},
): Promise<OtpWakeResult> {
  const context = await (deps.resolveContext ?? resolveContext)(db, sessionId);
  if (!context) return { state: 'not_pending' };

  const authorizedDeviceCount = await (deps.countDevices ?? countDevices)(
    db,
    context.ownerSubject,
    context.connectionId,
  );
  const mode = otpRelayModeFor({ authorizedDeviceCount });
  await (deps.recordMode ?? recordMode)(
    db,
    context.sessionId,
    context.otpRequestEpoch,
    mode,
  );
  if (mode === 'manual') {
    // eslint-disable-next-line no-console
    console.info(
      `[companion-wake] no Companion is authorized for connection ${context.connectionId} — `
      + `session ${context.sessionId} will wait for the code to be entered in the console`,
    );
    return { state: 'manual' };
  }

  const data: Record<string, string> = {
    sessionId: context.sessionId,
    institutionId: context.institutionId,
    institutionName: context.institutionName,
    otpRequestEpoch: String(context.otpRequestEpoch),
    ...(context.connectionName
      ? { connectionName: context.connectionName }
      : {}),
    ...(context.otpSenderPattern
      ? { otpSenderPattern: context.otpSenderPattern }
      : {}),
  };
  const result = await (deps.sendWake ?? sendCompanionWake)(db, {
    ownerSubject: context.ownerSubject,
    connectionId: context.connectionId,
    data,
  });
  return { state: 'sent', mode, ...result };
}
