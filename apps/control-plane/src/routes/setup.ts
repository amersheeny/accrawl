/**
 * First-run setup: the operator sets the admin password ONCE. Until then the deployment is uninitialized,
 * and the web UI shows a setup screen instead of login (gated on GET /api/setup/status).
 *
 *  GET  /api/setup/status        -> { initialized: boolean }
 *  POST /api/setup { password }  -> 201 { token }   (only while uninitialized; 409 afterwards)
 *
 * The password is stored only as an argon2id hash (never plaintext). A successful setup logs the operator
 * straight in (returns a session token), so there is no separate login step on first run.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config';
import { db } from '../db/client';
import {
  isOperatorInitialized,
  initializeOperator,
  OperatorAlreadyInitializedError,
  OperatorSetupError,
} from '../data/operator-credential';
import { mintOperatorToken, clearOperatorAuthCache } from '../auth/operator';

const setupSchema = z.object({
  password: z.string().min(8).max(256),
  setupCode: z.string().min(1).max(512).optional(),
});

/**
 * Compare without letting the time taken say how much of the code was right.
 *
 * Both sides are hashed first so the comparison is over two equal-length digests: `timingSafeEqual`
 * throws on differing lengths, and catching that would leak the length through the error instead.
 */
function claimMatches(supplied: string, expected: string): boolean {
  return timingSafeEqual(
    createHash('sha256').update(supplied).digest(),
    createHash('sha256').update(expected).digest(),
  );
}

export async function setupRoutes(app: FastifyInstance): Promise<void> {
  // Unauthenticated by necessity (there is no operator yet) but safe: it reveals only whether setup is done.
  app.get('/api/setup/status', async () => ({ initialized: await isOperatorInitialized(db) }));

  // Rate-limited like login: a one-shot privileged write. `initializeOperator` is itself race-safe
  // (INSERT ... ON CONFLICT DO NOTHING), so a second/concurrent attempt cannot overwrite the credential.
  app.post('/api/setup', { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } }, async (req, reply) => {
    const parsed = setupSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'password must be 8–256 characters' });
    }
    // Checked before the password is looked at, and answered identically whether the code is absent or
    // wrong: a caller without it learns only that they need one.
    const expected = config.setupClaimToken;
    if (!expected) {
      return reply.code(403).send({
        error: 'setup_code_not_configured',
        message: 'This deployment has no setup code configured. Set SETUP_CLAIM_TOKEN and restart Accrawl before trying again.',
      });
    }
    if (!parsed.data.setupCode || !claimMatches(parsed.data.setupCode, expected)) {
      return reply.code(403).send({
        error: 'setup_code_invalid',
        message: 'The setup code is missing or does not match this deployment. Use this deployment\'s SETUP_CLAIM_TOKEN value.',
      });
    }
    try {
      await initializeOperator(db, parsed.data.password);
    } catch (err) {
      if (err instanceof OperatorAlreadyInitializedError) {
        return reply.code(409).send({ error: 'already initialized' });
      }
      if (err instanceof OperatorSetupError) {
        return reply.code(400).send({ error: err.message });
      }
      throw err;
    }
    clearOperatorAuthCache(); // pick up the freshly-written signing secret
    return reply.code(201).send({ token: await mintOperatorToken() });
  });
}
