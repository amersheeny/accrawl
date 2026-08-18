import { describe, it, expect } from 'vitest';
import {
  signToken, verifyToken, signConsentTicket, checkConsentTicket, operatorTokenTtlMs,
  type ConsentTicketBinding,
} from './operator';

// The DB-backed operations (verifyOperatorPassword / mintOperatorToken / verifyOperatorToken /
// mintConsentTicket / verifyConsentTicket) are covered end-to-end by the integration test (real server +
// pglite). Here we test the pure HMAC token + consent-ticket logic.
const SECRET = 'a-test-token-signing-secret';

describe('operator token (pure HMAC signing/verification)', () => {
  it('mints a token that round-trips under the same secret', () => {
    const t = signToken(SECRET);
    expect(t.startsWith('accs1.')).toBe(true);
    expect(verifyToken(SECRET, t)).toBe(true);
  });

  it('rejects an expired token', () => {
    expect(verifyToken(SECRET, signToken(SECRET, -1000))).toBe(false);
  });

  it('rejects a forged (re-signed) payload', () => {
    const [prefix, , mac] = signToken(SECRET).split('.');
    const forged = Buffer.from(JSON.stringify({ exp: Date.now() + 1e9 })).toString('base64url');
    expect(verifyToken(SECRET, `${prefix}.${forged}.${mac}`)).toBe(false);
  });

  it('rejects a token verified under a different secret (re-setup/rotation invalidates outstanding tokens)', () => {
    expect(verifyToken('a-different-secret', signToken(SECRET))).toBe(false);
  });

  it('binds a valid token to the tenant it was minted for', () => {
    const token = signToken(SECRET, 60_000, 'tenant-a');
    expect(verifyToken(SECRET, token, 'tenant-a')).toBe(true);
    expect(verifyToken(SECRET, token, 'tenant-b')).toBe(false);
  });

  it('rejects malformed tokens', () => {
    expect(verifyToken(SECRET, 'garbage')).toBe(false);
    expect(verifyToken(SECRET, 'accs1.onlytwo')).toBe(false);
  });
});

describe('consent ticket (pure HMAC, request-bound)', () => {
  const binding: ConsentTicketBinding = {
    clientId: 'accl_abc', redirectUri: 'https://app.example.com/cb', scope: 'read:data', codeChallenge: 'chal123',
  };
  const ttl = 10 * 60 * 1000;

  it('mints a ticket that round-trips for the SAME request binding', () => {
    const t = signConsentTicket(SECRET, binding, ttl);
    expect(t.startsWith('accsent1.')).toBe(true);
    expect(checkConsentTicket(SECRET, t, binding)).toBe(true);
  });

  it('rejects a ticket presented for a DIFFERENT request (any bound field changed)', () => {
    const t = signConsentTicket(SECRET, binding, ttl);
    expect(checkConsentTicket(SECRET, t, { ...binding, clientId: 'accl_other' })).toBe(false);
    expect(checkConsentTicket(SECRET, t, { ...binding, redirectUri: 'https://evil.example.com/cb' })).toBe(false);
    expect(checkConsentTicket(SECRET, t, { ...binding, scope: 'read:data write:crawl' })).toBe(false);
    expect(checkConsentTicket(SECRET, t, { ...binding, codeChallenge: 'different' })).toBe(false);
  });

  it('rejects an expired ticket', () => {
    expect(checkConsentTicket(SECRET, signConsentTicket(SECRET, binding, -1000), binding)).toBe(false);
  });

  it('rejects a ticket signed under a different secret', () => {
    expect(checkConsentTicket('another-secret', signConsentTicket(SECRET, binding, ttl), binding)).toBe(false);
  });

  it('rejects a forged (re-signed) payload — the binding is in the signed material, not the token', () => {
    const [prefix, , mac] = signConsentTicket(SECRET, binding, ttl).split('.');
    const forged = Buffer.from(JSON.stringify({ exp: Date.now() + 1e9 })).toString('base64url');
    expect(checkConsentTicket(SECRET, `${prefix}.${forged}.${mac}`, binding)).toBe(false);
  });

  it('rejects malformed tickets and the wrong prefix', () => {
    expect(checkConsentTicket(SECRET, 'garbage', binding)).toBe(false);
    expect(checkConsentTicket(SECRET, 'accsent1.onlytwo', binding)).toBe(false);
    // A well-formed OPERATOR token must not pass as a consent ticket (distinct prefix).
    expect(checkConsentTicket(SECRET, signToken(SECRET), binding)).toBe(false);
  });
});

describe('operatorTokenTtlMs', () => {
  const HOUR = 60 * 60 * 1000;

  it('keeps the seven-day default when nothing is configured', () => {
    expect(operatorTokenTtlMs({} as NodeJS.ProcessEnv)).toBe(168 * HOUR);
  });

  it('honours a shorter window, which is the point of making it settable', () => {
    expect(operatorTokenTtlMs({ OPERATOR_TOKEN_TTL_HOURS: '8' } as NodeJS.ProcessEnv)).toBe(8 * HOUR);
    expect(operatorTokenTtlMs({ OPERATOR_TOKEN_TTL_HOURS: '1' } as NodeJS.ProcessEnv)).toBe(1 * HOUR);
  });

  it('falls back to the default on anything it cannot use, rather than failing to start', () => {
    // A typo in a self-hoster's environment file must not stop the deployment booting; the fallback
    // is what they had before, so nothing silently gets LONGER than the default either.
    for (const value of ['', '   ', 'eight', '0', '-5', '721', 'NaN', 'Infinity', '1e999']) {
      expect(operatorTokenTtlMs({ OPERATOR_TOKEN_TTL_HOURS: value } as NodeJS.ProcessEnv)).toBe(168 * HOUR);
    }
  });

  it('refuses to extend beyond thirty days', () => {
    expect(operatorTokenTtlMs({ OPERATOR_TOKEN_TTL_HOURS: '720' } as NodeJS.ProcessEnv)).toBe(720 * HOUR);
    expect(operatorTokenTtlMs({ OPERATOR_TOKEN_TTL_HOURS: '1000' } as NodeJS.ProcessEnv)).toBe(168 * HOUR);
  });
});
