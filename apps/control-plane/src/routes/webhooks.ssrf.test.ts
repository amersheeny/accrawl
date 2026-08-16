import { describe, it, expect } from 'vitest';
import { isSafeWebhookUrl } from './webhooks';

describe('isSafeWebhookUrl (SSRF guard at registration)', () => {
  it('allows https and a co-located loopback receiver', () => {
    expect(isSafeWebhookUrl('https://hooks.example.com/accrawl')).toBe(true);
    expect(isSafeWebhookUrl('http://localhost:9000/hook')).toBe(true);
    expect(isSafeWebhookUrl('http://127.0.0.1:9000/hook')).toBe(true);
    expect(isSafeWebhookUrl('http://localhost:9000/hook', false)).toBe(false);
  });

  it('rejects plaintext http to a non-loopback host', () => {
    expect(isSafeWebhookUrl('http://hooks.example.com/hook')).toBe(false);
  });

  it('rejects a literal private / link-local / metadata IP (SSRF)', () => {
    expect(isSafeWebhookUrl('https://169.254.169.254/latest/meta-data')).toBe(false); // cloud metadata
    expect(isSafeWebhookUrl('https://10.0.0.5/hook')).toBe(false); // RFC-1918
    expect(isSafeWebhookUrl('https://192.168.1.10/hook')).toBe(false);
    expect(isSafeWebhookUrl('https://172.16.0.9/hook')).toBe(false);
    expect(isSafeWebhookUrl('https://[fd00::1]/hook')).toBe(false); // ULA IPv6
  });

  it('rejects malformed input', () => {
    expect(isSafeWebhookUrl('not a url')).toBe(false);
    expect(isSafeWebhookUrl('ftp://host/x')).toBe(false);
  });
});
