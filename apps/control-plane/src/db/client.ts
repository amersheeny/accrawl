/**
 * Tenant-aware Drizzle + postgres.js client registry.
 *
 * Note: the ENGINE runs under a separate, least-privilege Postgres role (staged
 * inserts for its own session only) — see the deployment docs. This client is the
 * control-plane's full-access role.
 */
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { currentTenant } from '../tenancy/context';
import { fallbackTenant, hostedCell } from '../tenancy/directory';
import * as schema from './schema';

// Pool size: DB_POOL_MAX if set (so an operator can size it to their Postgres), else 10 in production but 1
// under test. The socket-backed tests run against a single-connection pglite socket that RESETS under
// concurrent pool connections (e.g. verifyApiKey's fire-and-forget lastUsedAt stamp racing the next foreground
// query — an intermittent ECONNRESET); pinning the test pool to 1 serializes that away. Real Postgres has no
// such limit, so production is unaffected. An explicit DB_POOL_MAX always wins.
const configuredPoolMax = Number(process.env.DB_POOL_MAX);
if (hostedCell && configuredPoolMax > 0 && configuredPoolMax < 2) {
  throw new Error('Hosted cells require DB_POOL_MAX >= 2 for the HA watcher leadership connection');
}
const poolMax = configuredPoolMax
  || (process.env.NODE_ENV === 'test' ? 1 : hostedCell ? 2 : 10);
function createClient(databaseUrl: string) {
  const sql = postgres(databaseUrl, {
    max: poolMax,
    idle_timeout: hostedCell ? 30 : 0,
    max_lifetime: hostedCell ? 30 * 60 : 0,
    connection: { application_name: 'accrawl-control-plane' },
  });
  return { sql, db: drizzle(sql, { schema }) };
}

type Client = ReturnType<typeof createClient>;
const clients = new Map<string, Client>();

function clientForCurrentTenant(): Client {
  const tenant = currentTenant();
  let client = clients.get(tenant.id);
  if (!client) {
    client = createClient(tenant.databaseUrl);
    clients.set(tenant.id, client);
  }
  return client;
}

export function getDb(): Client['db'] {
  return clientForCurrentTenant().db;
}

export function getSql(): Client['sql'] {
  return clientForCurrentTenant().sql;
}

export interface LeadershipLease {
  isHeld: () => Promise<boolean>;
  release: () => Promise<void>;
}

/**
 * Try to hold a session-scoped PostgreSQL advisory lock on one reserved pool
 * connection. The connection is the lease: a crashed pod loses it immediately,
 * and a standby can acquire the same lock on its next tick.
 */
export async function tryAcquireLeadershipLease(name: string): Promise<LeadershipLease | null> {
  const connection = await clientForCurrentTenant().sql.reserve();
  let released = false;
  try {
    const [result] = await connection<{ acquired: boolean }[]>`
      select pg_try_advisory_lock(hashtextextended(${name}, 0)) as acquired
    `;
    if (!result?.acquired) {
      connection.release();
      return null;
    }
  } catch (error) {
    connection.release();
    throw error;
  }

  return {
    isHeld: async () => {
      if (released) return false;
      const [result] = await connection<{ held: boolean }[]>`
        select exists (
          select 1
          from pg_locks
          where locktype = 'advisory'
            and pid = pg_backend_pid()
            and granted
        ) as held
      `;
      return result?.held === true;
    },
    release: async () => {
      if (released) return;
      released = true;
      try {
        await connection`
          select pg_advisory_unlock(hashtextextended(${name}, 0))
        `;
      } finally {
        connection.release();
      }
    },
  };
}

/** Close every tenant pool during graceful shutdown. */
export async function closeDatabasePools(): Promise<void> {
  const pools = [...clients.values()].map((client) => client.sql.end({ timeout: 5 }));
  clients.clear();
  await Promise.allSettled(pools);
}

export type Db = Client['db'];

/**
 * Compatibility facade used throughout the domain layer. Every property access is
 * resolved against the database selected by the current tenant context.
 */
export const db = new Proxy({} as Db, {
  get(_target, property) {
    const target = getDb() as unknown as Record<PropertyKey, unknown>;
    const value = Reflect.get(target, property, target);
    return typeof value === 'function' ? value.bind(target) : value;
  },
});

/** Legacy self-host/testing export. Hosted code should use getSql() in a tenant context. */
export const sql = (() => {
  let client = clients.get(fallbackTenant.id);
  if (!client) {
    client = createClient(fallbackTenant.databaseUrl);
    clients.set(fallbackTenant.id, client);
  }
  return client.sql;
})();

export { schema };
