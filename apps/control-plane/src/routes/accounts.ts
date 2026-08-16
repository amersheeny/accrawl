/**
 * Account-centric console routes — the Accounts page.
 *
 *   GET /api/accounts                                -> { accounts: AccountView[] }   (operator-only: cross-connection)
 *   GET /api/accounts/:id/transactions               -> { items, hasMore, limit, offset }
 *   GET /api/connections/:id/unassigned-transactions -> { items, hasMore, limit, offset }
 *
 * Positions intentionally have NO per-account route: the data model carries no account↔position linkage
 * (see data/account-views.ts) — the console reads holdings per connection via /api/v1.
 * Auth mirrors the data API: operator, or an API key with read:data granted the underlying connection.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/client';
import { requireOperator, requireOperatorOrApiKey } from '../auth/middleware';
import { actorCanAccessAccount, actorCanAccessConnection } from '../auth/authorization';
import { requireOperatorSubject } from '../auth/subjects';
import { clampLimit } from '../data/public-data';
import { getUserDataStore } from '../storage';
import { HOSTED_COPY } from '@accrawl/contracts';

const pageSchema = z.object({
  limit: z.coerce.number().int().positive().optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export async function accountRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/accounts', { preHandler: requireOperator }, async (req) => {
    return {
      accounts: await (await getUserDataStore())
        .listAllAccounts(requireOperatorSubject(req)),
    };
  });

  app.get('/api/accounts/:id/transactions', { preHandler: requireOperatorOrApiKey('read:data') }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!(await actorCanAccessAccount(db, req, id))) {
      return reply.code(req.apiKey ? 403 : 404).send({
        error: req.apiKey ? 'api key is not authorized for this account' : 'account not found',
      });
    }
    const parsed = pageSchema.safeParse(req.query ?? {});
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'The page request is invalid. Refresh and try again.',
      });
    }
    const limit = clampLimit(parsed.data.limit);
    const page = await (await getUserDataStore())
      .listAccountTransactions(id, limit, parsed.data.offset ?? 0);
    if (!page) return reply.code(404).send({ error: 'account not found' });
    return { ...page, limit, offset: parsed.data.offset ?? 0 };
  });

  app.get('/api/connections/:id/unassigned-transactions', { preHandler: requireOperatorOrApiKey('read:data') }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!(await actorCanAccessConnection(db, req, id))) {
      return reply.code(req.apiKey ? 403 : 404).send({
        error: req.apiKey
          ? HOSTED_COPY.apiKeyCannotAccessConnection
          : HOSTED_COPY.connectionNotFound,
      });
    }
    const parsed = pageSchema.safeParse(req.query ?? {});
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'The page request is invalid. Refresh and try again.',
      });
    }
    const limit = clampLimit(parsed.data.limit);
    const page = await (await getUserDataStore())
      .listUnassignedTransactions(id, limit, parsed.data.offset ?? 0);
    return { ...page, limit, offset: parsed.data.offset ?? 0 };
  });
}
