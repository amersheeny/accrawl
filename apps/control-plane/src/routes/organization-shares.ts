import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  requireOrganizationAdmin,
  requirePlatformAdmin,
} from '../auth/middleware';
import { getUserDataStore } from '../storage';

const organizationId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);
const organizationInput = z.object({
  disabled: z.boolean().optional().default(false),
  id: organizationId,
  name: z.string().trim().min(1).max(120),
  provisioningId: z.string().regex(/^[A-Za-z0-9_-]{43}$/).optional(),
}).strict().refine(
  (value) => !value.provisioningId || value.disabled,
  { path: ['disabled'] },
);
const organizationStateInput = z.object({ disabled: z.boolean() }).strict();
const organizationProvisioningInput = z.object({
  provisioningId: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
}).strict();
export async function organizationShareRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/organizations/:organizationId',
    { preHandler: requireOrganizationAdmin },
    async (req) => {
      const id = (req.params as { organizationId: string }).organizationId;
      const organization = await (await getUserDataStore()).getOrganization(id);
      return { organizations: organization ? [organization] : [] };
    },
  );

  app.get('/api/admin/organizations', { preHandler: requirePlatformAdmin }, async () => {
    return {
      organizations: await (await getUserDataStore()).listOrganizations(true),
    };
  });

  app.post('/api/admin/organizations', { preHandler: requirePlatformAdmin }, async (req, reply) => {
    const parsed = organizationInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    const store = await getUserDataStore();
    const created = await store.createOrganization(parsed.data);
    await store.writeAudit({
      actorType: 'operator',
      actorId: req.operatorSubject,
      action: 'organization.create',
      targetType: 'organization',
      targetId: created.id,
      sourceIp: req.ip,
    });
    return reply.code(201).send(created);
  });

  app.patch('/api/admin/organizations/:organizationId', { preHandler: requirePlatformAdmin }, async (req, reply) => {
    const id = (req.params as { organizationId: string }).organizationId;
    const parsed = organizationStateInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    const store = await getUserDataStore();
    const updated = await store.setOrganizationDisabled(id, parsed.data.disabled);
    if (!updated) {
      return reply.code(404).send({
        error: 'We couldn’t find that organisation. Refresh and try again.',
      });
    }
    await store.writeAudit({
      actorType: 'operator',
      actorId: req.operatorSubject,
      action: parsed.data.disabled ? 'organization.disable' : 'organization.enable',
      targetType: 'organization',
      targetId: id,
      sourceIp: req.ip,
    });
    return updated;
  });

  app.post(
    '/api/admin/organizations/:organizationId/activate-provisioning',
    { preHandler: requirePlatformAdmin },
    async (req, reply) => {
      const id = (req.params as { organizationId: string }).organizationId;
      const parsed = organizationProvisioningInput.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
      let updated;
      try {
        updated = await (await getUserDataStore()).activateOrganizationProvisioning(
          id,
          parsed.data.provisioningId,
        );
      } catch (error) {
        if (error instanceof Error
          && error.message === 'organization-provisioning-unavailable') {
          return reply.code(409).send({ error: error.message });
        }
        throw error;
      }
      if (!updated) {
        return reply.code(404).send({
          error: 'We couldn’t find that organisation. Refresh and try again.',
        });
      }
      await (await getUserDataStore()).writeAudit({
        actorType: 'operator',
        actorId: req.operatorSubject,
        action: 'organization.provisioning.activate',
        targetType: 'organization',
        targetId: id,
        sourceIp: req.ip,
      });
      return updated;
    },
  );

}
