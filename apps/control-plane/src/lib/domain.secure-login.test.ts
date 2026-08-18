/**
 * A login URL is where bank credentials are typed and posted. Over plain HTTP they cross the network
 * in the clear, and the canonical-domain anti-phishing anchor guarantees nothing, because anyone on the
 * path can rewrite the page that asks for them. These tests pin that https is required and that the two
 * exceptions stay narrow — in particular that neither is reachable in production.
 */
import { describe, it, expect } from 'vitest';
import { isSecureLoginUrl, insecureLoginUrlAllowed } from './domain';

const PROD = { NODE_ENV: 'production' } as NodeJS.ProcessEnv;
const DEV = { NODE_ENV: 'development' } as NodeJS.ProcessEnv;
const DEV_OPTED_IN = { NODE_ENV: 'development', ACCRAWL_ALLOW_INSECURE_LOGIN_URL: '1' } as NodeJS.ProcessEnv;
const PROD_OPTED_IN = { NODE_ENV: 'production', ACCRAWL_ALLOW_INSECURE_LOGIN_URL: '1' } as NodeJS.ProcessEnv;
/** The least-configured self-host: someone running the image outside the shipped compose file. */
const UNSET_OPTED_IN = { ACCRAWL_ALLOW_INSECURE_LOGIN_URL: '1' } as NodeJS.ProcessEnv;
const EMPTY_OPTED_IN = { NODE_ENV: '', ACCRAWL_ALLOW_INSECURE_LOGIN_URL: '1' } as NodeJS.ProcessEnv;
const BLANK_OPTED_IN = { NODE_ENV: '   ', ACCRAWL_ALLOW_INSECURE_LOGIN_URL: '1' } as NodeJS.ProcessEnv;

describe('isSecureLoginUrl', () => {
  it('accepts https anywhere, including in production', () => {
    for (const env of [PROD, DEV]) {
      expect(isSecureLoginUrl('https://bank.example/login', env)).toBe(true);
      expect(isSecureLoginUrl('https://login.bank.co.uk/portal', env)).toBe(true);
    }
  });

  it('rejects plain HTTP to a real host — the case that leaks credentials', () => {
    for (const env of [PROD, DEV, DEV_OPTED_IN.NODE_ENV ? DEV : DEV]) {
      expect(isSecureLoginUrl('http://bank.example/login', env)).toBe(false);
    }
  });

  it('rejects plain HTTP to a real host even when the opt-in is set IN PRODUCTION', () => {
    // The opt-in exists for a local mock bank. Production must never honour it, however it got set.
    expect(isSecureLoginUrl('http://bank.example/login', PROD_OPTED_IN)).toBe(false);
  });

  it('allows plain HTTP to a real host only outside production and only with the opt-in', () => {
    expect(isSecureLoginUrl('http://northwind-bank.com:4101/login', DEV_OPTED_IN)).toBe(true);
    expect(isSecureLoginUrl('http://northwind-bank.com:4101/login', DEV)).toBe(false);
  });

  it('allows loopback over plain HTTP with no opt-in — there is no network to intercept', () => {
    for (const url of ['http://localhost:8088/login', 'http://127.0.0.1:8088/login', 'http://127.5.5.5/login']) {
      expect(isSecureLoginUrl(url, PROD), url).toBe(true);
    }
  });

  it('rejects every non-web scheme', () => {
    for (const url of ['ftp://bank.example/login', 'file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,x']) {
      expect(isSecureLoginUrl(url, DEV_OPTED_IN), url).toBe(false);
    }
  });

  it('rejects a malformed URL rather than throwing', () => {
    for (const url of ['', 'not a url', '://', 'https://']) {
      expect(isSecureLoginUrl(url, DEV), JSON.stringify(url)).toBe(false);
    }
  });

  it('does not let a lookalike host masquerade as loopback', () => {
    // "127.0.0.1.evil.com" and "localhost.evil.com" are ordinary public hosts.
    for (const url of ['http://127.0.0.1.evil.com/login', 'http://localhost.evil.com/login']) {
      expect(isSecureLoginUrl(url, PROD), url).toBe(false);
    }
  });
});

describe('insecureLoginUrlAllowed', () => {
  it('treats only real loopback names as needing no opt-in', () => {
    for (const host of ['localhost', '127.0.0.1', '127.1.2.3', '::1', '[::1]']) {
      expect(insecureLoginUrlAllowed(host, PROD), host).toBe(true);
    }
    for (const host of ['bank.example', '10.0.0.1', '192.168.1.1', '0.0.0.0', 'localhost.evil.com']) {
      expect(insecureLoginUrlAllowed(host, PROD), host).toBe(false);
    }
  });

  it('is case-insensitive about the host', () => {
    expect(insecureLoginUrlAllowed('LOCALHOST', PROD)).toBe(true);
  });
});

describe('an unconfigured environment is not a development environment', () => {
  // Reading `NODE_ENV !== 'production'` made ABSENT the permissive case, so the deployment least
  // likely to have been configured deliberately was the only one that would post bank credentials
  // over plain HTTP. Absent, empty and whitespace all have to fail closed.
  it('refuses plain HTTP when NODE_ENV is absent, empty or blank, even with the opt-in set', () => {
    for (const env of [UNSET_OPTED_IN, EMPTY_OPTED_IN, BLANK_OPTED_IN]) {
      expect(insecureLoginUrlAllowed('bank.example.com', env)).toBe(false);
      expect(isSecureLoginUrl('http://bank.example.com/login', env)).toBe(false);
    }
  });

  it('still allows it only when NODE_ENV is explicitly non-production AND the opt-in is set', () => {
    expect(insecureLoginUrlAllowed('bank.example.com', DEV_OPTED_IN)).toBe(true);
    expect(insecureLoginUrlAllowed('bank.example.com', DEV)).toBe(false);
    expect(insecureLoginUrlAllowed('bank.example.com', PROD_OPTED_IN)).toBe(false);
  });

  it('leaves the loopback exception alone, which needs no environment at all', () => {
    for (const host of ['localhost', '127.0.0.1', '::1']) {
      expect(insecureLoginUrlAllowed(host, {} as NodeJS.ProcessEnv)).toBe(true);
    }
    // and the anchoring that keeps 127.0.0.1.evil.com out of it
    expect(insecureLoginUrlAllowed('127.0.0.1.evil.com', {} as NodeJS.ProcessEnv)).toBe(false);
  });
});
