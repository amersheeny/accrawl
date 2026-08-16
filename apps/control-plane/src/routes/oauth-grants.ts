/**
 * OAuth grant management (operator-only) — the "Connected apps" surface.
 *
 *  GET    /api/grants        -> { grants: [...] }   which third-party apps hold access, over which scopes +
 *                                                    connections, when granted, when it expires, and status.
 *  DELETE /api/grants/:id    -> 204 | 404            revoke: the app loses access at once (access + refresh
 *                                                    tokens are revoked with the grant).
 */
import type { FastifyInstance } from 'fastify';
import { db } from '../db/client';
import { requireOperator } from '../auth/middleware';
import {
  getGrantClientPublicId,
  listGrants,
  revokeGrant,
} from '../data/oauth-grants';
import { dispatchGrantWebhook } from '../webhooks/dispatch';
import { requireOperatorSubject } from '../auth/subjects';
import { getUserDataStore } from '../storage';

export async function oauthGrantRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/grants', { preHandler: requireOperator }, async (req) => {
    return { grants: await listGrants(db, requireOperatorSubject(req)) };
  });

  app.delete('/api/grants/:id', { preHandler: requireOperator }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const ownerSubject = requireOperatorSubject(req);
    // Resolve the app's PUBLIC client_id (accl_…) BEFORE revoking, so the grant.revoked webhook can name
    // the app whose access was pulled. A revoked/missing grant still resolves here (we don't filter on
    // revokedAt); revokeGrant below is the authority on whether anything actually changed.
    const clientPublicId = await getGrantClientPublicId(
      db,
      id,
      ownerSubject,
    );
    const outcome = await revokeGrant(db, id, ownerSubject);
    if (outcome === 'not_found') return reply.code(404).send({ error: 'grant not found' });
    await (await getUserDataStore()).writeAudit({ actorType: 'operator', actorId: req.operatorSubject, action: 'oauth_grant.revoke', targetType: 'oauth_grant', targetId: id, sourceIp: req.ip });
    // Fire the webhook ONLY on an actual revocation (not a repeat DELETE of an already-revoked grant — a
    // no-op must not emit a spurious event). Fire-and-forget: a receiver must never gate the revoke (it
    // already committed); errors are logged inside dispatch, we only stop an unhandled rejection escaping.
    if (outcome === 'revoked') {
      void dispatchGrantWebhook(db, {
        grantId: id,
        clientId: clientPublicId,
      }).catch((error) => {
        req.log.warn({ error }, 'grant.revoked webhook dispatch failed');
      });
    }
    return reply.code(204).send(); // idempotent: a repeat DELETE of an already-revoked grant is still 204
  });
}
