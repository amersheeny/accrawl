/**
 * OAuth grant lifecycle helpers — the operator's "connected apps".
 *
 * A grant is the standing consent for one client (scopes over connections) with a ~90-day expiry. An access
 * token issued under it expires in an hour, so the consent outlives any single bearer credential. Access
 * tokens (api_keys.grant_id) and refresh tokens reference it. Revoking a grant cascades to BOTH so the app
 * loses access immediately, without waiting for token expiry.
 */
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { Db } from '../db/client';
import { oauthGrants, oauthClients, oauthRefreshTokens, apiKeys } from '../db/schema';
import { SELF_HOSTED_OPERATOR_SUBJECT } from '../auth/subjects';
import {
  hostedOauthStore,
  usesHostedOauthStore,
} from '../auth/oauth-store';

export type GrantStatus = 'active' | 'expired' | 'revoked';

export interface GrantView {
  id: string;
  clientId: string | null; // the public client_id (accl_…)
  clientName: string | null;
  scopes: string[];
  connectionGrants: string[];
  status: GrantStatus;
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
}

function statusOf(row: { revokedAt: Date | null; expiresAt: Date }): GrantStatus {
  if (row.revokedAt) return 'revoked';
  if (row.expiresAt.getTime() <= Date.now()) return 'expired';
  return 'active';
}

/** All grants (connected apps), newest first, joined to the client's public id + name. */
export async function listGrants(
  db: Db,
  ownerSubject: string = SELF_HOSTED_OPERATOR_SUBJECT,
): Promise<GrantView[]> {
  if (usesHostedOauthStore()) {
    return (await hostedOauthStore()).listGrants(ownerSubject);
  }
  const rows = await db
    .select({
      id: oauthGrants.id,
      clientPublicId: oauthClients.clientId,
      clientName: oauthClients.name,
      scopes: oauthGrants.scopes,
      connectionGrants: oauthGrants.connectionGrants,
      createdAt: oauthGrants.createdAt,
      expiresAt: oauthGrants.expiresAt,
      revokedAt: oauthGrants.revokedAt,
    })
    .from(oauthGrants)
    .leftJoin(oauthClients, eq(oauthGrants.clientId, oauthClients.id))
    .where(eq(oauthGrants.ownerSubject, ownerSubject))
    .orderBy(desc(oauthGrants.createdAt));
  return rows.map((r) => ({
    id: r.id,
    clientId: r.clientPublicId,
    clientName: r.clientName,
    scopes: r.scopes ?? [],
    connectionGrants: r.connectionGrants ?? [],
    status: statusOf(r),
    createdAt: r.createdAt,
    expiresAt: r.expiresAt,
    revokedAt: r.revokedAt,
  }));
}

/** The outcome of a revoke: `revoked` = this call performed the active→revoked transition (the event actually
 *  happened); `already_revoked` = the grant existed but was already revoked (idempotent no-op); `not_found` =
 *  no such grant. Callers use `revoked` to fire the `grant.revoked` webhook ONLY on a real revocation. */
export type RevokeGrantOutcome = 'revoked' | 'already_revoked' | 'not_found';

/**
 * Revoke a grant and everything issued under it — its access tokens (api_keys) and refresh tokens — so the
 * connected app loses access at once. Idempotent (only flips rows still active). The `oauthGrants` flip is
 * atomic (`isNull` guard + RETURNING), so under a concurrent double-revoke exactly one call reports `revoked`.
 *
 * ALL THREE PostgreSQL writes run in ONE transaction, because the relational
 * verifier authorizes access-token rows directly and relies on their explicit
 * revocation. A document-store backend additionally re-checks the live grant and client on
 * every access-token use while its transaction invalidates grant and refresh
 * state atomically. A mid-operation failure therefore cannot leave a revoked
 * grant with a live access or refresh path in either backend.
 */
export async function revokeGrant(
  db: Db,
  grantId: string,
  ownerSubject?: string,
): Promise<RevokeGrantOutcome> {
  if (usesHostedOauthStore()) {
    return (await hostedOauthStore()).revokeGrant(
      grantId,
      ownerSubject,
    );
  }
  const now = new Date();
  return db.transaction(async (tx) => {
    const ownerPredicate = ownerSubject
      ? and(eq(oauthGrants.id, grantId), eq(oauthGrants.ownerSubject, ownerSubject))
      : eq(oauthGrants.id, grantId);
    const [g] = await tx.select({ id: oauthGrants.id }).from(oauthGrants).where(ownerPredicate).limit(1);
    if (!g) return 'not_found';
    // Flip only a still-active grant; RETURNING tells us whether THIS call performed the transition (vs. the
    // grant already being revoked) — so the caller fires the revocation webhook exactly once, never on a no-op.
    const flipped = await tx
      .update(oauthGrants)
      .set({ revokedAt: now })
      .where(and(ownerPredicate, isNull(oauthGrants.revokedAt)))
      .returning({ id: oauthGrants.id });
    // Cascade to any still-active tokens regardless (idempotent — a repeat call just matches nothing).
    await tx.update(apiKeys).set({ revokedAt: now }).where(and(eq(apiKeys.grantId, grantId), isNull(apiKeys.revokedAt)));
    await tx.update(oauthRefreshTokens).set({ revokedAt: now }).where(and(eq(oauthRefreshTokens.grantId, grantId), isNull(oauthRefreshTokens.revokedAt)));
    return flipped.length > 0 ? 'revoked' : 'already_revoked';
  });
}

export async function getGrantClientPublicId(
  db: Db,
  grantId: string,
  ownerSubject: string,
): Promise<string | null> {
  if (usesHostedOauthStore()) {
    return (await hostedOauthStore()).getGrantClientPublicId(
      grantId,
      ownerSubject,
    );
  }
  const [row] = await db
    .select({ clientPublicId: oauthClients.clientId })
    .from(oauthGrants)
    .leftJoin(oauthClients, eq(oauthGrants.clientId, oauthClients.id))
    .where(and(
      eq(oauthGrants.id, grantId),
      eq(oauthGrants.ownerSubject, ownerSubject),
    ))
    .limit(1);
  return row?.clientPublicId ?? null;
}
