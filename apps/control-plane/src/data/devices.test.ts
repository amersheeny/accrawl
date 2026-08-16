import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import type { Db } from '../db/client';
import {
  clearDevicePushToken, generateDeviceToken, hashDeviceToken,
  listCompanionPushTargets, listDevices, pairDevice, revokeDevice,
  updateDevicePush, verifyDeviceToken,
} from './devices';

describe('devices — pure', () => {
  it('generates a prefixed token with a stable 64-hex hash', () => {
    const { plaintext, hashedToken } = generateDeviceToken();
    expect(plaintext.startsWith('acdv_')).toBe(true);
    expect(hashedToken).toBe(hashDeviceToken(plaintext));
    expect(hashedToken).toHaveLength(64);
    expect(generateDeviceToken().plaintext).not.toBe(plaintext);
  });
});

describe('devices — persisted (pglite)', () => {
  let client: PGlite;
  let db: Db;

  beforeAll(async () => {
    client = new PGlite();
    db = drizzle(client, { schema }) as unknown as Db;
    const dir = path.resolve(__dirname, '../../migrations');
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
      await client.exec(fs.readFileSync(path.join(dir, f), 'utf8'));
    }
  });
  afterAll(async () => { await client.close(); });

  it('pairs a device, returns the plaintext once, and verifies it back', async () => {
    const { id, plaintext } = await pairDevice(db, { name: 'Pixel' });
    const ctx = await verifyDeviceToken(db, plaintext);
    expect(ctx?.id).toBe(id);
    expect(ctx?.name).toBe('Pixel');
    // only the hash is stored
    const [row] = await db.select().from(schema.devices).where(eq(schema.devices.id, id));
    expect(row.hashedToken).toBe(hashDeviceToken(plaintext));
    expect(row.hashedToken).not.toContain(plaintext);
  });

  it('rejects an unknown, non-prefixed, or revoked token', async () => {
    expect(await verifyDeviceToken(db, 'acdv_nope')).toBeNull();
    expect(await verifyDeviceToken(db, 'not-a-token')).toBeNull();
    const { id, plaintext } = await pairDevice(db, { name: 'Temp' });
    await revokeDevice(db, id);
    expect(await verifyDeviceToken(db, plaintext)).toBeNull();
  });

  it('lists devices (secret-free) and updates the push token', async () => {
    const { id, plaintext } = await pairDevice(db, { name: 'WithPush' });
    const device = await verifyDeviceToken(db, plaintext);
    if (!device) throw new Error('paired device did not authenticate');
    expect(await updateDevicePush(db, device, 'fcm', 'fcm-token-123')).toBe(true);
    const found = (await listDevices(db)).find((d) => d.id === id);
    expect(found?.pushTransport).toBe('fcm');
    // the listed view must not include the hashed token
    expect(JSON.stringify(found)).not.toContain('hashedToken');
    expect(JSON.stringify(found)).not.toContain('fcm-token-123'); // push TOKEN is not exposed in the view

    await db
      .update(schema.devices)
      .set({ hashedToken: 'rotated-device-token-hash' })
      .where(eq(schema.devices.id, id));
    expect(await updateDevicePush(db, device, 'fcm', 'superseded-token')).toBe(false);
  });

  it('drops a revoked device from the operator list (revoke removes it, not just its token)', async () => {
    const { id } = await pairDevice(db, { name: 'ToRemove' });
    expect((await listDevices(db)).some((d) => d.id === id)).toBe(true); // listed while active
    expect(await revokeDevice(db, id)).toBe(true);
    expect((await listDevices(db)).some((d) => d.id === id)).toBe(false); // gone after revoke — no lingering row
  });

  it('returns push targets only for active devices explicitly granted the connection', async () => {
    const granted = await pairDevice(db, {
      name: 'Granted', connectionGrants: ['connection-a'],
      pushTransport: 'fcm', pushToken: 'granted-token',
    }, 'account-user:owner');
    await pairDevice(db, {
      name: 'Other connection', connectionGrants: ['connection-b'],
      pushTransport: 'fcm', pushToken: 'wrong-grant-token',
    }, 'account-user:owner');
    await pairDevice(db, {
      name: 'Other owner', connectionGrants: ['connection-a'],
      pushTransport: 'fcm', pushToken: 'wrong-owner-token',
    }, 'account-user:other');
    const revoked = await pairDevice(db, {
      name: 'Revoked', connectionGrants: ['connection-a'],
      pushTransport: 'fcm', pushToken: 'revoked-token',
    }, 'account-user:owner');
    await revokeDevice(db, revoked.id, 'account-user:owner');

    expect(await listCompanionPushTargets(
      db, 'account-user:owner', 'connection-a',
    )).toEqual([{
      id: granted.id,
      pushTransport: 'fcm',
      pushToken: 'granted-token',
    }]);
  });

  it('clears an invalid push token only when it is still the rejected generation', async () => {
    const owner = 'account-user:refresh-owner';
    const paired = await pairDevice(db, {
      name: 'Refresh race', connectionGrants: ['connection-a'],
      pushTransport: 'fcm', pushToken: 'old-token',
    }, owner);
    expect(await clearDevicePushToken(
      db, paired.id, owner, 'old-token',
    )).toBe(true);
    expect(await listCompanionPushTargets(
      db, owner, 'connection-a',
    )).toEqual([]);

    const device = await verifyDeviceToken(db, paired.plaintext);
    if (!device) throw new Error('paired device did not authenticate');
    await updateDevicePush(db, device, 'fcm', 'new-token');
    expect(await clearDevicePushToken(
      db, paired.id, owner, 'old-token',
    )).toBe(false);
    expect((await listCompanionPushTargets(
      db, owner, 'connection-a',
    ))[0]?.pushToken).toBe('new-token');
  });
});
