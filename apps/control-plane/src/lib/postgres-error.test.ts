import { describe, expect, it } from 'vitest';
import { postgresErrorCode } from './postgres-error';

describe('postgresErrorCode', () => {
  it('reads direct and driver-wrapped PostgreSQL errors', () => {
    expect(postgresErrorCode({ code: '23505' })).toBe('23505');
    expect(postgresErrorCode(new Error('query failed', {
      cause: { code: '23503' },
    }))).toBe('23503');
  });

  it('returns undefined for non-PostgreSQL and cyclic errors', () => {
    expect(postgresErrorCode(new Error('network failed'))).toBeUndefined();
    const cyclic: { cause?: unknown } = {};
    cyclic.cause = cyclic;
    expect(postgresErrorCode(cyclic)).toBeUndefined();
  });
});
