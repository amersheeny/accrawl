import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { db, closeDatabasePools } from '../db/client';
import { institutions } from '../db/schema';
import { runAsTenant, type TenantRuntime } from './context';

const tenantA: TenantRuntime = {
  id: 'isolation-a',
  hosts: ['a.test'],
  databaseUrl: 'postgres://localhost:54361/postgres',
  engineUrl: 'http://engine',
};
const tenantB: TenantRuntime = {
  id: 'isolation-b',
  hosts: ['b.test'],
  databaseUrl: 'postgres://localhost:54362/postgres',
  engineUrl: 'http://engine',
};

describe('tenant database isolation', () => {
  const clients = [new PGlite(), new PGlite()];
  const servers = [
    new PGLiteSocketServer({ db: clients[0], port: 54361 }),
    new PGLiteSocketServer({ db: clients[1], port: 54362 }),
  ];

  beforeAll(async () => {
    const migrations = path.resolve(__dirname, '../../migrations');
    await Promise.all(clients.map(async (client) => {
      await migrate(drizzle(client), { migrationsFolder: migrations });
    }));
    await Promise.all(servers.map((server) => server.start()));
  });

  afterAll(async () => {
    await closeDatabasePools();
    await Promise.all(servers.map((server) => server.stop()));
    await Promise.all(clients.map((client) => client.close()));
  });

  it('keeps concurrent calls on separate physical databases', async () => {
    await Promise.all([
      runAsTenant(tenantA, () => db.insert(institutions).values({
        id: 'same-id',
        name: 'Tenant A Bank',
        loginUrl: 'https://a.bank.test',
        canonicalDomain: 'bank.test',
        type: 'bank',
      })),
      runAsTenant(tenantB, () => db.insert(institutions).values({
        id: 'same-id',
        name: 'Tenant B Bank',
        loginUrl: 'https://b.bank.test',
        canonicalDomain: 'bank.test',
        type: 'bank',
      })),
    ]);

    const [nameA, nameB] = await Promise.all([
      runAsTenant(tenantA, async () => (
        await db.select({ name: institutions.name }).from(institutions).where(eq(institutions.id, 'same-id'))
      )[0].name),
      runAsTenant(tenantB, async () => (
        await db.select({ name: institutions.name }).from(institutions).where(eq(institutions.id, 'same-id'))
      )[0].name),
    ]);
    expect(nameA).toBe('Tenant A Bank');
    expect(nameB).toBe('Tenant B Bank');
  });
});
