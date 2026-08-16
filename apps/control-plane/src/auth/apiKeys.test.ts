import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import type { Db } from '../db/client';
import {
  generateApiKey, hashApiKey, keyHasScope, keyGrantsConnection,
  createApiKey, verifyApiKey, type ApiKeyContext,
} from './apiKeys';

describe('api keys — pure', () => {
  it('generates a prefixed key with a stable 64-hex hash', () => {
    const { plaintext, hashedKey } = generateApiKey();
    expect(plaintext.startsWith('acck_')).toBe(true);
    expect(hashedKey).toBe(hashApiKey(plaintext));
    expect(hashedKey).toHaveLength(64);
    expect(generateApiKey().plaintext).not.toBe(plaintext); // random per call
  });

  it('scope checks are explicit — no catch-all/superuser scope grants others', () => {
    const ctx: ApiKeyContext = {
      id: 'k',
      ownerSubject: 'owner:a',
      deviceId: null,
      oauthGrantId: null,
      credentialHash: 'credential-hash',
      scopes: ['read:data'],
      connectionGrants: [],
    };
    expect(keyHasScope(ctx, 'read:data')).toBe(true);
    expect(keyHasScope(ctx, 'write:otp')).toBe(false);
    expect(keyHasScope(ctx, 'write:crawl')).toBe(false);
    // A key holds only the scopes it was explicitly granted (a read+crawl key, not a magic 'admin').
    expect(keyHasScope({ ...ctx, scopes: ['read:data', 'write:crawl'] }, 'write:crawl')).toBe(true);
  });

  it('connection grants honor the * wildcard, and empty grants deny everything (least-privilege default)', () => {
    const ctx: ApiKeyContext = {
      id: 'k',
      ownerSubject: 'owner:a',
      deviceId: null,
      oauthGrantId: null,
      credentialHash: 'credential-hash',
      scopes: [],
      connectionGrants: [],
    };
    expect(keyGrantsConnection({ ...ctx, connectionGrants: ['*'] }, 'c1')).toBe(true);
    expect(keyGrantsConnection({ ...ctx, connectionGrants: ['c1'] }, 'c1')).toBe(true);
    expect(keyGrantsConnection({ ...ctx, connectionGrants: ['c1'] }, 'c2')).toBe(false);
    // The secure default: a key with no explicit grants (the createKeySchema default) accesses nothing.
    expect(keyGrantsConnection(ctx, 'c1')).toBe(false);
  });
});

describe('api keys — persisted (pglite)', () => {
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

  it('creates a key, returns the plaintext once, and verifies it back', async () => {
    const { id, plaintext } = await createApiKey(db, { name: 'CI', scopes: ['read:data'], connectionGrants: ['*'] });
    expect(plaintext.startsWith('acck_')).toBe(true);
    const ctx = await verifyApiKey(db, plaintext);
    expect(ctx?.id).toBe(id);
    expect(ctx?.scopes).toEqual(['read:data']);
    expect(ctx?.connectionGrants).toEqual(['*']);
  });

  it('rejects an unknown or non-prefixed key', async () => {
    expect(await verifyApiKey(db, 'acck_does-not-exist')).toBeNull();
    expect(await verifyApiKey(db, 'not-a-key')).toBeNull();
  });

  it('rejects a revoked key', async () => {
    const { id, plaintext } = await createApiKey(db, { name: 'temp', scopes: ['read:data'], connectionGrants: ['*'] });
    await db.update(schema.apiKeys).set({ revokedAt: new Date() }).where(eq(schema.apiKeys.id, id));
    expect(await verifyApiKey(db, plaintext)).toBeNull();
  });

  it('rejects an expired key; accepts one not yet expired', async () => {
    const expired = await createApiKey(db, { name: 'expired', scopes: ['read:data'], connectionGrants: ['*'], expiresAt: new Date(Date.now() - 1000) });
    expect(await verifyApiKey(db, expired.plaintext)).toBeNull();

    const future = await createApiKey(db, { name: 'future', scopes: ['read:data'], connectionGrants: ['*'], expiresAt: new Date(Date.now() + 60_000) });
    expect((await verifyApiKey(db, future.plaintext))?.id).toBe(future.id);
  });

  it('a key with no expiry (null) never expires', async () => {
    const { id, plaintext } = await createApiKey(db, { name: 'forever', scopes: ['read:data'], connectionGrants: ['*'] });
    expect((await verifyApiKey(db, plaintext))?.id).toBe(id);
  });
});
