import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { eq } from 'drizzle-orm';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import * as schema from '../db/schema';
import type { Db } from '../db/client';
import { oauthClients, oauthGrants, oauthRefreshTokens, apiKeys } from '../db/schema';
import { createOauthClient } from '../auth/oauthClients';
import { createApiKey, verifyApiKey } from '../auth/apiKeys';
import { generateRefreshToken } from '../auth/oauthCodes';
import { revokeGrant } from './oauth-grants';

/**
 * revokeGrant's contract, verified with INDEPENDENT oracles (a direct DB read + the real verifyApiKey auth
 * path), not the function's own return value. The load-bearing invariant: a `revoked` outcome means the grant
 * AND every token issued under it are revoked TOGETHER — verifyApiKey (which checks only the api_key's own
 * revokedAt, never the grant) must reject the access token afterward. The three writes run in one transaction
 * so this can never be left half-done.
 */
describe('revokeGrant (pglite)', () => {
  let client: PGlite;
  let db: Db;
  const future = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);

  beforeAll(async () => {
    client = new PGlite();
    db = drizzle(client, { schema }) as unknown as Db;
    const dir = path.resolve(__dirname, '../../migrations');
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
      await client.exec(fs.readFileSync(path.join(dir, f), 'utf8'));
    }
  });
  afterAll(async () => { await client.close(); });
  beforeEach(async () => { await client.exec('truncate oauth_clients cascade'); });

  /** Seed a client + an active grant with one access token (api_keys.grant_id) and one refresh token. */
  async function seedGrant(): Promise<{ grantId: string; accessToken: string; refreshHash: string }> {
    const { id: clientPk } = await createOauthClient(db, {
      name: 'App', redirectUris: ['https://app.example.com/cb'], allowedScopes: ['read:data'], isPublic: false,
    });
    const [grant] = await db.insert(oauthGrants).values({
      clientId: clientPk, scopes: ['read:data'], connectionGrants: ['*'], expiresAt: future,
    }).returning({ id: oauthGrants.id });
    const { plaintext: accessToken } = await createApiKey(db, {
      name: 'oauth:App', scopes: ['read:data'], connectionGrants: ['*'], expiresAt: future, grantId: grant.id,
    });
    const { plaintext: _rt, tokenHash: refreshHash } = generateRefreshToken();
    await db.insert(oauthRefreshTokens).values({ tokenHash: refreshHash, grantId: grant.id, expiresAt: future });
    return { grantId: grant.id, accessToken, refreshHash };
  }

  it('revokes the grant AND all its tokens atomically; verifyApiKey then rejects the access token', async () => {
    const { grantId, accessToken, refreshHash } = await seedGrant();

    // The access token authorizes BEFORE the revoke (baseline — proves the token was genuinely live).
    expect(await verifyApiKey(db, accessToken)).not.toBeNull();

    expect(await revokeGrant(db, grantId)).toBe('revoked');

    // Independent DB read: the grant and BOTH token rows carry revokedAt.
    const [g] = await db.select().from(oauthGrants).where(eq(oauthGrants.id, grantId));
    expect(g.revokedAt).not.toBeNull();
    const keys = await db.select().from(apiKeys).where(eq(apiKeys.grantId, grantId));
    expect(keys.length).toBe(1);
    expect(keys.every((k) => k.revokedAt !== null)).toBe(true);
    const rts = await db.select().from(oauthRefreshTokens).where(eq(oauthRefreshTokens.grantId, grantId));
    expect(rts.length).toBe(1);
    expect(rts.every((r) => r.revokedAt !== null)).toBe(true);
    expect(rts[0].tokenHash).toBe(refreshHash);

    // The SECURITY oracle: the real auth path now rejects the token. verifyApiKey never re-checks the grant,
    // so this passing PROVES the cascade to api_keys actually happened (not just the grant flip).
    expect(await verifyApiKey(db, accessToken)).toBeNull();
  });

  it('a second revoke is already_revoked and leaves the state unchanged (no re-flip)', async () => {
    const { grantId } = await seedGrant();
    expect(await revokeGrant(db, grantId)).toBe('revoked');
    const [afterFirst] = await db.select().from(oauthGrants).where(eq(oauthGrants.id, grantId));
    const firstRevokedAt = afterFirst.revokedAt;

    expect(await revokeGrant(db, grantId)).toBe('already_revoked');
    const [afterSecond] = await db.select().from(oauthGrants).where(eq(oauthGrants.id, grantId));
    // revokedAt is not moved forward by the no-op second call (the isNull guard skips the flip).
    expect(afterSecond.revokedAt?.getTime()).toBe(firstRevokedAt?.getTime());
  });

  it('a grant that does not exist is not_found (no error)', async () => {
    expect(await revokeGrant(db, '00000000-0000-0000-0000-000000000000')).toBe('not_found');
  });
});
