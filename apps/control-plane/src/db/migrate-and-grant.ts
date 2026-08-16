import { runEngineGrants } from './apply-engine-grants';
import { runMigrations } from './migrate';

export async function migrateAndGrant(): Promise<void> {
  await runMigrations();
  await runEngineGrants();
}

if (require.main === module) {
  migrateAndGrant().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[migrate] failed:', err);
    process.exit(1);
  });
}
