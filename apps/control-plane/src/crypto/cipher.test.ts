import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { encryptSecret, decryptSecret } from './cipher';

const KEY_A = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff'; // 32 bytes hex
const KEY_B = 'ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100';
const CTX = { connectionId: 'conn-1', field: 'password' as const };

describe('credential cipher (envelope AES-256-GCM, AAD-bound)', () => {
  beforeEach(() => { process.env.CREDENTIAL_ENC_KEY = KEY_A; });
  afterEach(() => { delete process.env.CREDENTIAL_ENC_KEY; });

  it('round-trips a secret', () => {
    const token = encryptSecret('hunter2!', CTX);
    expect(token.startsWith('acc1.')).toBe(true);
    expect(decryptSecret(token, CTX)).toBe('hunter2!');
  });

  it('produces a fresh ciphertext each time (random DEK + nonces)', () => {
    const a = encryptSecret('same', CTX);
    const b = encryptSecret('same', CTX);
    expect(a).not.toBe(b);
    expect(decryptSecret(a, CTX)).toBe('same');
    expect(decryptSecret(b, CTX)).toBe('same');
  });

  it('rejects decryption under a DIFFERENT connection (AAD anti-copy)', () => {
    const token = encryptSecret('secret', CTX);
    expect(() => decryptSecret(token, { connectionId: 'conn-2', field: 'password' })).toThrow();
  });

  it('rejects decryption under a DIFFERENT field (AAD anti-copy)', () => {
    const token = encryptSecret('secret', CTX);
    expect(() => decryptSecret(token, { connectionId: 'conn-1', field: 'username' })).toThrow();
  });

  it('has no AAD collision when a component contains the old delimiter', () => {
    // A ':'-joined AAD would make these two contexts identical ('a:b:c:v1'); the
    // injective encoding must keep them distinct so a token never cross-decrypts.
    const token = encryptSecret('secret', { connectionId: 'a:b', field: 'c' });
    expect(() => decryptSecret(token, { connectionId: 'a', field: 'b:c' })).toThrow();
    expect(decryptSecret(token, { connectionId: 'a:b', field: 'c' })).toBe('secret');
  });

  it('rejects a tampered ciphertext (GCM auth)', () => {
    const token = encryptSecret('secret', CTX);
    const parts = token.split('.');
    const ct = Buffer.from(parts[6], 'base64url');
    ct[0] ^= 0xff; // flip a byte of the ciphertext
    parts[6] = ct.toString('base64url');
    expect(() => decryptSecret(parts.join('.'), CTX)).toThrow();
  });

  it('rejects a ciphertext sealed under a different master key (rotation)', () => {
    const token = encryptSecret('secret', CTX);
    process.env.CREDENTIAL_ENC_KEY = KEY_B;
    expect(() => decryptSecret(token, CTX)).toThrow(/different master key|rotation/i);
  });

  it('rejects a malformed token', () => {
    expect(() => decryptSecret('not-a-token', CTX)).toThrow(/malformed/i);
    expect(() => decryptSecret('acc1.aa.bb', CTX)).toThrow(/malformed/i);
  });

  it('throws a clear error when the key is unset', () => {
    delete process.env.CREDENTIAL_ENC_KEY;
    expect(() => encryptSecret('x', CTX)).toThrow(/CREDENTIAL_ENC_KEY is not set/);
  });

  it('rejects a key of the wrong length', () => {
    process.env.CREDENTIAL_ENC_KEY = 'deadbeef';
    expect(() => encryptSecret('x', CTX)).toThrow(/32 bytes/);
  });

  it('accepts a base64-encoded 32-byte key', () => {
    process.env.CREDENTIAL_ENC_KEY = Buffer.from(KEY_A, 'hex').toString('base64');
    const token = encryptSecret('via-b64', CTX);
    expect(decryptSecret(token, CTX)).toBe('via-b64');
  });
});
