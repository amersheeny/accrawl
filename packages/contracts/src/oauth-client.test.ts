import { describe, expect, it } from 'vitest';
import {
  isAllowedOauthRedirectUri,
  oauthClientRegistrationSchema,
  oauthRedirectUriMatches,
} from './oauth-client';

describe('OAuth client registration contract', () => {
  it('accepts exact HTTPS callbacks and loopback HTTP development callbacks', () => {
    expect(isAllowedOauthRedirectUri('https://app.example.com/callback')).toBe(true);
    expect(isAllowedOauthRedirectUri('https://app.example.com/callback?flow=accrawl'))
      .toBe(true);
    expect(isAllowedOauthRedirectUri('http://localhost:3000/callback')).toBe(true);
    expect(isAllowedOauthRedirectUri('http://127.0.0.1:3000/callback')).toBe(true);
    expect(isAllowedOauthRedirectUri('http://[::1]:3000/callback')).toBe(true);
  });

  it('rejects insecure, fragment-bearing, duplicate, and unknown metadata', () => {
    const base = {
      name: 'Example app',
      redirectUris: ['https://app.example.com/callback'],
      allowedScopes: ['read:data'],
      isPublic: false,
    };
    expect(oauthClientRegistrationSchema.safeParse(base).success).toBe(true);
    expect(oauthClientRegistrationSchema.safeParse({
      ...base,
      redirectUris: ['http://app.example.com/callback'],
    }).success).toBe(false);
    expect(oauthClientRegistrationSchema.safeParse({
      ...base,
      redirectUris: ['https://app.example.com/callback#fragment'],
    }).success).toBe(false);
    expect(oauthClientRegistrationSchema.safeParse({
      ...base,
      redirectUris: ['https://user:password@app.example.com/callback'],
    }).success).toBe(false);
    expect(oauthClientRegistrationSchema.safeParse({
      ...base,
      redirectUris: [
        'https://app.example.com/callback',
        'https://app.example.com/callback',
      ],
    }).success).toBe(false);
    expect(oauthClientRegistrationSchema.safeParse({
      ...base,
      allowedScopes: ['read:data', 'read:data'],
    }).success).toBe(false);
    expect(oauthClientRegistrationSchema.safeParse({
      ...base,
      recipientTenantId: 'another-tenant',
    }).success).toBe(false);
  });

  it('allows only the loopback port to vary at authorization time', () => {
    expect(oauthRedirectUriMatches(
      'http://127.0.0.1:3000/callback?flow=accrawl',
      'http://127.0.0.1:49152/callback?flow=accrawl',
    )).toBe(true);
    expect(oauthRedirectUriMatches(
      'http://[::1]:3000/callback',
      'http://[::1]:49152/callback',
    )).toBe(true);
    expect(oauthRedirectUriMatches(
      'https://app.example.com/callback',
      'https://app.example.com:444/callback',
    )).toBe(false);
    expect(oauthRedirectUriMatches(
      'http://localhost:3000/callback',
      'http://127.0.0.1:3000/callback',
    )).toBe(false);
    expect(oauthRedirectUriMatches(
      'http://localhost:3000/callback',
      'http://localhost:4000/other',
    )).toBe(false);
  });
});
