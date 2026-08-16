/**
 * Short-lived identity assertion from a proprietary authentication edge to the
 * public core. It is tenant-, subject-, method-, and request-target-bound.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

const PREFIX = 'acci1';

export interface IdentityAssertionInput {
  tenantId: string;
  subject: string;
  /** Verified sign-in address, when the identity provider issued one. */
  email?: string;
  method: string;
  requestTarget: string;
  /** Closed-edge attested platform capabilities. The public core accepts only
   * the exact capability permitted for the signing key's trust domain. */
  capabilities?: string[];
}

interface IdentityAssertionPayload {
  v: 1;
  tid: string;
  sub: string;
  eml?: string;
  m: string;
  p: string;
  exp: number;
  cap?: string[];
}

function mac(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(`${PREFIX}.${payload}`).digest('base64url');
}

export function signIdentityAssertion(
  secret: string,
  input: IdentityAssertionInput,
  ttlMs: number = 30_000,
): string {
  if (!secret) throw new Error('identity assertion secret is required');
  if (ttlMs <= 0 || ttlMs > 60_000) throw new Error('identity assertion TTL must be between 1 and 60000 ms');
  if (input.email !== undefined
    && (input.email.length < 3
      || input.email.length > 320
      || input.email.includes(' ')
      || input.email.indexOf('@') <= 0
      || input.email.lastIndexOf('@') !== input.email.indexOf('@')
      || input.email.endsWith('@'))) {
    throw new Error('identity assertion email is invalid');
  }
  const payload: IdentityAssertionPayload = {
    v: 1,
    tid: input.tenantId,
    sub: input.subject,
    ...(input.email ? { eml: input.email } : {}),
    m: input.method.toUpperCase(),
    p: input.requestTarget,
    exp: Date.now() + ttlMs,
    ...(input.capabilities?.length ? { cap: [...new Set(input.capabilities)].sort() } : {}),
  };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${PREFIX}.${encoded}.${mac(secret, encoded)}`;
}

export function verifyIdentityAssertion(
  secret: string,
  assertion: string,
  expected: Pick<IdentityAssertionInput, 'tenantId' | 'method' | 'requestTarget'>,
): { subject: string; email: string | null; capabilities: string[] } | null {
  const parts = assertion.split('.');
  if (!secret || parts.length !== 3 || parts[0] !== PREFIX) return null;
  const [, encoded, presentedMac] = parts;
  const expectedMac = mac(secret, encoded);
  const presented = Buffer.from(presentedMac);
  const calculated = Buffer.from(expectedMac);
  if (presented.length !== calculated.length || !timingSafeEqual(presented, calculated)) return null;
  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as IdentityAssertionPayload;
    if (payload.v !== 1
      || payload.tid !== expected.tenantId
      || payload.m !== expected.method.toUpperCase()
      || payload.p !== expected.requestTarget
      || typeof payload.sub !== 'string'
      || payload.sub.length < 1
      || payload.sub.length > 256
      || (payload.eml !== undefined
        && (typeof payload.eml !== 'string'
          || payload.eml.length < 3
          || payload.eml.length > 320
          || payload.eml.includes(' ')
          || payload.eml.indexOf('@') <= 0
          || payload.eml.lastIndexOf('@') !== payload.eml.indexOf('@')
          || payload.eml.endsWith('@')))
      || typeof payload.exp !== 'number'
      || payload.exp < Date.now()
      || payload.exp > Date.now() + 60_000
      || (payload.cap !== undefined
        && (!Array.isArray(payload.cap)
          || payload.cap.length > 16
          || payload.cap.some((value) => typeof value !== 'string' || value.length < 1 || value.length > 64)))) {
      return null;
    }
    return {
      subject: payload.sub,
      email: payload.eml ?? null,
      capabilities: payload.cap ?? [],
    };
  } catch {
    return null;
  }
}
