import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { AccrawlOAuthClient, generatePkce } from './oauth';
import { AccrawlApiError } from './errors';

interface Recorded { url: string; method?: string; headers?: Record<string, string>; body?: string }

function stub(status: number, body: string | object) {
  const calls: Recorded[] = [];
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  const fetch = async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
    calls.push({ url, method: init?.method, headers: init?.headers, body: init?.body });
    return { status, text: async () => text };
  };
  return { fetch, calls };
}

const make = (fetch: ReturnType<typeof stub>['fetch'], over: Partial<{ clientSecret?: string }> = {}) =>
  new AccrawlOAuthClient({
    baseUrl: 'https://acc.example.com/',
    clientId: 'accl_test',
    clientSecret: 'acls_secret',
    redirectUri: 'https://app.example.com/callback',
    fetch,
    ...over,
  });

describe('generatePkce', () => {
  it('produces a 43-char base64url verifier and its S256 challenge', () => {
    const p = generatePkce();
    expect(p.codeChallengeMethod).toBe('S256');
    expect(p.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 bytes → 43 base64url chars, unreserved
    // The challenge is BASE64URL(SHA256(verifier)) — reproduce it independently.
    const expected = createHash('sha256').update(p.codeVerifier).digest('base64url');
    expect(p.codeChallenge).toBe(expected);
  });

  it('is random per call', () => {
    expect(generatePkce().codeVerifier).not.toBe(generatePkce().codeVerifier);
  });
});

describe('AccrawlOAuthClient — construction', () => {
  it('requires baseUrl, clientId, redirectUri', () => {
    const f = stub(200, {}).fetch;
    expect(() => new AccrawlOAuthClient({ baseUrl: '', clientId: 'c', redirectUri: 'r', fetch: f })).toThrow(/baseUrl/);
    expect(() => new AccrawlOAuthClient({ baseUrl: 'https://x', clientId: '', redirectUri: 'r', fetch: f })).toThrow(/clientId/);
    expect(() => new AccrawlOAuthClient({ baseUrl: 'https://x', clientId: 'c', redirectUri: '', fetch: f })).toThrow(/redirectUri/);
  });
});

describe('AccrawlOAuthClient — startAuthorization / buildAuthorizationUrl', () => {
  it('builds a /oauth/authorize URL with PKCE S256 and returns state + verifier to persist', () => {
    const started = make(stub(200, {}).fetch).startAuthorization({ scope: 'read:data', state: 'st-123' });
    const u = new URL(started.url);
    expect(u.origin + u.pathname).toBe('https://acc.example.com/oauth/authorize'); // trailing slash stripped
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(u.searchParams.get('client_id')).toBe('accl_test');
    expect(u.searchParams.get('redirect_uri')).toBe('https://app.example.com/callback');
    expect(u.searchParams.get('scope')).toBe('read:data');
    expect(u.searchParams.get('state')).toBe('st-123');
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    // The challenge in the URL must be the S256 of the returned verifier (they pair).
    expect(u.searchParams.get('code_challenge')).toBe(createHash('sha256').update(started.codeVerifier).digest('base64url'));
  });

  it('joins array scopes with a space and auto-generates state when omitted', () => {
    const started = make(stub(200, {}).fetch).startAuthorization({ scope: ['read:data', 'write:otp'] });
    const u = new URL(started.url);
    expect(u.searchParams.get('scope')).toBe('read:data write:otp');
    expect(started.state).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(started.state.length).toBeGreaterThan(10);
  });

  it('defaults scope to read:data', () => {
    const started = make(stub(200, {}).fetch).startAuthorization();
    expect(new URL(started.url).searchParams.get('scope')).toBe('read:data');
  });
});

describe('AccrawlOAuthClient — exchangeCode', () => {
  const tokenBody = { access_token: 'acck_abc', token_type: 'Bearer', expires_in: 7776000, refresh_token: 'acrt_xyz', scope: 'read:data' };

  it('POSTs form-encoded authorization_code with client_secret_post + PKCE verifier', async () => {
    const s = stub(200, tokenBody);
    const tok = await make(s.fetch).exchangeCode({ code: 'the-code', codeVerifier: 'the-verifier' });
    expect(tok).toEqual(tokenBody);
    const c = s.calls[0];
    expect(c.url).toBe('https://acc.example.com/oauth/token');
    expect(c.method).toBe('POST');
    expect(c.headers?.['content-type']).toBe('application/x-www-form-urlencoded');
    const p = new URLSearchParams(c.body);
    expect(p.get('grant_type')).toBe('authorization_code');
    expect(p.get('code')).toBe('the-code');
    expect(p.get('code_verifier')).toBe('the-verifier');
    expect(p.get('redirect_uri')).toBe('https://app.example.com/callback'); // defaults to constructor value
    expect(p.get('client_id')).toBe('accl_test');
    expect(p.get('client_secret')).toBe('acls_secret');
  });

  it('a public client (no secret) sends client_id only', async () => {
    const s = stub(200, tokenBody);
    await make(s.fetch, { clientSecret: undefined }).exchangeCode({ code: 'c', codeVerifier: 'v' });
    const p = new URLSearchParams(s.calls[0].body);
    expect(p.get('client_id')).toBe('accl_test');
    expect(p.has('client_secret')).toBe(false);
  });

  it('honours an explicit redirectUri override', async () => {
    const s = stub(200, tokenBody);
    await make(s.fetch).exchangeCode({ code: 'c', codeVerifier: 'v', redirectUri: 'https://other/cb' });
    expect(new URLSearchParams(s.calls[0].body).get('redirect_uri')).toBe('https://other/cb');
  });

  it('throws AccrawlApiError with error_description on an OAuth error', async () => {
    const s = stub(400, { error: 'invalid_grant', error_description: 'authorization code expired' });
    await expect(make(s.fetch).exchangeCode({ code: 'c', codeVerifier: 'v' })).rejects.toMatchObject({
      name: 'AccrawlApiError',
      status: 400,
      message: 'authorization code expired',
    });
    await expect(make(stub(400, { error: 'invalid_grant', error_description: 'x' }).fetch)
      .exchangeCode({ code: 'c', codeVerifier: 'v' })).rejects.toBeInstanceOf(AccrawlApiError);
  });
});

describe('AccrawlOAuthClient — refresh', () => {
  it('POSTs grant_type=refresh_token with the token + client auth', async () => {
    const s = stub(200, { access_token: 'acck_new', token_type: 'Bearer', expires_in: 7000000, refresh_token: 'acrt_new', scope: 'read:data' });
    const tok = await make(s.fetch).refresh({ refreshToken: 'acrt_old' });
    expect(tok.access_token).toBe('acck_new');
    const p = new URLSearchParams(s.calls[0].body);
    expect(s.calls[0].url).toBe('https://acc.example.com/oauth/token');
    expect(p.get('grant_type')).toBe('refresh_token');
    expect(p.get('refresh_token')).toBe('acrt_old');
    expect(p.get('client_secret')).toBe('acls_secret');
  });

  it('surfaces reuse-detection as an AccrawlApiError', async () => {
    const s = stub(400, { error: 'invalid_grant', error_description: 'refresh token reuse detected; grant revoked' });
    await expect(make(s.fetch).refresh({ refreshToken: 'acrt_replayed' })).rejects.toMatchObject({ status: 400 });
  });
});

describe('AccrawlOAuthClient — revoke', () => {
  it('POSTs the token (+ optional hint) to /oauth/revoke and resolves on 200', async () => {
    const s = stub(200, {});
    await make(s.fetch).revoke({ token: 'acrt_x', tokenTypeHint: 'refresh_token' });
    const c = s.calls[0];
    expect(c.url).toBe('https://acc.example.com/oauth/revoke');
    const p = new URLSearchParams(c.body);
    expect(p.get('token')).toBe('acrt_x');
    expect(p.get('token_type_hint')).toBe('refresh_token');
    expect(p.get('client_id')).toBe('accl_test');
  });

  it('omits token_type_hint when not given', async () => {
    const s = stub(200, {});
    await make(s.fetch).revoke({ token: 'acck_y' });
    expect(new URLSearchParams(s.calls[0].body).has('token_type_hint')).toBe(false);
  });

  it('throws on a non-2xx revoke (e.g. bad client auth)', async () => {
    const s = stub(401, { error: 'invalid_client', error_description: 'bad client credentials' });
    await expect(make(s.fetch).revoke({ token: 't' })).rejects.toMatchObject({ status: 401 });
  });
});
