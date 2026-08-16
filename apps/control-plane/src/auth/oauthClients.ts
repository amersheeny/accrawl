/**
 * OAuth client registry — the third-party apps that may run the "Connect with Accrawl" flow.
 *
 * The operator registers a client; a CONFIDENTIAL client gets a `client_secret` shown ONCE and stored only
 * as a SHA-256 hash (like an API key), a PUBLIC client (PKCE-only, e.g. a SPA/mobile app) gets none.
 * `redirectUris` is an exact-match allowlist captured at registration and re-checked at /oauth/authorize —
 * the anchor that stops an attacker redirecting a minted code to a URL they control.
 */
import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { isAllowedOauthRedirectUri } from '@accrawl/contracts';
import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from '../db/client';
import {
  auditLog,
  authorizationCodes,
  oauthClients,
  oauthGrants,
} from '../db/schema';
import {
  hostedOauthStore,
  usesHostedOauthStore,
} from './oauth-store';
import type { OauthClientView } from '../storage/hosted-stores';
import type { AuditEntry } from './audit';

const CLIENT_ID_PREFIX = 'accl_';
const CLIENT_SECRET_PREFIX = 'acls_';

export function hashClientSecret(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}

export interface OauthClientRecord {
  id: string;
  recipientTenantId: string;
  clientId: string;
  name: string;
  isPublic: boolean;
  redirectUris: string[];
  allowedScopes: string[];
  disabledAt: Date | null;
  hashedSecret: string | null;
}

type OauthClientInput = {
  name: string;
  recipientTenantId?: string;
  redirectUris: string[];
  allowedScopes: string[];
  isPublic: boolean;
};

export class OauthRegistrationConflictError extends Error {
  constructor() {
    super('Idempotency key was reused for different metadata');
    this.name = 'OauthRegistrationConflictError';
  }
}

/**
 * Whether a redirect URI is acceptable to REGISTER: an absolute URL, TLS in production OR a loopback host
 * for local development, and NO fragment (RFC 6749 §3.1.2 forbids a fragment on a redirect_uri). This is the
 * registration gate; /oauth/authorize then requires an EXACT string match against this stored allowlist.
 */
export const isAllowedRedirectUri = isAllowedOauthRedirectUri;

/** Register a client. Returns the one-time client_secret (null for a public client). */
export async function createOauthClient(
  db: Db,
  input: OauthClientInput,
  audit?: AuditEntry,
): Promise<{ id: string; clientId: string; clientSecret: string | null }> {
  const clientId = CLIENT_ID_PREFIX + randomBytes(16).toString('base64url');
  let clientSecret: string | null = null;
  let hashedSecret: string | null = null;
  if (!input.isPublic) {
    clientSecret = CLIENT_SECRET_PREFIX + randomBytes(32).toString('base64url');
    hashedSecret = hashClientSecret(clientSecret);
  }
  if (usesHostedOauthStore()) {
    const id = randomUUID();
    await (await hostedOauthStore()).createClient({
      id,
      clientId,
      recipientTenantId: input.recipientTenantId ?? 'self-hosted',
      hashedSecret,
      name: input.name,
      isPublic: input.isPublic,
      redirectUris: [...input.redirectUris],
      allowedScopes: [...input.allowedScopes],
      disabledAt: null,
    }, new Date(), audit);
    return { id, clientId, clientSecret };
  }
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(oauthClients)
      .values({
        clientId,
        recipientTenantId: input.recipientTenantId ?? 'self-hosted',
        hashedSecret,
        name: input.name,
        isPublic: input.isPublic,
        redirectUris: input.redirectUris,
        allowedScopes: input.allowedScopes,
      })
      .returning({ id: oauthClients.id });
    if (audit) {
      await tx.insert(auditLog).values({
        ...audit,
        actorId: audit.actorId ?? null,
        targetType: audit.targetType ?? null,
        targetId: row.id,
        sourceIp: audit.sourceIp ?? null,
      });
    }
    return { id: row.id, clientId, clientSecret };
  });
}

function sameRegistration(
  existing: OauthClientRecord,
  input: OauthClientInput,
): boolean {
  return existing.disabledAt == null
    && existing.recipientTenantId
      === (input.recipientTenantId ?? 'self-hosted')
    && existing.name === input.name
    && existing.isPublic === input.isPublic
    && existing.redirectUris.length === input.redirectUris.length
    && existing.redirectUris.every(
      (uri, index) => uri === input.redirectUris[index],
    )
    && existing.allowedScopes.length === input.allowedScopes.length
    && existing.allowedScopes.every(
      (scope, index) => scope === input.allowedScopes[index],
    );
}

function derivedCredential(
  secret: string,
  purpose: 'client-id' | 'client-secret',
  recipientTenantId: string,
  idempotencyKey: string,
): string {
  return createHmac('sha256', secret)
    .update(`oauth-registration-${purpose}-v1\0`)
    .update(recipientTenantId)
    .update('\0')
    .update(idempotencyKey)
    .digest('base64url');
}

/** Idempotently register a hosted tenant client. The browser's opaque request
 * key is not itself a credential: server-side HMAC derivation makes the same
 * authenticated request replay-safe without storing a plaintext client secret.
 * Reusing the key for different metadata is rejected. */
export async function createOauthClientIdempotently(
  db: Db,
  input: OauthClientInput & { recipientTenantId: string },
  idempotencyKey: string,
  derivationSecret: string,
  audit?: AuditEntry,
): Promise<{
  id: string;
  clientId: string;
  clientSecret: string | null;
  created: boolean;
}> {
  const clientId = CLIENT_ID_PREFIX + derivedCredential(
    derivationSecret,
    'client-id',
    input.recipientTenantId,
    idempotencyKey,
  );
  const clientSecret = input.isPublic
    ? null
    : CLIENT_SECRET_PREFIX + derivedCredential(
      derivationSecret,
      'client-secret',
      input.recipientTenantId,
      idempotencyKey,
    );
  const hashedSecret = clientSecret ? hashClientSecret(clientSecret) : null;

  if (usesHostedOauthStore()) {
    const record: OauthClientRecord = {
      id: randomUUID(),
      clientId,
      recipientTenantId: input.recipientTenantId,
      hashedSecret,
      name: input.name,
      isPublic: input.isPublic,
      redirectUris: [...input.redirectUris],
      allowedScopes: [...input.allowedScopes],
      disabledAt: null,
    };
    const existing = await (await hostedOauthStore())
      .createOrGetClient(record, new Date(), audit
        ? { ...audit, targetId: record.id }
        : undefined);
    if (!sameRegistration(existing, input)) {
      throw new OauthRegistrationConflictError();
    }
    return {
      id: existing.id,
      clientId,
      clientSecret,
      created: existing.id === record.id,
    };
  }

  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(oauthClients)
      .values({
        clientId,
        recipientTenantId: input.recipientTenantId,
        hashedSecret,
        name: input.name,
        isPublic: input.isPublic,
        redirectUris: input.redirectUris,
        allowedScopes: input.allowedScopes,
      })
      .onConflictDoNothing({ target: oauthClients.clientId })
      .returning({ id: oauthClients.id });
    if (inserted[0]) {
      if (audit) {
        await tx.insert(auditLog).values({
          ...audit,
          actorId: audit.actorId ?? null,
          targetType: audit.targetType ?? null,
          targetId: inserted[0].id,
          sourceIp: audit.sourceIp ?? null,
        });
      }
      return {
        id: inserted[0].id,
        clientId,
        clientSecret,
        created: true,
      };
    }
    const [row] = await tx
      .select()
      .from(oauthClients)
      .where(eq(oauthClients.clientId, clientId))
      .limit(1);
    const existing = row ? oauthClientRecord(row) : null;
    if (!existing || !sameRegistration(existing, input)) {
      throw new OauthRegistrationConflictError();
    }
    return { id: existing.id, clientId, clientSecret, created: false };
  });
}

function oauthClientRecord(
  row: typeof oauthClients.$inferSelect,
): OauthClientRecord {
  return {
    id: row.id,
    recipientTenantId: row.recipientTenantId,
    clientId: row.clientId,
    name: row.name,
    isPublic: row.isPublic,
    redirectUris: row.redirectUris ?? [],
    allowedScopes: row.allowedScopes ?? [],
    disabledAt: row.disabledAt,
    hashedSecret: row.hashedSecret,
  };
}

/** Resolve a public client_id to its record (including the secret hash), or null if unknown. */
export async function getOauthClient(db: Db, clientId: string): Promise<OauthClientRecord | null> {
  if (usesHostedOauthStore()) {
    return (await hostedOauthStore()).getClient(clientId);
  }
  const [row] = await db.select().from(oauthClients).where(eq(oauthClients.clientId, clientId)).limit(1);
  if (!row) return null;
  return oauthClientRecord(row);
}

export async function listOauthClients(
  db: Db,
  recipientTenantId?: string,
): Promise<OauthClientView[]> {
  if (usesHostedOauthStore()) {
    return (await hostedOauthStore()).listClients(recipientTenantId);
  }
  const query = db
    .select({
      id: oauthClients.id,
      recipientTenantId: oauthClients.recipientTenantId,
      clientId: oauthClients.clientId,
      name: oauthClients.name,
      isPublic: oauthClients.isPublic,
      redirectUris: oauthClients.redirectUris,
      allowedScopes: oauthClients.allowedScopes,
      createdAt: oauthClients.createdAt,
      disabledAt: oauthClients.disabledAt,
    })
    .from(oauthClients);
  return recipientTenantId === undefined
    ? query.where(isNull(oauthClients.disabledAt))
    : query.where(and(
      eq(oauthClients.recipientTenantId, recipientTenantId),
      isNull(oauthClients.disabledAt),
    ));
}

async function disableOauthClient(
  db: Db,
  id: string,
  recipientTenantId: string | undefined,
  audit?: AuditEntry,
): Promise<boolean> {
  if (usesHostedOauthStore()) {
    return (await hostedOauthStore()).deleteClient(
      id,
      recipientTenantId,
      new Date(),
      audit ? { ...audit, targetId: id } : undefined,
    );
  }
  return db.transaction(async (tx) => {
    const condition = recipientTenantId === undefined
      ? and(eq(oauthClients.id, id), isNull(oauthClients.disabledAt))
      : and(
        eq(oauthClients.id, id),
        eq(oauthClients.recipientTenantId, recipientTenantId),
        isNull(oauthClients.disabledAt),
      );
    const disabled = await tx
      .update(oauthClients)
      .set({ disabledAt: new Date() })
      .where(condition)
      .returning({ id: oauthClients.id });
    if (disabled.length !== 1) return false;
    // Preserve the client row as the idempotency tombstone while invalidating
    // every credential that was issued under it.
    await tx.delete(authorizationCodes)
      .where(eq(authorizationCodes.clientId, id));
    await tx.delete(oauthGrants)
      .where(eq(oauthGrants.clientId, id));
    if (audit) {
      await tx.insert(auditLog).values({
        ...audit,
        actorId: audit.actorId ?? null,
        targetType: audit.targetType ?? null,
        targetId: id,
        sourceIp: audit.sourceIp ?? null,
      });
    }
    return true;
  });
}

export async function deleteOauthClient(
  db: Db,
  id: string,
  audit?: AuditEntry,
): Promise<void> {
  await disableOauthClient(db, id, undefined, audit);
}

export async function deleteOauthClientForTenant(
  db: Db,
  id: string,
  recipientTenantId: string,
  audit?: AuditEntry,
): Promise<boolean> {
  return disableOauthClient(db, id, recipientTenantId, audit);
}

/** Constant-time check that a presented client_secret matches the stored hash (false if the client has none). */
export function verifyClientSecret(presented: string, storedHash: string | null): boolean {
  if (!storedHash) return false;
  const a = Buffer.from(hashClientSecret(presented), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
