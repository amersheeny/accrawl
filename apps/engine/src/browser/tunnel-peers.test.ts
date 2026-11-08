import { describe, it, expect } from 'vitest';
import { canonicalIp, peerKey } from './tunnel-peers';
import { assertConnectedAddressIsPublic } from '../utils/url-safety';

describe('canonicalIp', () => {
  it('compresses the IPv6 a phone prints uncompressed, so loopback is recognised as loopback', async () => {
    expect(canonicalIp('0:0:0:0:0:0:0:1')).toBe('::1');
    const relayed = { serverAddr: async () => ({ ipAddress: '127.0.0.1' }), url: () => 'https://bank.example/' };
    const peers = () => [canonicalIp('0:0:0:0:0:0:0:1')!];
    await expect(assertConnectedAddressIsPublic(relayed, 'https://bank.example/', {}, peers))
      .rejects.toThrow(/bank\.example -> ::1/);
  });

  it('drops an IPv6 zone and keeps the address', () => {
    expect(canonicalIp('fe80:0:0:0:0:0:0:1%wlan0')).toBe('fe80::1');
  });

  it('keeps an IPv4 address as it is', () => {
    expect(canonicalIp('93.184.216.34')).toBe('93.184.216.34');
  });

  it('rejects anything that is not an IP address', () => {
    for (const raw of ['', 'bank.example', '999.1.1.1', '1.2.3', 'fe80::zz']) expect(canonicalIp(raw)).toBeNull();
  });
});

describe('peerKey', () => {
  it('matches a proxy target to the URL the browser navigated to', () => {
    expect(peerKey('Bank.Example', 443)).toBe(peerKey('bank.example', 443));
    // The SOCKS5 server spells an IPv6 target as eight groups; a URL spells it compressed and bracketed.
    expect(peerKey('0:0:0:0:0:0:0:1', 8080)).toBe(peerKey('[::1]', 8080));
    expect(peerKey('bank.example', 443)).not.toBe(peerKey('bank.example', 8443));
  });
});
