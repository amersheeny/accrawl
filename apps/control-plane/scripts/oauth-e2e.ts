/* eslint-disable no-console */
/**
 * Local end-to-end run of the "Connect with Accrawl" OAuth flow across REAL processes:
 *   - the control-plane: a real Fastify server listening on a TCP port, backed by pglite-over-socket Postgres.
 *   - the test third-party app (e2e/oauth-consumer/server.mjs): a SEPARATE node process.
 * The runner plays the browser + operator: it walks /connect → /oauth/authorize → approves the consent with
 * the operator password → /callback, then asserts the consumer actually read the CONSENTED account data over
 * HTTP with the issued token. Proves the flow works when the pieces are genuinely assembled, not just in-process.
 *
 * Run (from apps/control-plane):  npx tsx scripts/oauth-e2e.ts     (or: pnpm e2e:oauth)
 */
import path from 'node:path';
import fs from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

const DB_PORT = 54347;
const CP_PORT = 3999;
const APP_PORT = 4999;
const ENC_KEY = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
const PW = 'e2e-operator-password';
const CP = `http://127.0.0.1:${CP_PORT}`;
const APP = `http://127.0.0.1:${APP_PORT}`;

const log = (...a: unknown[]) => console.log('[oauth-e2e]', ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
  console.log('[oauth-e2e]   ✓', msg);
}

async function waitFor(url: string, label: string, tries = 100): Promise<void> {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url); if (r.ok || r.status === 404) return; } catch { /* not up yet */ }
    await sleep(100);
  }
  throw new Error(`${label} did not come up at ${url}`);
}

async function main(): Promise<void> {
  // 1) Postgres (pglite over a TCP socket) + the real migrations.
  const client = new PGlite();
  const migDir = path.resolve(__dirname, '../migrations');
  for (const f of fs.readdirSync(migDir).filter((x) => x.endsWith('.sql')).sort()) {
    await client.exec(fs.readFileSync(path.join(migDir, f), 'utf8'));
  }
  const dbServer = new PGLiteSocketServer({ db: client, port: DB_PORT });
  await dbServer.start();

  // 2) Boot the control-plane as a real listening server (env MUST precede importing db/client).
  process.env.DATABASE_URL = `postgres://localhost:${DB_PORT}/postgres`;
  process.env.CREDENTIAL_ENC_KEY = ENC_KEY;
  process.env.DB_POOL_MAX = '1'; // PGLiteSocketServer is single-connection; >1 races into ECONNRESET
  process.env.NODE_ENV = 'test'; // quiet logger + no rate-limit noise; the endpoints behave identically
  const { db, sql } = await import('../src/db/client');
  const { buildServer } = await import('../src/index');
  const app = await buildServer();
  await app.listen({ port: CP_PORT, host: '127.0.0.1' });
  log(`control-plane up on ${CP}`);

  let appProc: ChildProcess | undefined;
  let failed = false;
  try {
    // 3) Seed: operator, institution, connection, accounts, and the OAuth client.
    const post = (p: string, body: unknown, token?: string) => fetch(`${CP}${p}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
    await post('/api/setup', { password: PW });
    const operatorToken = (await (await post('/api/auth/login', { password: PW })).json()).token as string;

    await client.exec(`insert into institutions (id,name,login_url,canonical_domain,type) values ('demobank','Demo Bank','https://demobank.test/','demobank.test','bank')`);
    const { createConnection } = await import('../src/data/connections');
    const conn = await createConnection(db, { institutionId: 'demobank', username: 'u', password: 'p', nickname: 'Everyday Checking' });
    const { storeCrawlResults } = await import('../src/data/store-crawl');
    await storeCrawlResults(db, {
      connectionId: conn.id,
      accounts: [
        { providerAccountId: 'chk', name: 'Everyday Checking', description: '', currency: 'USD', type: 'current', balance: 4210.55, available: 4210.55 },
        { providerAccountId: 'sav', name: 'Rainy Day Savings', description: '', currency: 'USD', type: 'savings', balance: 15000 },
      ],
      transactions: [], positions: [],
    });

    const reg = await (await post('/api/oauth-clients', {
      name: 'Budget Buddy', redirectUris: [`${APP}/callback`], allowedScopes: ['read:data'], isPublic: false,
    }, operatorToken)).json();
    log(`registered client ${reg.clientId}`);

    // 4) Boot the test third-party app as a SEPARATE process.
    const appPath = path.resolve(__dirname, '../../../e2e/oauth-consumer/server.mjs');
    appProc = spawn('node', [appPath], {
      env: {
        ...process.env, PORT: String(APP_PORT), ACCRAWL_BASE_URL: CP,
        ACCRAWL_CLIENT_ID: reg.clientId, ACCRAWL_CLIENT_SECRET: reg.clientSecret, ACCRAWL_CONNECTION_ID: conn.id,
      },
      stdio: 'inherit',
    });
    await waitFor(`${APP}/`, 'test app');

    // 5) Drive the flow as the browser + operator.
    // (a) /connect → 302 to /oauth/authorize (carrying the app's PKCE challenge + state).
    const connectRes = await fetch(`${APP}/connect`, { redirect: 'manual' });
    const authorizeUrl = new URL(connectRes.headers.get('location') as string);
    assert(authorizeUrl.pathname.endsWith('/oauth/authorize'), '/connect redirects to /oauth/authorize');

    // (b) GET the consent page — authenticate-first, so it names the app + asks the operator to sign in but
    //     does NOT leak the connection inventory before authentication.
    const consent = await fetch(authorizeUrl.toString(), { redirect: 'manual' });
    const consentHtml = await consent.text();
    assert(consent.status === 200, 'consent page renders (200)');
    assert(consentHtml.includes('Budget Buddy'), 'consent page names the requesting app');
    assert(consentHtml.includes('type="password"'), 'consent page asks the operator to sign in first');
    assert(!consentHtml.includes('Everyday Checking'), 'consent page does NOT leak connections pre-auth');

    // (c) Step 1 — the operator signs in with their password; the picker comes back with a consent ticket.
    const q = authorizeUrl.searchParams;
    const decisionForm = (extra: Record<string, string>) => new URLSearchParams({
      client_id: q.get('client_id')!, redirect_uri: q.get('redirect_uri')!, scope: q.get('scope')!,
      state: q.get('state')!, code_challenge: q.get('code_challenge')!, code_challenge_method: 'S256', ...extra,
    });
    const signIn = await fetch(`${CP}/oauth/authorize/decision`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, redirect: 'manual',
      body: decisionForm({ decision: 'continue', password: PW }),
    });
    const pickerHtml = await signIn.text();
    assert(signIn.status === 200, 'sign-in returns the connection picker');
    assert(pickerHtml.includes('Everyday Checking'), 'picker lists the connection to share (post-auth)');
    const ticket = pickerHtml.match(/name="consent_ticket" value="([^"]+)"/)?.[1];
    assert(ticket != null, 'picker carries a consent ticket');

    // (d) Step 2 — the operator ticks the connection and approves with the ticket (no password re-entry).
    const decision = await fetch(`${CP}/oauth/authorize/decision`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, redirect: 'manual',
      body: decisionForm({ decision: 'approve', consent_ticket: ticket!, connectionGrants: conn.id }),
    });
    assert(decision.status === 302, 'approval returns a redirect');
    const callbackUrl = new URL(decision.headers.get('location') as string);
    assert(callbackUrl.searchParams.get('code') != null, 'a single-use code is returned to the app');
    assert(callbackUrl.searchParams.get('state') === q.get('state'), 'state round-trips (CSRF binding)');

    // (e) The consumer's /callback exchanges the code and reads the data — end to end.
    const cb = await fetch(callbackUrl.toString(), { redirect: 'manual' });
    const cbHtml = await cb.text();
    assert(cb.status === 200, `consumer callback succeeds (got ${cb.status})`);
    assert(cbHtml.includes('Connected to Accrawl'), 'consumer reports a successful connection');
    assert(cbHtml.includes('Everyday Checking'), 'consumer displays the account it read via the token');
    assert(cbHtml.includes('4210.55'), 'consumer displays the real seeded balance');
    // The directory hands over the institution's NAME, so the app never renders a storage slug.
    assert(cbHtml.includes('Demo Bank'), 'directory names the institution for display');
    assert(cbHtml.includes('Demo Bank (bank)'), 'directory carries the institution type');
    // And the token reaches no retrieval control: no refresh route exists, and crawl/session are the
    // owner's own surface.
    assert(cbHtml.includes(`POST /api/v1/connections/${conn.id}/refresh → HTTP 404`), 'no refresh endpoint exists for a consumer');
    assert(cbHtml.includes(`POST /api/connections/${conn.id}/crawl → HTTP 401`), 'an OAuth token cannot start a crawl');
    assert(cbHtml.includes('GET /api/sessions/any → HTTP 404'), 'an OAuth token cannot read a crawl session');

    log('\n  ✅ PASS — the third-party app connected via OAuth, read exactly the consented account data, and could reach no retrieval control.\n');
  } catch (e) {
    failed = true;
    console.error('\n  ❌ FAIL:', e instanceof Error ? e.message : e, '\n');
  } finally {
    appProc?.kill('SIGKILL');
    await app.close();
    await sql.end({ timeout: 5 }).catch(() => {});
    await dbServer.stop().catch(() => {});
    await client.close().catch(() => {});
  }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
