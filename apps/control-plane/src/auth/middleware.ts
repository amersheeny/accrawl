/**
 * Fastify auth guards.
 *
 *  - `requireOperator`         — a valid operator bearer token (the web UI / admin).
 *  - `requireApiKey(...scopes)` — a valid, unrevoked API key holding ALL listed scopes.
 *
 * Connection-level authorization (does this key grant THIS connection?) is checked in the
 * route handler via `keyGrantsConnection`, since it depends on the route's :connectionId.
 */
import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { db } from '../db/client';
import { verifyOperatorToken } from './operator';
import { verifyApiKey, keyHasScope, type ApiKeyContext, type ApiScope } from './apiKeys';
import { verifyDeviceToken, type DeviceContext } from '../data/devices';
import { verifyIdentityAssertion } from '@accrawl/contracts';
import { currentTenant } from '../tenancy/context';
import { SELF_HOSTED_OPERATOR_SUBJECT } from './subjects';

declare module 'fastify' {
  interface FastifyRequest {
    operator?: boolean;
    operatorSubject?: string;
    operatorEmail?: string;
    platformAdmin?: boolean;
    capabilities?: string[];
    apiKey?: ApiKeyContext;
    device?: DeviceContext;
  }
}

const ORGANIZATION_ADMIN_CAPABILITY = /^organization-admin:[a-z0-9][a-z0-9-]{0,62}$/;

function acceptIdentity(
  req: FastifyRequest,
  verified: { subject: string; email: string | null; capabilities: string[] },
): void {
  req.operator = true;
  req.operatorSubject = verified.subject;
  if (verified.email) req.operatorEmail = verified.email;
  req.capabilities = verified.capabilities;
  req.platformAdmin = verified.capabilities.includes('platform-admin');
}

/** Accept a method/path/tenant-bound assertion before route guards run.
 * Separate keys constrain the edge to user capabilities and the portal to
 * administrative capabilities even if either caller is compromised. */
export function acceptTrustedOperatorIdentity(req: FastifyRequest): void {
  const header = req.headers['x-accrawl-identity'];
  if (typeof header !== 'string') return;
  const tenant = currentTenant();
  if (!tenant.identityAssertionSecret) return;
  const expected = {
    tenantId: tenant.id,
    method: req.method,
    requestTarget: req.raw.url ?? req.url,
  };
  const user = verifyIdentityAssertion(
    tenant.identityAssertionSecret,
    header,
    expected,
  );
  if (user?.capabilities.length === 1
    && user.capabilities[0] === 'data-owner') {
    acceptIdentity(req, user);
    return;
  }
  const administrativeSecret = tenant.administrativeIdentityAssertionSecret;
  if (!administrativeSecret) return;
  const administrator = verifyIdentityAssertion(
    administrativeSecret,
    header,
    expected,
  );
  if (administrator?.capabilities.length === 1
    && (administrator.capabilities[0] === 'platform-admin'
      || ORGANIZATION_ADMIN_CAPABILITY.test(administrator.capabilities[0]))) {
    acceptIdentity(req, administrator);
  }
}

function bearerToken(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return null;
  const token = header.slice('Bearer '.length).trim();
  return token.length > 0 ? token : null;
}

async function authenticateOperator(req: FastifyRequest): Promise<boolean> {
  if (req.operator) return true;
  // Hosted mode has no local operator login: user and administrator identities
  // must arrive through the edge's request-bound signed assertion. A legacy
  // operator_credential row may still exist in a migrated tenant database, but
  // its bearer tokens must never bypass the hosted identity boundary.
  if (currentTenant().identityAssertionSecret) return false;
  const token = bearerToken(req);
  if (!token || !(await verifyOperatorToken(token))) return false;
  req.operator = true;
  req.operatorSubject = SELF_HOSTED_OPERATOR_SUBJECT;
  req.capabilities = ['platform-admin'];
  req.platformAdmin = true;
  return true;
}

function hasDataOwnerAccess(req: FastifyRequest): boolean {
  // The self-hosted operator owns that deployment's data. Hosted identities
  // have distinct user/admin roles and must carry the explicit data-owner
  // capability minted by the closed edge.
  return !currentTenant().identityAssertionSecret
    || req.capabilities?.includes('data-owner') === true;
}

export const requireOperator: preHandlerHookHandler = async (req, reply) => {
  if (!(await authenticateOperator(req))) {
    return reply.code(401).send({ error: 'Sign in to continue.' });
  }
  if (!hasDataOwnerAccess(req)) {
    return reply.code(403).send({ error: 'This account can’t open financial data. Sign in with the account that owns these connections.' });
  }
};

/** Every authenticated user can access the institution catalogue. Permissions
 * are resolved inside the route: a platform administrator manages every row;
 * every other identity manages only rows owned by its exact subject. */
export const requireInstitutionActor: preHandlerHookHandler = async (req, reply) => {
  if (!(await authenticateOperator(req))) {
    return reply.code(401).send({ error: 'Sign in to continue.' });
  }
};

export function requireApiKey(...scopes: ApiScope[]): preHandlerHookHandler {
  return async (req, reply) => {
    const presented = bearerToken(req);
    if (!presented) return reply.code(401).send({ error: 'api key required' });
    const ctx = await verifyApiKey(db, presented);
    if (!ctx) return reply.code(401).send({ error: 'invalid or revoked api key' });
    if (ctx.oauthGrantId) {
      return reply.code(404).send();
    }
    for (const scope of scopes) {
      if (!keyHasScope(ctx, scope)) return reply.code(403).send({ error: `missing required scope: ${scope}` });
    }
    req.apiKey = ctx;
  };
}

/** An authenticated guard body, in the shape Fastify accepts as an async preHandler. */
type AuthGuard = (
  req: FastifyRequest,
  reply: FastifyReply,
) => Promise<unknown>;

/**
 * Accept EITHER the operator (web UI / admin) OR an API key holding ALL listed scopes (Accrawl as a data
 * provider). This authenticates + scope-checks only; CONNECTION-level authorization (does the key grant THIS
 * :id?) MUST still be enforced in the handler via keyGrantsConnection — an operator is unconstrained, a key
 * is not. On the key path we set req.apiKey (and leave req.operator unset) so the handler can tell them apart.
 */
function requireOperatorOrApiKeyWithPolicy(
  allowOauthAccessTokens: boolean,
  ...scopes: ApiScope[]
): AuthGuard {
  return async (req, reply) => {
    if (await authenticateOperator(req)) {
      if (hasDataOwnerAccess(req)) return;
      return reply.code(403).send({ error: 'This account can’t open financial data. Sign in with the account that owns these connections.' });
    }
    const token = bearerToken(req);
    if (token) {
      const ctx = await verifyApiKey(db, token);
      if (ctx) {
        if (ctx.oauthGrantId && !allowOauthAccessTokens) {
          return reply.code(404).send();
        }
        for (const scope of scopes) {
          if (!keyHasScope(ctx, scope)) return reply.code(403).send({ error: `missing required scope: ${scope}` });
        }
        req.apiKey = ctx;
        return;
      }
    }
    return reply.code(401).send({ error: 'Sign in to continue, or authenticate with a valid API key.' });
  };
}

/** Internal operator/API-key endpoints reject OAuth-issued bearer tokens. */
export function requireOperatorOrApiKey(
  ...scopes: ApiScope[]
): preHandlerHookHandler {
  return requireOperatorOrApiKeyWithPolicy(false, ...scopes);
}

/** Methods that only read. The public API is defined by this set. */
const READ_ONLY_METHODS = new Set(['GET', 'HEAD']);

/**
 * The documented public resource API. It accepts both manually issued API keys
 * and OAuth access tokens, with identical scope and connection-grant checks.
 *
 * READ-ONLY BY CONSTRUCTION. The public API serves data Accrawl has already
 * retrieved; it never mutates anything and has no crawl vocabulary. That is not
 * merely how the current routes happen to be written — this guard refuses any
 * non-read method outright, so a future route cannot quietly turn a consumer
 * credential into a write by registering the wrong preHandler.
 */
export function requireOperatorOrPublicApiKey(
  ...scopes: ApiScope[]
): preHandlerHookHandler {
  const authenticate = requireOperatorOrApiKeyWithPolicy(true, ...scopes);
  return async (req, reply) => {
    if (!READ_ONLY_METHODS.has(req.method)) {
      return reply.code(405).send({ error: 'the public API is read-only' });
    }
    return authenticate(req, reply);
  };
}

/** A valid, unrevoked companion device token (the Android OTP-relay registering its push token). */
export const requireDevice: preHandlerHookHandler = async (req, reply) => {
  const presented = bearerToken(req);
  if (!presented) return reply.code(401).send({ error: 'device token required' });
  const ctx = await verifyDeviceToken(db, presented);
  if (!ctx) return reply.code(401).send({ error: 'invalid or revoked device token' });
  req.device = ctx;
};

/**
 * OTP relay accepts EITHER the operator (manual web-UI entry) OR a paired companion device (auto-relay).
 * The session's own otp-handshake state is the real gate on whether a code is accepted (see submitOtp).
 */
export const requireOperatorOrDevice: preHandlerHookHandler = async (req, reply) => {
  if (await authenticateOperator(req)) {
    if (hasDataOwnerAccess(req)) return;
    return reply.code(403).send({ error: 'This account can’t open financial data. Sign in with the account that owns these connections.' });
  }
  const token = bearerToken(req);
  if (token) {
    const ctx = await verifyDeviceToken(db, token);
    if (ctx) {
      req.device = ctx;
      return;
    }
  }
  return reply.code(401).send({ error: 'Sign in to continue, or authenticate with a paired companion device.' });
};

/** Hosted platform administration is explicitly attested by the closed edge.
 * The single self-hosted operator remains its own administrator. */
export const requirePlatformAdmin: preHandlerHookHandler = async (req, reply) => {
  if (!(await authenticateOperator(req))) {
    return reply.code(401).send({ error: 'Sign in to continue.' });
  }
  if (!req.platformAdmin) {
    return reply.code(403).send({ error: 'Only a platform administrator can do this. Sign in with a platform administrator account or ask one for help.' });
  }
};

/** Organisation administrators can only read grants addressed to the exact
 * organisation id carried in both their signed capability and the route. */
export const requireOrganizationAdmin: preHandlerHookHandler = async (req, reply) => {
  if (!(await authenticateOperator(req))) {
    return reply.code(401).send({ error: 'authentication required' });
  }
  const organizationId = (req.params as { organizationId?: unknown }).organizationId;
  if (typeof organizationId !== 'string') {
    return reply.code(400).send({ error: 'Select a recipient organisation before continuing.' });
  }
  if (!req.capabilities?.includes(`organization-admin:${organizationId}`)) {
    return reply.code(403).send({ error: 'Only an organisation administrator can do this. Sign in with an organisation administrator account or ask one for help.' });
  }
};

/** Features whose storage is intentionally deployment-singleton remain
 * available to self-hosting only until they have an owner-keyed schema. */
export const requireSelfHostedOperator: preHandlerHookHandler = async (req, reply) => {
  if (!(await authenticateOperator(req))) {
    return reply.code(401).send({ error: 'Sign in to continue.' });
  }
  if (currentTenant().identityAssertionSecret) {
    return reply.code(403).send({ error: 'this setting is managed by the hosted service' });
  }
};
