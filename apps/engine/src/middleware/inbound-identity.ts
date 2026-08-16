/**
 * Who the engine will accept a crawl from.
 *
 * The engine's protected routes (`/crawl`, `/cancel`) are reached by exactly one caller: the
 * control-plane. How that caller proves it is the control-plane depends on where the engine runs, so
 * the proof is supplied rather than assumed:
 *
 *   - a shared secret over the internal network — what the documented compose deployment uses, since
 *     the engine is not published to the host at all;
 *   - a signed identity token, when the engine is reachable on a network where the caller carries an
 *     identity from a token issuer both sides trust.
 *
 * The token route is a port. This module ships one implementation of it — plain OpenID Connect,
 * configured with an issuer — which is enough for any runtime whose caller identity is an OIDC token.
 * A deployment whose identities come from somewhere else registers its own instead; nothing else in
 * the engine changes.
 */

import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

/** What a verifier learned about the caller. Both fields are optional: an issuer that asserts only a
 *  subject is still a complete proof of identity, it just cannot be pinned by email. */
export interface InboundIdentity {
  /** The token subject, as the issuer names it. */
  subject?: string;
  /** The caller's email address, when the issuer asserts one. */
  email?: string;
  /** Whether the issuer vouches for that email. An unverified email pins nothing. */
  emailVerified?: boolean;
}

export interface InboundIdentityVerifier {
  /**
   * Establish that `token` was minted for `audience` by an issuer this deployment trusts, and return
   * who it says the caller is. Throw to reject — the caller is told only that the token was invalid.
   *
   * `audience` is undefined only outside production, where the engine accepts a token that proves an
   * issuer without proving it was meant for this service.
   */
  verify(token: string, audience: string | undefined): Promise<InboundIdentity>;
}

let registered: InboundIdentityVerifier | undefined;

/** Supply the verifier for deployments whose callers carry an identity this module cannot check. */
export function registerInboundIdentityVerifier(verifier: InboundIdentityVerifier): void {
  registered = verifier;
}

/** Test-only: drop a registered verifier so a case can start from the built-in resolution. */
export function resetInboundIdentityVerifierForTest(): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('resetInboundIdentityVerifierForTest is available only under NODE_ENV=test');
  }
  registered = undefined;
  discovered.clear();
}

/**
 * The verifier this deployment uses, or undefined when none is configured. A registered one wins; the
 * built-in OpenID Connect verifier answers whenever an issuer (or a JWKS URL) is configured.
 */
export function resolveInboundIdentityVerifier(
  environment: NodeJS.ProcessEnv = process.env,
): InboundIdentityVerifier | undefined {
  return registered ?? openIdConnectVerifier(environment);
}

/** JWKS handles are keyed by the URL they were built from: jose caches keys and honours rotation, so
 *  rebuilding one per request would re-fetch the key set on every call. */
const discovered = new Map<string, JWTVerifyGetKey>();

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** Keys and discovery must travel over TLS — plain HTTP would let anything on the path substitute the
 *  signing keys. A loopback address is exempt: it never leaves the machine, and a deployment being
 *  brought up against a local issuer needs to be able to try it. */
function secureUrl(value: string, name: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute https URL`);
  }
  if (parsed.protocol === 'https:') return parsed;
  if (parsed.protocol === 'http:' && LOOPBACK.has(parsed.hostname)) return parsed;
  throw new Error(`${name} must be an https URL (http is accepted only on loopback)`);
}

/** Ask the issuer where its keys are. The document must name the same issuer it was fetched from,
 *  otherwise a redirect could point the engine at somebody else's signing keys. */
async function discoverJwksUri(issuer: string): Promise<string> {
  const base = issuer.replace(/\/+$/, '');
  const response = await fetch(`${base}/.well-known/openid-configuration`);
  if (!response.ok) {
    throw new Error(`OIDC discovery for ${base} returned HTTP ${response.status}`);
  }
  const document = await response.json() as { issuer?: unknown; jwks_uri?: unknown };
  if (document.issuer !== base && document.issuer !== `${base}/`) {
    throw new Error(`OIDC discovery document for ${base} names a different issuer`);
  }
  if (typeof document.jwks_uri !== 'string') {
    throw new Error(`OIDC discovery document for ${base} has no jwks_uri`);
  }
  return document.jwks_uri;
}

async function keySet(issuer: string | undefined, jwksUrl: string | undefined): Promise<JWTVerifyGetKey> {
  const cacheKey = jwksUrl ?? issuer ?? '';
  const cached = discovered.get(cacheKey);
  if (cached) return cached;
  const url = secureUrl(
    jwksUrl ?? await discoverJwksUri(issuer as string),
    jwksUrl ? 'OIDC_JWKS_URL' : 'the issuer jwks_uri',
  );
  const handle = createRemoteJWKSet(url);
  discovered.set(cacheKey, handle);
  return handle;
}

/**
 * OpenID Connect, configured by environment:
 *   OIDC_ISSUER   — the issuer whose tokens are accepted; its keys are found by discovery.
 *   OIDC_JWKS_URL — where those keys are, when the issuer publishes no discovery document.
 *
 * Signatures are checked against the issuer's published keys, and the token must carry an expiry and
 * name this service as its audience. Symmetric algorithms are refused: a key set is public, so an
 * HMAC token "verified" against it would be forgeable by anyone who can read it.
 */
export function openIdConnectVerifier(
  environment: NodeJS.ProcessEnv = process.env,
): InboundIdentityVerifier | undefined {
  const issuer = environment.OIDC_ISSUER?.trim() || undefined;
  const jwksUrl = environment.OIDC_JWKS_URL?.trim() || undefined;
  if (!issuer && !jwksUrl) return undefined;
  if (issuer) secureUrl(issuer, 'OIDC_ISSUER');
  return {
    async verify(token, audience) {
      const { payload } = await jwtVerify(token, await keySet(issuer, jwksUrl), {
        ...(issuer ? { issuer: [issuer, `${issuer.replace(/\/+$/, '')}/`] } : {}),
        ...(audience ? { audience } : {}),
        algorithms: ['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512'],
        requiredClaims: ['exp'],
      });
      return {
        subject: payload.sub,
        email: typeof payload.email === 'string' ? payload.email : undefined,
        emailVerified: payload.email_verified === true,
      };
    },
  };
}
