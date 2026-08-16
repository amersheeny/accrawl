/**
 * Global Fastify error handler.
 *
 * A 5xx response must NEVER echo the internal error message: an uncaught throw can carry a Postgres column
 * name, a driver string like "read ECONNRESET", or a cipher/`CREDENTIAL_ENC_KEY` detail — reachable even
 * unauthenticated (e.g. a DB error on the login path). We log the full error server-side and return a
 * generic body for 5xx. For 4xx we reproduce Fastify's DEFAULT `{ statusCode, error, message }` shape, so
 * validation / explicit client-error messages (which are safe and useful) are unchanged.
 */
import { STATUS_CODES } from 'node:http';
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';

export function apiErrorHandler(err: FastifyError, req: FastifyRequest, reply: FastifyReply): FastifyReply {
  const status = err.statusCode ?? 500;
  if (status >= 500) {
    req.log.error(err); // full detail stays server-side
    return reply.code(status).send({ error: 'internal error' });
  }
  return reply.code(status).send({ statusCode: status, error: STATUS_CODES[status] ?? 'Error', message: err.message });
}
