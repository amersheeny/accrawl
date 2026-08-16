import { describe, expect, it } from 'vitest';
import { INTERNAL_TENANT_HOST_HEADER } from '@accrawl/contracts';
import { requestTenantHost } from './request-host';

describe('internal tenant host selection', () => {
  it('ignores the internal header unless explicitly enabled', () => {
    expect(requestTenantHost({
      host: 'a.accrawl.test',
      [INTERNAL_TENANT_HOST_HEADER]: 'b.accrawl.test',
    }, false)).toBe('a.accrawl.test');
  });

  it('preserves Host fallback and accepts one trusted internal value', () => {
    expect(requestTenantHost({
      host: 'accrawl-core-abc123-ew.a.run.app',
    }, true)).toBe('accrawl-core-abc123-ew.a.run.app');
    expect(requestTenantHost({
      host: 'accrawl-core-abc123-ew.a.run.app',
      [INTERNAL_TENANT_HOST_HEADER]: 'a.accrawl.test',
    }, true)).toBe('a.accrawl.test');
  });

  it('fails closed on repeated internal tenant headers', () => {
    expect(requestTenantHost({
      host: 'accrawl-core-abc123-ew.a.run.app',
      [INTERNAL_TENANT_HOST_HEADER]: ['a.accrawl.test', 'b.accrawl.test'],
    }, true)).toBeUndefined();
  });
});
