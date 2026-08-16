/**
 * Apply pending Drizzle migrations. Run via `pnpm --filter @accrawl/control-plane db:migrate`
 * (or in the container's entrypoint before the server starts).
 */
import path from 'node:path';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { tenantDirectory } from '../tenancy/directory';
import { prepareSessionStatusEnum } from './migration-preflight';

export async function runMigrations(): Promise<void> {
  const migrationsFolder = path.join(__dirname, '..', '..', 'migrations');
  for (const tenant of tenantDirectory.tenants) {
    const sql = postgres(tenant.databaseUrl, { max: 1 });
    try {
      await prepareSessionStatusEnum(sql);
      await migrate(drizzle(sql), { migrationsFolder });
    } finally {
      await sql.end();
    }
    // eslint-disable-next-line no-console
    console.log(`[migrate] migrations applied for tenant ${tenant.id}`);
  }
  // eslint-disable-next-line no-console
  console.log('[migrate] migrations applied from', migrationsFolder);
}

if (require.main === module) {
  runMigrations().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[migrate] failed:', err);
    process.exit(1);
  });
}
