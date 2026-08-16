import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireApiKey } from '../auth/middleware';
import { db } from '../db/client';
import {
  listCompanionAccounts, listCompanionTransactions,
} from '../data/companion-data';

const pageSchema = z.object({
  limit: z.coerce.number().int().positive().max(100).default(50),
  cursor: z.string().max(2048).optional(),
});

function transportAllowed(req: FastifyRequest): boolean {
  if (req.protocol === 'https') return true;
  return process.env.NODE_ENV !== 'production'
    && process.env.ACCRAWL_COMPANION_ALLOW_INSECURE_HTTP === '1';
}

function denyInsecure(req: FastifyRequest, reply: FastifyReply): boolean {
  if (transportAllowed(req)) return false;
  void reply.code(426).send({
    error: 'Use HTTPS to access financial data in the companion app.',
  });
  return true;
}

export async function companionRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/companion/accounts', { preHandler: requireApiKey('read:companion') }, async (req, reply) => {
    if (denyInsecure(req, reply)) return reply;
    const parsed = pageSchema.safeParse(req.query ?? {});
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'The page request is invalid. Refresh and try again.',
      });
    }
    try {
      const page = await listCompanionAccounts(
        db,
        req.apiKey!,
        parsed.data.limit,
        parsed.data.cursor,
      );
      return reply.header('Cache-Control', 'no-store').send(page);
    } catch (error) {
      if (error instanceof Error && error.message === 'invalid companion credential') {
        return reply.code(401).send({
          error: 'access is no longer authorized',
          code: 'access_revoked',
        });
      }
      if (error instanceof Error && error.message === 'invalid cursor') {
        return reply.code(400).send({
          error: 'The page request is invalid. Refresh and try again.',
        });
      }
      throw error;
    }
  });

  app.get('/api/companion/transactions', { preHandler: requireApiKey('read:companion') }, async (req, reply) => {
    if (denyInsecure(req, reply)) return reply;
    const parsed = pageSchema.safeParse(req.query ?? {});
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'The page request is invalid. Refresh and try again.',
      });
    }
    try {
      const page = await listCompanionTransactions(
        db,
        req.apiKey!,
        parsed.data.limit,
        parsed.data.cursor,
      );
      return reply.header('Cache-Control', 'no-store').send(page);
    } catch (error) {
      if (error instanceof Error && error.message === 'invalid companion credential') {
        return reply.code(401).send({
          error: 'access is no longer authorized',
          code: 'access_revoked',
        });
      }
      if (error instanceof Error && error.message === 'invalid cursor') {
        return reply.code(400).send({
          error: 'The page request is invalid. Refresh and try again.',
        });
      }
      throw error;
    }
  });

  app.get('/api/companion/accounts/:id/transactions', { preHandler: requireApiKey('read:companion') }, async (req, reply) => {
    if (denyInsecure(req, reply)) return reply;
    const parsed = pageSchema.safeParse(req.query ?? {});
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'The page request is invalid. Refresh and try again.',
      });
    }
    try {
      const page = await listCompanionTransactions(
        db,
        req.apiKey!,
        parsed.data.limit,
        parsed.data.cursor,
        (req.params as { id: string }).id,
      );
      return reply.header('Cache-Control', 'no-store').send(page);
    } catch (error) {
      if (error instanceof Error && error.message === 'invalid companion credential') {
        return reply.code(401).send({
          error: 'access is no longer authorized',
          code: 'access_revoked',
        });
      }
      if (error instanceof Error && error.message === 'invalid cursor') {
        return reply.code(400).send({
          error: 'The page request is invalid. Refresh and try again.',
        });
      }
      if (error instanceof Error && error.message === 'account not found') {
        return reply.code(404).send({ error: error.message });
      }
      throw error;
    }
  });
}
