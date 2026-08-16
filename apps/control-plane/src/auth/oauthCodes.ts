/**
 * Authorization-code + PKCE primitives for the OAuth Authorization Server.
 *
 * The authorization code is a high-entropy secret shown to the browser once and stored only as a SHA-256
 * hash with a short TTL; it is single-use (see the atomic consume in routes/oauth.ts). PKCE (RFC 7636)
 * binds the code to the client instance that started the flow: the client sends `code_challenge =
 * BASE64URL(SHA256(verifier))` at /authorize and proves possession with the raw `verifier` at /token.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const CODE_PREFIX = 'acoc_'; // accrawl oauth code
const REFRESH_PREFIX = 'acrt_'; // accrawl refresh token
export const AUTHORIZATION_CODE_TTL_MS = 5 * 60 * 1000; // 5 minutes (RFC 6749 §4.1.2 "short lived")

/** RFC 7636 §4.1: the code_verifier is 43–128 chars from the unreserved set. */
const PKCE_VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/;

export function hashCode(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}

export function generateAuthorizationCode(): { plaintext: string; codeHash: string } {
  const plaintext = CODE_PREFIX + randomBytes(32).toString('base64url');
  return { plaintext, codeHash: hashCode(plaintext) };
}

/** A rotating refresh token; stored only as a SHA-256 hash (same scheme as the auth code). */
export function generateRefreshToken(): { plaintext: string; tokenHash: string } {
  const plaintext = REFRESH_PREFIX + randomBytes(32).toString('base64url');
  return { plaintext, tokenHash: hashCode(plaintext) };
}

export function isValidPkceVerifier(verifier: string): boolean {
  return PKCE_VERIFIER_RE.test(verifier);
}

/** PKCE S256: constant-time check that BASE64URL(SHA256(verifier)) equals the stored challenge. */
export function verifyPkceS256(verifier: string, challenge: string): boolean {
  if (!isValidPkceVerifier(verifier)) return false;
  const computed = createHash('sha256').update(verifier).digest('base64url');
  const a = Buffer.from(computed);
  const b = Buffer.from(challenge);
  return a.length === b.length && timingSafeEqual(a, b);
}
