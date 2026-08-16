/**
 * Companion device pairing + device-token auth.
 *
 * A device (the operator's Android OTP-relay) pairs once and receives a token shown ONCE; only its
 * SHA-256 hash is stored, so a DB compromise never yields a usable token. The device authenticates its
 * OTP relays + push-token registration with the token. Tokens are revocable, and every device is
 * limited to the exact connections approved during pairing.
 */
import { createHash, randomBytes } from 'node:crypto';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { Db } from '../db/client';
import { apiKeys, connections, devices, institutions, sessions } from '../db/schema';
import { SELF_HOSTED_OPERATOR_SUBJECT } from '../auth/subjects';
import {
  hostedCredentialStore,
  usesHostedCredentials,
} from '../auth/credential-store';

const DEVICE_PREFIX = 'acdv_';

export function hashDeviceToken(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}

/** Generate a fresh device token + its stored hash. The plaintext is shown to the operator ONCE. */
export function generateDeviceToken(): { plaintext: string; hashedToken: string } {
  const plaintext = DEVICE_PREFIX + randomBytes(32).toString('base64url');
  return { plaintext, hashedToken: hashDeviceToken(plaintext) };
}

export interface DeviceContext {
  id: string;
  name: string;
  ownerSubject: string;
  /** Hash of the exact bearer generation authenticated for this request. */
  credentialHash: string;
  connectionGrants: string[];
}

/** Re-resolve a previously authenticated device by its stored id so
 * authorization and polling cannot continue on a context revoked meanwhile. */
export async function refreshDeviceContext(
  db: Db,
  context: DeviceContext,
): Promise<DeviceContext | null> {
  if (usesHostedCredentials()) {
    return (await hostedCredentialStore()).refreshDevice(context);
  }
  const [row] = await db
    .select({
      id: devices.id,
      name: devices.name,
      ownerSubject: devices.ownerSubject,
      credentialHash: devices.hashedToken,
      connectionGrants: devices.connectionGrants,
    })
    .from(devices)
    .where(and(
      eq(devices.id, context.id),
      eq(devices.ownerSubject, context.ownerSubject),
      eq(devices.hashedToken, context.credentialHash),
      isNull(devices.revokedAt),
    ))
    .limit(1);
  return row ?? null;
}

export async function pairDevice(
  db: Db,
  input: {
    name: string;
    connectionGrants?: string[];
    pushTransport?: string | null;
    pushToken?: string | null;
  },
  ownerSubject: string = SELF_HOSTED_OPERATOR_SUBJECT,
): Promise<{ id: string; plaintext: string }> {
  const { plaintext, hashedToken } = generateDeviceToken();
  if (usesHostedCredentials()) {
    const id = await (await hostedCredentialStore()).createDevice({
      name: input.name,
      ownerSubject,
      hashedToken,
      connectionGrants: input.connectionGrants ?? [],
      pushTransport: input.pushTransport ?? null,
      pushToken: input.pushToken ?? null,
    });
    return { id, plaintext };
  }
  const [row] = await db
    .insert(devices)
    .values({
      name: input.name,
      ownerSubject,
      hashedToken,
      connectionGrants: input.connectionGrants ?? [],
      pushTransport: input.pushTransport ?? null,
      pushToken: input.pushToken ?? null,
    })
    .returning({ id: devices.id });
  return { id: row.id, plaintext };
}

/** Resolve a presented device token to its context, or null if unknown/revoked. Touches lastSeenAt. */
export async function verifyDeviceToken(db: Db, presented: string): Promise<DeviceContext | null> {
  if (!presented.startsWith(DEVICE_PREFIX)) return null;
  const hashed = hashDeviceToken(presented);
  if (usesHostedCredentials()) {
    return (await hostedCredentialStore()).verifyDevice(hashed);
  }
  const [row] = await db.select().from(devices).where(eq(devices.hashedToken, hashed)).limit(1);
  if (!row || row.revokedAt) return null;
  // Liveness stamp — awaited (device auth is infrequent, so this is cheap, and not overlapping the next
  // query keeps a single-connection caller well-behaved) but error-tolerant: a failed stamp never fails auth.
  await db
    .update(devices)
    .set({ lastSeenAt: new Date() })
    .where(eq(devices.id, row.id))
    // eslint-disable-next-line no-console
    .catch((err) => console.warn(`[devices] lastSeenAt stamp failed for ${row.id}:`, err));
  return {
    id: row.id,
    name: row.name,
    ownerSubject: row.ownerSubject,
    credentialHash: row.hashedToken,
    connectionGrants: row.connectionGrants,
  };
}

export interface DeviceView {
  id: string;
  name: string;
  connectionGrants: string[];
  pushTransport: string | null;
  pairedAt: Date;
  lastSeenAt: Date | null;
  revokedAt: Date | null;
}

/** Secret-bearing delivery target used only by the control plane. It is never
 * returned by a public/device-list route. */
export interface CompanionPushTarget {
  id: string;
  pushTransport: string;
  pushToken: string;
}

/** The operator's ACTIVE devices (revoked ones are hidden — a revoke removes the device from the list, not
 *  just its token). The row is kept for token invalidation + audit, but the operator's list only shows live
 *  devices, so revoking one makes it disappear rather than lingering forever with no way to clear it. */
export async function listDevices(
  db: Db,
  ownerSubject: string = SELF_HOSTED_OPERATOR_SUBJECT,
): Promise<DeviceView[]> {
  if (usesHostedCredentials()) {
    return (await hostedCredentialStore()).listDevices(ownerSubject);
  }
  return db
    .select({
      id: devices.id,
      name: devices.name,
      connectionGrants: devices.connectionGrants,
      pushTransport: devices.pushTransport,
      pairedAt: devices.pairedAt,
      lastSeenAt: devices.lastSeenAt,
      revokedAt: devices.revokedAt,
    })
    .from(devices)
    .where(and(eq(devices.ownerSubject, ownerSubject), isNull(devices.revokedAt)))
    .orderBy(desc(devices.pairedAt));
}

const ACTIVE_SESSION_STATUSES = [
  'starting', 'logging_in', 'navigating', 'waiting_for_otp', 'extracting',
] as const;

export interface DeviceRevocation {
  revoked: boolean;
  sessionIds: string[];
}

/** Revoke both companion credentials and place every crawl bound to this
 * device behind the durable cancellation fence in the same transaction. */
export async function revokeDeviceAccess(
  db: Db,
  id: string,
  ownerSubject: string = SELF_HOSTED_OPERATOR_SUBJECT,
  credentialHash?: string,
): Promise<DeviceRevocation> {
  if (usesHostedCredentials()) {
    return (await hostedCredentialStore()).revokeDevice(
      id,
      ownerSubject,
      credentialHash,
    );
  }
  return db.transaction(async (tx) => {
    const [revoked] = await tx
      .update(devices)
      .set({ revokedAt: new Date() })
      .where(and(
        eq(devices.id, id),
        eq(devices.ownerSubject, ownerSubject),
        credentialHash ? eq(devices.hashedToken, credentialHash) : undefined,
        isNull(devices.revokedAt),
      ))
      .returning({ id: devices.id });
    if (!revoked) return { revoked: false, sessionIds: [] };
    await tx
      .update(apiKeys)
      .set({ revokedAt: new Date() })
      .where(and(eq(apiKeys.deviceId, id), isNull(apiKeys.revokedAt)));
    const fenced = await tx
      .update(sessions)
      .set({ status: 'cancelling' })
      .where(and(
        eq(sessions.tunnelDeviceId, id),
        inArray(sessions.status, [...ACTIVE_SESSION_STATUSES]),
      ))
      .returning({ id: sessions.id });
    return { revoked: true, sessionIds: fenced.map((row) => row.id) };
  });
}

export async function revokeDevice(
  db: Db,
  id: string,
  ownerSubject: string = SELF_HOSTED_OPERATOR_SUBJECT,
): Promise<boolean> {
  return (await revokeDeviceAccess(db, id, ownerSubject)).revoked;
}

/** The device registers/refreshes its push token after pairing so the control-plane can wake it for OTP. */
export async function updateDevicePush(
  db: Db,
  device: DeviceContext,
  pushTransport: string,
  pushToken: string,
): Promise<boolean> {
  if (usesHostedCredentials()) {
    return (await hostedCredentialStore()).updateDevicePush(
      device,
      pushTransport,
      pushToken,
    );
  }
  const updated = await db
    .update(devices)
    .set({ pushTransport, pushToken, lastSeenAt: new Date() })
    .where(and(
      eq(devices.id, device.id),
      eq(devices.ownerSubject, device.ownerSubject),
      eq(devices.hashedToken, device.credentialHash),
      isNull(devices.revokedAt),
    ))
    .returning({ id: devices.id });
  return updated.length > 0;
}

/**
 * How many devices could relay this connection's 2FA codes at all — active, owned, and holding a grant for
 * the connection. This is the same authorization the relay-status report is checked against, minus the push
 * registration: a phone with no push token can still be running and polling, so it counts. Used to decide
 * whether an armed OTP episode waits for a Companion or falls to the operator (see data/otp-readiness.ts).
 */
export async function countRelayAuthorizedDevices(
  db: Db,
  ownerSubject: string,
  connectionId: string,
): Promise<number> {
  if (usesHostedCredentials()) {
    return (await hostedCredentialStore()).countRelayAuthorizedDevices(
      ownerSubject,
      connectionId,
    );
  }
  const rows = await db
    .select({ connectionGrants: devices.connectionGrants })
    .from(devices)
    .where(and(
      eq(devices.ownerSubject, ownerSubject),
      isNull(devices.revokedAt),
    ));
  return rows.filter((row) => row.connectionGrants.includes(connectionId)).length;
}

/** Active push registrations whose immutable pairing grant includes this exact
 * connection. Tokens stay inside the control plane and are never projected
 * through DeviceView. */
export async function listCompanionPushTargets(
  db: Db,
  ownerSubject: string,
  connectionId: string,
  deviceId?: string,
): Promise<CompanionPushTarget[]> {
  if (usesHostedCredentials()) {
    return (await hostedCredentialStore()).listCompanionPushTargets(
      ownerSubject,
      connectionId,
      deviceId,
    );
  }
  const rows = await db
    .select({
      id: devices.id,
      connectionGrants: devices.connectionGrants,
      pushTransport: devices.pushTransport,
      pushToken: devices.pushToken,
    })
    .from(devices)
    .where(and(
      eq(devices.ownerSubject, ownerSubject),
      deviceId ? eq(devices.id, deviceId) : undefined,
      isNull(devices.revokedAt),
    ));
  return rows
    .filter((row) => (
      row.connectionGrants.includes(connectionId)
      && typeof row.pushTransport === 'string'
      && row.pushTransport.length > 0
      && typeof row.pushToken === 'string'
      && row.pushToken.length > 0
    ))
    .map((row) => ({
      id: row.id,
      pushTransport: row.pushTransport!,
      pushToken: row.pushToken!,
    }));
}

/** Clear a rejected registration only when it is still the exact generation
 * that failed. A concurrent token refresh must win. */
export async function clearDevicePushToken(
  db: Db,
  deviceId: string,
  ownerSubject: string,
  rejectedToken: string,
): Promise<boolean> {
  if (usesHostedCredentials()) {
    return (await hostedCredentialStore()).clearDevicePushToken(
      deviceId,
      ownerSubject,
      rejectedToken,
    );
  }
  const updated = await db
    .update(devices)
    .set({ pushTransport: null, pushToken: null })
    .where(and(
      eq(devices.id, deviceId),
      eq(devices.ownerSubject, ownerSubject),
      eq(devices.pushToken, rejectedToken),
      isNull(devices.revokedAt),
    ))
    .returning({ id: devices.id });
  return updated.length > 0;
}

/**
 * Pick the device a device-proxy tunnel should bind to: the newest non-revoked paired device, or null if
 * none. Mirrors the OTP "any paired device" precedent — one self-host operator, so the freshest live device
 * is the proxy. The caller (run-crawl / the awaiting-tunnel route) fails the crawl fast when this is null;
 * a device-proxy institution must never silently fall back to direct egress.
 */
export async function pickPairedDevice(
  db: Db,
  ownerSubject: string = SELF_HOSTED_OPERATOR_SUBJECT,
): Promise<{ id: string } | null> {
  if (usesHostedCredentials()) {
    return (await hostedCredentialStore()).pickDevice(ownerSubject);
  }
  const [row] = await db
    .select({ id: devices.id })
    .from(devices)
    .where(and(eq(devices.ownerSubject, ownerSubject), isNull(devices.revokedAt)))
    .orderBy(desc(devices.pairedAt))
    .limit(1);
  return row ?? null;
}

/** Select and bind the newest active device that is explicitly granted this
 * session's connection while holding its row lock. Device revocation takes the
 * same lock, closing the choose-then-revoke race. */
export async function bindPairedDeviceToSession(
  db: Db,
  sessionId: string,
  ownerSubject: string = SELF_HOSTED_OPERATOR_SUBJECT,
): Promise<{ id: string } | null> {
  const [session] = await db
    .select({ connectionId: sessions.connectionId })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  if (!session) return null;
  const candidates = await db
    .select({
      id: devices.id,
      connectionGrants: devices.connectionGrants,
    })
    .from(devices)
    .where(and(
      eq(devices.ownerSubject, ownerSubject),
      isNull(devices.revokedAt),
    ))
    .orderBy(desc(devices.pairedAt));
  const selected = candidates.find(
    (candidate) => candidate.connectionGrants.includes(session.connectionId),
  );
  if (!selected) return null;
  return db.transaction(async (tx) => {
    const [device] = await tx
      .select({
        id: devices.id,
        connectionGrants: devices.connectionGrants,
      })
      .from(devices)
      .where(and(
        eq(devices.id, selected.id),
        eq(devices.ownerSubject, ownerSubject),
        isNull(devices.revokedAt),
      ))
      .limit(1)
      .for('update');
    if (!device) return null;
    if (!device.connectionGrants.includes(session.connectionId)) return null;
    const [bound] = await tx
      .update(sessions)
      .set({ tunnelRequested: true, tunnelDeviceId: device.id })
      .where(eq(sessions.id, sessionId))
      .returning({ id: sessions.id });
    return bound ? device : null;
  });
}

/** A granted connection that has the device proxy enabled, labelled the way the companion labels crawls
 *  (nickname when set, else the institution name). */
export interface DeviceProxyConnection {
  id: string;
  label: string;
}

/**
 * The subset of a device's granted connections that currently have `useDeviceProxy` enabled — the
 * companion's signal for whether its device-proxy watch service needs to run at all. A pairing with none
 * (including every pairing on a deployment that keeps its records elsewhere: the device proxy needs the
 * database this deployment runs, mirroring
 * the awaiting-tunnel route's early return) runs no standing service and shows no standing notification.
 */
export async function listDeviceProxyConnections(
  db: Db,
  device: DeviceContext,
): Promise<DeviceProxyConnection[]> {
  if (usesHostedCredentials()) return [];
  if (device.connectionGrants.length === 0) return [];
  const rows = await db
    .select({
      id: connections.id,
      nickname: connections.nickname,
      institutionName: institutions.name,
    })
    .from(connections)
    .innerJoin(institutions, eq(connections.institutionId, institutions.id))
    .where(and(
      inArray(connections.id, device.connectionGrants),
      eq(connections.ownerSubject, device.ownerSubject),
      // The device-proxy opt-in lives on the institution recipe ("this bank needs a residential
      // IP"), so a connection routes through the phone iff its institution says so.
      eq(institutions.useDeviceProxy, true),
    ));
  return rows.map((row) => ({
    id: row.id,
    label: row.nickname?.trim() || row.institutionName,
  }));
}
