/**
 * Operator password hashing — Argon2id, the OWASP Password Storage Cheat Sheet's first recommendation,
 * via @node-rs/argon2 (prebuilt napi binaries; no node-gyp). The admin password is NEVER stored in
 * plaintext: the first-run setup flow stores an argon2id hash, and login verifies against it.
 *
 * Parameters follow OWASP (m=19 MiB, t=2, p=1). The output is a self-describing PHC string
 * ($argon2id$v=19$m=...$salt$hash) carrying its own salt + params, so it is verifiable and upgradeable.
 */
import { hash, verify, Algorithm } from '@node-rs/argon2';

const OPTIONS = { algorithm: Algorithm.Argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

/** Produce an Argon2id PHC-string hash of a plaintext password. */
export function hashPassword(plain: string): Promise<string> {
  return hash(plain, OPTIONS);
}

/** Verify a password against an argon2id PHC hash (argon2's verify is constant-time). False on any malformed hash. */
export async function verifyPassword(phc: string, plain: string): Promise<boolean> {
  try {
    return await verify(phc, plain);
  } catch {
    return false;
  }
}

/** Whether a string is an argon2 PHC hash (vs. a raw/plaintext value). */
export function isArgon2Hash(s: string): boolean {
  return s.startsWith('$argon2');
}
