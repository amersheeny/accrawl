import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import type { Db } from '../db/client';
import { refreshApiKeyContext, verifyApiKey } from '../auth/apiKeys';
import { refreshDeviceContext, verifyDeviceToken, revokeDeviceAccess } from './devices';
import {
  approvePairingIntent,
  cancelPairingIntent,
  claimPairingIntent,
  completePairingIntent,
  createPairingIntent,
  generatePairingClaim,
  getPairingIntent,
} from './device-pairing';

describe('companion pairing intents (pglite)', () => {
  let client: PGlite;
  let db: Db;
  let ownedConnectionId: string;
  let otherOwnerConnectionId: string;

  beforeAll(async () => {
    client = new PGlite();
    db = drizzle(client, { schema }) as unknown as Db;
    const directory = path.resolve(__dirname, '../../migrations');
    for (const file of fs.readdirSync(directory).filter((name) => name.endsWith('.sql')).sort()) {
      await client.exec(fs.readFileSync(path.join(directory, file), 'utf8'));
    }
  });

  afterAll(async () => {
    await client.close();
  });

  beforeEach(async () => {
    await client.exec('truncate institutions cascade');
    await client.exec('truncate device_pairing_intents, devices cascade');
    await client.exec(
      `insert into institutions (id, name, login_url, canonical_domain, type)
       values ('bank', 'Bank', 'https://bank.example', 'bank.example', 'bank')`,
    );
    const owned = await client.query<{ id: string }>(
      `insert into connections (owner_subject, institution_id, username_ct, password_ct)
       values ('owner:a', 'bank', 'u', 'p') returning id`,
    );
    const foreign = await client.query<{ id: string }>(
      `insert into connections (owner_subject, institution_id, username_ct, password_ct)
       values ('owner:b', 'bank', 'u', 'p') returning id`,
    );
    ownedConnectionId = owned.rows[0].id;
    otherOwnerConnectionId = foreign.rows[0].id;
  });

  it('stores only hashes, requires a matching phone claim and approval, then recovers a lost completion response without duplicating authority', async () => {
    const created = await createPairingIntent(
      db,
      { name: 'Pixel', connectionGrants: [ownedConnectionId] },
      'owner:a',
    );
    const [storedBeforeClaim] = await db
      .select()
      .from(schema.devicePairingIntents)
      .where(eq(schema.devicePairingIntents.id, created.intent.id));
    expect(storedBeforeClaim.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(storedBeforeClaim)).not.toContain(created.pairingCode);

    const claim = generatePairingClaim();
    const claimed = await claimPairingIntent(db, created.pairingCode, claim);
    expect(claimed.status).toBe('waiting_for_approval');
    expect(claimed.verificationCode).toMatch(/^\d{6}$/);
    expect(await claimPairingIntent(db, created.pairingCode, claim)).toEqual(claimed);

    const competing = await claimPairingIntent(
      db,
      created.pairingCode,
      generatePairingClaim(),
    );
    expect(competing.status).toBe('waiting_for_approval');
    expect(competing.verificationCode).toBeUndefined();
    expect((await completePairingIntent(db, created.pairingCode, claim)).status)
      .toBe('waiting_for_approval');

    expect(await approvePairingIntent(db, created.intent.id, 'owner:b')).toBeNull();
    expect(await approvePairingIntent(db, created.intent.id, 'owner:a')).toBe('approved');
    const completion = await completePairingIntent(db, created.pairingCode, claim);
    expect(completion.status).toBe('paired');
    if (completion.status !== 'paired') throw new Error('pairing did not complete');

    const device = await verifyDeviceToken(db, completion.deviceToken);
    expect(device?.connectionGrants).toEqual([ownedConnectionId]);
    const financial = await verifyApiKey(db, completion.financialToken);
    expect(financial).toMatchObject({
      ownerSubject: 'owner:a',
      deviceId: completion.deviceId,
      scopes: ['read:companion'],
      connectionGrants: [ownedConnectionId],
    });
    // Completing again is refused, and it takes nothing away from the phone that paired. This used to
    // issue a second set of credentials and invalidate the first, so anyone holding the code and the
    // claim could help themselves and cut the real phone off, repeatedly, until the intent expired.
    const replay = await completePairingIntent(db, created.pairingCode, claim);
    expect(replay.status).toBe('used');
    expect(replay).not.toHaveProperty('deviceToken');
    expect(replay).not.toHaveProperty('financialToken');
    // The credentials the phone is actually holding still work.
    expect(await verifyDeviceToken(db, completion.deviceToken)).not.toBeNull();
    expect(await verifyApiKey(db, completion.financialToken)).not.toBeNull();
    if (!device || !financial) throw new Error('issued credentials did not authenticate');
    // Its sessions keep working too. The refused replay changed nothing about the paired phone, which is
    // the point: a stranger completing again used to invalidate exactly these.
    expect(await refreshDeviceContext(db, device)).not.toBeNull();
    expect(await refreshApiKeyContext(db, financial)).not.toBeNull();
    expect((await completePairingIntent(
      db,
      created.pairingCode,
      generatePairingClaim(),
    )).status).toBe('expired');
    expect(await verifyDeviceToken(db, completion.deviceToken)).not.toBeNull();
    expect(await verifyApiKey(db, completion.financialToken)).not.toBeNull();
    // One device and one key, because completing again never made a second set.
    expect(await db.select({ id: schema.devices.id }).from(schema.devices)).toHaveLength(1);
    expect(await db.select({ id: schema.apiKeys.id }).from(schema.apiKeys)).toHaveLength(1);

    const revocation = await revokeDeviceAccess(db, completion.deviceId, 'owner:a');
    expect(revocation.revoked).toBe(true);
    expect(await verifyDeviceToken(db, completion.deviceToken)).toBeNull();
    expect(await verifyApiKey(db, completion.financialToken)).toBeNull();
    expect((await completePairingIntent(db, created.pairingCode, claim)).status).toBe('used');
  });

  it('rejects wildcard, duplicate, and foreign grants instead of widening access', async () => {
    await expect(createPairingIntent(
      db,
      { name: 'Pixel', connectionGrants: ['*'] },
      'owner:a',
    )).rejects.toThrow(/unique, exact/);
    await expect(createPairingIntent(
      db,
      { name: 'Pixel', connectionGrants: [ownedConnectionId, ownedConnectionId] },
      'owner:a',
    )).rejects.toThrow(/unique, exact/);
    await expect(createPairingIntent(
      db,
      { name: 'Pixel', connectionGrants: [otherOwnerConnectionId] },
      'owner:a',
    )).rejects.toThrow(/unavailable/);
  });

  it('does not complete expired or cancelled requests', async () => {
    const now = new Date('2030-01-01T00:00:00.000Z');
    const expired = await createPairingIntent(
      db,
      { name: 'Old phone', connectionGrants: [ownedConnectionId] },
      'owner:a',
      now,
    );
    const later = new Date(now.getTime() + 6 * 60_000);
    expect((await claimPairingIntent(
      db,
      expired.pairingCode,
      generatePairingClaim(),
      later,
    )).status).toBe('expired');
    expect((await getPairingIntent(db, expired.intent.id, 'owner:a', later))?.status)
      .toBe('expired');

    const active = await createPairingIntent(
      db,
      { name: 'Cancelled phone', connectionGrants: [ownedConnectionId] },
      'owner:a',
      later,
    );
    const claim = generatePairingClaim();
    await claimPairingIntent(db, active.pairingCode, claim, later);
    expect(await cancelPairingIntent(db, active.intent.id, 'owner:a', later)).toBe(true);
    expect((await completePairingIntent(db, active.pairingCode, claim, later)).status)
      .toBe('cancelled');
  });

  it('does not rotate issued credentials after the original request expires', async () => {
    const now = new Date('2030-01-01T00:00:00.000Z');
    const created = await createPairingIntent(
      db,
      { name: 'Pixel', connectionGrants: [ownedConnectionId] },
      'owner:a',
      now,
    );
    const claim = generatePairingClaim();
    await claimPairingIntent(db, created.pairingCode, claim, now);
    await approvePairingIntent(db, created.intent.id, 'owner:a', now);
    const completion = await completePairingIntent(db, created.pairingCode, claim, now);
    expect(completion.status).toBe('paired');
    if (completion.status !== 'paired') throw new Error('pairing did not complete');

    const expired = new Date(now.getTime() + 6 * 60_000);
    expect((await completePairingIntent(
      db,
      created.pairingCode,
      claim,
      expired,
    )).status).toBe('used');
    expect(await verifyDeviceToken(db, completion.deviceToken)).not.toBeNull();
    expect(await verifyApiKey(db, completion.financialToken)).not.toBeNull();
  });
});
