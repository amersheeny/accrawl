/**
 * Authentication for the engine's protected endpoints (`/crawl`, `/cancel`).
 *
 * Exactly one caller is meant to reach them: the control-plane. How it proves that depends on where
 * the engine runs, so the deployment says which proof it uses via `ENGINE_INBOUND_AUTH`:
 *
 *   - `shared-secret` — the control-plane sends `ENGINE_SHARED_SECRET` as the bearer. What the
 *     documented compose deployment uses: the engine is not published to the host, so this is
 *     defence in depth behind the internal network.
 *   - `token` — the caller presents a signed identity token, checked by the registered inbound
 *     identity verifier (see `inbound-identity.ts`) against `CRAWLER_AUDIENCE`. For deployments where
 *     the engine is reachable on a network whose callers carry an issuer-signed identity.
 *   - `none` — no proof. Only for local development, or a deployment that authenticates in front of
 *     the engine and says so deliberately.
 *
 * Unset, the mode is inferred from what is configured — an audience means tokens, a shared secret
 * means the shared secret, neither means nothing — so every existing deployment keeps its behaviour
 * without setting a new variable.
 *
 * In production the audience is MANDATORY for `token`: without it, any token the issuer signed would
 * pass on signature and expiry alone, which is no real authorization on a publicly reachable host. We
 * fail closed — `assertInboundAuthConfig()` throws at startup, and the middleware also rejects every
 * request with 500 if the audience is somehow missing at request time.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { resolveInboundIdentityVerifier } from './inbound-identity';

export type InboundAuthMode = 'token' | 'shared-secret' | 'none';

const MODES: readonly InboundAuthMode[] = ['token', 'shared-secret', 'none'];

/**
 * True when running in production (set via NODE_ENV=production by the deploy scripts).
 * In production the audience check is mandatory.
 */
function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

/**
 * How this deployment expects a caller to prove itself. Declared with `ENGINE_INBOUND_AUTH`;
 * otherwise inferred from what is configured, so an existing deployment keeps its behaviour.
 *
 * @throws Error if ENGINE_INBOUND_AUTH is set to something that is not a mode.
 */
export function inboundAuthMode(
  environment: NodeJS.ProcessEnv = process.env,
): InboundAuthMode {
  const declared = environment.ENGINE_INBOUND_AUTH?.trim();
  if (declared) {
    if ((MODES as readonly string[]).includes(declared)) return declared as InboundAuthMode;
    throw new Error(
      `[auth] ENGINE_INBOUND_AUTH="${declared}" is not a mode. Use one of: ${MODES.join(', ')}.`,
    );
  }
  if (environment.CRAWLER_AUDIENCE?.trim()) return 'token';
  if (environment.ENGINE_SHARED_SECRET) return 'shared-secret';
  return 'none';
}

/**
 * Fail-closed startup guard. Call once at boot, before the server starts accepting traffic. A
 * misconfigured proof means the check would be a no-op, so we refuse to start rather than silently
 * regress.
 *
 * Only services that serve the protected routes need one: the tunnel service (SERVICE_MODE=tunnel)
 * never serves `/crawl` — it authenticates WebSocket clients with the tunnel token — so it must not
 * require an audience, otherwise it would crash on boot.
 *
 * @param crawlRoutesEnabled whether this service registers the /crawl route.
 * @throws Error when tokens are required but unusable: no audience in production, or no verifier.
 */
export function assertInboundAuthConfig(crawlRoutesEnabled: boolean): void {
  const mode = inboundAuthMode();
  if (!crawlRoutesEnabled) return;
  if (mode === 'token') {
    if (isProduction() && !process.env.CRAWLER_AUDIENCE) {
      throw new Error(
        '[auth] CRAWLER_AUDIENCE is not set but inbound identity tokens are required in production. '
        + 'Refusing to start: the audience check would be a no-op, accepting any token this issuer '
        + 'signed. Set CRAWLER_AUDIENCE to this service\'s public URL.',
      );
    }
    if (!resolveInboundIdentityVerifier()) {
      throw new Error(
        '[auth] Inbound identity tokens are required but no verifier is configured. Refusing to '
        + 'start: set OIDC_ISSUER to the issuer whose tokens this service accepts (or register a '
        + 'verifier), or set ENGINE_INBOUND_AUTH to another mode.',
      );
    }
    return;
  }
  if (mode === 'shared-secret' && !process.env.ENGINE_SHARED_SECRET) {
    throw new Error(
      '[auth] ENGINE_INBOUND_AUTH=shared-secret but ENGINE_SHARED_SECRET is not set. Refusing to '
      + 'start: the protected routes would accept every caller.',
    );
  }
  if (mode === 'none' && isProduction() && !process.env.ENGINE_INBOUND_AUTH) {
    console.warn(
      '[auth] The crawl routes are unauthenticated: no CRAWLER_AUDIENCE and no ENGINE_SHARED_SECRET '
      + 'are set. Anything that can reach this service can start a crawl. Set ENGINE_INBOUND_AUTH=none '
      + 'to record that this is deliberate.',
    );
  }
}

/**
 * Express middleware that authenticates the caller of a protected route, in whichever way this
 * deployment expects. Rejects with 401 when the proof is missing or invalid.
 */
export async function verifyInboundIdentity(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  let mode: InboundAuthMode;
  try {
    mode = inboundAuthMode();
  } catch (error) {
    console.error('[auth]', (error as Error).message);
    res.status(500).json({ error: 'Server auth misconfiguration' });
    return;
  }

  if (mode === 'none') {
    next();
    return;
  }

  if (mode === 'shared-secret') {
    const sharedSecret = process.env.ENGINE_SHARED_SECRET;
    if (!sharedSecret) {
      console.error('[auth] ENGINE_SHARED_SECRET is not set — rejecting rather than accepting every caller');
      res.status(500).json({ error: 'Server auth misconfiguration' });
      return;
    }
    const header = req.headers.authorization;
    const presented = header?.startsWith('Bearer ') ? header.slice(7) : '';
    // Constant-time compare via fixed-length digests (avoids the length-leak of timingSafeEqual).
    const a = createHash('sha256').update(presented).digest();
    const b = createHash('sha256').update(sharedSecret).digest();
    if (!timingSafeEqual(a, b)) {
      res.status(401).json({ error: 'invalid engine shared secret' });
      return;
    }
    next();
    return;
  }

  // Verify signature, expiration, and audience. CRAWLER_AUDIENCE is the URL the control-plane mints
  // its token for, set to this service's own URL during deployment.
  const audience = process.env.CRAWLER_AUDIENCE;

  // Fail closed in production: without an audience the check accepts ANY token this issuer signed.
  // Never silently degrade to signature-only verification.
  if (isProduction() && !audience) {
    console.error('[auth] CRAWLER_AUDIENCE missing in production — rejecting request to avoid accepting arbitrary identity tokens');
    res.status(500).json({ error: 'Server auth misconfiguration' });
    return;
  }

  const verifier = resolveInboundIdentityVerifier();
  if (!verifier) {
    console.error('[auth] no inbound identity verifier is configured — rejecting request');
    res.status(500).json({ error: 'Server auth misconfiguration' });
    return;
  }

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or invalid Authorization header' });
    return;
  }

  const token = authHeader.slice(7);

  // Optional defence in depth behind the platform's own access control: pin the accepted caller to a
  // single identity. Where the platform already restricts who can reach the container that binding is
  // the primary gate, but if it is ever loosened, audience+signature alone would accept any token
  // minted for this URL. When a caller is named, the token's verified identity must match it.
  const expectedCaller = process.env.ENGINE_ALLOWED_CALLER ?? process.env.CRAWLER_INVOKER_SA;

  try {
    const identity = await verifier.verify(token, audience);

    if (expectedCaller) {
      const matchesEmail = identity.emailVerified === true && identity.email === expectedCaller;
      if (!matchesEmail && identity.subject !== expectedCaller) {
        res.status(403).json({ error: 'Token not from the expected caller' });
        return;
      }
    }

    next();
  } catch {
    res.status(401).json({ error: 'Invalid identity token' });
  }
}
