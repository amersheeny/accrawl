/**
 * Request/job-scoped tenant runtime.
 *
 * The hosted cell runs one control-plane process for many tenants, but every tenant
 * owns a separate database and secret namespace. AsyncLocalStorage makes the tenant
 * selection part of the async call chain, so existing domain modules can keep using
 * the shared `db` facade without accepting a tenant id on every function.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { config } from '../config';
import { readSecret } from '../lib/secrets';

export interface TenantRuntime {
  id: string;
  hosts: readonly string[];
  databaseUrl: string;
  engineUrl: string;
  engineWsUrl?: string;
  engineSharedSecret?: string;
  identityAssertionSecret?: string;
  administrativeIdentityAssertionSecret?: string;
  credentialEncryptionKey?: string;
  screenshotDir?: string;
  screenshotBucket?: string;
  screenshotPrefix?: string;
  /** Per-tenant key used only to envelope crawl-job payloads at rest. */
  jobEncryptionKey?: string;
}

const storage = new AsyncLocalStorage<TenantRuntime>();

/**
 * The implicit self-hosted tenant is resolved lazily. Apart from avoiding an
 * import-order dependency on the hosted directory, this keeps config overrides
 * used by tests and embedded callers visible at the point of use.
 */
export function selfHostedTenant(): TenantRuntime {
  return {
    id: 'self-hosted',
    hosts: [],
    databaseUrl: config.databaseUrl,
    engineUrl: config.engineUrl,
    engineWsUrl: config.engineWsUrl,
    engineSharedSecret: config.engineSharedSecret,
    credentialEncryptionKey: readSecret('CREDENTIAL_ENC_KEY'),
    screenshotDir: config.screenshotDir,
  };
}

export function currentTenant(): TenantRuntime {
  const tenant = storage.getStore();
  if (tenant) return tenant;
  // A hosted request/job must always carry an explicit AsyncLocalStorage
  // context. Never silently fall back to the first catalog tenant.
  if (config.tenantDirectoryFile) throw new Error('Tenant context is unavailable');
  return selfHostedTenant();
}

export function runAsTenant<T>(tenant: TenantRuntime, fn: () => T): T {
  return storage.run(tenant, fn);
}

/** Fastify's callback-style lifecycle continues in the async resource where done() is invoked. */
export function bindTenant(tenant: TenantRuntime, done: (error?: Error) => void): void {
  storage.run(tenant, done);
}
