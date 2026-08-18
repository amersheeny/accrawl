/**
 * Operator authentication — single-operator self-host login, backed by the operator_credential store.
 *
 * The admin password is set by the first-run setup flow and stored as an argon2id hash (never plaintext);
 * login verifies the presented password against it. Session tokens are stateless and HMAC-signed with the
 * credential's `tokenSigningSecret`, so re-running setup (which mints a fresh secret) invalidates every
 * outstanding token. The signing secret is stable between setups, so it is cached in-process to avoid a
 * DB read on each authenticated request; `clearOperatorAuthCache()` drops it after setup writes a new one.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { db } from '../db/client';
import { getOperatorCredential, rotateOperatorTokenSigningSecret } from '../data/operator-credential';
import { verifyPassword } from './password';
import { currentTenant } from '../tenancy/context';

const TOKEN_PREFIX = 'accs1';
const DEFAULT_TTL_HOURS = 168; // 7 days
const MIN_TTL_HOURS = 1;
const MAX_TTL_HOURS = 720; // 30 days

/**
 * How long an operator session lasts, in hours.
 *
 * The token is a bearer credential held in browser storage, so its lifetime IS the window a stolen
 * one stays useful. Seven days suits an operator who checks in occasionally; it is far too long for
 * one working from a shared or untrusted machine, and until now neither could choose.
 *
 * Ending a session early is already possible for everyone through `POST /api/auth/revoke-all`, which
 * rotates the signing secret and invalidates every token at once — there is exactly one operator per
 * deployment, enforced in the schema, so that is a complete answer to a stolen token rather than a
 * blunt one. This only decides how long the window is before anyone has to notice.
 *
 * An unparseable or out-of-range value falls back to the default rather than failing the process: a
 * typo in a self-hoster's environment file should not stop their deployment from starting, and the
 * fallback is the safe end of the range in the sense that it is what they had before.
 */
function operatorTokenTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.OPERATOR_TOKEN_TTL_HOURS?.trim();
  const hours = raw ? Number(raw) : Number.NaN;
  const valid = Number.isFinite(hours) && hours >= MIN_TTL_HOURS && hours <= MAX_TTL_HOURS;
  return (valid ? hours : DEFAULT_TTL_HOURS) * 60 * 60 * 1000;
}

interface TokenPayload {
  exp: number; // epoch ms
  tid: string;
}

export { operatorTokenTtlMs };

const cachedSigningSecrets = new Map<string, string | null>();

/** Drop the cached signing secret so the next token operation reloads it from the DB (call after setup). */
export function clearOperatorAuthCache(): void {
  cachedSigningSecrets.delete(currentTenant().id);
}

async function signingSecret(): Promise<string | null> {
  const tenantId = currentTenant().id;
  if (cachedSigningSecrets.has(tenantId)) return cachedSigningSecrets.get(tenantId) ?? null;
  const cred = await getOperatorCredential(db);
  const secret = cred?.tokenSigningSecret ?? null;
  cachedSigningSecrets.set(tenantId, secret);
  return secret;
}

function b64u(buf: Buffer): string {
  return buf.toString('base64url');
}

// ── Pure token logic (no DB — unit-tested directly) ──────────────────────────

/** Sign a stateless operator token (prefix.payload.hmac) with an explicit secret. */
export function signToken(
  secret: string,
  ttlMs: number = operatorTokenTtlMs(),
  tenantId: string = 'self-hosted',
): string {
  const payload: TokenPayload = { exp: Date.now() + ttlMs, tid: tenantId };
  const payloadB64 = b64u(Buffer.from(JSON.stringify(payload), 'utf8'));
  const mac = b64u(createHmac('sha256', secret).update(`${TOKEN_PREFIX}.${payloadB64}`).digest());
  return `${TOKEN_PREFIX}.${payloadB64}.${mac}`;
}

/** Verify a token's signature + expiry against an explicit secret. */
export function verifyToken(secret: string, token: string, tenantId: string = 'self-hosted'): boolean {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) return false;
  const [, payloadB64, mac] = parts;

  const expectedMac = b64u(createHmac('sha256', secret).update(`${TOKEN_PREFIX}.${payloadB64}`).digest());
  const macBuf = Buffer.from(mac);
  const expBuf = Buffer.from(expectedMac);
  if (macBuf.length !== expBuf.length || !timingSafeEqual(macBuf, expBuf)) return false;

  try {
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as TokenPayload;
    return typeof payload.exp === 'number' && payload.tid === tenantId && Date.now() <= payload.exp;
  } catch {
    return false;
  }
}

// ── DB-backed operator operations ────────────────────────────────────────────

/** Verify a presented password against the stored argon2id hash. False if first-run setup hasn't happened. */
export async function verifyOperatorPassword(presented: string): Promise<boolean> {
  const cred = await getOperatorCredential(db);
  if (!cred) return false;
  return verifyPassword(cred.passwordHash, presented);
}

/** Mint an operator bearer token valid for `ttlMs`. Throws if setup hasn't run (no signing secret yet). */
export async function mintOperatorToken(ttlMs: number = operatorTokenTtlMs()): Promise<string> {
  const secret = await signingSecret();
  if (!secret) throw new Error('Operator auth unavailable: first-run setup has not completed.');
  return signToken(secret, ttlMs, currentTenant().id);
}

/**
 * End every operator session by rotating the secret their tokens are signed with.
 *
 * Tokens are stateless — nothing is stored to delete — so this is what "sign out everywhere" means
 * here, and it is the only answer to a token that has left the operator's own browser. The cache is
 * dropped in the same breath, so the very next request verifies against the new secret rather than a
 * stale in-process copy.
 *
 * Returns false when setup has not run, so a caller can tell "nothing to revoke" from "revoked".
 */
export async function revokeAllOperatorTokens(): Promise<boolean> {
  const rotated = await rotateOperatorTokenSigningSecret(db);
  clearOperatorAuthCache();
  return rotated !== null;
}

/** Verify an operator token's signature + expiry. False if setup hasn't run or the token is invalid/expired. */
export async function verifyOperatorToken(token: string): Promise<boolean> {
  const secret = await signingSecret();
  if (!secret) return false;
  return verifyToken(secret, token, currentTenant().id);
}

// ── Consent tickets (OAuth authenticate-first consent) ───────────────────────
//
// The "Connect with Accrawl" consent screen is authenticate-FIRST: the operator signs in before the page
// ever reveals their connection inventory (see routes/oauth.ts). A consent ticket carries proof of that
// password check from step 1 (sign-in) to step 2 (pick connections + approve), so the operator types their
// password exactly once. It is NOT an operator bearer token: it is bound to the ONE authorize request it was
// minted for (client + redirect + scope + PKCE challenge) and is useless for anything else, so embedding it
// in the consent form's HTML — where a full operator token must never go — is safe.

const CONSENT_TICKET_PREFIX = 'accsent1';

export interface ConsentTicketBinding {
  clientId: string;
  redirectUri: string;
  scope: string;
  codeChallenge: string;
}

/** Unambiguous serialization of the request a ticket is bound to (a JSON array — no field can bleed into
 *  the next regardless of its contents). */
function consentBindingMaterial(b: ConsentTicketBinding): string {
  return JSON.stringify([b.clientId, b.redirectUri, b.scope, b.codeChallenge]);
}

async function consentSigningSecret(): Promise<string | null> {
  const tenant = currentTenant();
  if (tenant.identityAssertionSecret) {
    // Hosted cells have no self-hosted operator-credential row. Derive a
    // protocol-specific HMAC key from the user-edge trust key so consent
    // tickets cannot be replayed as identity assertions (or vice versa).
    return createHmac('sha256', tenant.identityAssertionSecret)
      .update('accrawl-oauth-consent-ticket-v1')
      .digest('base64url');
  }
  return signingSecret();
}

// Pure consent-ticket logic (explicit secret, no DB — unit-tested directly), paralleling signToken/verifyToken.

/** Sign a consent ticket (prefix.payload.hmac) bound to a specific authorize request, with an explicit secret. */
export function signConsentTicket(
  secret: string,
  binding: ConsentTicketBinding,
  ttlMs: number,
  tenantId: string = 'self-hosted',
): string {
  const payloadB64 = b64u(Buffer.from(JSON.stringify({ exp: Date.now() + ttlMs, tid: tenantId }), 'utf8'));
  const mac = b64u(
    createHmac('sha256', secret).update(`${CONSENT_TICKET_PREFIX}.${payloadB64}.${consentBindingMaterial(binding)}`).digest(),
  );
  return `${CONSENT_TICKET_PREFIX}.${payloadB64}.${mac}`;
}

/** Verify a consent ticket's signature, request binding, and expiry against an explicit secret. False on any
 *  mismatch or a ticket minted for a different request. */
export function checkConsentTicket(
  secret: string,
  ticket: string,
  binding: ConsentTicketBinding,
  tenantId: string = 'self-hosted',
): boolean {
  const parts = ticket.split('.');
  if (parts.length !== 3 || parts[0] !== CONSENT_TICKET_PREFIX) return false;
  const [, payloadB64, mac] = parts;

  const expectedMac = b64u(
    createHmac('sha256', secret).update(`${CONSENT_TICKET_PREFIX}.${payloadB64}.${consentBindingMaterial(binding)}`).digest(),
  );
  const macBuf = Buffer.from(mac);
  const expBuf = Buffer.from(expectedMac);
  if (macBuf.length !== expBuf.length || !timingSafeEqual(macBuf, expBuf)) return false;

  try {
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as { exp: number; tid?: string };
    return typeof payload.exp === 'number' && payload.tid === tenantId && Date.now() <= payload.exp;
  } catch {
    return false;
  }
}

/** Mint a short-lived consent ticket proving the operator authenticated for THIS exact authorize request.
 *  Throws if first-run setup hasn't completed (no signing secret yet). */
export async function mintConsentTicket(binding: ConsentTicketBinding, ttlMs: number): Promise<string> {
  const secret = await consentSigningSecret();
  if (!secret) throw new Error('Operator auth unavailable: first-run setup has not completed.');
  return signConsentTicket(secret, binding, ttlMs, currentTenant().id);
}

/** Verify a consent ticket's signature, request binding, and expiry. False on any mismatch, a ticket minted
 *  for a different request, or if setup hasn't run. */
export async function verifyConsentTicket(ticket: string, binding: ConsentTicketBinding): Promise<boolean> {
  const secret = await consentSigningSecret();
  if (!secret) return false;
  return checkConsentTicket(secret, ticket, binding, currentTenant().id);
}
