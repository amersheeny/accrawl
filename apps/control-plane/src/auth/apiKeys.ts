/**
 * Scoped API keys for external consumers (Accrawl is a data provider).
 *
 * A key is `acck_<random>`; only its SHA-256 hash is stored, so a DB compromise never
 * yields a usable key. Each key carries a set of SCOPES (what it may do) and CONNECTION
 * GRANTS (which connections' data it may touch — explicit ids or `['*']`). Verification
 * is a hash lookup; scope/grant checks are explicit per route so a consumer can read only
 * its own connections and POST OTP only to its own sessions.
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  PUBLIC_API_SCOPES,
  type PublicApiScope as ContractPublicApiScope,
} from '@accrawl/contracts';
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { Db } from '../db/client';
import { apiKeys, devices } from '../db/schema';
import {
  hostedCredentialStore,
  usesHostedCredentials,
} from './credential-store';
import { SELF_HOSTED_OPERATOR_SUBJECT } from './subjects';

export const API_SCOPES = PUBLIC_API_SCOPES;
export type PublicApiScope = ContractPublicApiScope;
/** `read:companion` is intentionally absent from API_SCOPES: operators and
 * OAuth clients cannot mint it. It is issued only by an approved pairing, and
 * it — never `read:data` — is what reaches the crawl-session surface the
 * companion renders as its own activity view. */
export type ApiScope = PublicApiScope | 'read:companion' | 'write:crawl';

/**
 * What an owner may put on a key they mint for their own automation.
 *
 * Wider than API_SCOPES on purpose, and the gap is the security property: starting a crawl decrypts the
 * owner's bank credentials and signs into their bank. That is something an owner may delegate to their
 * own scheduler, and never something a third-party application obtains by asking — OAuth validates
 * against API_SCOPES, which does not contain this, so no consent screen can offer it.
 *
 * A key carrying it must expire (see the mint route). A credential that can begin a bank login should
 * not outlive the reason it was created, and a leaked one should stop working without anyone noticing
 * it leaked. Which connections it may drive is still decided per request, as for any key.
 */
export const OPERATOR_MINTABLE_SCOPES = [
  ...PUBLIC_API_SCOPES,
  'write:crawl',
] as const satisfies readonly ApiScope[];

export interface ApiKeyContext {
  id: string;
  ownerSubject: string;
  deviceId: string | null;
  /** Non-null only for a bearer minted by the OAuth authorization server.
   * Route guards use this provenance to keep OAuth tokens off internal APIs. */
  oauthGrantId: string | null;
  /** Hash of the exact bearer generation authenticated for this request.
   * Point-of-use checks compare it with storage so an in-flight request cannot
   * survive credential rotation merely because the row id stayed the same. */
  credentialHash: string;
  scopes: string[];
  connectionGrants: string[];
}

export interface ApiKeyView {
  id: string;
  name: string;
  scopes: string[];
  connectionGrants: string[];
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

/** Re-resolve an already authenticated key by its stored id. Authorization
 * paths use this when a request may outlive a concurrent revocation, so a
 * cached context never becomes durable authority. */
export async function refreshApiKeyContext(
  db: Pick<Db, 'select'>,
  context: ApiKeyContext,
  now: Date = new Date(),
): Promise<ApiKeyContext | null> {
  if (usesHostedCredentials()) {
    return (await hostedCredentialStore()).refreshApiKey(context, now);
  }
  const [row] = await db
    .select()
    .from(apiKeys)
    .where(and(
      eq(apiKeys.id, context.id),
      eq(apiKeys.ownerSubject, context.ownerSubject),
      eq(apiKeys.hashedKey, context.credentialHash),
      isNull(apiKeys.revokedAt),
    ))
    .limit(1);
  if (!row || (row.expiresAt && row.expiresAt.getTime() <= now.getTime())) return null;
  if (row.scopes.includes('read:companion')) {
    if (!row.deviceId || row.connectionGrants.includes('*')) return null;
    const [device] = await db
      .select({ id: devices.id })
      .from(devices)
      .where(and(
        eq(devices.id, row.deviceId),
        eq(devices.ownerSubject, row.ownerSubject),
        isNull(devices.revokedAt),
      ))
      .limit(1);
    if (!device) return null;
  }
  return {
    id: row.id,
    ownerSubject: row.ownerSubject,
    deviceId: row.deviceId,
    oauthGrantId: row.grantId,
    credentialHash: row.hashedKey,
    scopes: row.scopes ?? [],
    connectionGrants: row.connectionGrants ?? [],
  };
}

/** Lock an authenticated key's live authority until the caller's transaction
 * commits. Companion keys lock their device first, matching device revocation's
 * lock order, then their API-key row. A completed revocation therefore proves
 * that no earlier financial read can still return afterward. */
export async function lockActiveApiKeyContext(
  db: Pick<Db, 'select'>,
  context: ApiKeyContext,
  now: Date = new Date(),
): Promise<ApiKeyContext | null> {
  if (usesHostedCredentials()) {
    // A document store's transactions provide the same live-record compare-and-set
    // boundary for hosted callers; the financial store separately enforces the
    // context's owner and connection grants at point of use.
    return (await hostedCredentialStore()).refreshApiKey(context, now);
  }
  const [candidate] = await db
    .select({ deviceId: apiKeys.deviceId, scopes: apiKeys.scopes })
    .from(apiKeys)
    .where(and(
      eq(apiKeys.id, context.id),
      eq(apiKeys.ownerSubject, context.ownerSubject),
      eq(apiKeys.hashedKey, context.credentialHash),
      isNull(apiKeys.revokedAt),
    ))
    .limit(1);
  if (!candidate) return null;
  const companionCandidate = candidate.scopes.includes('read:companion');
  if (companionCandidate) {
    if (!candidate.deviceId) return null;
    const [device] = await db
      .select({ id: devices.id })
      .from(devices)
      .where(and(
        eq(devices.id, candidate.deviceId),
        eq(devices.ownerSubject, context.ownerSubject),
        isNull(devices.revokedAt),
      ))
      .limit(1)
      .for('share');
    if (!device) return null;
  }
  const [row] = await db
    .select()
    .from(apiKeys)
    .where(and(
      eq(apiKeys.id, context.id),
      eq(apiKeys.ownerSubject, context.ownerSubject),
      eq(apiKeys.hashedKey, context.credentialHash),
      isNull(apiKeys.revokedAt),
    ))
    .limit(1)
    .for('share');
  if (!row || (row.expiresAt && row.expiresAt.getTime() <= now.getTime())) return null;
  if (
    row.scopes.includes('read:companion')
    && (
      !companionCandidate
      || !row.deviceId
      || row.deviceId !== candidate.deviceId
      || row.connectionGrants.includes('*')
    )
  ) {
    return null;
  }
  return {
    id: row.id,
    ownerSubject: row.ownerSubject,
    deviceId: row.deviceId,
    oauthGrantId: row.grantId,
    credentialHash: row.hashedKey,
    scopes: row.scopes ?? [],
    connectionGrants: row.connectionGrants ?? [],
  };
}

const KEY_PREFIX = 'acck_';

export function hashApiKey(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}

/** Generate a fresh key + its stored hash. The plaintext is shown to the operator ONCE. */
export function generateApiKey(): { plaintext: string; hashedKey: string } {
  const plaintext = KEY_PREFIX + randomBytes(32).toString('base64url');
  return { plaintext, hashedKey: hashApiKey(plaintext) };
}

export async function createApiKey(
  db: Pick<Db, 'insert'>,
  input: {
    name: string;
    scopes: string[];
    connectionGrants: string[];
    ownerSubject?: string;
    expiresAt?: Date | null;
    grantId?: string | null;
    deviceId?: string | null;
  },
): Promise<{ id: string; plaintext: string }> {
  const { plaintext, hashedKey } = generateApiKey();
  if (usesHostedCredentials()) {
    const id = await (await hostedCredentialStore()).createApiKey({
      name: input.name,
      ownerSubject: input.ownerSubject ?? SELF_HOSTED_OPERATOR_SUBJECT,
      hashedKey,
      scopes: input.scopes,
      connectionGrants: input.connectionGrants,
      expiresAt: input.expiresAt ?? null,
      grantId: input.grantId ?? null,
      deviceId: input.deviceId ?? null,
    });
    return { id, plaintext };
  }
  const [row] = await db
    .insert(apiKeys)
    .values({
      name: input.name,
      ownerSubject: input.ownerSubject ?? SELF_HOSTED_OPERATOR_SUBJECT,
      hashedKey,
      scopes: input.scopes,
      connectionGrants: input.connectionGrants,
      expiresAt: input.expiresAt ?? null,
      // Set for OAuth-issued access tokens so revoking the grant (FK cascade) drops the token too.
      grantId: input.grantId ?? null,
      deviceId: input.deviceId ?? null,
    })
    .returning({ id: apiKeys.id });
  return { id: row.id, plaintext };
}

/** Resolve a presented key to its context, or null if unknown/revoked/expired. Touches lastUsedAt. */
export async function verifyApiKey(db: Db, presented: string): Promise<ApiKeyContext | null> {
  if (!presented.startsWith(KEY_PREFIX)) return null;
  const hashed = hashApiKey(presented);
  if (usesHostedCredentials()) {
    return (await hostedCredentialStore()).verifyApiKey(hashed);
  }
  const [row] = await db.select().from(apiKeys).where(eq(apiKeys.hashedKey, hashed)).limit(1);
  if (!row || row.revokedAt) return null;
  if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return null; // past its time limit
  if (row.scopes.includes('read:companion')) {
    if (!row.deviceId || row.connectionGrants.includes('*')) return null;
    const [device] = await db
      .select({ id: devices.id })
      .from(devices)
      .where(and(
        eq(devices.id, row.deviceId),
        eq(devices.ownerSubject, row.ownerSubject),
        isNull(devices.revokedAt),
      ))
      .limit(1);
    if (!device) return null;
  }
  // Best-effort usage stamp — never block auth on it, but surface a failure (no silent swallow).
  void db
    .update(apiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(apiKeys.id, row.id))
    .catch((err) => console.warn(`[apiKeys] lastUsedAt stamp failed for ${row.id}:`, err));
  return {
    id: row.id,
    ownerSubject: row.ownerSubject,
    deviceId: row.deviceId,
    oauthGrantId: row.grantId,
    credentialHash: row.hashedKey,
    scopes: row.scopes ?? [],
    connectionGrants: row.connectionGrants ?? [],
  };
}

export async function listApiKeys(
  db: Pick<Db, 'select'>,
  ownerSubject: string,
): Promise<ApiKeyView[]> {
  if (usesHostedCredentials()) {
    return (await hostedCredentialStore()).listApiKeys(ownerSubject);
  }
  return db
    .select({
      id: apiKeys.id,
      name: apiKeys.name,
      scopes: apiKeys.scopes,
      connectionGrants: apiKeys.connectionGrants,
      createdAt: apiKeys.createdAt,
      lastUsedAt: apiKeys.lastUsedAt,
      revokedAt: apiKeys.revokedAt,
    })
    .from(apiKeys)
    .where(eq(apiKeys.ownerSubject, ownerSubject))
    .orderBy(desc(apiKeys.createdAt));
}

export async function revokeApiKey(
  db: Pick<Db, 'update'>,
  id: string,
  ownerSubject: string,
): Promise<boolean> {
  if (usesHostedCredentials()) {
    return (await hostedCredentialStore()).revokeApiKey(id, ownerSubject);
  }
  const revoked = await db
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(and(
      eq(apiKeys.id, id),
      eq(apiKeys.ownerSubject, ownerSubject),
      isNull(apiKeys.revokedAt),
    ))
    .returning({ id: apiKeys.id });
  return revoked.length > 0;
}

/**
 * Whether the key EXPLICITLY holds a scope. API keys are external-consumer credentials governed by least
 * privilege — there is deliberately no catch-all/superuser scope (admin/operator actions use operator-token
 * auth, never an API key), so a data-read key MUST carry read:data; nothing silently implies it.
 */
export function keyHasScope(ctx: ApiKeyContext, scope: ApiScope): boolean {
  return ctx.scopes.includes(scope);
}

/** Whether the key may touch a specific connection's data (`['*']` grants all). */
export function keyGrantsConnection(ctx: ApiKeyContext, connectionId: string): boolean {
  return ctx.connectionGrants.includes('*') || ctx.connectionGrants.includes(connectionId);
}
