import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { deriveTunnelKey, signTunnelToken, verifyTunnelToken } from './tunnel-token';

// Pure HMAC tunnel-token logic — the engine + control-plane both import this module so sign/verify can
// never drift. The single-use CAS (sessions.tunnel_claimed_at) is tested in the control-plane, not here.
const SECRET = 'an-engine-shared-secret';
const KEY = deriveTunnelKey(SECRET);

describe('tunnel token (pure HMAC signing/verification)', () => {
  it('mints a token that round-trips and binds (sid, did) under the same key', () => {
    const t = signTunnelToken(KEY, { sid: 'sess-1', did: 'dev-1' });
    expect(t.startsWith('actt1.')).toBe(true);
    const v = verifyTunnelToken(KEY, t);
    expect(v?.sid).toBe('sess-1');
    expect(v?.did).toBe('dev-1');
    expect(typeof v?.jti).toBe('string');
    expect((v?.jti ?? '').length).toBeGreaterThan(0);
  });

  it('rejects an expired token (ttl in the past)', () => {
    expect(verifyTunnelToken(KEY, signTunnelToken(KEY, { sid: 's', did: 'd' }, -1000))).toBeNull();
  });

  it('rejects a tampered token (flip a char in the payload)', () => {
    const [prefix, payload, mac] = signTunnelToken(KEY, { sid: 's', did: 'd' }).split('.');
    const flipped = (payload[0] === 'a' ? 'b' : 'a') + payload.slice(1);
    expect(verifyTunnelToken(KEY, `${prefix}.${flipped}.${mac}`)).toBeNull();
  });

  it('rejects a token verified under a different (wrong) key', () => {
    const wrongKey = deriveTunnelKey('a-different-shared-secret');
    expect(verifyTunnelToken(wrongKey, signTunnelToken(KEY, { sid: 's', did: 'd' }))).toBeNull();
  });

  it('domain separation: a tunnel token cannot verify against the raw secret (it is NOT an engine bearer)', () => {
    // Re-sign the SAME payload with the RAW secret as the HMAC key (what an engine-bearer check would use).
    // The derived-key signature must not collide with the raw-secret signature → the cross-check fails.
    const token = signTunnelToken(KEY, { sid: 's', did: 'd' });
    const [prefix, payload] = token.split('.');
    const rawMac = createHmac('sha256', Buffer.from(SECRET, 'utf8')).update(`${prefix}.${payload}`).digest().toString('base64url');
    const tunnelMac = token.split('.')[2];
    expect(rawMac).not.toBe(tunnelMac);
    // And the derived key is not the raw secret bytes.
    expect(KEY.equals(Buffer.from(SECRET, 'utf8'))).toBe(false);
  });

  it('rejects malformed tokens', () => {
    expect(verifyTunnelToken(KEY, 'garbage')).toBeNull();
    expect(verifyTunnelToken(KEY, 'actt1.onlytwo')).toBeNull();
    expect(verifyTunnelToken(KEY, 'wrongprefix.a.b')).toBeNull();
  });
});
