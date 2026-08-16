/**
 * Connection routes (operator-only). Credentials are accepted in the request body, encrypted
 * immediately by the data layer, and never echoed back — every response is a secret-free view.
 * The external-consumer data API (API-key + connection-grant scoping) is a separate unit.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireOperator } from '../auth/middleware';
import {
  DomainMismatchError, LoginUrlOverrideError,
} from '../data/connections';
import { dataRoutes } from './data';
import { requireOperatorSubject } from '../auth/subjects';
import { postgresErrorCode } from '../lib/postgres-error';
import { getUserDataStore } from '../storage';
import { UnknownInstitutionError } from '../storage/user-data-store';
import { HOSTED_COPY } from '@accrawl/contracts';
import {
  DEFAULT_CRAWL_SCHEDULE,
  DEFAULT_CRAWL_TIMEZONE,
  isValidCrawlSchedule,
} from '../scheduling/crawl-schedule';

const createSchema = z.object({
  institutionId: z.string().min(1),
  username: z.string().min(1),
  password: z.string().min(1),
  dob: z.string().max(64).optional(),
  phone: z.string().max(64).optional(),
  loginUrlOverride: z.string().url().optional(),
  customInstructions: z.string().max(20000).optional(),
  crawlScheduleEnabled: z.boolean().optional(),
  crawlSchedule: z.string().max(120).optional(),
  crawlTimezone: z.string().max(100).optional(),
  nickname: z.string().max(120).optional(),
}).strict();
export const connectionUpdateSchema = createSchema
  .omit({ institutionId: true })
  .partial()
  .refine((value) => Object.keys(value).length > 0);
const verifySchema = z.object({ canonicalDomain: z.string().min(1).max(253) });

export async function connectionRoutes(app: FastifyInstance): Promise<void> {
  // The public, normalized data API (v1): the connection directory plus, per connection, GET
  // {accounts,transactions,holdings} and the transaction change cursor — read-only, with its own API-key +
  // connection-grant auth (independent of the operator guard on the routes below), serving the crawl-free
  // contract shapes. Registered here because it is connection-scoped.
  await app.register(dataRoutes);

  app.post('/api/connections', { preHandler: requireOperator }, async (req, reply) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    if (!isValidCrawlSchedule(
      parsed.data.crawlSchedule ?? DEFAULT_CRAWL_SCHEDULE,
      parsed.data.crawlTimezone ?? DEFAULT_CRAWL_TIMEZONE,
    )) {
      return reply.code(400).send({ error: HOSTED_COPY.scheduleInvalid });
    }
    try {
      const store = await getUserDataStore();
      const created = await store.createConnection(parsed.data, requireOperatorSubject(req));
      await store.writeAudit({ actorType: 'operator', actorId: req.operatorSubject, action: 'connection.create', targetType: 'connection', targetId: created.id, sourceIp: req.ip });
      return reply.code(201).send(created);
    } catch (err) {
      if (err instanceof LoginUrlOverrideError) return reply.code(400).send({ error: err.message });
      if (err instanceof UnknownInstitutionError || postgresErrorCode(err) === '23503') {
        return reply.code(400).send({ error: 'unknown institutionId' });
      }
      throw err;
    }
  });

  app.get('/api/connections', { preHandler: requireOperator }, async (req) => {
    const store = await getUserDataStore();
    return {
      connections: await store.listConnections(requireOperatorSubject(req)),
    };
  });

  app.get('/api/connections/:id', { preHandler: requireOperator }, async (req, reply) => {
    const row = await (await getUserDataStore()).getConnection(
      (req.params as { id: string }).id,
      requireOperatorSubject(req),
    );
    return row ?? reply.code(404).send({ error: HOSTED_COPY.connectionNotFound });
  });

  app.patch('/api/connections/:id', { preHandler: requireOperator }, async (req, reply) => {
    const parsed = connectionUpdateSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    try {
      const store = await getUserDataStore();
      const id = (req.params as { id: string }).id;
      if (parsed.data.crawlSchedule !== undefined || parsed.data.crawlTimezone !== undefined) {
        const current = await store.getConnection(id, requireOperatorSubject(req));
        if (!current) return reply.code(404).send({ error: HOSTED_COPY.connectionNotFound });
        if (!isValidCrawlSchedule(
          parsed.data.crawlSchedule ?? current.crawlSchedule,
          parsed.data.crawlTimezone ?? current.crawlTimezone,
        )) {
          return reply.code(400).send({ error: HOSTED_COPY.scheduleInvalid });
        }
      }
      const row = await store.updateConnection(
        id,
        parsed.data,
        requireOperatorSubject(req),
      );
      return row ?? reply.code(404).send({ error: HOSTED_COPY.connectionNotFound });
    } catch (err) {
      if (err instanceof LoginUrlOverrideError) return reply.code(400).send({ error: err.message });
      throw err;
    }
  });

  app.delete('/api/connections/:id', { preHandler: requireOperator }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const store = await getUserDataStore();
    const result = await store.deleteConnection(id, requireOperatorSubject(req));
    if (result === 'not_found') {
      return reply.code(404).send({ error: HOSTED_COPY.connectionNotFound });
    }
    if (result === 'active_crawl') {
      return reply.code(409).send({
        error: 'Wait for the crawl to finish or stop before deleting this connection.',
      });
    }
    await store.writeAudit({ actorType: 'operator', actorId: req.operatorSubject, action: 'connection.delete', targetType: 'connection', targetId: id, sourceIp: req.ip });
    return reply.code(204).send();
  });

  app.post('/api/connections/:id/verify-domain', { preHandler: requireOperator }, async (req, reply) => {
    const parsed = verifySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    try {
      const row = await (await getUserDataStore()).verifyLoginDomain(
        (req.params as { id: string }).id,
        parsed.data.canonicalDomain,
        requireOperatorSubject(req),
      );
      return row ?? reply.code(404).send({ error: HOSTED_COPY.connectionNotFound });
    } catch (err) {
      if (err instanceof DomainMismatchError) return reply.code(400).send({ error: err.message });
      throw err;
    }
  });
}
