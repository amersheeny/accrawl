import type { FastifyRequest } from 'fastify';

/** Stable owner for the single local operator. Existing self-hosted rows
 * migrate to this value and therefore retain their original semantics. */
export const SELF_HOSTED_OPERATOR_SUBJECT = 'self-hosted:operator';

export function requireOperatorSubject(req: FastifyRequest): string {
  if (!req.operator || !req.operatorSubject) {
    throw new Error('authenticated operator subject is missing');
  }
  return req.operatorSubject;
}
