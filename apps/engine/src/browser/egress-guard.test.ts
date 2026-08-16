import { describe, it, expect } from 'vitest';
import { allowedSuffixes, isUrlAllowed } from './egress-guard';

describe('egress guard — host-suffix decisions', () => {
  it('pins the loginUrl eTLD+1 + each allowedDomain hostname', () => {
    expect(allowedSuffixes('https://login.bank.co.il/x', ['cdn.assets.com', 'https://sso.idp.io/a']))
      .toEqual(['bank.co.il', 'cdn.assets.com', 'sso.idp.io']);
  });

  it('rejects a bare public suffix / IP allowedDomain (cannot widen the pin to a whole TLD)', () => {
    const s = allowedSuffixes('https://login.victimbank.com/x', ['com', 'co.uk', 'github.io', '203.0.113.5']);
    expect(s).toEqual(['victimbank.com']); // every non-registrable entry dropped
    expect(isUrlAllowed('https://attacker.com/collect?creds=pw&acct=123', s)).toBe(false);
    expect(isUrlAllowed('https://evil.co.uk/x', s)).toBe(false);
    expect(isUrlAllowed('https://evil.github.io/x', s)).toBe(false);
  });

  it('allows the pinned eTLD+1 and all of its subdomains', () => {
    const s = allowedSuffixes('https://login.bank.com/x');
    expect(isUrlAllowed('https://login.bank.com/p', s)).toBe(true);
    expect(isUrlAllowed('https://bank.com/p', s)).toBe(true);
    expect(isUrlAllowed('https://api.bank.com/v1?x=1', s)).toBe(true);
  });

  it('blocks off-domain, look-alikes, and the PARENT/siblings of an allowed host', () => {
    const s = allowedSuffixes('https://login.bank.com/x', ['cdn.assets.com']);
    expect(isUrlAllowed('https://evil.com/x?d=acct123', s)).toBe(false);
    expect(isUrlAllowed('https://bank.com.evil.com/x', s)).toBe(false); // look-alike suffix attack
    expect(isUrlAllowed('https://x.cdn.assets.com/img', s)).toBe(true); // subdomain of an allowed host
    expect(isUrlAllowed('https://assets.com/x', s)).toBe(false); // PARENT of allowed host — not widened
    expect(isUrlAllowed('https://other.assets.com/x', s)).toBe(false); // sibling — not allowed
  });

  it('allows inert schemes; blocks raw IPs not pinned', () => {
    const s = allowedSuffixes('https://bank.com');
    expect(isUrlAllowed('data:text/html,x', s)).toBe(true);
    expect(isUrlAllowed('about:blank', s)).toBe(true);
    expect(isUrlAllowed('https://203.0.113.5/x', s)).toBe(false);
  });

  it('pins a multi-tenant-platform bank to ITS tenant, not the whole shared suffix', () => {
    // github.io / pages.dev / web.app etc. are PRIVATE suffixes — the pin must not widen to them.
    for (const [login, tenant, coTenant] of [
      ['https://victimbank.github.io/login', 'victimbank.github.io', 'https://attacker.github.io/collect?d=acct'],
      ['https://mybank.pages.dev/login', 'mybank.pages.dev', 'https://evil.pages.dev/x'],
      ['https://mybank.web.app/login', 'mybank.web.app', 'https://evil.web.app/x'],
    ] as const) {
      const s = allowedSuffixes(login);
      expect(s).toEqual([tenant]);
      expect(isUrlAllowed(`https://${tenant}/x`, s)).toBe(true);
      expect(isUrlAllowed(coTenant, s)).toBe(false); // co-tenant exfil is blocked
    }
  });
});
