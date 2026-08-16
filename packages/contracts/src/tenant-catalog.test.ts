import { describe, expect, it } from 'vitest';
import { CellTenantCatalogSchema } from './tenant-catalog';

describe('hosted runtime catalog contract', () => {
  it('accepts a partition keeping records and workers elsewhere, without legacy database secrets', () => {
    expect(CellTenantCatalogSchema.parse({
      version: 1,
      tenants: [{
        id: 'accrawl',
        hosts: ['accrawl.example'],
        identityAssertionSecret: 'user-assertion-secret',
        administrativeIdentityAssertionSecret: 'admin-assertion-secret',
        credentialEncryptionKey: 'credential-key',
        screenshotBucket: 'example-project-screenshots',
        jobEncryptionKey: 'job-envelope-key',
      }],
    }).tenants[0]).not.toHaveProperty('databaseUrl');
  });

  it('still rejects ambiguous secret sources', () => {
    expect(() => CellTenantCatalogSchema.parse({
      version: 1,
      tenants: [{
        id: 'accrawl',
        hosts: ['accrawl.example'],
        databaseUrl: 'postgres://inline',
        databaseUrlFile: '/run/secrets/database-url',
      }],
    })).toThrow(/at most one/);
  });
});
