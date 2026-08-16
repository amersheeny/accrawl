/**
 * Runnable entrypoint for the least-privilege engine-role grants (the convergent logic lives in
 * engine-grants.ts so it can be execution-tested). Run after migrations, before the server starts:
 * the container entrypoint does `db:migrate && db:grant-engine && start`. No-op when ENGINE_DB_PASSWORD
 * is unset (single-role dev).
 */
import postgres from 'postgres';
import { applyEngineGrants } from './engine-grants';
import { hostedCell, tenantDirectory } from '../tenancy/directory';

export async function runEngineGrants(): Promise<void> {
  if (!hostedCell && !process.env.ENGINE_DB_PASSWORD) {
    // eslint-disable-next-line no-console
    console.log('[grant-engine] ENGINE_DB_PASSWORD unset — skipping; engine will share DATABASE_URL.');
    return;
  }
  for (const tenant of tenantDirectory.tenants) {
    const enginePassword = process.env.ENGINE_DB_PASSWORD;
    if (!enginePassword) throw new Error(`Engine DB password is missing for tenant ${tenant.id}`);
    const sql = postgres(tenant.databaseUrl, { max: 1 });
    try {
      await applyEngineGrants(
        sql,
        enginePassword,
        undefined,
        process.env.ENGINE_ROLE_MANAGED_EXTERNALLY !== 'true',
      );
      // eslint-disable-next-line no-console
      console.log(`[grant-engine] least-privilege grants applied for tenant ${tenant.id}`);
    } finally {
      await sql.end();
    }
  }
}

if (require.main === module) {
  runEngineGrants().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[grant-engine] failed:', err);
    process.exit(1);
  });
}
