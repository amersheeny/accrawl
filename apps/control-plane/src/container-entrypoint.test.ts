import { describe, expect, it } from 'vitest';
import { shouldBootstrapPostgres } from './container-entrypoint';

describe('control-plane container startup policy', () => {
  it('bootstraps PostgreSQL for the self-hosted default', () => {
    expect(shouldBootstrapPostgres({})).toBe(true);
    expect(shouldBootstrapPostgres({ PERSISTENCE_BACKEND: 'postgres' })).toBe(true);
  });

  it('preserves the explicit PostgreSQL bootstrap escape hatch', () => {
    expect(shouldBootstrapPostgres({
      PERSISTENCE_BACKEND: 'postgres',
      SKIP_DB_BOOTSTRAP: 'true',
    })).toBe(false);
  });

  it('never runs migrations for a backend that keeps its records elsewhere', () => {
    expect(shouldBootstrapPostgres({ PERSISTENCE_BACKEND: 'somewhere-else' })).toBe(false);
    // Even asked explicitly not to skip: there is nothing here to migrate, so the escape hatch has
    // nothing to switch back on.
    expect(shouldBootstrapPostgres({
      PERSISTENCE_BACKEND: 'somewhere-else',
      SKIP_DB_BOOTSTRAP: 'false',
    })).toBe(false);
  });

  it('creates nothing for a backend whose storage this container does not run', () => {
    // Whether the name means anything is the registry's question, and the server refuses to start when
    // it means nothing. What is decided here is narrower: there is no database beside this container to
    // migrate unless the built-in backend is the one in use.
    expect(shouldBootstrapPostgres({ PERSISTENCE_BACKEND: 'somewhere-else' })).toBe(false);
  });
});
