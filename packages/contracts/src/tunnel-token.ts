/**
 * Tunnel token — a short-lived, HMAC-signed grant that lets the engine open the device-proxy WS for a
 * specific (session, device) pair, WITHOUT the engine reading an identity service or the devices table.
 *
 * The control-plane (which owns devices + sessions, full DB privileges) mints the token; the engine
 * verifies it with a key DERIVED from the ENGINE_SHARED_SECRET it already holds. Both sides import this
 * shared module so the sign/verify logic can never drift.
 *
 * Two defenses are baked in here:
 *  - **Domain separation**: the verification key is an HKDF subkey of the shared secret (NOT the raw
 *    secret), so a tunnel token can never be replayed as an engine bearer (which uses the raw secret) and
 *    vice-versa — different key, signatures never collide.
 *  - **Short TTL + jti**: the token carries `iat`/`exp` (default 2 min) and a random `jti`. Single-use is
 *    enforced elsewhere (an atomic CAS on `sessions.tunnel_claimed_at`); the TTL is the outer bound.
 *
 * Token shape mirrors the operator token: `actt1.<payloadB64url>.<hmacSHA256 b64url>`.
 */
import { createHmac, hkdfSync, randomUUID, timingSafeEqual } from 'node:crypto';

const TOKEN_PREFIX = 'actt1';
const DEFAULT_TTL_MS = 2 * 60 * 1000; // 2 min — outer bound; single-use CAS is the real gate

/** The signed/verified tunnel-token payload. */
export interface TunnelTokenPayload {
  /** Session ID this token authorizes a tunnel for. */
  sid: string;
  /** Device ID the tunnel binds to. */
  did: string;
  /** Issued-at (epoch ms). */
  iat: number;
  /** Expiry (epoch ms) = iat + ttlMs. */
  exp: number;
  /** Random per-token id (defense-in-depth alongside the single-use CAS). */
  jti: string;
}

function b64u(buf: Buffer): string {
  return buf.toString('base64url');
}

/**
 * Derive the tunnel-signing subkey from the engine shared secret via HKDF-SHA256. Domain-separated
 * (`salt='accrawl-tunnel'`, `info='accrawl-tunnel-v1'`) so a tunnel token can never verify as an engine
 * bearer (which uses the raw secret), and vice-versa. `hkdfSync` returns an ArrayBuffer — wrap to a Buffer
 * so callers get a stable createHmac key type.
 */
export function deriveTunnelKey(sharedSecret: string): Buffer {
  return Buffer.from(
    hkdfSync('sha256', Buffer.from(sharedSecret, 'utf8'), Buffer.from('accrawl-tunnel'), 'accrawl-tunnel-v1', 32),
  );
}

// ── Pure token logic (no DB, no identity service — unit-tested directly) ─────

/** Mint a short-lived tunnel token binding a session to a device, signed with the derived tunnel key. */
export function signTunnelToken(key: Buffer, payload: { sid: string; did: string }, ttlMs: number = DEFAULT_TTL_MS): string {
  const iat = Date.now();
  const full: TunnelTokenPayload = { sid: payload.sid, did: payload.did, iat, exp: iat + ttlMs, jti: randomUUID() };
  const payloadB64 = b64u(Buffer.from(JSON.stringify(full), 'utf8'));
  const mac = b64u(createHmac('sha256', key).update(`${TOKEN_PREFIX}.${payloadB64}`).digest());
  return `${TOKEN_PREFIX}.${payloadB64}.${mac}`;
}

/** Verify a tunnel token's signature + expiry against the derived tunnel key. Returns the bound
 *  (sid, did, jti) or null on any failure (bad shape, wrong key, tamper, expired, unparseable). */
export function verifyTunnelToken(key: Buffer, token: string): { sid: string; did: string; jti: string } | null {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) return null;
  const [, payloadB64, mac] = parts;

  const expectedMac = b64u(createHmac('sha256', key).update(`${TOKEN_PREFIX}.${payloadB64}`).digest());
  const macBuf = Buffer.from(mac);
  const expBuf = Buffer.from(expectedMac);
  if (macBuf.length !== expBuf.length || !timingSafeEqual(macBuf, expBuf)) return null;

  try {
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as TunnelTokenPayload;
    if (typeof payload.exp !== 'number' || Date.now() > payload.exp) return null;
    return { sid: payload.sid, did: payload.did, jti: payload.jti };
  } catch {
    return null;
  }
}
