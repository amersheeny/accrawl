import { describe, expect, it } from 'vitest';
import {
  normalizeHost,
  TenantDirectory,
  tenantRuntimeFromCatalogEntry,
} from './directory';

describe('tenant host directory', () => {
  const a = {
    id: 'tenant-a',
    hosts: ['a.accrawl.test'],
    databaseUrl: 'postgres://a',
    engineUrl: 'http://engine',
  };
  const b = {
    id: 'tenant-b',
    hosts: ['b.accrawl.test'],
    databaseUrl: 'postgres://b',
    engineUrl: 'http://engine',
  };

  it('normalizes ports and resolves only an exact configured host', () => {
    const directory = new TenantDirectory([a, b]);
    expect(directory.resolveHost('A.ACCRAWL.TEST:443')?.id).toBe('tenant-a');
    expect(directory.resolveHost('b.accrawl.test')?.id).toBe('tenant-b');
    expect(directory.resolveHost('attacker.test')).toBeNull();
    expect(directory.resolveHost('a.accrawl.test.attacker.test')).toBeNull();
  });

  it('rejects malformed and duplicate hosts at startup', () => {
    expect(normalizeHost('a.accrawl.test/path')).toBeNull();
    expect(normalizeHost('user@a.accrawl.test')).toBeNull();
    expect(normalizeHost('a.accrawl.test:65536')).toBeNull();
    expect(normalizeHost('[2001:db8::1]:65536')).toBeNull();
    expect(() => new TenantDirectory([a, { ...b, hosts: ['A.ACCRAWL.TEST'] }])).toThrow(/Duplicate tenant host/);
  });

  it('rejects a shared user and administrative assertion trust key', () => {
    expect(() => new TenantDirectory([{
      ...a,
      identityAssertionSecret: 'shared-trust-key',
      administrativeIdentityAssertionSecret: 'shared-trust-key',
    }])).toThrow(/globally distinct/);
  });

  it('rejects assertion trust keys reused by another tenant', () => {
    expect(() => new TenantDirectory([
      {
        ...a,
        identityAssertionSecret: 'tenant-a-user',
        administrativeIdentityAssertionSecret: 'shared-cross-tenant-key',
      },
      {
        ...b,
        identityAssertionSecret: 'shared-cross-tenant-key',
        administrativeIdentityAssertionSecret: 'tenant-b-administrator',
      },
    ])).toThrow(/globally distinct/);
  });

  it('requires only the secrets used by a partition that keeps records and workers elsewhere', () => {
    const runtime = tenantRuntimeFromCatalogEntry({
      id: 'accrawl',
      hosts: ['accrawl.example'],
      identityAssertionSecret: 'user-assertion-key',
      administrativeIdentityAssertionSecret: 'admin-assertion-key',
      credentialEncryptionKey: 'credential-key',
      screenshotBucket: 'example-project-screenshots',
      jobEncryptionKey: 'job-envelope-key',
    }, {
      persistenceBackend: 'somewhere-else',
      engineDispatchMode: 'per-crawl-worker',
      fallbackDatabaseUrl: 'postgres://unused',
      fallbackEngineUrl: 'http://unused',
      fallbackWorkerNamespace: 'unused',
    });
    expect(runtime).toMatchObject({
      id: 'accrawl',
      databaseUrl: 'postgres://unused',
      screenshotBucket: 'example-project-screenshots',
      jobEncryptionKey: 'job-envelope-key',
    });
    expect(runtime).not.toHaveProperty('engineSharedSecret');
    expect(runtime).not.toHaveProperty('workerSecretName');
  });

  it('retains fail-closed PostgreSQL and Kubernetes requirements', () => {
    expect(() => tenantRuntimeFromCatalogEntry({
      id: 'legacy',
      hosts: ['legacy.accrawl.test'],
      identityAssertionSecret: 'user-assertion-key',
      administrativeIdentityAssertionSecret: 'admin-assertion-key',
      credentialEncryptionKey: 'credential-key',
      screenshotBucket: 'legacy-screenshots',
      jobEncryptionKey: 'job-envelope-key',
      workerSecretName: 'legacy-worker-secrets',
    }, {
      persistenceBackend: 'postgres',
      engineDispatchMode: 'kubernetes',
      fallbackDatabaseUrl: 'postgres://must-not-be-used',
      fallbackEngineUrl: 'http://unused',
      fallbackWorkerNamespace: 'accrawl-workers',
    })).toThrow(/databaseUrl/);
  });
});
