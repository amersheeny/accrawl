import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import type { ApiKeyContext } from '../auth/apiKeys';
import type { Db } from '../db/client';
import { revokeDeviceAccess } from './devices';
import { listCompanionAccounts, listCompanionTransactions } from './companion-data';

describe('companion financial data (pglite)', () => {
  let client: PGlite;
  let db: Db;
  let grantedConnectionId: string;
  let excludedConnectionId: string;
  let grantedAccountIds: string[];
  let activeCredential: ApiKeyContext;

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
    await client.exec('truncate devices cascade');
    await client.exec(
      `insert into institutions (id, name, login_url, canonical_domain, type)
       values ('bank', 'Example Bank', 'https://bank.example', 'bank.example', 'bank')`,
    );
    const granted = await client.query<{ id: string }>(
      `insert into connections (owner_subject, institution_id, username_ct, password_ct, nickname)
       values ('owner:a', 'bank', 'u', 'p', 'Everyday') returning id`,
    );
    const excluded = await client.query<{ id: string }>(
      `insert into connections (owner_subject, institution_id, username_ct, password_ct, nickname)
       values ('owner:a', 'bank', 'u', 'p', 'Savings') returning id`,
    );
    const foreign = await client.query<{ id: string }>(
      `insert into connections (owner_subject, institution_id, username_ct, password_ct)
       values ('owner:b', 'bank', 'u', 'p') returning id`,
    );
    grantedConnectionId = granted.rows[0].id;
    excludedConnectionId = excluded.rows[0].id;
    const [device] = await db
      .insert(schema.devices)
      .values({
        ownerSubject: 'owner:a',
        name: 'Pixel',
        hashedToken: 'device-token-hash',
        connectionGrants: [grantedConnectionId],
      })
      .returning({ id: schema.devices.id });
    const [key] = await db
      .insert(schema.apiKeys)
      .values({
        ownerSubject: 'owner:a',
        name: 'Pixel companion data',
        hashedKey: 'financial-key-hash',
        scopes: ['read:companion'],
        connectionGrants: [grantedConnectionId],
        deviceId: device.id,
      })
      .returning({ id: schema.apiKeys.id });
    activeCredential = {
      id: key.id,
      ownerSubject: 'owner:a',
      deviceId: device.id,
      oauthGrantId: null,
      credentialHash: 'financial-key-hash',
      scopes: ['read:companion'],
      connectionGrants: [grantedConnectionId],
    };
    grantedAccountIds = [];
    for (let index = 0; index < 3; index++) {
      const id = `account-granted-${index}`;
      grantedAccountIds.push(id);
      await db.insert(schema.accounts).values({
        id,
        connectionId: grantedConnectionId,
        data: {
          providerAccountId: `provider-${index}`,
          name: `Account ${index}`,
          description: '',
          currency: 'GBP',
          type: index === 0 ? 'credit_card' : 'current',
          balance: index === 0 ? -123.45 : 100 + index,
        },
        missingSinceCrawlCount: index === 2 ? 2 : 0,
        lastSeenAt: new Date(`2030-01-0${index + 1}T12:00:00.000Z`),
      });
    }
    await db.insert(schema.accounts).values([
      {
        id: 'excluded-account',
        connectionId: excludedConnectionId,
        data: {
          providerAccountId: 'excluded',
          name: 'Excluded',
          description: '',
          currency: 'GBP',
          type: 'current',
          balance: 999,
        },
      },
      {
        id: 'foreign-account',
        connectionId: foreign.rows[0].id,
        data: {
          providerAccountId: 'foreign',
          name: 'Foreign',
          description: '',
          currency: 'GBP',
          type: 'current',
          balance: 999,
        },
      },
    ]);

    const duplicateLike = {
      providerAccountId: 'provider-0',
      bookingDate: '2030-02-03',
      amount: -12.34,
      currency: 'GBP',
      merchant: 'Cafe',
      description: 'Coffee',
      isPending: false,
    };
    await db.insert(schema.transactions).values([
      { id: 'tx-a', connectionId: grantedConnectionId, data: { ...duplicateLike, providerTransactionId: 'bank-a' } },
      { id: 'tx-b', connectionId: grantedConnectionId, data: { ...duplicateLike, providerTransactionId: 'bank-b' } },
      {
        id: 'tx-unassigned',
        connectionId: grantedConnectionId,
        data: {
          bookingDate: '2030-02-02',
          amount: 50,
          currency: 'GBP',
          description: 'Unassigned',
          isPending: true,
        },
      },
      {
        id: 'tx-excluded',
        connectionId: excludedConnectionId,
        data: {
          providerAccountId: 'excluded',
          bookingDate: '2030-02-04',
          amount: 999,
          currency: 'GBP',
          description: 'Excluded',
          isPending: false,
        },
      },
    ]);
  });

  const credential = (): ApiKeyContext => ({ ...activeCredential });

  it('paginates every granted account without leaking another connection and preserves balance state', async () => {
    const first = await listCompanionAccounts(db, credential(), 2);
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toBeTruthy();
    const second = await listCompanionAccounts(db, credential(), 2, first.nextCursor!);
    expect([...first.items, ...second.items].map((account) => account.id))
      .toEqual(grantedAccountIds);
    expect(JSON.stringify([...first.items, ...second.items])).not.toContain('Excluded');
    expect(first.items[0].balance.current).toBe(-123.45);
    expect(second.items[0].status).toBe('inactive');
  });

  it('keeps genuinely separate same-date/amount/merchant transactions and includes unassigned records', async () => {
    const first = await listCompanionTransactions(db, credential(), 2);
    const second = await listCompanionTransactions(db, credential(), 2, first.nextCursor!);
    const all = [...first.items, ...second.items];
    expect(all.map((transaction) => transaction.id)).toEqual([
      'tx-a',
      'tx-b',
      'tx-unassigned',
    ]);
    expect(all.filter((transaction) => transaction.merchant === 'Cafe')).toHaveLength(2);
    expect(all.find((transaction) => transaction.id === 'tx-unassigned')?.accountId)
      .toBeNull();
    expect(JSON.stringify(all)).not.toContain('tx-excluded');
  });

  it('limits account transaction pages to the exact canonical account', async () => {
    const page = await listCompanionTransactions(
      db,
      credential(),
      10,
      undefined,
      grantedAccountIds[0],
    );
    expect(page.items.map((transaction) => transaction.id)).toEqual(['tx-a', 'tx-b']);
    await expect(listCompanionTransactions(
      db,
      credential(),
      10,
      undefined,
      'excluded-account',
    )).rejects.toThrow('account not found');
  });

  it('rejects widened or malformed companion credentials', async () => {
    await db
      .update(schema.apiKeys)
      .set({ connectionGrants: ['*'] })
      .where(eq(schema.apiKeys.id, activeCredential.id));
    await expect(listCompanionAccounts(
      db,
      credential(),
      10,
    )).rejects.toThrow('invalid companion credential');
    await db
      .update(schema.apiKeys)
      .set({ connectionGrants: [grantedConnectionId], scopes: ['read:data'] })
      .where(eq(schema.apiKeys.id, activeCredential.id));
    await expect(listCompanionAccounts(
      db,
      credential(),
      10,
    )).rejects.toThrow('invalid companion credential');
  });

  it('rejects a cached credential immediately after its paired device is revoked', async () => {
    expect((await listCompanionAccounts(db, credential(), 10)).items).toHaveLength(3);
    expect((await revokeDeviceAccess(db, activeCredential.deviceId!, 'owner:a')).revoked)
      .toBe(true);
    await expect(listCompanionAccounts(db, credential(), 10))
      .rejects.toThrow('invalid companion credential');
    await expect(listCompanionTransactions(db, credential(), 10))
      .rejects.toThrow('invalid companion credential');
  });
});
