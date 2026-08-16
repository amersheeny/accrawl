import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import {
  INTERNAL_TENANT_HOST_HEADER,
  signIdentityAssertion,
} from '@accrawl/contracts';
import type { FastifyInstance } from 'fastify';

const SECRETS = ['identity-a', 'identity-b'] as const;
const ADMIN_SECRETS = ['administrative-identity-a', 'administrative-identity-b'] as const;
const LEGACY_OPERATOR_SECRETS = ['legacy-operator-a', 'legacy-operator-b'] as const;

describe('hosted-cell HTTP tenant isolation', () => {
  const clients = [new PGlite(), new PGlite()];
  const servers: PGLiteSocketServer[] = [];
  let app: FastifyInstance;
  let directory: string;
  const ports: number[] = [];

  beforeAll(async () => {
    const migrations = path.resolve(__dirname, '../../migrations');
    const fixtures = await Promise.all(clients.map(async (client, index) => {
      await migrate(drizzle(client), { migrationsFolder: migrations });
      await client.query(
        `insert into institutions (id, name, login_url, canonical_domain, type)
         values ('same-id', $1, 'https://bank.test', 'bank.test', 'bank')`,
        [`Tenant ${index === 0 ? 'A' : 'B'} Bank`],
      );
      await client.query(
        `insert into operator_credential (id, password_hash, token_signing_secret)
         values (1, 'unused-in-hosted-mode', $1)`,
        [LEGACY_OPERATOR_SECRETS[index]],
      );
      await client.query(
        `insert into organizations (id, name)
         values ('firm-a', $1)`,
        [`Tenant ${index === 0 ? 'A' : 'B'} Firm`],
      );
      const server = new PGLiteSocketServer({ db: client, port: 0 });
      await server.start();
      const port = Number.parseInt(server.getServerConn().split(':').at(-1)!, 10);
      if (!Number.isInteger(port) || port <= 0) throw new Error('PGlite did not allocate a TCP port');
      return { port, server };
    }));
    servers.push(...fixtures.map((fixture) => fixture.server));
    ports.push(...fixtures.map((fixture) => fixture.port));
    directory = mkdtempSync(path.join(tmpdir(), 'accrawl-tenants-'));
    const catalogPath = path.join(directory, 'catalog.json');
    writeFileSync(catalogPath, JSON.stringify({
      version: 1,
      tenants: ports.map((port, index) => ({
        id: `tenant-${index === 0 ? 'a' : 'b'}`,
        hosts: [`${index === 0 ? 'a' : 'b'}.accrawl.test`],
        databaseUrl: `postgres://localhost:${port}/postgres`,
        engineSharedSecret: `engine-${index}`,
        engineDatabasePassword: `engine-db-${index}`,
        engineDatabaseRole: `accrawl_engine_tenant_${index === 0 ? 'a' : 'b'}`,
        identityAssertionSecret: SECRETS[index],
        administrativeIdentityAssertionSecret: ADMIN_SECRETS[index],
        credentialEncryptionKey: '11'.repeat(32),
        jobEncryptionKey: Buffer.alloc(32, index + 1).toString('base64'),
        screenshotBucket: `accrawl-tenant-${index === 0 ? 'a' : 'b'}-screenshots`,
        workerSecretProviderClass: `accrawl-tenant-${index === 0 ? 'a' : 'b'}-worker`,
      })),
    }), { mode: 0o600 });
    process.env.TENANT_DIRECTORY_FILE = catalogPath;
    process.env.TRUST_INTERNAL_TENANT_HOST_HEADER = 'true';
    process.env.NODE_ENV = 'test';
    vi.resetModules();
    const { buildServer } = await import('../index');
    app = await buildServer();
  }, 30_000);

  afterAll(async () => {
    await app?.close();
    const { closeDatabasePools } = await import('../db/client');
    await closeDatabasePools();
    for (const server of servers) await server.stop();
    for (const client of clients) await client.close();
    if (directory) rmSync(directory, { recursive: true, force: true });
    delete process.env.TENANT_DIRECTORY_FILE;
    delete process.env.TRUST_INTERNAL_TENANT_HOST_HEADER;
  });

  function assertion(
    tenantId: string,
    secret: string,
    capabilities: string[] = ['data-owner'],
    requestTarget = '/api/institutions',
    method = 'GET',
    email?: string,
    subject = 'operator-1',
  ): string {
    return signIdentityAssertion(secret, {
      tenantId,
      subject,
      email,
      capabilities,
      method,
      requestTarget,
    });
  }

  it.each([
    ['tenant-a', 'a.accrawl.test', SECRETS[0], 'Tenant A Bank'],
    ['tenant-b', 'b.accrawl.test', SECRETS[1], 'Tenant B Bank'],
  ])('routes %s to only its own database', async (tenantId, host, secret, expectedName) => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/institutions',
      headers: {
        host,
        'x-accrawl-identity': assertion(tenantId, secret),
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      institutions: [
        expect.objectContaining({ id: 'same-id', name: expectedName }),
      ],
    });
  });

  it('lets every owner add private institutions while administrators manage and publish independent copies', async () => {
    const request = (
      method: string,
      url: string,
      secret: string,
      capabilities: string[],
      subject: string,
      payload?: unknown,
    ) => app.inject({
      method,
      url,
      headers: {
        host: 'a.accrawl.test',
        'x-accrawl-identity': assertion(
          'tenant-a',
          secret,
          capabilities,
          url,
          method,
          undefined,
          subject,
        ),
      },
      ...(payload === undefined ? {} : { payload }),
    });
    const recipe = {
      id: 'shared-slug',
      name: 'User Bank',
      loginUrl: 'https://login.user-bank.test/',
      type: 'bank',
    };

    const ownerOneCreate = await request(
      'POST',
      '/api/institutions',
      SECRETS[0],
      ['data-owner'],
      'owner-one',
      recipe,
    );
    expect(ownerOneCreate.statusCode).toBe(201);
    const ownerOneInstitution = ownerOneCreate.json<{
      id: string;
      visibility: string;
      ownedByViewer: boolean;
      canManage: boolean;
      canPublish: boolean;
    }>();
    expect(ownerOneInstitution).toMatchObject({
      visibility: 'private',
      ownedByViewer: true,
      canManage: true,
      canPublish: false,
    });
    expect(ownerOneInstitution.id).toMatch(/^u-[a-f0-9]{62}$/);
    expect(ownerOneCreate.body).not.toContain('ownerSubject');
    expect(ownerOneCreate.body).not.toContain('catalogKey');

    const ownerTwoCreate = await request(
      'POST',
      '/api/institutions',
      SECRETS[0],
      ['data-owner'],
      'owner-two',
      recipe,
    );
    expect(ownerTwoCreate.statusCode).toBe(201);
    const ownerTwoInstitution = ownerTwoCreate.json<{ id: string }>();
    expect(ownerTwoInstitution.id).not.toBe(ownerOneInstitution.id);

    const managerCreate = await request(
      'POST',
      '/api/institutions',
      ADMIN_SECRETS[0],
      ['platform-admin'],
      'admin-one',
      {
        ...recipe,
        id: 'manager-bank',
        name: 'Manager Bank',
      },
    );
    expect(managerCreate.statusCode).toBe(201);
    const managerInstitution = managerCreate.json<{ id: string }>();
    expect(managerCreate.json()).toMatchObject({
      visibility: 'private',
      ownedByViewer: true,
      canManage: true,
      canPublish: true,
    });
    expect(managerInstitution.id).toMatch(/^u-[a-f0-9]{62}$/);

    const ownerTwoBeforePublish = await request(
      'GET',
      '/api/institutions',
      SECRETS[0],
      ['data-owner'],
      'owner-two',
    );
    expect(ownerTwoBeforePublish.statusCode).toBe(200);
    expect(ownerTwoBeforePublish.json().institutions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'same-id',
          visibility: 'published',
          ownedByViewer: false,
          canManage: false,
          canPublish: false,
        }),
        expect.objectContaining({
          id: ownerTwoInstitution.id,
          visibility: 'private',
          ownedByViewer: true,
          canManage: true,
          canPublish: false,
        }),
      ]),
    );
    expect(ownerTwoBeforePublish.body).not.toContain(ownerOneInstitution.id);

    const ownerCannotEditAdmin = await request(
      'PATCH',
      '/api/institutions/same-id',
      SECRETS[0],
      ['data-owner'],
      'owner-one',
      { name: 'Not allowed' },
    );
    expect(ownerCannotEditAdmin.statusCode).toBe(404);

    const adminList = await request(
      'GET',
      '/api/institutions',
      ADMIN_SECRETS[0],
      ['platform-admin'],
      'admin-one',
    );
    expect(adminList.statusCode).toBe(200);
    expect(adminList.json().institutions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: ownerOneInstitution.id,
        visibility: 'private',
        ownedByViewer: false,
        canManage: true,
        canPublish: true,
      }),
      expect.objectContaining({
        id: ownerTwoInstitution.id,
        visibility: 'private',
        ownedByViewer: false,
        canManage: true,
        canPublish: true,
      }),
      expect.objectContaining({
        id: managerInstitution.id,
        visibility: 'private',
        ownedByViewer: true,
        canManage: true,
        canPublish: true,
      }),
    ]));

    const adminEdit = await request(
      'PATCH',
      `/api/institutions/${ownerOneInstitution.id}`,
      ADMIN_SECRETS[0],
      ['platform-admin'],
      'admin-one',
      { name: 'Reviewed User Bank' },
    );
    expect(adminEdit.statusCode).toBe(200);
    expect(adminEdit.json().name).toBe('Reviewed User Bank');

    const publish = await request(
      'POST',
      `/api/institutions/${ownerOneInstitution.id}/publish`,
      ADMIN_SECRETS[0],
      ['platform-admin'],
      'admin-one',
    );
    expect(publish.statusCode).toBe(201);
    const published = publish.json<{ id: string }>();
    expect(publish.json()).toMatchObject({
      visibility: 'published',
      ownedByViewer: false,
      canManage: true,
      canPublish: false,
      name: 'Reviewed User Bank',
    });
    expect(published.id).not.toBe(ownerOneInstitution.id);

    const duplicatePublish = await request(
      'POST',
      `/api/institutions/${ownerOneInstitution.id}/publish`,
      ADMIN_SECRETS[0],
      ['platform-admin'],
      'admin-one',
    );
    expect(duplicatePublish.statusCode).toBe(409);
    expect(duplicatePublish.json()).toMatchObject({
      code: 'institution_publish_copy_exists',
      error:
        'A published copy of Reviewed User Bank already exists in this Accrawl workspace.',
    });

    const publishPublishedCopy = await request(
      'POST',
      `/api/institutions/${published.id}/publish`,
      ADMIN_SECRETS[0],
      ['platform-admin'],
      'admin-one',
    );
    expect(publishPublishedCopy.statusCode).toBe(409);
    expect(publishPublishedCopy.json()).toEqual({
      code: 'institution_already_published',
      error: 'This institution is already published.',
    });

    const adminAfterPublish = await request(
      'GET',
      '/api/institutions',
      ADMIN_SECRETS[0],
      ['platform-admin'],
      'admin-one',
    );
    expect(adminAfterPublish.json().institutions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: ownerOneInstitution.id,
        visibility: 'private',
        canPublish: false,
      }),
      expect.objectContaining({
        id: ownerTwoInstitution.id,
        visibility: 'private',
        canPublish: true,
      }),
    ]));

    const ownerTwoAfterPublish = await request(
      'GET',
      '/api/institutions',
      SECRETS[0],
      ['data-owner'],
      'owner-two',
    );
    expect(ownerTwoAfterPublish.json().institutions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: published.id,
          visibility: 'published',
          ownedByViewer: false,
          canManage: false,
          canPublish: false,
        }),
      ]),
    );

    const ownerCannotEditPublished = await request(
      'PATCH',
      `/api/institutions/${published.id}`,
      SECRETS[0],
      ['data-owner'],
      'owner-two',
      { name: 'Not allowed either' },
    );
    expect(ownerCannotEditPublished.statusCode).toBe(404);

    const crossOwnerConnection = await request(
      'POST',
      '/api/connections',
      SECRETS[0],
      ['data-owner'],
      'owner-two',
      {
        institutionId: ownerOneInstitution.id,
        username: 'owner-two',
        password: 'secret',
      },
    );
    expect(crossOwnerConnection.statusCode).toBe(400);

    const ownConnection = await request(
      'POST',
      '/api/connections',
      SECRETS[0],
      ['data-owner'],
      'owner-two',
      {
        institutionId: ownerTwoInstitution.id,
        username: 'owner-two',
        password: 'secret',
      },
    );
    expect(ownConnection.statusCode).toBe(201);
  });

  it('gives every authenticated non-platform role its own private institution catalogue', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/api/institutions',
      headers: {
        host: 'a.accrawl.test',
        'x-accrawl-identity': assertion(
          'tenant-a',
          ADMIN_SECRETS[0],
          ['organization-admin:firm-a'],
          '/api/institutions',
          'POST',
          undefined,
          'organization-user',
        ),
      },
      payload: {
        id: 'organisation-bank',
        name: 'Organisation User Bank',
        loginUrl: 'https://login.organisation-user-bank.test/',
        type: 'bank',
      },
    });
    expect(create.statusCode).toBe(201);
    expect(create.json()).toMatchObject({
      visibility: 'private',
      ownedByViewer: true,
      canManage: true,
      canPublish: false,
    });

    const list = await app.inject({
      method: 'GET',
      url: '/api/institutions',
      headers: {
        host: 'a.accrawl.test',
        'x-accrawl-identity': assertion(
          'tenant-a',
          ADMIN_SECRETS[0],
          ['organization-admin:firm-a'],
          '/api/institutions',
          'GET',
          undefined,
          'organization-user',
        ),
      },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().institutions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: create.json().id,
        visibility: 'private',
        ownedByViewer: true,
      }),
      expect.objectContaining({
        id: 'same-id',
        visibility: 'published',
        canManage: false,
      }),
    ]));
  });

  it('keeps the transport host while selecting the signed tenant internally', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/institutions',
      headers: {
        host: 'accrawl-core-abc123-ew.a.run.app',
        [INTERNAL_TENANT_HOST_HEADER]: 'a.accrawl.test',
        'x-accrawl-identity': assertion('tenant-a', SECRETS[0]),
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().institutions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'same-id', name: 'Tenant A Bank' }),
    ]));
  });

  it('rejects an unknown internal tenant host before identity acceptance', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/institutions',
      headers: {
        host: 'accrawl-core-abc123-ew.a.run.app',
        [INTERNAL_TENANT_HOST_HEADER]: 'unknown.accrawl.test',
        'x-accrawl-identity': assertion('tenant-a', SECRETS[0]),
      },
    });
    expect(response.statusCode).toBe(421);
  });

  it('does not accept one tenant assertion through another internal tenant host', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/institutions',
      headers: {
        host: 'accrawl-core-abc123-ew.a.run.app',
        [INTERNAL_TENANT_HOST_HEADER]: 'b.accrawl.test',
        'x-accrawl-identity': assertion('tenant-a', SECRETS[0]),
      },
    });
    expect(response.statusCode).toBe(401);
  });

  it('returns only the recipient organisation attested for its administrator', async () => {
    const requestTarget = '/api/organizations/firm-a';
    const response = await app.inject({
      method: 'GET',
      url: requestTarget,
      headers: {
        host: 'a.accrawl.test',
        'x-accrawl-identity': assertion(
          'tenant-a',
          ADMIN_SECRETS[0],
          ['organization-admin:firm-a'],
          requestTarget,
        ),
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      organizations: [{
        id: 'firm-a',
        name: 'Tenant A Firm',
        disabledAt: null,
      }],
    });

    const wrongOrganization = await app.inject({
      method: 'GET',
      url: requestTarget,
      headers: {
        host: 'a.accrawl.test',
        'x-accrawl-identity': assertion(
          'tenant-a',
          ADMIN_SECRETS[0],
          ['organization-admin:firm-b'],
          requestTarget,
        ),
      },
    });
    expect(wrongOrganization.statusCode).toBe(403);
  });

  it.each([
    ['GET', '/api/profile'],
    ['POST', '/api/shares'],
  ] as const)('keeps the removed data-owner initiated sharing endpoint unavailable: %s %s', async (
    method,
    requestTarget,
  ) => {
    const response = await app.inject({
      method,
      url: requestTarget,
      headers: {
        host: 'a.accrawl.test',
        'content-type': 'application/json',
        'x-accrawl-identity': assertion(
          'tenant-a',
          SECRETS[0],
          ['data-owner'],
          requestTarget,
          method,
          'owner@example.com',
        ),
      },
    });
    expect(response.statusCode).toBe(404);
  });

  it('keeps tenant context isolated across concurrent requests', async () => {
    const requests = Array.from({ length: 24 }, async (_, index) => {
      const tenant = index % 2 === 0
        ? { id: 'tenant-a', host: 'a.accrawl.test', secret: SECRETS[0], bank: 'Tenant A Bank' }
        : { id: 'tenant-b', host: 'b.accrawl.test', secret: SECRETS[1], bank: 'Tenant B Bank' };
      const response = await app.inject({
        method: 'GET',
        url: '/api/institutions',
        headers: {
          host: tenant.host,
          'x-accrawl-identity': assertion(tenant.id, tenant.secret),
        },
      });
      return { response, bank: tenant.bank };
    });
    for (const { response, bank } of await Promise.all(requests)) {
      expect(response.statusCode).toBe(200);
      const institutions = response.json().institutions as Array<{ id: string; name: string }>;
      expect(institutions.filter((institution) => institution.id === 'same-id')).toEqual([
        expect.objectContaining({ name: bank }),
      ]);
    }
  });

  it('rejects an unknown host before authentication or database selection', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/institutions',
      headers: { host: 'unknown.accrawl.test' },
    });
    expect(response.statusCode).toBe(421);
    expect(response.body).toBe('');
  });

  it('exposes only the process health probe without a tenant host', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/healthz',
      headers: { host: '10.0.0.8' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('does not accept one tenant assertion on another tenant host', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/institutions',
      headers: {
        host: 'b.accrawl.test',
        'x-accrawl-identity': assertion('tenant-a', SECRETS[0]),
      },
    });
    expect(response.statusCode).toBe(401);
  });

  it('rejects legacy self-hosted operator tokens in hosted mode', async () => {
    const { signToken } = await import('../auth/operator');
    const response = await app.inject({
      method: 'GET',
      url: '/api/institutions',
      headers: {
        host: 'a.accrawl.test',
        authorization: `Bearer ${signToken(
          LEGACY_OPERATOR_SECRETS[0],
          60_000,
          'tenant-a',
        )}`,
      },
    });
    expect(response.statusCode).toBe(401);
  });

  it.each([
    ['platform administrator', ADMIN_SECRETS[0], ['platform-admin'], 200],
    [
      'recipient organisation administrator',
      ADMIN_SECRETS[0],
      ['organization-admin:firm-a'],
      200,
    ],
    ['claimless identity', SECRETS[0], [], 401],
  ])('applies institution-catalogue access to a %s', async (
    _name,
    secret,
    capabilities,
    expectedStatus,
  ) => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/institutions',
      headers: {
        host: 'a.accrawl.test',
        'x-accrawl-identity': assertion(
          'tenant-a',
          secret,
          capabilities,
        ),
      },
    });
    expect(response.statusCode).toBe(expectedStatus);
  });

  it.each([
    ['edge key', SECRETS[0], ['platform-admin']],
    ['portal key', ADMIN_SECRETS[0], ['data-owner']],
  ])('rejects a capability outside the %s trust domain', async (
    _name,
    secret,
    capabilities,
  ) => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/institutions',
      headers: {
        host: 'a.accrawl.test',
        'x-accrawl-identity': assertion('tenant-a', secret, capabilities),
      },
    });
    expect(response.statusCode).toBe(401);
  });
});
