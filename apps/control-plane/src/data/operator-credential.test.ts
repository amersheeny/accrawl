import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import * as schema from '../db/schema';
import type { Db } from '../db/client';
import {
  getOperatorCredential,
  isOperatorInitialized,
  initializeOperator,
  OperatorAlreadyInitializedError,
  OperatorSetupError,
} from './operator-credential';
import { verifyPassword } from '../auth/password';

const MIGRATIONS = path.resolve(__dirname, '../../migrations');
async function freshDb(): Promise<{ client: PGlite; db: Db }> {
  const client = new PGlite();
  const db = drizzle(client, { schema }) as unknown as Db;
  for (const f of fs.readdirSync(MIGRATIONS).filter((x) => x.endsWith('.sql')).sort()) {
    await client.exec(fs.readFileSync(path.join(MIGRATIONS, f), 'utf8'));
  }
  return { client, db };
}

describe('operator-credential (pglite)', () => {
  let client: PGlite;
  let db: Db;
  beforeAll(async () => { ({ client, db } = await freshDb()); });
  afterAll(async () => { await client.close(); });

  it('starts uninitialized', async () => {
    expect(await isOperatorInitialized(db)).toBe(false);
    expect(await getOperatorCredential(db)).toBeNull();
  });

  it('initializes once: stores an argon2id hash (never plaintext) + a 32-byte signing secret', async () => {
    const cred = await initializeOperator(db, 'super-secret-pw');
    expect(cred.passwordHash.startsWith('$argon2id$')).toBe(true);
    expect(cred.passwordHash).not.toContain('super-secret-pw');
    expect(cred.tokenSigningSecret).toMatch(/^[0-9a-f]{64}$/);
    expect(await verifyPassword(cred.passwordHash, 'super-secret-pw')).toBe(true);
    expect(await isOperatorInitialized(db)).toBe(true);
  });

  it('refuses a second initialization and leaves the original credential intact', async () => {
    await expect(initializeOperator(db, 'a-different-password')).rejects.toBeInstanceOf(
      OperatorAlreadyInitializedError,
    );
    const cred = await getOperatorCredential(db);
    expect(cred).not.toBeNull();
    // still verifies against the FIRST password — the second attempt did not overwrite it
    expect(await verifyPassword(cred!.passwordHash, 'super-secret-pw')).toBe(true);
    expect(await verifyPassword(cred!.passwordHash, 'a-different-password')).toBe(false);
  });

  it('singleton CHECK rejects any row other than id=1 (proves migration 0002 applied + the CHECK enforces)', async () => {
    const { client: c3, db: db3 } = await freshDb();
    try {
      await expect(
        db3.insert(schema.operatorCredential).values({ id: 2, passwordHash: 'x', tokenSigningSecret: 'y' }),
      ).rejects.toThrow();
    } finally {
      await c3.close();
    }
  });

  it('rejects a too-short password without writing a row', async () => {
    const { client: c2, db: db2 } = await freshDb();
    try {
      await expect(initializeOperator(db2, 'short')).rejects.toBeInstanceOf(OperatorSetupError);
      expect(await isOperatorInitialized(db2)).toBe(false);
    } finally {
      await c2.close();
    }
  });
});
