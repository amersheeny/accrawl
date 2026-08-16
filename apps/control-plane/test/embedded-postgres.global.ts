/**
 * One real PostgreSQL for the whole test run.
 *
 * Two suites need a genuine server rather than an in-process substitute: the privilege and row-level
 * security assertions, and the migration and cancellation-ordering races. Both used to start a cluster
 * of their own, which meant two `initdb` runs — process-spawn and fsync heavy — racing each other and
 * every other test file for the machine. That is enough to push provisioning past its budget, and the
 * suite then passed or failed depending on what else was running.
 *
 * Started once here, before any file runs, and shared. Each suite creates its own database on it, so
 * they still cannot see each other's schema, roles or rows.
 */
import EmbeddedPostgres from 'embedded-postgres';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PORT = 55440;
const USER = 'accrawl';
const PASSWORD = 'accrawl';

let server: EmbeddedPostgres | undefined;
let directory: string | undefined;

export async function setup(): Promise<void> {
  directory = mkdtempSync(path.join(tmpdir(), 'accrawl-test-postgres-'));
  server = new EmbeddedPostgres({
    databaseDir: path.join(directory, 'data'),
    user: USER,
    password: PASSWORD,
    port: PORT,
    persistent: false,
  });
  await server.initialise();
  await server.start();
  // Address only, no scheme or credentials: each suite connects as whichever role it is testing, and a
  // URL with a non-special scheme does not parse into host and port reliably enough to rebuild.
  process.env.ACCRAWL_TEST_POSTGRES = `127.0.0.1:${PORT}`;
  process.env.ACCRAWL_TEST_POSTGRES_OWNER = `${USER}:${PASSWORD}`;
}

export async function teardown(): Promise<void> {
  await server?.stop();
  if (directory) rmSync(directory, { recursive: true, force: true });
}
