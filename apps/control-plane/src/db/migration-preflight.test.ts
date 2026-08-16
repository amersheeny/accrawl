import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import postgres, { type Sql } from 'postgres';
import { prepareSessionStatusEnum } from './migration-preflight';

const PORT = 54368;
const MIGRATIONS = path.resolve(__dirname, '../../migrations');

describe('incremental session-status migration preflight', () => {
  let client: PGlite;
  let server: PGLiteSocketServer;
  let sql: Sql;

  beforeAll(async () => {
    client = new PGlite();
    for (const file of fs.readdirSync(MIGRATIONS)
      .filter((name) => name.endsWith('.sql') && name < '0013')
      .sort()) {
      let source = fs.readFileSync(path.join(MIGRATIONS, file), 'utf8');
      if (file.startsWith('0000_')) source = source.replace(", 'cancelling'", '');
      await client.exec(source);
    }
    server = new PGLiteSocketServer({ db: client, port: PORT });
    await server.start();
    sql = postgres(`postgres://localhost:${PORT}/postgres`, { max: 1 });
  });

  afterAll(async () => {
    await sql?.end();
    await server?.stop();
    await client?.close();
  });

  it('commits cancelling before Drizzle batches the enum and index migrations', async () => {
    const legacyLabels = await sql<Array<{ enumlabel: string }>>`
      select enumlabel
      from pg_enum
      where enumtypid = 'public.session_status'::regtype
      order by enumsortorder`;
    expect(legacyLabels.map((row) => row.enumlabel)).not.toContain('cancelling');

    await prepareSessionStatusEnum(sql);

    await expect(sql.begin(async (tx) => {
      for (const file of ['0013_sloppy_marvex.sql', '0014_loving_bloodaxe.sql']) {
        for (const statement of fs.readFileSync(path.join(MIGRATIONS, file), 'utf8')
          .split('--> statement-breakpoint')
          .map((value) => value.trim())
          .filter(Boolean)) {
          await tx.unsafe(statement);
        }
      }
    })).resolves.toBeUndefined();

    const [index] = await sql<Array<{ predicate: string }>>`
      select pg_get_expr(indpred, indrelid) as predicate
      from pg_index
      where indexrelid = 'sessions_active_connection_uq'::regclass`;
    expect(index.predicate).toContain('cancelling');
  });
});
