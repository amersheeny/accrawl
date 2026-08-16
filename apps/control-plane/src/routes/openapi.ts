/**
 * Serve the OpenAPI description of the consumer/provider API. Public (no auth): the spec is just the API's
 * shape — it carries no secrets and integrators need it to generate clients before they hold a key.
 */
import type { FastifyInstance } from 'fastify';
import { openApiSpec } from '../openapi/spec';

export async function openApiRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/openapi.json', async (_req, reply) => {
    reply.header('content-type', 'application/json');
    return openApiSpec;
  });
}
