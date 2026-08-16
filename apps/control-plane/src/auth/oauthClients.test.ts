import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import type { Db } from '../db/client';
import { auditLog } from '../db/schema';
import {
  createOauthClient,
  createOauthClientIdempotently,
  deleteOauthClientForTenant,
  getOauthClient,
  isAllowedRedirectUri,
  listOauthClients,
  verifyClientSecret,
} from './oauthClients';

describe('isAllowedRedirectUri (registration gate)', () => {
  it('accepts absolute https and loopback http; rejects everything else', () => {
    expect(isAllowedRedirectUri('https://app.example.com/callback')).toBe(true);
    expect(isAllowedRedirectUri('https://app.example.com/cb?x=1')).toBe(true); // query is fine
    expect(isAllowedRedirectUri('http://localhost:4000/callback')).toBe(true);
    expect(isAllowedRedirectUri('http://127.0.0.1:4000/cb')).toBe(true);
    expect(isAllowedRedirectUri('http://[::1]/cb')).toBe(true);
    // rejects: plain-http non-loopback (downgrade/interception), other schemes, fragments, garbage
    expect(isAllowedRedirectUri('http://evil.example.com/cb')).toBe(false);
    expect(isAllowedRedirectUri('ftp://host/cb')).toBe(false);
    expect(isAllowedRedirectUri('https://app.example.com/cb#frag')).toBe(false); // RFC6749 §3.1.2
    expect(isAllowedRedirectUri('not a url')).toBe(false);
    expect(isAllowedRedirectUri('javascript:alert(1)')).toBe(false);
  });
});

describe('OAuth client registry (pglite)', () => {
  let client: PGlite;
  let db: Db;

  beforeAll(async () => {
    client = new PGlite();
    db = drizzle(client) as unknown as Db;
    const dir = path.resolve(__dirname, '../../migrations');
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
      await client.exec(fs.readFileSync(path.join(dir, f), 'utf8'));
    }
  });
  afterAll(async () => { await client.close(); });

  it('confidential client: returns a one-time secret whose hash verifies; public client: no secret', async () => {
    const conf = await createOauthClient(db, {
      name: 'Budget App', redirectUris: ['https://budget.example.com/cb'], allowedScopes: ['read:data'], isPublic: false,
    });
    expect(conf.clientId).toMatch(/^accl_/);
    expect(conf.clientSecret).toMatch(/^acls_/);

    const rec = await getOauthClient(db, conf.clientId);
    expect(rec).not.toBeNull();
    expect(rec!.redirectUris).toEqual(['https://budget.example.com/cb']);
    // The stored hash verifies the one-time secret, and rejects a wrong one — constant-time.
    expect(verifyClientSecret(conf.clientSecret!, rec!.hashedSecret)).toBe(true);
    expect(verifyClientSecret('acls_wrong', rec!.hashedSecret)).toBe(false);

    const pub = await createOauthClient(db, {
      name: 'SPA', redirectUris: ['https://spa.example.com/cb'], allowedScopes: ['read:data'], isPublic: true,
    });
    expect(pub.clientSecret).toBeNull();
    const pubRec = await getOauthClient(db, pub.clientId);
    expect(pubRec!.hashedSecret).toBeNull();
    // A public client can never be authenticated by a secret (no hash to match).
    expect(verifyClientSecret('acls_anything', pubRec!.hashedSecret)).toBe(false);
  });

  it('lists and deletes clients only inside the administering tenant', async () => {
    const tenantA = await createOauthClient(db, {
      recipientTenantId: 'tenant-a',
      name: 'Tenant A app',
      redirectUris: ['https://a.example.com/callback'],
      allowedScopes: ['read:data'],
      isPublic: false,
    });
    const tenantB = await createOauthClient(db, {
      recipientTenantId: 'tenant-b',
      name: 'Tenant B app',
      redirectUris: ['https://b.example.com/callback'],
      allowedScopes: ['read:data'],
      isPublic: true,
    });

    await expect(listOauthClients(db, 'tenant-a')).resolves.toEqual([
      expect.objectContaining({
        id: tenantA.id,
        recipientTenantId: 'tenant-a',
      }),
    ]);
    await expect(
      deleteOauthClientForTenant(db, tenantB.id, 'tenant-a'),
    ).resolves.toBe(false);
    await expect(getOauthClient(db, tenantB.clientId)).resolves.not.toBeNull();
    await expect(
      deleteOauthClientForTenant(db, tenantA.id, 'tenant-a'),
    ).resolves.toBe(true);
    await expect(listOauthClients(db, 'tenant-a')).resolves.toEqual([]);
    await expect(getOauthClient(db, tenantA.clientId)).resolves
      .toEqual(expect.objectContaining({ disabledAt: expect.any(Date) }));
    await expect(getOauthClient(db, tenantB.clientId)).resolves.not.toBeNull();
  });

  it('replays one registration without duplicating it or changing credentials', async () => {
    const input = {
      recipientTenantId: 'tenant-idempotent',
      name: 'Reliable app',
      redirectUris: ['https://reliable.example.com/callback'],
      allowedScopes: ['read:data'],
      isPublic: false,
    };
    const first = await createOauthClientIdempotently(
      db,
      input,
      'request-key-that-is-long-enough-0001',
      'tenant-administration-secret',
    );
    const replay = await createOauthClientIdempotently(
      db,
      input,
      'request-key-that-is-long-enough-0001',
      'tenant-administration-secret',
    );

    expect(first.created).toBe(true);
    expect(replay.created).toBe(false);
    expect(replay).toMatchObject({
      id: first.id,
      clientId: first.clientId,
      clientSecret: first.clientSecret,
    });
    await expect(listOauthClients(db, input.recipientTenantId)).resolves
      .toHaveLength(1);
    await expect(createOauthClientIdempotently(
      db,
      { ...input, name: 'Different app' },
      'request-key-that-is-long-enough-0001',
      'tenant-administration-secret',
    )).rejects.toThrow('Idempotency key was reused');

    await expect(deleteOauthClientForTenant(
      db,
      first.id,
      input.recipientTenantId,
    )).resolves.toBe(true);
    await expect(createOauthClientIdempotently(
      db,
      input,
      'request-key-that-is-long-enough-0001',
      'tenant-administration-secret',
    )).rejects.toThrow('Idempotency key was reused');
    await expect(createOauthClientIdempotently(
      db,
      { ...input, name: 'Resurrected as another app' },
      'request-key-that-is-long-enough-0001',
      'tenant-administration-secret',
    )).rejects.toThrow('Idempotency key was reused');
  });

  it('commits lifecycle audit rows in the same client transactions', async () => {
    const input = {
      recipientTenantId: 'tenant-audited',
      name: 'Audited app',
      redirectUris: ['https://audited.example.com/callback'],
      allowedScopes: ['read:data'],
      isPublic: false,
    };
    const created = await createOauthClientIdempotently(
      db,
      input,
      'request-key-that-is-long-enough-audit',
      'tenant-administration-secret',
      {
        actorType: 'operator',
        actorId: 'organization-admin',
        action: 'oauth_client.create',
        targetType: 'oauth_client',
        sourceIp: '192.0.2.1',
      },
    );
    await createOauthClientIdempotently(
      db,
      input,
      'request-key-that-is-long-enough-audit',
      'tenant-administration-secret',
      {
        actorType: 'operator',
        actorId: 'organization-admin',
        action: 'oauth_client.create',
        targetType: 'oauth_client',
        sourceIp: '192.0.2.1',
      },
    );
    await deleteOauthClientForTenant(
      db,
      created.id,
      input.recipientTenantId,
      {
        actorType: 'operator',
        actorId: 'organization-admin',
        action: 'oauth_client.delete',
        targetType: 'oauth_client',
        sourceIp: '192.0.2.1',
      },
    );

    const rows = await db.select().from(auditLog);
    expect(rows.filter((row) => row.targetId === created.id)
      .map((row) => row.action).sort()).toEqual([
      'oauth_client.create',
      'oauth_client.delete',
    ]);
  });
});
