import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword, isArgon2Hash } from './password';

describe('operator password hashing (argon2id)', () => {
  it('hashes to an argon2id PHC string and verifies the correct password', async () => {
    const h = await hashPassword('correct horse battery staple');
    expect(h.startsWith('$argon2id$')).toBe(true);
    expect(isArgon2Hash(h)).toBe(true);
    expect(await verifyPassword(h, 'correct horse battery staple')).toBe(true);
    expect(await verifyPassword(h, 'wrong password')).toBe(false);
  });

  it('uses a per-hash salt — the same password hashes to different strings', async () => {
    expect(await hashPassword('same')).not.toBe(await hashPassword('same'));
  });

  it('returns false (never throws) on a malformed hash, and isArgon2Hash rejects plaintext', async () => {
    expect(await verifyPassword('not-a-hash', 'x')).toBe(false);
    expect(isArgon2Hash('plaintext-not-a-hash')).toBe(false);
  });
});
