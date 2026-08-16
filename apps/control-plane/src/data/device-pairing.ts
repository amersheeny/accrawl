import { createHash, randomBytes, randomInt } from 'node:crypto';
import { and, eq, inArray, isNull, lt } from 'drizzle-orm';
import type { Db } from '../db/client';
import {
  apiKeys, connections, devicePairingIntents, devices,
} from '../db/schema';
import { createApiKey, generateApiKey } from '../auth/apiKeys';
import { generateDeviceToken } from './devices';
import {
  hostedPairingStore,
  usesHostedPairingStore,
} from './device-pairing-store';

const PAIRING_PREFIX = 'acpair_';
const CLAIM_PREFIX = 'acclaim_';
const PAIRING_LIFETIME_MS = 5 * 60 * 1000;

function hashSecret(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function generatePairingCode(): string {
  return PAIRING_PREFIX + randomBytes(32).toString('base64url');
}

export function generatePairingClaim(): string {
  return CLAIM_PREFIX + randomBytes(32).toString('base64url');
}

function verificationCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0');
}

export interface PairingIntentView {
  id: string;
  name: string;
  connectionGrants: string[];
  expiresAt: Date;
  verificationCode: string | null;
  status: 'waiting_for_phone' | 'waiting_for_approval' | 'approved' | 'expired' | 'used' | 'cancelled';
}

function pairingStatus(row: {
  expiresAt: Date;
  claimHash: string | null;
  approvedAt: Date | null;
  consumedAt: Date | null;
  cancelledAt: Date | null;
}, now: Date): PairingIntentView['status'] {
  if (row.cancelledAt) return 'cancelled';
  if (row.consumedAt) return 'used';
  if (row.expiresAt.getTime() <= now.getTime()) return 'expired';
  if (row.approvedAt) return 'approved';
  if (row.claimHash) return 'waiting_for_approval';
  return 'waiting_for_phone';
}

/** Create a request only after proving every exact grant is still owned. */
export async function createPairingIntent(
  db: Db,
  input: { name: string; connectionGrants: string[] },
  ownerSubject: string,
  now: Date = new Date(),
): Promise<{ intent: PairingIntentView; pairingCode: string }> {
  const grants = [...new Set(input.connectionGrants)];
  if (grants.length !== input.connectionGrants.length || grants.includes('*')) {
    throw new Error('pairing requires unique, exact connection grants');
  }
  if (usesHostedPairingStore()) {
    const pairingCode = generatePairingCode();
    const expiresAt = new Date(now.getTime() + PAIRING_LIFETIME_MS);
    const intent = await (await hostedPairingStore()).createIntent({
      ownerSubject,
      name: input.name,
      connectionGrants: grants,
      codeHash: hashSecret(pairingCode),
      expiresAt,
      now,
    });
    return { pairingCode, intent };
  }
  return db.transaction(async (tx) => {
    const owned = grants.length === 0
      ? []
      : await tx
        .select({ id: connections.id })
        .from(connections)
        .where(and(
          eq(connections.ownerSubject, ownerSubject),
          inArray(connections.id, grants),
        ));
    if (owned.length !== grants.length) throw new Error('one or more connection grants are unavailable');

    await tx.delete(devicePairingIntents).where(and(
      eq(devicePairingIntents.ownerSubject, ownerSubject),
      lt(devicePairingIntents.expiresAt, now),
    ));
    const pairingCode = generatePairingCode();
    const expiresAt = new Date(now.getTime() + PAIRING_LIFETIME_MS);
    const [row] = await tx
      .insert(devicePairingIntents)
      .values({
        ownerSubject,
        name: input.name,
        connectionGrants: grants,
        codeHash: hashSecret(pairingCode),
        expiresAt,
      })
      .returning();
    return {
      pairingCode,
      intent: {
        id: row.id,
        name: row.name,
        connectionGrants: row.connectionGrants,
        expiresAt: row.expiresAt,
        verificationCode: null,
        status: 'waiting_for_phone',
      },
    };
  });
}

export async function getPairingIntent(
  db: Db,
  id: string,
  ownerSubject: string,
  now: Date = new Date(),
): Promise<PairingIntentView | null> {
  if (usesHostedPairingStore()) {
    return (await hostedPairingStore()).getIntent(
      id,
      ownerSubject,
      now,
    );
  }
  const [row] = await db
    .select()
    .from(devicePairingIntents)
    .where(and(
      eq(devicePairingIntents.id, id),
      eq(devicePairingIntents.ownerSubject, ownerSubject),
    ))
    .limit(1);
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    connectionGrants: row.connectionGrants,
    expiresAt: row.expiresAt,
    verificationCode: row.claimHash ? row.verificationCode : null,
    status: pairingStatus(row, now),
  };
}

export async function claimPairingIntent(
  db: Db,
  pairingCode: string,
  claim: string,
  now: Date = new Date(),
): Promise<{ status: PairingIntentView['status']; verificationCode?: string }> {
  const codeHash = hashSecret(pairingCode);
  const claimHash = hashSecret(claim);
  if (usesHostedPairingStore()) {
    return (await hostedPairingStore()).claimIntent({
      codeHash,
      claimHash,
      verificationCode: verificationCode(),
      now,
    });
  }
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(devicePairingIntents)
      .where(eq(devicePairingIntents.codeHash, codeHash))
      .limit(1)
      .for('update');
    if (!row) return { status: 'expired' };
    const status = pairingStatus(row, now);
    if (status !== 'waiting_for_phone' && row.claimHash !== claimHash) return { status };
    if (row.claimHash === claimHash && row.verificationCode) {
      return { status, verificationCode: row.verificationCode };
    }
    if (status !== 'waiting_for_phone') return { status };
    const code = verificationCode();
    await tx
      .update(devicePairingIntents)
      .set({ claimHash, verificationCode: code })
      .where(and(
        eq(devicePairingIntents.id, row.id),
        isNull(devicePairingIntents.claimHash),
      ));
    return { status: 'waiting_for_approval', verificationCode: code };
  });
}

export async function approvePairingIntent(
  db: Db,
  id: string,
  ownerSubject: string,
  now: Date = new Date(),
): Promise<PairingIntentView['status'] | null> {
  if (usesHostedPairingStore()) {
    return (await hostedPairingStore()).approveIntent(
      id,
      ownerSubject,
      now,
    );
  }
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(devicePairingIntents)
      .where(and(
        eq(devicePairingIntents.id, id),
        eq(devicePairingIntents.ownerSubject, ownerSubject),
      ))
      .limit(1)
      .for('update');
    if (!row) return null;
    const status = pairingStatus(row, now);
    if (status !== 'waiting_for_approval') return status;
    await tx
      .update(devicePairingIntents)
      .set({ approvedAt: now })
      .where(eq(devicePairingIntents.id, id));
    return 'approved';
  });
}

export async function cancelPairingIntent(
  db: Db,
  id: string,
  ownerSubject: string,
  now: Date = new Date(),
): Promise<boolean> {
  if (usesHostedPairingStore()) {
    return (await hostedPairingStore()).cancelIntent(
      id,
      ownerSubject,
      now,
    );
  }
  const rows = await db
    .update(devicePairingIntents)
    .set({ cancelledAt: now })
    .where(and(
      eq(devicePairingIntents.id, id),
      eq(devicePairingIntents.ownerSubject, ownerSubject),
      isNull(devicePairingIntents.consumedAt),
      isNull(devicePairingIntents.cancelledAt),
    ))
    .returning({ id: devicePairingIntents.id });
  return rows.length > 0;
}

export type PairingCompletion =
  | { status: 'waiting_for_approval' | 'expired' | 'used' | 'cancelled' }
  | { status: 'paired'; deviceId: string; deviceToken: string; financialToken: string };

/** Consume an approved request and mint both linked credentials atomically. */
export async function completePairingIntent(
  db: Db,
  pairingCode: string,
  claim: string,
  now: Date = new Date(),
): Promise<PairingCompletion> {
  const codeHash = hashSecret(pairingCode);
  const claimHash = hashSecret(claim);
  if (usesHostedPairingStore()) {
    const relay = generateDeviceToken();
    const financial = generateApiKey();
    return (await hostedPairingStore()).completeIntent({
      codeHash,
      claimHash,
      credentials: {
        deviceToken: relay.plaintext,
        hashedDeviceToken: relay.hashedToken,
        financialToken: financial.plaintext,
        hashedFinancialToken: financial.hashedKey,
      },
      now,
    });
  }
  return db.transaction(async (tx) => {
    const [intent] = await tx
      .select()
      .from(devicePairingIntents)
      .where(eq(devicePairingIntents.codeHash, codeHash))
      .limit(1)
      .for('update');
    if (!intent || intent.claimHash !== claimHash) return { status: 'expired' };
    // Completing a pairing happens once. It used to be repeatable while the intent lived, so that a phone
    // whose response was lost could ask again — but asking again did not return what it had been given,
    // it issued a new relay token and a new financial key and replaced both. Anyone holding the code and
    // the claim could therefore do it too, as often as they liked until the intent expired, and each time
    // they were handed working credentials while the phone that actually paired was cut off without
    // anything telling it why.
    //
    // A phone that loses its response now pairs again from the console, which takes seconds and is the
    // same flow it already used. Returning the first result instead of reissuing would keep that recovery
    // and is the better answer; it means holding the issued credentials somewhere until the intent
    // expires, which this product deliberately does not do today — it keeps only their hashes.
    if (intent.consumedAt) return { status: 'used' };
    const status = pairingStatus(intent, now);
    if (status !== 'approved') {
      return { status: status === 'waiting_for_phone' ? 'waiting_for_approval' : status };
    }
    const owned = intent.connectionGrants.length === 0
      ? []
      : await tx
        .select({ id: connections.id })
        .from(connections)
        .where(and(
          eq(connections.ownerSubject, intent.ownerSubject),
          inArray(connections.id, intent.connectionGrants),
        ));
    if (owned.length !== intent.connectionGrants.length) return { status: 'cancelled' };

    const relay = generateDeviceToken();
    const [device] = await tx
      .insert(devices)
      .values({
        ownerSubject: intent.ownerSubject,
        name: intent.name,
        hashedToken: relay.hashedToken,
        connectionGrants: intent.connectionGrants,
      })
      .returning({ id: devices.id });
    const financial = await createApiKey(tx, {
      name: `${intent.name} companion data`,
      ownerSubject: intent.ownerSubject,
      scopes: ['read:companion'],
      connectionGrants: intent.connectionGrants,
      deviceId: device.id,
    });
    await tx
      .update(devicePairingIntents)
      .set({ consumedAt: now, deviceId: device.id })
      .where(eq(devicePairingIntents.id, intent.id));
    return {
      status: 'paired',
      deviceId: device.id,
      deviceToken: relay.plaintext,
      financialToken: financial.plaintext,
    };
  });
}
