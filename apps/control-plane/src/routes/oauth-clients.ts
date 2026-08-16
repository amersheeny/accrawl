/**
 * OAuth client management: platform-wide operator endpoints plus
 * organisation-scoped endpoints for hosted tenant administrators.
 *
 *  POST   /api/oauth-clients   { name, redirectUris, allowedScopes, isPublic? }
 *                              -> { id, clientId, clientSecret }   (clientSecret shown ONCE; null if public)
 *  GET    /api/oauth-clients                                       -> { clients: [...] }  (never the secret/hash)
 *  DELETE /api/oauth-clients/:id                                   -> 204  (disables the client and invalidates
 *                                                                            codes, grants, and tokens)
 */
import type { FastifyInstance } from 'fastify';
import {
  HOSTED_COPY,
  oauthClientRegistrationSchema,
} from '@accrawl/contracts';
import { z } from 'zod';
import { db } from '../db/client';
import {
  requireOrganizationAdmin,
  requirePlatformAdmin,
} from '../auth/middleware';
import {
  createOauthClient,
  createOauthClientIdempotently,
  deleteOauthClient,
  deleteOauthClientForTenant,
  listOauthClients,
  OauthRegistrationConflictError,
} from '../auth/oauthClients';
import { getUserDataStore } from '../storage';
import { currentTenant } from '../tenancy/context';

const tenantIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);
const createClientSchema = oauthClientRegistrationSchema.extend({
  recipientTenantId: tenantIdSchema.default('self-hosted'),
}).strict();
const idempotencyKeySchema = z.string()
  .min(32)
  .max(128)
  .regex(/^[A-Za-z0-9._~-]+$/);

function registrationFieldCodes(
  error: z.ZodError,
): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const field = typeof issue.path[0] === 'string'
      ? issue.path[0]
      : '_form';
    fields[field] ??= issue.message;
  }
  return fields;
}

function organizationId(req: { params: unknown }): string {
  return (req.params as { organizationId: string }).organizationId;
}

export async function oauthClientRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/oauth-clients', { preHandler: requirePlatformAdmin }, async (req, reply) => {
    const parsed = createClientSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    const { id, clientId, clientSecret } = await createOauthClient(
      db,
      parsed.data,
      {
        actorType: 'operator',
        actorId: req.operatorSubject,
        action: 'oauth_client.create',
        targetType: 'oauth_client',
        sourceIp: req.ip,
      },
    );
    // clientSecret is returned ONCE here (null for a public/PKCE client) and never stored or shown again.
    return reply.code(201).send({ id, clientId, clientSecret });
  });

  app.get('/api/oauth-clients', { preHandler: requirePlatformAdmin }, async () => {
    return { clients: await listOauthClients(db) };
  });

  app.delete('/api/oauth-clients/:id', { preHandler: requirePlatformAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    // Every backend invalidates the client's authorization codes, grants,
    // refresh tokens, and OAuth-issued access tokens. PostgreSQL enforces that
    // through cascading deletion; a document-store backend retains audit history behind a
    // disabled marker and rejects every associated credential.
    await deleteOauthClient(db, id, {
      actorType: 'operator',
      actorId: req.operatorSubject,
      action: 'oauth_client.delete',
      targetType: 'oauth_client',
      sourceIp: req.ip,
    });
    return reply.code(204).send();
  });

  app.post(
    '/api/organizations/:organizationId/oauth-clients',
    { preHandler: requireOrganizationAdmin },
    async (req, reply) => {
      const parsed = oauthClientRegistrationSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({
          code: 'invalid_registration',
          error: HOSTED_COPY.oauthInvalidRegistration,
          fields: registrationFieldCodes(parsed.error),
        });
      }
      const recipientTenantId = organizationId(req);
      const idempotencyKey = idempotencyKeySchema.safeParse(
        req.headers['idempotency-key'],
      );
      if (!idempotencyKey.success) {
        return reply.code(400).send({
          code: 'request_verification_failed',
          error: HOSTED_COPY.oauthRequestVerificationFailed,
        });
      }
      const organization = await (await getUserDataStore())
        .getOrganization(recipientTenantId);
      if (!organization || organization.disabledAt !== null) {
        return reply.code(404).send();
      }
      const derivationSecret = currentTenant().credentialEncryptionKey;
      if (!derivationSecret) {
        throw new Error(
          'Tenant credential key is unavailable for app registration',
        );
      }
      try {
        const {
          id,
          clientId,
          clientSecret,
        } = await createOauthClientIdempotently(db, {
          ...parsed.data,
          recipientTenantId,
        }, idempotencyKey.data, derivationSecret, {
          actorType: 'operator',
          actorId: req.operatorSubject,
          action: 'oauth_client.create',
          targetType: 'oauth_client',
          sourceIp: req.ip,
        });
        return reply.code(201).send({ id, clientId, clientSecret });
      } catch (error) {
        if (error instanceof OauthRegistrationConflictError) {
          return reply.code(409).send({
            code: 'registration_outcome_unknown',
            error: HOSTED_COPY.oauthRegistrationOutcomeUnknown,
          });
        }
        throw error;
      }
    },
  );

  app.get(
    '/api/organizations/:organizationId/oauth-clients',
    { preHandler: requireOrganizationAdmin },
    async (req) => ({
      clients: await listOauthClients(db, organizationId(req)),
    }),
  );

  app.delete(
    '/api/organizations/:organizationId/oauth-clients/:id',
    { preHandler: requireOrganizationAdmin },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!await deleteOauthClientForTenant(
        db,
        id,
        organizationId(req),
        {
          actorType: 'operator',
          actorId: req.operatorSubject,
          action: 'oauth_client.delete',
          targetType: 'oauth_client',
          sourceIp: req.ip,
        },
      )) {
        return reply.code(404).send();
      }
      return reply.code(204).send();
    },
  );
}
