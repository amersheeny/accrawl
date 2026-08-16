/**
 * Normalized data API (v1) — the whole public API (docs/spec-data-api.md). Serves the projected contract
 * shapes (two-level account type + subtype, balance triple, holdings + securities, a change cursor) and
 * nothing else.
 *
 *   GET  /api/v1/connections                            -> ConnectionSummary[]
 *   GET  /api/v1/connections/:id/accounts               -> ContractAccount[]
 *   GET  /api/v1/connections/:id/transactions           -> ContractTransaction[]  (?from&to&limit&offset)
 *   GET  /api/v1/connections/:id/transactions/sync      -> { added, modified, removed, nextCursor, hasMore }
 *   GET  /api/v1/connections/:id/holdings               -> { holdings, securities }
 *
 * READ-ONLY, and crawl-free in both directions: nothing here mentions how the data was retrieved, and
 * nothing here can start a retrieval. A consumer reads what Accrawl already has; freshness travels in the
 * data itself (`lastSyncedAt` on a connection, `asOf` on a balance). Retrieval belongs to the deployment
 * owner — the schedule each connection carries, or the operator console.
 *
 * Authorization: operator (unconstrained) OR an API key with read:data AND a grant for the connection.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { HOSTED_COPY } from '@accrawl/contracts';
import { db } from '../db/client';
import { requireOperatorOrPublicApiKey } from '../auth/middleware';
import { actorCanAccessConnection } from '../auth/authorization';
import {
  clampLimit, MAX_OFFSET,
} from '../data/public-data';
import { getUserDataStore } from '../storage';

const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const pageSchema = z.object({
  limit: z.coerce.number().int().positive().optional(),
  // Bounded: an unbounded offset is a scan-and-discard DoS (see MAX_OFFSET). Beyond it → 400.
  offset: z.coerce.number().int().min(0).max(MAX_OFFSET).optional(),
  from: IsoDate.optional(),
  to: IsoDate.optional(),
});
const syncSchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().positive().optional(),
});

/** Owner + grant guard. An API key must satisfy both its immutable owner and
 * explicit connection grants; an operator is limited to their own rows. */
async function grantsConnection(
  req: FastifyRequest,
  reply: FastifyReply,
  connectionId: string,
): Promise<boolean> {
  if (!(await actorCanAccessConnection(db, req, connectionId))) {
    reply.code(req.apiKey ? 403 : 404).send({
      error: req.apiKey
        ? HOSTED_COPY.apiKeyCannotAccessConnection
        : HOSTED_COPY.connectionNotFound,
    });
    return false;
  }
  return true;
}

export async function dataRoutes(app: FastifyInstance): Promise<void> {
  // Connection directory — grant-scoped for an API key (only connections it may touch), all for the operator.
  // The projection is crawl-free: id, institution, status enum, nickname, and the last-synced day.
  //
  // The institution is carried as DISPLAY metadata (name, type, logo), not just its slug: a consumer app
  // renders these connections to the person who authorized them, and an id like `example-bank` is a storage
  // key, never a name to show anyone. Only institutions the listed connections already reference are
  // revealed, so this exposes nothing the directory did not already imply — there is no way to enumerate the
  // catalogue through it.
  app.get('/api/v1/connections', { preHandler: requireOperatorOrPublicApiKey('read:data') }, async (req) => {
    const store = await getUserDataStore();
    const key = req.apiKey;
    const ownerSubject = key?.ownerSubject ?? req.operatorSubject;
    let rows;
    if (key && !key.connectionGrants.includes('*')) {
      // A scoped key: list only the explicit connection ids it was granted (empty grants → empty list).
      rows = key.connectionGrants.length > 0
        ? await store.listConnections(key.ownerSubject, key.connectionGrants)
        : [];
    } else {
      rows = ownerSubject ? await store.listConnections(ownerSubject) : [];
    }
    if (rows.length === 0 || !ownerSubject) return { items: [] };
    // Resolve each distinct institution once, under the SAME visibility the owner has: platform rows plus
    // their own private ones.
    const access = { kind: 'visible' as const, ownerSubject };
    const institutions = new Map(await Promise.all(
      [...new Set(rows.map((c) => c.institutionId))].map(async (id) =>
        [id, await store.getInstitution(id, access)] as const),
    ));
    return {
      items: rows.flatMap((c) => {
        const institution = institutions.get(c.institutionId);
        // A connection whose institution row is gone cannot be named honestly, so it is not listed rather
        // than listed under its slug.
        if (!institution) return [];
        return [{
          id: c.id,
          institutionId: c.institutionId,
          institutionName: institution.name,
          institutionType: institution.type,
          institutionLogoUrl: institution.logo ?? null,
          status: c.status,
          nickname: c.nickname,
          lastSyncedAt: c.crawlStats?.lastSuccessfulTxCrawlDay ?? null,
        }];
      }),
    };
  });

  app.get('/api/v1/connections/:id/accounts', { preHandler: requireOperatorOrPublicApiKey('read:data') }, async (req, reply) => {
    const connectionId = (req.params as { id: string }).id;
    if (!(await grantsConnection(req, reply, connectionId))) return reply;
    const parsed = pageSchema.safeParse(req.query ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    const limit = clampLimit(parsed.data.limit);
    const offset = parsed.data.offset ?? 0;
    const { items, hasMore } = await (await getUserDataStore())
      .listConnectionAccountsContract(connectionId, limit, offset);
    return { items, hasMore, limit, offset };
  });

  app.get('/api/v1/connections/:id/transactions', { preHandler: requireOperatorOrPublicApiKey('read:data') }, async (req, reply) => {
    const connectionId = (req.params as { id: string }).id;
    if (!(await grantsConnection(req, reply, connectionId))) return reply;
    const parsed = pageSchema.safeParse(req.query ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    const limit = clampLimit(parsed.data.limit);
    const offset = parsed.data.offset ?? 0;
    const { items, hasMore } = await (await getUserDataStore())
      .listConnectionTransactionsContract(
        connectionId,
        limit,
        offset,
        parsed.data.from,
        parsed.data.to,
      );
    return { items, hasMore, limit, offset };
  });

  // Static deeper segment — registered so it resolves distinctly from …/transactions.
  app.get('/api/v1/connections/:id/transactions/sync', { preHandler: requireOperatorOrPublicApiKey('read:data') }, async (req, reply) => {
    const connectionId = (req.params as { id: string }).id;
    if (!(await grantsConnection(req, reply, connectionId))) return reply;
    const parsed = syncSchema.safeParse(req.query ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    const limit = clampLimit(parsed.data.limit);
    return (await getUserDataStore())
      .transactionSyncPage(connectionId, parsed.data.cursor, limit);
  });

  app.get('/api/v1/connections/:id/holdings', { preHandler: requireOperatorOrPublicApiKey('read:data') }, async (req, reply) => {
    const connectionId = (req.params as { id: string }).id;
    if (!(await grantsConnection(req, reply, connectionId))) return reply;
    const parsed = pageSchema.safeParse(req.query ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    const limit = clampLimit(parsed.data.limit);
    const offset = parsed.data.offset ?? 0;
    const { holdings, securities, hasMore } = await (await getUserDataStore())
      .listConnectionHoldings(connectionId, limit, offset);
    return { holdings, securities, hasMore, limit, offset };
  });
}
