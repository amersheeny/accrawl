import { describe, expect, it, vi } from 'vitest';
import { signIdentityAssertion, verifyIdentityAssertion } from './identity-assertion';

const secret = 'edge-to-core-secret';
const input = {
  tenantId: 'tenant-a',
  subject: 'account-user-123',
  method: 'GET',
  requestTarget: '/api/connections?limit=20',
};

describe('trusted identity assertion', () => {
  it('round-trips only for the exact tenant, method, and request target', () => {
    const assertion = signIdentityAssertion(secret, input);
    expect(verifyIdentityAssertion(secret, assertion, input)).toEqual({
      subject: input.subject,
      email: null,
      capabilities: [],
    });
    expect(verifyIdentityAssertion(secret, assertion, { ...input, tenantId: 'tenant-b' })).toBeNull();
    expect(verifyIdentityAssertion(secret, assertion, { ...input, method: 'POST' })).toBeNull();
    expect(verifyIdentityAssertion(secret, assertion, { ...input, requestTarget: '/api/connections?limit=200' })).toBeNull();
  });

  it('authenticates edge-attested capabilities and rejects tampering', () => {
    const assertion = signIdentityAssertion(secret, {
      ...input,
      email: 'owner@example.com',
      capabilities: ['platform-admin'],
    });
    expect(verifyIdentityAssertion(secret, assertion, input)).toEqual({
      subject: input.subject,
      email: 'owner@example.com',
      capabilities: ['platform-admin'],
    });
    const parts = assertion.split('.');
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as {
      cap: string[];
    };
    payload.cap = ['platform-admin', 'attacker-added'];
    const tampered = `${parts[0]}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${parts[2]}`;
    expect(verifyIdentityAssertion(secret, tampered, input)).toBeNull();
  });

  it('rejects invalid verified-email values before signing', () => {
    expect(() => signIdentityAssertion(secret, { ...input, email: 'not-an-email' })).toThrow(
      'identity assertion email is invalid',
    );
    expect(() => signIdentityAssertion(secret, { ...input, email: 'owner @example.com' })).toThrow(
      'identity assertion email is invalid',
    );
  });

  it('rejects expiry, tampering, and a different secret', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-07-25T12:00:00Z'));
      const assertion = signIdentityAssertion(secret, input, 1);
      const [prefix, payload, signature] = assertion.split('.');
      expect(verifyIdentityAssertion('other', assertion, input)).toBeNull();
      expect(verifyIdentityAssertion(secret, `${prefix}.${payload}A.${signature}`, input)).toBeNull();
      vi.advanceTimersByTime(2);
      expect(verifyIdentityAssertion(secret, assertion, input)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
