/**
 * Auth routes: operator login + API-key management (operator-only).
 *
 *  POST   /api/auth/login   { password }            -> { token }
 *  POST   /api/keys         { name, scopes, grants } -> { id, key }   (key shown ONCE)
 *  GET    /api/keys                                  -> { keys: [...] } (never the key/hash)
 *  DELETE /api/keys/:id                              -> 204            (revoke)
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/client';
import { verifyOperatorPassword, mintOperatorToken, revokeAllOperatorTokens } from '../auth/operator';
import {
  createApiKey,
  API_SCOPES,
  OPERATOR_MINTABLE_SCOPES,
  listApiKeys,
  revokeApiKey,
} from '../auth/apiKeys';
import { requireOperator } from '../auth/middleware';
import { hostedCell } from '../tenancy/directory';
import { requireOperatorSubject } from '../auth/subjects';
import { getUserDataStore } from '../storage';

const loginSchema = z.object({ password: z.string().min(1) });
const createKeySchema = z.object({
  name: z.string().min(1).max(120),
  scopes: z.array(z.enum(OPERATOR_MINTABLE_SCOPES)).min(1),
  // Least privilege: default to NO connections. A data key reads only connections the operator lists
  // explicitly; pass ['*'] consciously to grant all. Omitting it must never silently mint an all-access key.
  connectionGrants: z.array(z.string()).default([]),
  // Optional time-limit so a key has a bounded blast radius if leaked. Omit for a never-expiring key
  // (revocable only). Bounded to ~10 years to avoid an effectively-infinite-but-typo'd value.
  expiresInDays: z.number().int().positive().max(3650).optional(),
}).refine(
  (key) => !key.scopes.includes('write:crawl') || key.expiresInDays !== undefined,
  { path: ['expiresInDays'], message: 'a key that can start a crawl must expire' },
);

// Sign-in and sign-out-everywhere ask the same question of the caller, so they answer it in the same
// words. Shared as constants rather than repeated literals: two copies of a user-visible sentence drift
// apart, and the reviewed-copy gate counts occurrences precisely because a second one is a second thing
// a reader can see.
const PASSWORD_REQUIRED = 'password is required';
const INVALID_PASSWORD = 'invalid password';

export async function authRoutes(app: FastifyInstance): Promise<void> {
  // Strict per-route rate limit on the master-credential endpoint (overrides the global default) — the
  // operator password is the single highest-value brute-force target. Active in production; see buildServer.
  if (!hostedCell) {
    app.post('/api/auth/login', { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } }, async (req, reply) => {
      const parsed = loginSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: PASSWORD_REQUIRED });
      if (!(await verifyOperatorPassword(parsed.data.password))) {
        await new Promise((r) => setTimeout(r, 300)); // small friction on a wrong guess, on top of the limit
        return reply.code(401).send({ error: INVALID_PASSWORD });
      }
      return { token: await mintOperatorToken() };
    });
  }

  // Sign out everywhere. Operator tokens are stateless and last seven days, and the console keeps one in
  // the browser's local storage — so before this there was no way to end a session that had been copied
  // out, short of re-running first-run setup and hoping that was safe to attempt. Rotating the signing
  // secret ends every outstanding token at once, including this caller's: that is the point, not a
  // side effect, and it is why the password is required again rather than the bearer token alone. A
  // stolen token must not be able to lock the real operator out by revoking on their behalf.
  if (!hostedCell) {
    app.post('/api/auth/revoke-all', { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } }, async (req, reply) => {
      const parsed = loginSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: PASSWORD_REQUIRED });
      if (!(await verifyOperatorPassword(parsed.data.password))) {
        await new Promise((r) => setTimeout(r, 300));
        return reply.code(401).send({ error: INVALID_PASSWORD });
      }
      // Unreachable in practice: the password check above needs the operator credential, so there is
      // always a row to rotate by the time we get here. If that ever stops being true it is an internal
      // inconsistency, not something to explain to the caller — so it raises rather than inventing a
      // user-facing sentence for a state the user cannot be in or act on.
      if (!(await revokeAllOperatorTokens())) {
        throw new Error('operator credential vanished between password check and secret rotation');
      }
      return reply.code(204).send();
    });
  }

  app.post('/api/keys', { preHandler: requireOperator }, async (req, reply) => {
    const parsed = createKeySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    const { expiresInDays, ...rest } = parsed.data;
    const ownerSubject = requireOperatorSubject(req);
    const requestedGrants = rest.connectionGrants;
    const store = await getUserDataStore();
    const connectionGrants = requestedGrants.includes('*')
      ? ['*']
      : (await store.listConnections(ownerSubject, requestedGrants))
        .map((connection) => connection.id);
    if (connectionGrants.length !== requestedGrants.length) {
      return reply.code(400).send({
        error: 'Access to one or more connections is unavailable. Refresh and try again.',
      });
    }
    const expiresAt = expiresInDays != null ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000) : null;
    const { id, plaintext } = await createApiKey(db, {
      ...rest,
      connectionGrants,
      ownerSubject,
      expiresAt,
    });
    await store.writeAudit({ actorType: 'operator', actorId: req.operatorSubject, action: 'api_key.create', targetType: 'api_key', targetId: id, sourceIp: req.ip });
    // The plaintext key is returned ONCE here and never stored or shown again.
    return reply.code(201).send({ id, key: plaintext });
  });

  app.get('/api/keys', { preHandler: requireOperator }, async (req) => {
    return {
      keys: await listApiKeys(db, requireOperatorSubject(req)),
    };
  });

  app.delete('/api/keys/:id', { preHandler: requireOperator }, async (req, reply) => {
    const { id } = req.params as { id: string };
    await revokeApiKey(db, id, requireOperatorSubject(req));
    await (await getUserDataStore()).writeAudit({
      actorType: 'operator',
      actorId: req.operatorSubject,
      action: 'api_key.revoke',
      targetType: 'api_key',
      targetId: id,
      sourceIp: req.ip,
    });
    return reply.code(204).send();
  });
}
