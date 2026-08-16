/**
 * Where this deployment keeps its records.
 *
 * The product is written against the store interface, not against a particular database, so a deployment
 * registers what it uses and everything else is unchanged. PostgreSQL is built in, because a deployment
 * that keeps its own records needs nothing from anyone.
 *
 * Some deployments can additionally run crawls somewhere else, which needs a handful of operations the
 * basic store does not have. That is declared rather than discovered: a provider says whether its store
 * supports the hosted crawl lifecycle, and callers ask for it by that name instead of assuming a
 * particular implementation and casting to it.
 */
import type { UserDataStore } from './user-data-store';
import type { HostedCrawlLifecycleStore } from './hosted-crawl-lifecycle';
import { config } from '../config';
import { currentTenant } from '../tenancy/context';
import type { Db } from '../db/client';

export interface PersistenceContext {
  /** The tenant whose records are being served. */
  runtimePartitionId: string;
  /** A caller-supplied SQL handle, for backends that use one; others ignore it. */
  postgresDb?: Db;
}

export interface PersistenceProvider {
  readonly name: string;
  /** True when the stores this provider builds also implement HostedCrawlLifecycleStore. */
  readonly hostedCrawlLifecycle: boolean;
  createUserDataStore(context: PersistenceContext): Promise<UserDataStore>;
}

const providers = new Map<string, PersistenceProvider>();
const storePromises = new Map<string, Promise<UserDataStore>>();

export function registerPersistenceProvider(provider: PersistenceProvider): void {
  providers.set(provider.name, provider);
}

/** The backends this deployment can use. Lets a composition assert what it registered. */
export function registeredPersistenceBackends(): string[] {
  return [...providers.keys()].sort();
}

/** PostgreSQL, always available: keeping records in a database this deployment runs needs no provider. */
registerPersistenceProvider({
  name: 'postgres',
  hostedCrawlLifecycle: false,
  async createUserDataStore(context) {
    const { PostgresUserDataStore } = await import('./postgres-user-data-store');
    if (context.postgresDb) return new PostgresUserDataStore(context.postgresDb);
    const { db } = await import('../db/client');
    return new PostgresUserDataStore(db);
  },
});

function unregistered(name: string): Error {
  return new Error(
    `No persistence provider is registered for PERSISTENCE_BACKEND="${name}". `
    + `Registered: ${[...providers.keys()].join(', ') || 'none'}.`,
  );
}

async function resolveProvider(name: string): Promise<PersistenceProvider> {
  const provider = providers.get(name);
  if (!provider) throw unregistered(name);
  return provider;
}

/**
 * Refuse to start when this deployment is configured for a backend nothing registered.
 *
 * Resolution alone would notice, but not until the first request that needs a store — so a misspelled
 * name would leave a server listening and healthy that cannot serve a single crawl. Asking at startup
 * turns that into a boot failure naming what is actually available.
 */
export function assertPersistenceBackendRegistered(): void {
  const backend = config.persistenceBackend || 'postgres';
  if (!providers.has(backend)) throw unregistered(backend);
}

/**
 * Lazily resolve the configured store. A deployment that keeps its records elsewhere never imports the
 * PostgreSQL client, so it can boot and serve requests with no database URL and no idle SQL connection.
 */
export function getUserDataStore(postgresDb?: Db): Promise<UserDataStore> {
  const runtimePartitionId = currentTenant().id;
  const backend = config.persistenceBackend || 'postgres';
  const create = async (): Promise<UserDataStore> => {
    const provider = await resolveProvider(backend);
    return provider.createUserDataStore({ runtimePartitionId, postgresDb });
  };
  // Domain helpers accept an explicit SQL handle so PGlite callers and request-scoped adapters operate
  // against the exact database they were handed; a store that does not use one keeps its tenant singleton.
  if (backend === 'postgres' && postgresDb) return create();
  let storePromise = storePromises.get(runtimePartitionId);
  if (!storePromise) {
    storePromise = create();
    storePromises.set(runtimePartitionId, storePromise);
  }
  return storePromise;
}

/** Whether this deployment can run crawls somewhere else and track their lifecycle. */
export async function hostedCrawlLifecycleAvailable(): Promise<boolean> {
  const backend = config.persistenceBackend || 'postgres';
  try {
    return (await resolveProvider(backend)).hostedCrawlLifecycle;
  } catch {
    return false;
  }
}

/**
 * The store, as a hosted crawl lifecycle. Asks the provider whether it supports one rather than assuming a
 * particular implementation, and still checks the store itself before handing it over — a provider that
 * claims support and does not deliver it should fail here, not halfway through a crawl.
 */
export async function getHostedCrawlLifecycleStore(): Promise<HostedCrawlLifecycleStore> {
  const backend = config.persistenceBackend || 'postgres';
  const provider = await resolveProvider(backend);
  if (!provider.hostedCrawlLifecycle) {
    throw new Error(
      `The "${provider.name}" persistence provider does not support the hosted crawl lifecycle`,
    );
  }
  const store = await getUserDataStore();
  const candidate = store as Partial<HostedCrawlLifecycleStore>;
  if (
    typeof candidate.reconcileCrawlLifecycle !== 'function'
    || typeof candidate.ensureScheduledConnections !== 'function'
  ) {
    throw new Error(
      `The "${provider.name}" persistence provider claims hosted crawl lifecycle support but its store does not implement it`,
    );
  }
  return store as HostedCrawlLifecycleStore;
}

/** Test-only reset for modules that switch backends between cases. */
export function resetUserDataStoreForTest(): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('resetUserDataStoreForTest is available only under NODE_ENV=test');
  }
  storePromises.clear();
}
