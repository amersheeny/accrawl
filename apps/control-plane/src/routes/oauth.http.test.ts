import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import type { FastifyInstance } from 'fastify';

/**
 * End-to-end "Connect with Accrawl" OAuth flow against a real Fastify server + real (pglite-over-socket)
 * Postgres: register a client → GET /oauth/authorize (consent page) → POST the operator's approval →
 * exchange the code at /oauth/token → use the issued Bearer on /api/v1. The oracle is behavioural and
 * independent of the flow's internals: a token obtained purely through OAuth reads exactly the consented
 * connection and nothing else. Also covers the security negatives (code replay, PKCE failure, redirect
 * mismatch, cross-connection isolation, deny).
 */
const DB_PORT = 54345; // unique per socket-using test file (54343 is session-steps; keep this distinct)
const ENC_KEY = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
const PW = 'hunter2-operator-pw';

const form = (o: Record<string, string | string[]>): string => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) (Array.isArray(v) ? v : [v]).forEach((x) => p.append(k, x));
  return p.toString();
};
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };

describe('OAuth authorization-code + PKCE flow (real server + pglite)', () => {
  let client: PGlite;
  let dbServer: PGLiteSocketServer;
  let app: FastifyInstance;
  let closeDb: (() => Promise<void>) | undefined;
  let operatorToken: string;
  let connId: string; // granted
  let connId2: string; // NOT granted (isolation check)
  let clientRecordId: string;
  let clientId: string;
  let clientSecret: string;
  const redirectUri = 'https://app.example.com/callback';

  // PKCE pair
  const verifier = randomBytes(32).toString('base64url'); // 43 chars, unreserved
  const challenge = createHash('sha256').update(verifier).digest('base64url');

  beforeAll(async () => {
    client = new PGlite();
    const dir = path.resolve(__dirname, '../../migrations');
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
      await client.exec(fs.readFileSync(path.join(dir, f), 'utf8'));
    }
    dbServer = new PGLiteSocketServer({ db: client, port: DB_PORT });
    await dbServer.start();
    process.env.DATABASE_URL = `postgres://localhost:${DB_PORT}/postgres`;
    process.env.CREDENTIAL_ENC_KEY = ENC_KEY;
    process.env.SETUP_CLAIM_TOKEN = 'test-setup-code';
    process.env.DB_POOL_MAX = '1';

    const { db: dbc, sql } = await import('../db/client');
    closeDb = () => sql.end({ timeout: 5 });
    const { buildServer } = await import('../index');
    app = await buildServer();
    await app.ready();

    await app.inject({ method: 'POST', url: '/api/setup', payload: { password: PW, setupCode: 'test-setup-code' } });
    operatorToken = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: PW } })).json().token;

    await client.exec(`insert into institutions (id,name,login_url,canonical_domain,type) values ('bk','BankCo','https://bk.com/','bk.com','bank')`);
    const { createConnection } = await import('../data/connections');
    connId = (await createConnection(dbc, { institutionId: 'bk', username: 'u', password: 'p', nickname: 'Everyday' })).id;
    connId2 = (await createConnection(dbc, { institutionId: 'bk', username: 'u2', password: 'p2', nickname: 'Other' })).id;
    const { storeCrawlResults } = await import('../data/store-crawl');
    await storeCrawlResults(dbc, {
      connectionId: connId,
      accounts: [{ providerAccountId: 'p1', name: 'Everyday', description: '', currency: 'GBP', type: 'current', balance: 2500 }],
      transactions: [], positions: [],
    });

    const mk = await app.inject({
      method: 'POST', url: '/api/oauth-clients', headers: { authorization: `Bearer ${operatorToken}` },
      payload: { name: 'Budget Buddy', redirectUris: [redirectUri], allowedScopes: ['read:data'], isPublic: false },
    });
    expect(mk.statusCode).toBe(201);
    clientRecordId = mk.json().id;
    clientId = mk.json().clientId;
    clientSecret = mk.json().clientSecret;
  });

  afterAll(async () => {
    await app?.close();
    await closeDb?.();
    await dbServer?.stop();
    await client?.close();
    for (const k of ['DATABASE_URL', 'CREDENTIAL_ENC_KEY', 'DB_POOL_MAX']) delete process.env[k];
  });

  const authorizeUrl = (over: Record<string, string> = {}) => {
    const q = new URLSearchParams({
      response_type: 'code', client_id: clientId, redirect_uri: redirectUri, scope: 'read:data',
      state: 'xyz-state', code_challenge: challenge, code_challenge_method: 'S256', ...over,
    });
    return `/oauth/authorize?${q.toString()}`;
  };

  // Pull the hidden consent-ticket field out of the picker HTML (base64url + '.' — no chars esc() would touch).
  const extractTicket = (html: string): string => {
    const m = html.match(/name="consent_ticket" value="([^"]+)"/);
    expect(m, 'picker page carries a consent_ticket').toBeTruthy();
    return (m as RegExpMatchArray)[1];
  };

  // Drive the authenticate-first consent: step 1 (password) → picker + ticket; step 2 (ticket + selection) → code.
  async function signIn(): Promise<string> {
    const step1 = await app.inject({
      method: 'POST', url: '/oauth/authorize/decision', headers: FORM,
      payload: form({
        client_id: clientId, redirect_uri: redirectUri, scope: 'read:data', state: 'xyz-state',
        code_challenge: challenge, code_challenge_method: 'S256', decision: 'continue', password: PW,
      }),
    });
    expect(step1.statusCode).toBe(200);
    expect(step1.headers['content-type']).toContain('text/html');
    return extractTicket(step1.body);
  }

  async function getCode(connectionGrants: string[] = [connId]): Promise<string> {
    const ticket = await signIn();
    const dec = await app.inject({
      method: 'POST', url: '/oauth/authorize/decision', headers: FORM,
      payload: form({
        client_id: clientId, redirect_uri: redirectUri, scope: 'read:data', state: 'xyz-state',
        code_challenge: challenge, code_challenge_method: 'S256', decision: 'approve',
        consent_ticket: ticket, connectionGrants,
      }),
    });
    expect(dec.statusCode).toBe(302);
    const loc = new URL(dec.headers.location as string);
    expect(loc.searchParams.get('state')).toBe('xyz-state');
    const code = loc.searchParams.get('code');
    expect(code).toBeTruthy();
    return code as string;
  }

  const exchange = (over: Record<string, string> = {}) =>
    app.inject({
      method: 'POST', url: '/oauth/token', headers: FORM,
      payload: form({
        grant_type: 'authorization_code', code: 'PLACEHOLDER', redirect_uri: redirectUri,
        client_id: clientId, client_secret: clientSecret, code_verifier: verifier, ...over,
      }),
    });

  it('authorize renders a SIGN-IN-FIRST page and does NOT leak the connection inventory pre-auth', async () => {
    const res = await app.inject({ method: 'GET', url: authorizeUrl() });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('Budget Buddy');
    expect(res.body).toContain('Read your accounts'); // the human-readable scope label
    // Informed-consent cues for a financial-data grant: the access duration (derived from the ~90-day grant
    // TTL) and where approving sends the operator back (the registered redirect host).
    expect(res.body).toContain('Access lasts about 90 days');
    expect(res.body).toContain('app.example.com'); // the redirect destination host
    expect(res.body).toContain('type="password"'); // it asks the operator to sign in first
    // The leak that authenticate-first closes: neither connection's label is exposed before authentication.
    expect(res.body).not.toContain('Everyday');
    expect(res.body).not.toContain('Other');
    expect(res.body).not.toContain('connectionGrants');
  });

  it('the consent page referrer policy leaves its own form POST an Origin to be judged by', async () => {
    const res = await app.inject({ method: 'GET', url: authorizeUrl() });
    expect(res.statusCode).toBe(200);
    // This page submits a real HTML form, not a fetch(). Per Fetch's "append a request Origin
    // header", a non-GET navigation is sent with `Origin: null` when the referrer policy is
    // `no-referrer` — so the page's own privacy header erased the single piece of evidence the
    // origin check downstream has, and every approval was refused. `same-origin` keeps the real
    // origin on a same-origin submission while still sending nothing whatsoever cross-origin, so
    // an authorization code in a redirect URL still cannot leak onward through Referer.
    expect(res.body).toContain('<form method="post"');
    expect(res.headers['referrer-policy']).toBe('same-origin');
    // The rest of the consent-page hardening must not regress alongside it.
    expect(res.headers['x-frame-options']).toBe('DENY');
    const csp = String(res.headers['content-security-policy']);
    expect(csp).toContain("frame-ancestors 'none'");
    // The console keeps the operator bearer token in localStorage, so an unset script-src is a
    // token-theft path, not a cosmetic gap. Nothing shipped uses an inline script, so this stays
    // achievable — pinned here because it is the one directive that closes that path.
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    // Session screenshots are fetched as blobs and rendered via createObjectURL.
    expect(csp).toContain('blob:');
    // A script source wide enough to defeat the point must never creep in.
    expect(csp).not.toMatch(/script-src[^;]*unsafe-(inline|eval)/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('the connection picker (with a consent ticket) appears only AFTER the operator authenticates', async () => {
    const step1 = await app.inject({
      method: 'POST', url: '/oauth/authorize/decision', headers: FORM,
      payload: form({
        client_id: clientId, redirect_uri: redirectUri, scope: 'read:data', state: 'xyz-state',
        code_challenge: challenge, code_challenge_method: 'S256', decision: 'continue', password: PW,
      }),
    });
    expect(step1.statusCode).toBe(200);
    expect(step1.body).toContain('Everyday'); // now the granted connection is offered
    expect(step1.body).toContain('connectionGrants');
    expect(step1.body).toContain('name="consent_ticket"'); // proof-of-auth to carry into step 2
  });

  it('an approve without a valid consent ticket cannot mint a code (falls back to sign-in)', async () => {
    const dec = await app.inject({
      method: 'POST', url: '/oauth/authorize/decision', headers: FORM,
      payload: form({
        client_id: clientId, redirect_uri: redirectUri, scope: 'read:data', state: 'xyz-state',
        code_challenge: challenge, code_challenge_method: 'S256', decision: 'approve',
        consent_ticket: 'accsent1.forged.forged', connectionGrants: [connId],
      }),
    });
    expect(dec.statusCode).toBe(401); // forged ticket → back to sign-in
    expect(dec.headers['content-type']).toContain('text/html');
    expect(dec.headers.location).toBeUndefined(); // no redirect, no code
    expect(dec.body).not.toContain('Everyday'); // and still no inventory leak
  });

  it('the "select a connection" error re-uses the SAME ticket (a held ticket cannot be renewed past its TTL)', async () => {
    // Present a valid ticket but tick nothing → the recoverable "select at least one" error. The re-rendered
    // picker must echo the SAME ticket, not mint a fresh one — else this path could be looped to keep a held
    // ticket alive indefinitely, defeating the short TTL that bounds a stolen ticket's life.
    const ticket = await signIn();
    const dec = await app.inject({
      method: 'POST', url: '/oauth/authorize/decision', headers: FORM,
      payload: form({
        client_id: clientId, redirect_uri: redirectUri, scope: 'read:data', state: 'xyz-state',
        code_challenge: challenge, code_challenge_method: 'S256', decision: 'approve', consent_ticket: ticket,
      }),
    });
    expect(dec.statusCode).toBe(400);
    expect(dec.body).toContain('Select at least one existing connection to share.');
    expect(extractTicket(dec.body)).toBe(ticket); // same ticket echoed — no fresh mint, no TTL extension
  });

  it('a consent ticket is bound to its request: reusing it under a DIFFERENT PKCE challenge is rejected', async () => {
    // Sign in (ticket bound to `challenge`), then try to approve while swapping in a different code_challenge.
    // The binding mismatch invalidates the ticket, so no code is minted — it drops back to sign-in.
    const ticket = await signIn();
    const otherChallenge = createHash('sha256').update(randomBytes(32).toString('base64url')).digest('base64url');
    const dec = await app.inject({
      method: 'POST', url: '/oauth/authorize/decision', headers: FORM,
      payload: form({
        client_id: clientId, redirect_uri: redirectUri, scope: 'read:data', state: 'xyz-state',
        code_challenge: otherChallenge, code_challenge_method: 'S256', decision: 'approve',
        consent_ticket: ticket, connectionGrants: [connId],
      }),
    });
    expect(dec.statusCode).toBe(401); // ticket bound to the original challenge → rejected
    expect(dec.headers.location).toBeUndefined(); // no redirect, no code
  });

  it('authorize rejects an unregistered redirect_uri WITHOUT redirecting (open-redirect guard)', async () => {
    const res = await app.inject({ method: 'GET', url: authorizeUrl({ redirect_uri: 'https://evil.example.com/cb' }) });
    expect(res.statusCode).toBe(400);
    expect(res.headers.location).toBeUndefined();
  });

  it('authorize redirects protocol errors back to the client (invalid_scope)', async () => {
    const res = await app.inject({ method: 'GET', url: authorizeUrl({ scope: 'write:crawl' }) }); // not a scope this API has
    expect(res.statusCode).toBe(302);
    expect(new URL(res.headers.location as string).searchParams.get('error')).toBe('invalid_scope');
  });

  it('deny redirects back with access_denied and mints no code', async () => {
    const dec = await app.inject({
      method: 'POST', url: '/oauth/authorize/decision', headers: FORM,
      payload: form({ client_id: clientId, redirect_uri: redirectUri, scope: 'read:data', state: 's', decision: 'deny', password: PW, connectionGrants: [connId] }),
    });
    expect(dec.statusCode).toBe(302);
    const loc = new URL(dec.headers.location as string);
    expect(loc.searchParams.get('error')).toBe('access_denied');
    expect(loc.searchParams.get('code')).toBeNull();
  });

  it('a wrong password re-renders the consent page and mints no code', async () => {
    const dec = await app.inject({
      method: 'POST', url: '/oauth/authorize/decision', headers: FORM,
      payload: form({ client_id: clientId, redirect_uri: redirectUri, scope: 'read:data', state: 's', code_challenge: challenge, code_challenge_method: 'S256', decision: 'approve', password: 'WRONG', connectionGrants: [connId] }),
    });
    expect(dec.statusCode).toBe(401);
    expect(dec.headers['content-type']).toContain('text/html');
  });

  it('full flow: code → token → the token reads the granted connection but NOT an ungranted one', async () => {
    const code = await getCode([connId]);
    const tok = await exchange({ code });
    expect(tok.statusCode).toBe(200);
    const body = tok.json();
    expect(body.token_type).toBe('Bearer');
    expect(body.scope).toBe('read:data');
    expect(body.expires_in).toBeGreaterThan(90 * 24 * 60 * 60 - 60); // ~3-month clock (seconds remaining)
    expect(body.expires_in).toBeLessThanOrEqual(90 * 24 * 60 * 60);
    expect(body.refresh_token).toMatch(/^acrt_/); // a rotating refresh token is issued alongside
    const accessToken = body.access_token as string;
    expect(accessToken).toMatch(/^acck_/); // it's a scoped API key under the hood

    // Granted connection → 200.
    const ok = await app.inject({ method: 'GET', url: `/api/v1/connections/${connId}/accounts`, headers: { authorization: `Bearer ${accessToken}` } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().items).toHaveLength(1);

    // Ungranted connection → 403 (consent scoped the token to connId only).
    const denied = await app.inject({ method: 'GET', url: `/api/v1/connections/${connId2}/accounts`, headers: { authorization: `Bearer ${accessToken}` } });
    expect(denied.statusCode).toBe(403);
  });

  it('the authorization code is single-use (replay → invalid_grant)', async () => {
    const code = await getCode([connId]);
    expect((await exchange({ code })).statusCode).toBe(200);
    const replay = await exchange({ code });
    expect(replay.statusCode).toBe(400);
    expect(replay.json().error).toBe('invalid_grant');
  });

  it('PKCE is enforced: a wrong code_verifier fails the exchange', async () => {
    const code = await getCode([connId]);
    const bad = await exchange({ code, code_verifier: randomBytes(32).toString('base64url') });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe('invalid_grant');
  });

  it('a bad client_secret is rejected as invalid_client (401)', async () => {
    const code = await getCode([connId]);
    const bad = await exchange({ code, client_secret: 'acls_wrong' });
    expect(bad.statusCode).toBe(401);
    expect(bad.json().error).toBe('invalid_client');
  });

  it('rejects malformed or ambiguous OAuth client authentication', async () => {
    const malformed = await app.inject({
      method: 'POST',
      url: '/oauth/token',
      headers: { ...FORM, authorization: 'Basic !!!' },
      payload: form({
        grant_type: 'refresh_token',
        refresh_token: 'acrt_missing',
      }),
    });
    expect(malformed.statusCode).toBe(401);
    expect(malformed.json().error).toBe('invalid_client');

    const basic = Buffer.from(
      `${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`,
      'utf8',
    ).toString('base64');
    const ambiguous = await app.inject({
      method: 'POST',
      url: '/oauth/token',
      headers: { ...FORM, authorization: `Basic ${basic}` },
      payload: form({
        grant_type: 'refresh_token',
        refresh_token: 'acrt_missing',
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });
    expect(ambiguous.statusCode).toBe(401);
    expect(ambiguous.json().error).toBe('invalid_client');
  });

  it('redirect_uri must match at exchange (invalid_grant)', async () => {
    const code = await getCode([connId]);
    const bad = await exchange({ code, redirect_uri: 'https://app.example.com/other' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe('invalid_grant');
  });

  it('PKCE is mandatory even for a CONFIDENTIAL client: authorize + decision without code_challenge are refused', async () => {
    // The test client is confidential (has a secret). Without PKCE it must still be rejected (OAuth 2.1 / BCP).
    const auth = await app.inject({ method: 'GET', url: authorizeUrl({ code_challenge: '', code_challenge_method: '' }) });
    expect(auth.statusCode).toBe(302);
    expect(new URL(auth.headers.location as string).searchParams.get('error')).toBe('invalid_request');

    const dec = await app.inject({
      method: 'POST', url: '/oauth/authorize/decision', headers: FORM,
      payload: form({ client_id: clientId, redirect_uri: redirectUri, scope: 'read:data', state: 's', decision: 'approve', password: PW, connectionGrants: [connId] }),
    });
    expect(dec.statusCode).toBe(302);
    const loc = new URL(dec.headers.location as string);
    expect(loc.searchParams.get('error')).toBe('invalid_request'); // no code_challenge → refused
    expect(loc.searchParams.get('code')).toBeNull(); // no code minted
  });

  const tokenBundle = async () => (await exchange({ code: await getCode([connId]) })).json();

  it('limits OAuth access tokens to the documented public resource API', async () => {
    const bundle = await tokenBundle();
    const authorization = {
      authorization: `Bearer ${bundle.access_token as string}`,
    };
    const publicRead = await app.inject({
      method: 'GET',
      url: `/api/v1/connections/${connId}/accounts`,
      headers: authorization,
    });
    expect(publicRead.statusCode).toBe(200);

    // Everything about HOW the data was retrieved is refused. The owner-only routes answer 401 (they take an
    // operator, and this is not one); the companion-credential routes answer 404, which is what any
    // OAuth-issued token gets on a non-public route so it cannot map the internal surface.
    for (const [internalUrl, expected] of [
      [`/api/connections/${connId}/sessions`, 401],
      ['/api/sessions/not-a-real-session', 404],
      ['/api/sessions/not-a-real-session/steps', 404],
      ['/api/sessions/not-a-real-session/records', 404],
      ['/api/sessions/not-a-real-session/steps/1/screenshot', 404],
    ] as const) {
      const denied = await app.inject({
        method: 'GET',
        url: internalUrl,
        headers: authorization,
      });
      expect(denied.statusCode, internalUrl).toBe(expected);
    }

    // Nor can it cause a retrieval: no refresh route exists, and the crawl route takes an operator only.
    expect((await app.inject({ method: 'POST', url: `/api/v1/connections/${connId}/refresh`, headers: authorization })).statusCode).toBe(404);
    // Starting a crawl now also admits an owner's own expiring key, so it answers like the other routes
    // that do: an OAuth-issued token gets 404 and cannot tell whether the route exists. The refusal is
    // stronger than the 401 it used to give, and it is the guard's own rule, not this route's.
    expect((await app.inject({ method: 'POST', url: `/api/connections/${connId}/crawl`, headers: authorization })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/api/sessions/not-a-real-session/otp', payload: { code: '123456' }, headers: authorization })).statusCode).toBe(401);
  });

  it('a client cannot even register for a retrieval permission — read:data is the whole API', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/oauth-clients',
      headers: { authorization: `Bearer ${operatorToken}` },
      payload: { name: 'greedy', redirectUris: [redirectUri], allowedScopes: ['read:data', 'write:crawl'], isPublic: false },
    });
    expect(res.statusCode).toBe(400);
  });

  it('refresh_token rotates the pair; replaying the consumed refresh revokes the grant', async () => {
    const first = await tokenBundle();
    const refreshed = await app.inject({
      method: 'POST', url: '/oauth/token', headers: FORM,
      payload: form({ grant_type: 'refresh_token', refresh_token: first.refresh_token, client_id: clientId, client_secret: clientSecret }),
    });
    expect(refreshed.statusCode).toBe(200);
    const second = refreshed.json();
    expect(second.access_token).toMatch(/^acck_/);
    expect(second.refresh_token).toMatch(/^acrt_/);
    expect(second.refresh_token).not.toBe(first.refresh_token); // rotated
    const ok = await app.inject({ method: 'GET', url: `/api/v1/connections/${connId}/accounts`, headers: { authorization: `Bearer ${second.access_token}` } });
    expect(ok.statusCode).toBe(200); // the rotated access token works

    // Replaying the OLD (consumed) refresh token is reuse → grant revoked, and the new access token dies.
    const replay = await app.inject({
      method: 'POST', url: '/oauth/token', headers: FORM,
      payload: form({ grant_type: 'refresh_token', refresh_token: first.refresh_token, client_id: clientId, client_secret: clientSecret }),
    });
    expect(replay.statusCode).toBe(400);
    expect(replay.json().error).toBe('invalid_grant');
    const dead = await app.inject({ method: 'GET', url: `/api/v1/connections/${connId}/accounts`, headers: { authorization: `Bearer ${second.access_token}` } });
    expect(dead.statusCode).toBe(401); // grant revoked → access token invalid
  });

  it('introspect reports active, then inactive after RFC-7009 revoke', async () => {
    const bundle = await tokenBundle();
    const introspect = (tok: string) => app.inject({
      method: 'POST', url: '/oauth/introspect', headers: FORM,
      payload: form({ token: tok, client_id: clientId, client_secret: clientSecret }),
    });
    expect((await introspect(bundle.access_token)).json()).toMatchObject({ active: true, scope: 'read:data', token_type: 'Bearer' });

    const rev = await app.inject({
      method: 'POST', url: '/oauth/revoke', headers: FORM,
      payload: form({ token: bundle.access_token, client_id: clientId, client_secret: clientSecret }),
    });
    expect(rev.statusCode).toBe(200);
    expect((await introspect(bundle.access_token)).json()).toEqual({ active: false });
    const denied = await app.inject({ method: 'GET', url: `/api/v1/connections/${connId}/accounts`, headers: { authorization: `Bearer ${bundle.access_token}` } });
    expect(denied.statusCode).toBe(401);
  });

  it('operator lists connected apps and revokes a grant, killing its tokens', async () => {
    const bundle = await tokenBundle();
    const list = await app.inject({ method: 'GET', url: '/api/grants', headers: { authorization: `Bearer ${operatorToken}` } });
    expect(list.statusCode).toBe(200);
    const newest = list.json().grants[0]; // listGrants orders newest-first → this test's grant
    expect(newest).toMatchObject({ clientId, status: 'active', scopes: ['read:data'] });

    const del = await app.inject({ method: 'DELETE', url: `/api/grants/${newest.id}`, headers: { authorization: `Bearer ${operatorToken}` } });
    expect(del.statusCode).toBe(204);
    const denied = await app.inject({ method: 'GET', url: `/api/v1/connections/${connId}/accounts`, headers: { authorization: `Bearer ${bundle.access_token}` } });
    expect(denied.statusCode).toBe(401); // revoking the grant revoked its access token
  });

  it('revoking a grant fires a grant.revoked webhook once; a repeat DELETE is idempotent (204, no re-fire)', async () => {
    // A real HTTP receiver subscribed to grant.revoked; the DELETE fires the webhook fire-and-forget over
    // the global fetch, so we poll for the delivery rather than await it. We collect EVERY delivery so we can
    // assert the second (no-op) DELETE does not re-emit the event.
    const deliveries: string[] = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => { deliveries.push(body); res.writeHead(200).end('ok'); });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const { db: dbc } = await import('../db/client');
      const { createWebhook } = await import('../data/webhooks');
      await createWebhook(dbc, { url: `http://localhost:${port}/hook`, events: ['grant.revoked'] });

      await tokenBundle();
      const list = await app.inject({ method: 'GET', url: '/api/grants', headers: { authorization: `Bearer ${operatorToken}` } });
      const grant = list.json().grants[0];

      const del = await app.inject({ method: 'DELETE', url: `/api/grants/${grant.id}`, headers: { authorization: `Bearer ${operatorToken}` } });
      expect(del.statusCode).toBe(204);

      // Poll for the fire-and-forget delivery (up to ~2s).
      for (let i = 0; i < 40 && deliveries.length === 0; i++) await new Promise((r) => setTimeout(r, 50));
      expect(deliveries).toHaveLength(1);
      expect(JSON.parse(deliveries[0])).toMatchObject({
        event: 'grant.revoked',
        grantId: grant.id,
        clientId, // the public accl_… id of the app whose grant was pulled
      });

      // A repeat DELETE of the now-revoked grant is idempotent (still 204) and must NOT re-fire the webhook —
      // the event already happened; a no-op revoke is not a revocation event.
      const del2 = await app.inject({ method: 'DELETE', url: `/api/grants/${grant.id}`, headers: { authorization: `Bearer ${operatorToken}` } });
      expect(del2.statusCode).toBe(204);
      await new Promise((r) => setTimeout(r, 300)); // give any (erroneous) second delivery time to arrive
      expect(deliveries).toHaveLength(1); // still exactly one — no spurious re-fire

      // A DELETE of a grant that never existed is 404 (and obviously no webhook).
      const del404 = await app.inject({ method: 'DELETE', url: `/api/grants/00000000-0000-0000-0000-000000000000`, headers: { authorization: `Bearer ${operatorToken}` } });
      expect(del404.statusCode).toBe(404);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('disabling the client invalidates its codes, grants, access tokens, and refresh tokens', async () => {
    const bundle = await tokenBundle();
    const unusedCode = await getCode([connId]);
    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/oauth-clients/${clientRecordId}`,
      headers: { authorization: `Bearer ${operatorToken}` },
    });
    expect(deleted.statusCode).toBe(204);

    expect((await app.inject({
      method: 'GET',
      url: `/api/v1/connections/${connId}/accounts`,
      headers: { authorization: `Bearer ${bundle.access_token}` },
    })).statusCode).toBe(401);
    expect((await exchange({ code: unusedCode })).statusCode).toBe(401);
    const refresh = await app.inject({
      method: 'POST',
      url: '/oauth/token',
      headers: FORM,
      payload: form({
        grant_type: 'refresh_token',
        refresh_token: bundle.refresh_token,
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });
    expect(refresh.statusCode).toBe(401);
    const clients = await app.inject({
      method: 'GET',
      url: '/api/oauth-clients',
      headers: { authorization: `Bearer ${operatorToken}` },
    });
    expect(clients.json().clients).toEqual([]);
  });
});
