import { and, asc, desc, eq, gt, inArray, isNull } from 'drizzle-orm';
import {
  ORGANIZATION_SHARE_SCOPES,
  type OrganizationShareScope,
} from '@accrawl/contracts';
import type { Db } from '../db/client';
import {
  accounts,
  connections,
  institutions,
  organizations,
  organizationShares,
} from '../db/schema';

export {
  ORGANIZATION_SHARE_SCOPES,
  type OrganizationShareScope,
};

export interface OrganizationView {
  id: string;
  name: string;
  disabledAt: Date | null;
}

export interface OrganizationShareView {
  id: string;
  organizationId: string;
  organizationName: string;
  ownerSubject: string;
  ownerEmail: string;
  scopes: OrganizationShareScope[];
  connectionGrants: string[];
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  status: 'active' | 'expired' | 'revoked';
}

export function statusOf(row: {
  expiresAt: Date;
  revokedAt: Date | null;
}): OrganizationShareView['status'] {
  if (row.revokedAt) return 'revoked';
  return row.expiresAt.getTime() <= Date.now() ? 'expired' : 'active';
}

export async function listOrganizations(
  db: Db,
  includeDisabled = false,
): Promise<OrganizationView[]> {
  const query = db
    .select({
      id: organizations.id,
      name: organizations.name,
      disabledAt: organizations.disabledAt,
    })
    .from(organizations)
    .orderBy(asc(organizations.name));
  return includeDisabled ? query : query.where(isNull(organizations.disabledAt));
}

export async function getOrganization(
  db: Db,
  id: string,
  includeDisabled = false,
): Promise<OrganizationView | null> {
  const filters = includeDisabled
    ? eq(organizations.id, id)
    : and(eq(organizations.id, id), isNull(organizations.disabledAt));
  const [organization] = await db
    .select({
      id: organizations.id,
      name: organizations.name,
      disabledAt: organizations.disabledAt,
    })
    .from(organizations)
    .where(filters)
    .limit(1);
  return organization ?? null;
}

export async function createOrganization(
  db: Db,
  input: {
    disabled?: boolean;
    id: string;
    name: string;
    provisioningId?: string;
  },
): Promise<OrganizationView> {
  if (input.provisioningId && !input.disabled) {
    throw new Error('organization-provisioning-must-start-disabled');
  }
  const [row] = await db
    .insert(organizations)
    .values({
      id: input.id,
      name: input.name,
      disabledAt: input.disabled ? new Date() : null,
      provisioningId: input.provisioningId ?? null,
    })
    .onConflictDoNothing({ target: organizations.id })
    .returning({
      id: organizations.id,
      name: organizations.name,
      disabledAt: organizations.disabledAt,
    });
  if (row) return row;
  const [existing] = await db
    .select({
      id: organizations.id,
      name: organizations.name,
      disabledAt: organizations.disabledAt,
      provisioningId: organizations.provisioningId,
    })
    .from(organizations)
    .where(eq(organizations.id, input.id))
    .limit(1);
  if (!existing
    || existing.name !== input.name
    || (input.provisioningId
      && existing.provisioningId !== input.provisioningId)) {
    throw new Error('organization-id-conflict');
  }
  return {
    id: existing.id,
    name: existing.name,
    disabledAt: existing.disabledAt,
  };
}

/**
 * Complete a fail-closed provisioning operation with a database compare-and-set.
 *
 * The provisioning id remains as the active fence after success. Any explicit
 * administrator state change clears it, so a delayed invitation worker cannot
 * re-enable an organisation after that administrator action.
 */
export async function activateOrganizationProvisioning(
  db: Db,
  id: string,
  provisioningId: string,
): Promise<OrganizationView | null> {
  const [activated] = await db
    .update(organizations)
    .set({ disabledAt: null })
    .where(and(
      eq(organizations.id, id),
      eq(organizations.provisioningId, provisioningId),
    ))
    .returning({
      id: organizations.id,
      name: organizations.name,
      disabledAt: organizations.disabledAt,
    });
  if (activated) return activated;

  const [existing] = await db
    .select({
      id: organizations.id,
      name: organizations.name,
      disabledAt: organizations.disabledAt,
      provisioningId: organizations.provisioningId,
    })
    .from(organizations)
    .where(eq(organizations.id, id))
    .limit(1);
  if (!existing) return null;
  throw new Error('organization-provisioning-unavailable');
}

export async function setOrganizationDisabled(
  db: Db,
  id: string,
  disabled: boolean,
): Promise<OrganizationView | null> {
  const [row] = await db
    .update(organizations)
    .set({
      disabledAt: disabled ? new Date() : null,
      provisioningId: null,
    })
    .where(eq(organizations.id, id))
    .returning({
      id: organizations.id,
      name: organizations.name,
      disabledAt: organizations.disabledAt,
    });
  return row ?? null;
}

export function shareView(row: {
  id: string;
  organizationId: string;
  organizationName: string;
  ownerSubject: string;
  ownerEmail: string;
  scopes: string[];
  connectionGrants: string[];
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
}): OrganizationShareView {
  return {
    ...row,
    scopes: row.scopes.filter(
      (scope): scope is OrganizationShareScope =>
        (ORGANIZATION_SHARE_SCOPES as readonly string[]).includes(scope),
    ),
    status: statusOf(row),
  };
}

export async function listOwnerShares(
  db: Db,
  ownerSubject: string,
): Promise<OrganizationShareView[]> {
  const rows = await db
    .select({
      id: organizationShares.id,
      organizationId: organizationShares.organizationId,
      organizationName: organizations.name,
      ownerSubject: organizationShares.ownerSubject,
      ownerEmail: organizationShares.ownerEmail,
      scopes: organizationShares.scopes,
      connectionGrants: organizationShares.connectionGrants,
      createdAt: organizationShares.createdAt,
      expiresAt: organizationShares.expiresAt,
      revokedAt: organizationShares.revokedAt,
    })
    .from(organizationShares)
    .innerJoin(organizations, eq(organizationShares.organizationId, organizations.id))
    .where(eq(organizationShares.ownerSubject, ownerSubject))
    .orderBy(desc(organizationShares.createdAt));
  return rows.map(shareView);
}

export async function replaceOrganizationShare(
  db: Db,
  input: {
    ownerSubject: string;
    ownerEmail: string;
    organizationId: string;
    scopes: OrganizationShareScope[];
    connectionGrants: string[];
    expiresAt: Date;
  },
): Promise<OrganizationShareView> {
  return db.transaction(async (tx) => {
    const [organization] = await tx
      .select({ id: organizations.id, name: organizations.name })
      .from(organizations)
      .where(and(
        eq(organizations.id, input.organizationId),
        isNull(organizations.disabledAt),
      ))
      .limit(1);
    if (!organization) throw new Error('organization-unavailable');

    const owned = await tx
      .select({ id: connections.id })
      .from(connections)
      .where(and(
        eq(connections.ownerSubject, input.ownerSubject),
        inArray(connections.id, input.connectionGrants),
      ));
    if (owned.length !== input.connectionGrants.length) {
      throw new Error('connection-not-owned');
    }

    const now = new Date();
    await tx
      .update(organizationShares)
      .set({ revokedAt: now })
      .where(and(
        eq(organizationShares.ownerSubject, input.ownerSubject),
        eq(organizationShares.organizationId, input.organizationId),
        isNull(organizationShares.revokedAt),
      ));

    const [created] = await tx
      .insert(organizationShares)
      .values(input)
      .returning({
        id: organizationShares.id,
        organizationId: organizationShares.organizationId,
        ownerSubject: organizationShares.ownerSubject,
        ownerEmail: organizationShares.ownerEmail,
        scopes: organizationShares.scopes,
        connectionGrants: organizationShares.connectionGrants,
        createdAt: organizationShares.createdAt,
        expiresAt: organizationShares.expiresAt,
        revokedAt: organizationShares.revokedAt,
      });
    return shareView({ ...created, organizationName: organization.name });
  });
}

export async function revokeOrganizationShare(
  db: Db,
  shareId: string,
  ownerSubject: string,
): Promise<boolean> {
  const rows = await db
    .update(organizationShares)
    .set({ revokedAt: new Date() })
    .where(and(
      eq(organizationShares.id, shareId),
      eq(organizationShares.ownerSubject, ownerSubject),
      isNull(organizationShares.revokedAt),
    ))
    .returning({ id: organizationShares.id });
  return rows.length > 0;
}

export interface SharedBalanceAccount {
  institutionName: string | null;
  nickname: string | null;
  accountName: string;
  accountType: string;
  currency: string;
  balance: number;
  lastSeenAt: Date;
}

export interface SharedBalanceOwner {
  ownerEmail: string;
  shareId: string;
  expiresAt: Date;
  accounts: SharedBalanceAccount[];
}

export interface SharedConnectionOwner {
  ownerEmail: string;
  shareId: string;
  scopes: OrganizationShareScope[];
  expiresAt: Date;
  connections: Array<{
    id: string;
    institutionId: string;
    institutionName: string | null;
    nickname: string | null;
  }>;
}

export async function listOrganizationSharedConnections(
  db: Db,
  organizationId: string,
  now = new Date(),
): Promise<SharedConnectionOwner[]> {
  const shares = await db
    .select({
      id: organizationShares.id,
      ownerSubject: organizationShares.ownerSubject,
      ownerEmail: organizationShares.ownerEmail,
      scopes: organizationShares.scopes,
      connectionGrants: organizationShares.connectionGrants,
      expiresAt: organizationShares.expiresAt,
    })
    .from(organizationShares)
    .innerJoin(organizations, eq(organizationShares.organizationId, organizations.id))
    .where(and(
      eq(organizationShares.organizationId, organizationId),
      isNull(organizationShares.revokedAt),
      isNull(organizations.disabledAt),
      gt(organizationShares.expiresAt, now),
    ))
    .orderBy(desc(organizationShares.createdAt));
  const seenOwners = new Set<string>();
  const result: SharedConnectionOwner[] = [];
  for (const share of shares) {
    if (seenOwners.has(share.ownerSubject)) continue;
    seenOwners.add(share.ownerSubject);
    const rows = share.connectionGrants.length === 0
      ? []
      : await db
          .select({
            id: connections.id,
            institutionId: connections.institutionId,
            institutionName: institutions.name,
            nickname: connections.nickname,
          })
          .from(connections)
          .leftJoin(institutions, eq(connections.institutionId, institutions.id))
          .where(and(
            eq(connections.ownerSubject, share.ownerSubject),
            inArray(connections.id, share.connectionGrants),
          ))
          .orderBy(asc(institutions.name), asc(connections.id));
    result.push({
      ownerEmail: share.ownerEmail,
      shareId: share.id,
      scopes: share.scopes.filter(
        (scope): scope is OrganizationShareScope =>
          (ORGANIZATION_SHARE_SCOPES as readonly string[]).includes(scope),
      ),
      expiresAt: share.expiresAt,
      connections: rows,
    });
  }
  return result;
}

export async function organizationCanAccessConnection(
  db: Db,
  input: {
    organizationId: string;
    shareId: string;
    connectionId: string;
    scope: OrganizationShareScope;
    now?: Date;
  },
): Promise<boolean> {
  const shares = await db
    .select({
      ownerSubject: organizationShares.ownerSubject,
      scopes: organizationShares.scopes,
      connectionGrants: organizationShares.connectionGrants,
    })
    .from(organizationShares)
    .innerJoin(organizations, eq(organizationShares.organizationId, organizations.id))
    .where(and(
      eq(organizationShares.organizationId, input.organizationId),
      eq(organizationShares.id, input.shareId),
      isNull(organizationShares.revokedAt),
      isNull(organizations.disabledAt),
      gt(organizationShares.expiresAt, input.now ?? new Date()),
    ))
    .orderBy(desc(organizationShares.createdAt))
    .limit(1);
  const share = shares[0];
  if (!share
    || !share.scopes.includes(input.scope)
    || !share.connectionGrants.includes(input.connectionId)) return false;
  const [owned] = await db
    .select({ id: connections.id })
    .from(connections)
    .where(and(
      eq(connections.id, input.connectionId),
      eq(connections.ownerSubject, share.ownerSubject),
    ))
    .limit(1);
  return !!owned;
}

/**
 * Return only account/balance fields granted to one organisation. Every account
 * is selected through both the share's exact connection list and the connection's
 * owner subject; knowing an account id cannot bypass either predicate.
 */
export async function listOrganizationSharedBalances(
  db: Db,
  organizationId: string,
  now = new Date(),
): Promise<SharedBalanceOwner[]> {
  const shares = await db
    .select({
      id: organizationShares.id,
      ownerSubject: organizationShares.ownerSubject,
      ownerEmail: organizationShares.ownerEmail,
      scopes: organizationShares.scopes,
      connectionGrants: organizationShares.connectionGrants,
      expiresAt: organizationShares.expiresAt,
    })
    .from(organizationShares)
    .innerJoin(organizations, eq(organizationShares.organizationId, organizations.id))
    .where(and(
      eq(organizationShares.organizationId, organizationId),
      isNull(organizationShares.revokedAt),
      isNull(organizations.disabledAt),
      gt(organizationShares.expiresAt, now),
    ))
    .orderBy(desc(organizationShares.createdAt));

  // There is at most one live share per owner/organisation through the replace
  // transaction. Defensively deduplicate if legacy or concurrent rows exist.
  const seenOwners = new Set<string>();
  const result: SharedBalanceOwner[] = [];
  for (const share of shares) {
    if (seenOwners.has(share.ownerSubject) || !share.scopes.includes('balances')) continue;
    seenOwners.add(share.ownerSubject);
    if (share.connectionGrants.length === 0) {
      result.push({
        ownerEmail: share.ownerEmail,
        shareId: share.id,
        expiresAt: share.expiresAt,
        accounts: [],
      });
      continue;
    }
    const rows = await db
      .select({
        institutionName: institutions.name,
        nickname: connections.nickname,
        data: accounts.data,
        lastSeenAt: accounts.lastSeenAt,
      })
      .from(accounts)
      .innerJoin(connections, eq(accounts.connectionId, connections.id))
      .leftJoin(institutions, eq(connections.institutionId, institutions.id))
      .where(and(
        eq(connections.ownerSubject, share.ownerSubject),
        inArray(connections.id, share.connectionGrants),
      ))
      .orderBy(asc(institutions.name), asc(accounts.id));
    const projectedRows: SharedBalanceAccount[] = rows.map((row) => ({
      institutionName: row.institutionName,
      nickname: row.nickname,
      accountName: row.data.name,
      accountType: row.data.type,
      currency: row.data.currency,
      balance: row.data.balance,
      lastSeenAt: row.lastSeenAt,
    }));
    result.push({
      ownerEmail: share.ownerEmail,
      shareId: share.id,
      expiresAt: share.expiresAt,
      accounts: projectedRows,
    });
  }
  return result;
}
