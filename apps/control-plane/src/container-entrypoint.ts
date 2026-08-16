import { migrateAndGrant } from './db/migrate-and-grant';

/**
 * Whether this container should create and migrate the database it starts beside.
 *
 * Only the built-in backend keeps records in a database this container runs; a deployment that
 * registered somewhere else brings its own storage, already provisioned, and has nothing here to
 * migrate. A name nothing is registered for is not rejected here — the registry that knows what exists
 * says so when the store is resolved, and can name what it does have.
 */
export function shouldBootstrapPostgres(
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  const backend = environment.PERSISTENCE_BACKEND?.trim() || 'postgres';
  if (backend !== 'postgres') return false;
  return environment.SKIP_DB_BOOTSTRAP !== 'true';
}

export async function startContainer(): Promise<void> {
  if (shouldBootstrapPostgres()) await migrateAndGrant();
  await import('./server-main');
}

if (require.main === module) {
  startContainer().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[control-plane] fatal:', err);
    process.exit(1);
  });
}
