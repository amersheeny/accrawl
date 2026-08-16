/**
 * Deployed build version.
 *
 *  GET /version -> { version }   (the git short SHA baked in at launch, or "unknown")
 *
 * Unauthenticated by design — it reveals only the deployment's short git SHA (no secrets), so the
 * `./accrawl status` lifecycle command can compare the running build against the working tree and warn on a
 * stale deployment without needing an operator token. Routed at /version (like /health, not under /api); the
 * Caddy front door proxies it to the control-plane.
 */
import type { FastifyInstance } from 'fastify';
import { config } from '../config';

export async function versionRoutes(app: FastifyInstance): Promise<void> {
  app.get('/version', async () => ({ version: config.version }));
}
