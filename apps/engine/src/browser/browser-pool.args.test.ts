import { describe, it, expect } from 'vitest';
import { chromeUserAgent, sanitizeChromiumArgs, disableChromiumSandbox } from './browser-pool';

describe('disableChromiumSandbox — the sandbox is ON unless a deployment says it cannot be', () => {
  it('keeps the sandbox on by default', () => {
    expect(disableChromiumSandbox({})).toBe(false);
  });

  it('keeps the sandbox on for an empty or blank setting', () => {
    for (const value of ['', '   ']) {
      expect(disableChromiumSandbox({ CHROMIUM_DISABLE_SANDBOX: value })).toBe(false);
    }
  });

  it('disables it only on an explicit affirmative', () => {
    for (const value of ['1', 'true', 'TRUE', 'yes', ' Yes ']) {
      expect(disableChromiumSandbox({ CHROMIUM_DISABLE_SANDBOX: value })).toBe(true);
    }
  });

  it('does not treat an arbitrary or negative value as permission to disable it', () => {
    // A misspelling, a leftover, or "0"/"false" must never silently weaken the browser.
    for (const value of ['0', 'false', 'no', 'off', 'disabled', 'maybe', 'sandbox']) {
      expect(disableChromiumSandbox({ CHROMIUM_DISABLE_SANDBOX: value }), value).toBe(false);
    }
  });
});

describe('chromeUserAgent', () => {
  it('uses the exact launched Chrome version', () => {
    expect(chromeUserAgent('150.0.7871.186')).toBe(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
        + 'AppleWebKit/537.36 (KHTML, like Gecko) '
        + 'Chrome/150.0.7871.186 Safari/537.36',
    );
  });

  it('fails closed when the browser reports an unexpected version format', () => {
    expect(() => chromeUserAgent('HeadlessChrome/150.0.7871.186')).toThrow(
      'Chrome reported an unexpected version',
    );
  });
});

describe('sanitizeChromiumArgs — refuse security-defeating EXTRA_CHROMIUM_ARGS flags', () => {
  it('drops cert/TLS/same-origin-disabling flags (they would reopen the tunnel-MITM) but keeps legit ones', () => {
    const out = sanitizeChromiumArgs(
      [
        '--host-resolver-rules=MAP bank.com 127.0.0.1',
        '--ignore-certificate-errors',
        '--proxy-server=http://p:8080',
        '--ignore-certificate-errors-spki-list=abc123',
        '--disable-web-security',
        '--allow-insecure-localhost',
        '--unsafely-treat-insecure-origin-as-secure=http://x',
      ].join('\n'),
    );
    expect(out).toEqual(['--host-resolver-rules=MAP bank.com 127.0.0.1', '--proxy-server=http://p:8080']);
    expect(out.join(' ')).not.toMatch(/ignore-certificate|disable-web-security|insecure/);
  });

  it('matches the flag name case-insensitively and ignores an =value', () => {
    expect(sanitizeChromiumArgs('--IGNORE-Certificate-Errors')).toEqual([]);
    expect(sanitizeChromiumArgs('--Ignore-Certificate-Errors-SPKI-List=deadbeef')).toEqual([]);
  });

  it('blocks EVERY switch-prefix form (Chromium honors --flag, -flag and /flag alike — single-dash was a real bypass)', () => {
    // Verified empirically: `-ignore-certificate-errors` (single dash) disables cert validation in Chromium.
    expect(sanitizeChromiumArgs('-ignore-certificate-errors')).toEqual([]);
    expect(sanitizeChromiumArgs('/ignore-certificate-errors')).toEqual([]);
    expect(sanitizeChromiumArgs('---ignore-certificate-errors')).toEqual([]);
    expect(sanitizeChromiumArgs('-disable-web-security')).toEqual([]);
    // A legit single-dash-looking value is untouched (not a blocked switch).
    expect(sanitizeChromiumArgs('--host-resolver-rules=MAP a 1.2.3.4')).toEqual(['--host-resolver-rules=MAP a 1.2.3.4']);
  });

  it('handles empty / undefined / whitespace-only', () => {
    expect(sanitizeChromiumArgs(undefined)).toEqual([]);
    expect(sanitizeChromiumArgs('')).toEqual([]);
    expect(sanitizeChromiumArgs('\n  \n')).toEqual([]);
  });
});
