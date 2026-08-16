import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import type { Db } from '../db/client';
import * as schema from '../db/schema';
import {
  activateOrganizationProvisioning,
  createOrganization,
  listOrganizationSharedBalances,
  listOrganizationSharedConnections,
  organizationCanAccessConnection,
  replaceOrganizationShare,
  revokeOrganizationShare,
  setOrganizationDisabled,
} from './organization-shares';

describe('user-to-organisation sharing', () => {
  let client: PGlite;
  let db: Db;

  beforeAll(async () => {
    client = new PGlite();
    db = drizzle(client, { schema }) as unknown as Db;
    const dir = path.resolve(__dirname, '../../migrations');
    for (const file of fs.readdirSync(dir).filter((name) => name.endsWith('.sql')).sort()) {
      await client.exec(fs.readFileSync(path.join(dir, file), 'utf8'));
    }
  });

  afterAll(async () => client.close());

  beforeEach(async () => {
    await client.exec('truncate institutions cascade');
    await client.exec('truncate organizations cascade');
    await client.exec(`
      insert into institutions (id, name, login_url, canonical_domain, type)
      values ('bank', 'Example Bank', 'https://bank.example', 'bank.example', 'bank')
    `);
  });

  async function connection(ownerSubject: string, nickname: string): Promise<string> {
    const row = await client.query<{ id: string }>(`
      insert into connections (owner_subject, institution_id, username_ct, password_ct, nickname)
      values ($1, 'bank', 'u', 'p', $2)
      returning id
    `, [ownerSubject, nickname]);
    return row.rows[0].id;
  }

  async function account(connectionId: string, id: string, balance: number): Promise<void> {
    await client.query(`
      insert into accounts (id, connection_id, data)
      values ($1, $2, $3)
    `, [
      id,
      connectionId,
      JSON.stringify({
        providerAccountId: id,
        name: `${id} account`,
        description: '',
        currency: 'GBP',
        type: 'current',
        balance,
      }),
    ]);
  }

  it('requires exact user-owned connections and never expands a grant to later connections', async () => {
    const alice = await connection('user:alice', 'Alice current');
    const bob = await connection('user:bob', 'Bob current');
    await account(alice, 'alice-account', 125);
    await account(bob, 'bob-account', 999);
    await createOrganization(db, { id: 'tenant-one', name: 'Tenant One' });

    await expect(replaceOrganizationShare(db, {
      ownerSubject: 'user:alice',
      ownerEmail: 'alice@example.com',
      organizationId: 'tenant-one',
      scopes: ['balances'],
      connectionGrants: [bob],
      expiresAt: new Date(Date.now() + 86_400_000),
    })).rejects.toThrow('connection-not-owned');

    const share = await replaceOrganizationShare(db, {
      ownerSubject: 'user:alice',
      ownerEmail: 'alice@example.com',
      organizationId: 'tenant-one',
      scopes: ['balances'],
      connectionGrants: [alice],
      expiresAt: new Date(Date.now() + 86_400_000),
    });

    const later = await connection('user:alice', 'Alice savings');
    await account(later, 'later-account', 500);
    expect(share.ownerEmail).toBe('alice@example.com');
    const shared = await listOrganizationSharedBalances(db, 'tenant-one');
    expect(shared).toHaveLength(1);
    expect(shared[0].ownerEmail).toBe('alice@example.com');
    expect(shared[0].accounts.map((item) => item.accountName)).toEqual([
      'alice-account account',
    ]);
    expect(JSON.stringify(shared)).not.toContain('bob-account');
    expect(JSON.stringify(shared)).not.toContain('later-account');
    const directory = await listOrganizationSharedConnections(db, 'tenant-one');
    expect(directory).toHaveLength(1);
    expect(directory[0].ownerEmail).toBe('alice@example.com');
    expect(directory[0].connections.map((item) => item.id)).toEqual([alice]);
    expect(await organizationCanAccessConnection(db, {
      organizationId: 'tenant-one',
      shareId: share.id,
      connectionId: alice,
      scope: 'balances',
    })).toBe(true);
    expect(await organizationCanAccessConnection(db, {
      organizationId: 'tenant-one',
      shareId: share.id,
      connectionId: alice,
      scope: 'transactions',
    })).toBe(false);
    expect(await organizationCanAccessConnection(db, {
      organizationId: 'tenant-one',
      shareId: share.id,
      connectionId: bob,
      scope: 'balances',
    })).toBe(false);

    expect(await revokeOrganizationShare(db, share.id, 'user:bob')).toBe(false);
    expect(await revokeOrganizationShare(db, share.id, 'user:alice')).toBe(true);
    expect(await listOrganizationSharedBalances(db, 'tenant-one')).toEqual([]);
  });

  it('replaces the previous live grant and a disabled organisation sees no balances', async () => {
    const first = await connection('user:alice', 'First');
    const second = await connection('user:alice', 'Second');
    await account(first, 'first-account', 1);
    await account(second, 'second-account', 2);
    await createOrganization(db, { id: 'tenant-one', name: 'Tenant One' });

    await replaceOrganizationShare(db, {
      ownerSubject: 'user:alice',
      ownerEmail: 'alice@example.com',
      organizationId: 'tenant-one',
      scopes: ['balances'],
      connectionGrants: [first],
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    await replaceOrganizationShare(db, {
      ownerSubject: 'user:alice',
      ownerEmail: 'alice@example.com',
      organizationId: 'tenant-one',
      scopes: ['balances'],
      connectionGrants: [second],
      expiresAt: new Date(Date.now() + 86_400_000),
    });

    const shared = await listOrganizationSharedBalances(db, 'tenant-one');
    expect(shared).toHaveLength(1);
    expect(shared[0].accounts.map((item) => item.accountName)).toEqual([
      'second-account account',
    ]);

    await setOrganizationDisabled(db, 'tenant-one', true);
    expect(await listOrganizationSharedBalances(db, 'tenant-one')).toEqual([]);
  });

  it('creates an invited organisation disabled in the initial database write', async () => {
    const provisioningId = 'a'.repeat(43);
    await expect(createOrganization(db, {
      disabled: false,
      id: 'active-provisioning',
      name: 'Active Provisioning',
      provisioningId,
    })).rejects.toThrow('organization-provisioning-must-start-disabled');
    const organization = await createOrganization(db, {
      disabled: true,
      id: 'pending-tenant',
      name: 'Pending Tenant',
      provisioningId,
    });

    expect(organization).toMatchObject({
      id: 'pending-tenant',
      name: 'Pending Tenant',
    });
    expect(organization.disabledAt).toBeInstanceOf(Date);
    await expect(createOrganization(db, {
      disabled: true,
      id: 'pending-tenant',
      name: 'Pending Tenant',
      provisioningId: 'z'.repeat(43),
    })).rejects.toThrow('organization-id-conflict');
    await expect(createOrganization(db, {
      disabled: false,
      id: 'pending-tenant',
      name: 'Pending Tenant',
    })).resolves.toEqual(organization);

    await expect(activateOrganizationProvisioning(
      db,
      'pending-tenant',
      provisioningId,
    )).resolves.toMatchObject({
      id: 'pending-tenant',
      disabledAt: null,
    });
    await expect(activateOrganizationProvisioning(
      db,
      'pending-tenant',
      provisioningId,
    )).resolves.toMatchObject({
      id: 'pending-tenant',
      disabledAt: null,
    });
    await setOrganizationDisabled(db, 'pending-tenant', true);
    await expect(activateOrganizationProvisioning(
      db,
      'pending-tenant',
      provisioningId,
    )).rejects.toThrow('organization-provisioning-unavailable');
  });

  it('cancels delayed provisioning activation after an explicit state change', async () => {
    const provisioningId = 'b'.repeat(43);
    await createOrganization(db, {
      disabled: true,
      id: 'cancelled-tenant',
      name: 'Cancelled Tenant',
      provisioningId,
    });

    await setOrganizationDisabled(db, 'cancelled-tenant', true);
    await expect(activateOrganizationProvisioning(
      db,
      'cancelled-tenant',
      provisioningId,
    )).rejects.toThrow('organization-provisioning-unavailable');
    await expect(createOrganization(db, {
      disabled: true,
      id: 'cancelled-tenant',
      name: 'Cancelled Tenant',
      provisioningId,
    })).rejects.toThrow('organization-id-conflict');

    await expect(createOrganization(db, {
      disabled: true,
      id: 'cancelled-tenant',
      name: 'Cancelled Tenant',
      provisioningId: 'c'.repeat(43),
    })).rejects.toThrow('organization-id-conflict');
  });

  it('projects a balances grant to balance-only account fields', async () => {
    const alice = await connection('user:alice', 'Personal');
    await client.query(`
      insert into accounts (id, connection_id, data)
      values ($1, $2, $3)
    `, [
      'private-account-id',
      alice,
      JSON.stringify({
        providerAccountId: 'provider-secret-123',
        name: 'Everyday account',
        description: 'Private description',
        currency: 'GBP',
        type: 'credit',
        balance: 125,
        available: 80,
        limit: 5_000,
        creditCardLiability: {
          minimumPaymentAmount: 25,
          nextPaymentDueDate: '2026-08-01',
        },
        pensionDetail: {
          employer: 'Private Employer',
          vestedValue: 40_000,
        },
      }),
    ]);
    await createOrganization(db, { id: 'tenant-one', name: 'Tenant One' });
    await replaceOrganizationShare(db, {
      ownerSubject: 'user:alice',
      ownerEmail: 'alice@example.com',
      organizationId: 'tenant-one',
      scopes: ['balances'],
      connectionGrants: [alice],
      expiresAt: new Date(Date.now() + 86_400_000),
    });

    const shared = await listOrganizationSharedBalances(db, 'tenant-one');
    expect(shared[0].accounts[0]).toEqual({
      institutionName: 'Example Bank',
      nickname: 'Personal',
      accountName: 'Everyday account',
      accountType: 'credit',
      currency: 'GBP',
      balance: 125,
      lastSeenAt: expect.any(Date),
    });
    expect(JSON.stringify(shared)).not.toContain('private-account-id');
    expect(JSON.stringify(shared)).not.toContain('provider-secret-123');
    expect(JSON.stringify(shared)).not.toContain('Private description');
    expect(JSON.stringify(shared)).not.toContain('minimumPaymentAmount');
    expect(JSON.stringify(shared)).not.toContain('Private Employer');
  });
});
