import { describe, it, expect } from 'vitest';
import { deriveCanonicalDomain, hostnameOf, isHostWithinDomain } from './domain';

describe('domain helpers', () => {
  it('derives eTLD+1 including multi-level public suffixes', () => {
    expect(deriveCanonicalDomain('https://login.bankhapoalim.co.il/x')).toBe('bankhapoalim.co.il');
    expect(deriveCanonicalDomain('https://www.chase.com')).toBe('chase.com');
    expect(deriveCanonicalDomain('http://a.b.example.co.uk:8443/p')).toBe('example.co.uk');
    expect(deriveCanonicalDomain('https://CAPS.Example.COM')).toBe('example.com'); // lowercased
  });

  it('returns null for IPs, localhost, and malformed URLs', () => {
    expect(deriveCanonicalDomain('https://192.168.1.1/x')).toBeNull();
    expect(deriveCanonicalDomain('https://localhost/x')).toBeNull();
    expect(deriveCanonicalDomain('not a url')).toBeNull();
  });

  it('accepts only credential-free HTTP and HTTPS URLs', () => {
    expect(deriveCanonicalDomain('ftp://login.bank.com/x')).toBeNull();
    expect(deriveCanonicalDomain('javascript://login.bank.com/%0Aalert(1)')).toBeNull();
    expect(deriveCanonicalDomain('data://login.bank.com/text/plain,test')).toBeNull();
    expect(deriveCanonicalDomain('https://user:secret@login.bank.com/x')).toBeNull();
  });

  it('hostnameOf returns the lowercased host', () => {
    expect(hostnameOf('https://Login.Bank.COM/x')).toBe('login.bank.com');
    expect(hostnameOf('http://Login.Bank.COM/x')).toBe('login.bank.com');
    expect(hostnameOf('javascript://login.bank.com/alert(1)')).toBeNull();
    expect(hostnameOf('ftp://login.bank.com/x')).toBeNull();
    expect(hostnameOf('not a url')).toBeNull(); // whitespace ⇒ unparseable host
  });

  it('isHostWithinDomain accepts subdomains and rejects look-alikes', () => {
    expect(isHostWithinDomain('https://login.bank.com/x', 'bank.com')).toBe(true);
    expect(isHostWithinDomain('https://bank.com/x', 'bank.com')).toBe(true);
    expect(isHostWithinDomain('https://bank.com.evil.com/x', 'bank.com')).toBe(false);
    expect(isHostWithinDomain('https://notbank.com/x', 'bank.com')).toBe(false);
  });

  it('pins a multi-tenant-platform tenant, not the shared private suffix', () => {
    // appspot.com / web.app etc. are PRIVATE suffixes — the anti-phishing anchor must not widen to them.
    expect(deriveCanonicalDomain('https://victim.appspot.com/login')).toBe('victim.appspot.com');
    expect(deriveCanonicalDomain('https://bank.web.app/login')).toBe('bank.web.app');
    expect(deriveCanonicalDomain('https://login.realbank.com/')).toBe('realbank.com'); // normal: unchanged
    // consequence: a sibling tenant is NOT within the anchored canonical domain
    expect(isHostWithinDomain('https://attacker.appspot.com/login', 'victim.appspot.com')).toBe(false);
  });
});
