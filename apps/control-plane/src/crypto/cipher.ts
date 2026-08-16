/**
 * Credential-at-rest encryption — envelope AEAD with rotation + anti-copy.
 *
 * Per secret: a random 32-byte DEK encrypts the plaintext (AES-256-GCM); the DEK
 * is wrapped by a KEK derived from the operator master key (`CREDENTIAL_ENC_KEY`)
 * via HKDF-SHA256. The data encryption is **AAD-bound to (connection, field,
 * schema-version)** so a ciphertext copied to another row/field fails to decrypt.
 * Each token carries a `keyId` (a fingerprint of the master key) so rotation is
 * detectable and old ciphertext is never silently mis-decrypted under a new key.
 *
 * Token format (all parts base64url):
 *   acc1.<keyId>.<dekNonce>.<wrappedDek>.<dekTag>.<dataNonce>.<ct>.<dataTag>
 *
 * Only `node:crypto`. KMS/other ciphers can be added behind the same interface.
 */
import {
  createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, timingSafeEqual,
} from 'node:crypto';
import { readSecret } from '../lib/secrets';
import { currentTenant } from '../tenancy/context';

const SCHEME = 'acc1';
const KEY_LEN = 32;
const NONCE_LEN = 12;
const HKDF_INFO = 'accrawl-cred-kek-v1';

export interface SecretContext {
  /** Binds the ciphertext to a specific connection (AAD). */
  connectionId: string;
  /** Binds to a specific field, e.g. 'username' | 'password' | 'dob' | 'phone'. */
  field: string;
  /** Schema/AAD version. Bump only on a deliberate format change. */
  version?: string;
}

function b64u(buf: Buffer): string {
  return buf.toString('base64url');
}
function unb64u(s: string): Buffer {
  return Buffer.from(s, 'base64url');
}

/** Parse and validate the 32-byte master key from CREDENTIAL_ENC_KEY (hex or base64). */
function masterKey(): Buffer {
  let tenantKey: string | undefined;
  try {
    tenantKey = currentTenant().credentialEncryptionKey;
  } catch {
    // Pure cipher tests and standalone utilities can load before the tenant directory.
  }
  const raw = tenantKey ?? readSecret('CREDENTIAL_ENC_KEY'); // supports the _FILE / Docker-secrets convention
  if (!raw) {
    throw new Error('CREDENTIAL_ENC_KEY is not set — required to store/read credentials.');
  }
  let key: Buffer;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    key = Buffer.from(raw, 'hex');
  } else {
    key = Buffer.from(raw, 'base64');
  }
  if (key.length !== KEY_LEN) {
    throw new Error(`CREDENTIAL_ENC_KEY must decode to ${KEY_LEN} bytes (got ${key.length}); use 64 hex chars or 32-byte base64.`);
  }
  return key;
}

/** Short stable fingerprint of the master key — identifies which key a token was sealed under. */
function keyId(master: Buffer): string {
  return createHash('sha256').update(master).digest('hex').slice(0, 16);
}

function deriveKek(master: Buffer, kid: string): Buffer {
  // HKDF: salt = keyId (so a different master → different KEK), info = domain string.
  return Buffer.from(hkdfSync('sha256', master, Buffer.from(kid, 'hex'), HKDF_INFO, KEY_LEN));
}

function aadFor(ctx: SecretContext): Buffer {
  // Injective encoding. A delimiter-joined string would let distinct contexts collide
  // — connId 'a:b' + field 'c' and connId 'a' + field 'b:c' both become 'a:b:c:v1' —
  // which would let a token be decrypted under the wrong logical context. JSON of a
  // fixed-shape string tuple maps each (connectionId, field, version) to a distinct
  // AAD regardless of the characters in any component.
  return Buffer.from(JSON.stringify([ctx.connectionId, ctx.field, ctx.version ?? 'v1']), 'utf8');
}

/** Encrypt a credential field. Returns a self-describing token (safe to store as text). */
export function encryptSecret(plaintext: string, ctx: SecretContext): string {
  const master = masterKey();
  const kid = keyId(master);
  const kek = deriveKek(master, kid);

  // Wrap a fresh DEK under the KEK.
  const dek = randomBytes(KEY_LEN);
  const dekNonce = randomBytes(NONCE_LEN);
  const wrap = createCipheriv('aes-256-gcm', kek, dekNonce);
  const wrappedDek = Buffer.concat([wrap.update(dek), wrap.final()]);
  const dekTag = wrap.getAuthTag();

  // Encrypt the plaintext under the DEK, AAD-bound to (connection, field, version).
  const dataNonce = randomBytes(NONCE_LEN);
  const enc = createCipheriv('aes-256-gcm', dek, dataNonce);
  enc.setAAD(aadFor(ctx));
  const ct = Buffer.concat([enc.update(plaintext, 'utf8'), enc.final()]);
  const dataTag = enc.getAuthTag();

  return [
    SCHEME, kid, b64u(dekNonce), b64u(wrappedDek), b64u(dekTag), b64u(dataNonce), b64u(ct), b64u(dataTag),
  ].join('.');
}

/** Decrypt a credential token. Throws if the key rotated, the AAD context differs, or the data was tampered with. */
export function decryptSecret(token: string, ctx: SecretContext): string {
  const parts = token.split('.');
  if (parts.length !== 8 || parts[0] !== SCHEME) {
    throw new Error('decryptSecret: malformed ciphertext token');
  }
  const [, kid, dekNonceS, wrappedDekS, dekTagS, dataNonceS, ctS, dataTagS] = parts;

  const master = masterKey();
  const currentKid = keyId(master);
  // Constant-time keyId comparison; a mismatch means rotation under a different master.
  if (kid.length !== currentKid.length || !timingSafeEqual(Buffer.from(kid), Buffer.from(currentKid))) {
    throw new Error('decryptSecret: ciphertext was sealed under a different master key (rotation) — re-encrypt required.');
  }
  const kek = deriveKek(master, kid);

  // Unwrap the DEK.
  const unwrap = createDecipheriv('aes-256-gcm', kek, unb64u(dekNonceS));
  unwrap.setAuthTag(unb64u(dekTagS));
  const dek = Buffer.concat([unwrap.update(unb64u(wrappedDekS)), unwrap.final()]);

  // Decrypt the data with the AAD context (GCM auth fails on wrong context / tamper).
  const dec = createDecipheriv('aes-256-gcm', dek, unb64u(dataNonceS));
  dec.setAAD(aadFor(ctx));
  dec.setAuthTag(unb64u(dataTagS));
  return Buffer.concat([dec.update(unb64u(ctS)), dec.final()]).toString('utf8');
}
