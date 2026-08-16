import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/client';
import { armOtpRelayEpisode } from '../notifications/companion-wake';
import { currentTenant } from '../tenancy/context';

const requestSchema = z.strictObject({
  sessionId: z.uuid(),
});

export interface InternalEngineWakeRouteDependencies {
  secret?: string;
  wake?: (sessionId: string) => Promise<unknown>;
}

function exactBearer(
  authorization: string | string[] | undefined,
  secret: string | undefined,
): boolean {
  if (typeof authorization !== 'string' || !secret) return false;
  const supplied = Buffer.from(authorization, 'utf8');
  const expected = Buffer.from(`Bearer ${secret}`, 'utf8');
  try {
    return supplied.length === expected.length
      && timingSafeEqual(supplied, expected);
  } finally {
    supplied.fill(0);
    expected.fill(0);
  }
}

/** The engine can name only the session whose OTP transition it just committed.
 * All owner, connection, institution, epoch, device and payload fields are
 * resolved again from authoritative control-plane state. */
export async function internalEngineWakeRoutes(
  app: FastifyInstance,
  dependencies: InternalEngineWakeRouteDependencies = {},
): Promise<void> {
  const wake = dependencies.wake
    ?? ((sessionId: string) => armOtpRelayEpisode(db, sessionId));
  const configuredSecret = (): string | undefined => (
    Object.prototype.hasOwnProperty.call(dependencies, 'secret')
      ? dependencies.secret
      : currentTenant().engineSharedSecret
  );

  app.post('/internal/engine/companion/otp-wake', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    if (!exactBearer(request.headers.authorization, configuredSecret())) {
      return reply.code(401).send();
    }
    const parsed = requestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send();
    await wake(parsed.data.sessionId);
    return reply.code(204).send();
  });
}
