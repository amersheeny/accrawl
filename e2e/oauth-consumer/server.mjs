/**
 * A minimal THIRD-PARTY app that integrates with Accrawl via the "Connect with Accrawl" OAuth flow.
 *
 * It is intentionally tiny and dependency-free (node:http + node:crypto) so it reads as exactly what a real
 * consumer must implement:
 *   GET /            a landing page with a "Connect with Accrawl" button.
 *   GET /connect     starts the flow: generates PKCE (verifier+S256 challenge) + a CSRF `state`, remembers
 *                    them, and 302-redirects the browser to Accrawl's /oauth/authorize.
 *   GET /callback    Accrawl redirects back here with ?code&state. We verify `state`, exchange the code at
 *                    /oauth/token (client_secret + PKCE verifier) for an access token, then call the Accrawl
 *                    data API with that token and show what we got back.
 *
 * Config (env): ACCRAWL_BASE_URL, ACCRAWL_CLIENT_ID, ACCRAWL_CLIENT_SECRET, ACCRAWL_CONNECTION_ID, PORT.
 */
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';

const ACCRAWL = process.env.ACCRAWL_BASE_URL || 'http://127.0.0.1:3000';
const CLIENT_ID = process.env.ACCRAWL_CLIENT_ID || '';
const CLIENT_SECRET = process.env.ACCRAWL_CLIENT_SECRET || '';
const CONNECTION_ID = process.env.ACCRAWL_CONNECTION_ID || '';
const PORT = parseInt(process.env.PORT || '4000', 10);
const SELF = `http://127.0.0.1:${PORT}`;
const REDIRECT_URI = `${SELF}/callback`;
const SCOPE = 'read:data';

// state -> { verifier }. In-memory is fine for a single-user demo app; a real app keys this to the session.
const pending = new Map();

const base64url = (buf) => buf.toString('base64url');
const pkce = () => {
  const verifier = base64url(randomBytes(32)); // 43 chars, unreserved set
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
};

const page = (title, body) =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>` +
  `<style>body{font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;max-width:640px;margin:64px auto;padding:0 20px;color:#1c2330}` +
  `a.btn,button{display:inline-block;background:#4f7cff;color:#fff;border:0;border-radius:9px;padding:12px 18px;font-size:15px;font-weight:600;text-decoration:none;cursor:pointer}` +
  `pre{background:#0f1526;color:#d7e0f5;padding:16px;border-radius:10px;overflow:auto;font-size:13px}` +
  `.ok{color:#127a3a;font-weight:600}.err{color:#b0223a;font-weight:600}h1{font-size:22px}code{background:#eef1f8;padding:1px 5px;border-radius:5px}</style>` +
  body;

const send = (res, code, html) => { res.writeHead(code, { 'content-type': 'text/html; charset=utf-8' }); res.end(html); };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, SELF);

  if (url.pathname === '/') {
    return send(res, 200, page('Budget Buddy', `<h1>Budget Buddy</h1>
      <p>A demo third-party app. Connect your Accrawl account to let Budget Buddy read your balances.</p>
      <p><a class="btn" href="/connect">Connect with Accrawl</a></p>`));
  }

  if (url.pathname === '/connect') {
    const { verifier, challenge } = pkce();
    const state = base64url(randomBytes(16));
    pending.set(state, { verifier });
    const authorize = new URL(`${ACCRAWL}/oauth/authorize`);
    authorize.search = new URLSearchParams({
      response_type: 'code', client_id: CLIENT_ID, redirect_uri: REDIRECT_URI,
      scope: SCOPE, state, code_challenge: challenge, code_challenge_method: 'S256',
    }).toString();
    res.writeHead(302, { location: authorize.toString() });
    return res.end();
  }

  if (url.pathname === '/callback') {
    const err = url.searchParams.get('error');
    if (err) return send(res, 400, page('Denied', `<h1>Connection not completed</h1><p class="err">Accrawl returned: <code>${err}</code></p><p><a href="/">Back</a></p>`));
    const state = url.searchParams.get('state') || '';
    const code = url.searchParams.get('code') || '';
    const entry = pending.get(state);
    if (!entry) return send(res, 400, page('Error', `<h1 class="err">Invalid state</h1><p>Possible CSRF or an expired attempt. <a href="/">Start over</a>.</p>`));
    pending.delete(state);

    try {
      // 1) Exchange the single-use code for an access token (server-to-server; proves possession via PKCE).
      const tokenRes = await fetch(`${ACCRAWL}/oauth/token`, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI,
          client_id: CLIENT_ID, client_secret: CLIENT_SECRET, code_verifier: entry.verifier,
        }).toString(),
      });
      const token = await tokenRes.json();
      if (!tokenRes.ok) return send(res, 502, page('Token error', `<h1 class="err">Token exchange failed</h1><pre>${JSON.stringify(token, null, 2)}</pre>`));

      const bearer = { authorization: `Bearer ${token.access_token}` };

      // 2) Read the directory first — it names each institution, so an app never has to show a slug,
      //    and it carries the freshness the app should display (lastSyncedAt).
      const dirRes = await fetch(`${ACCRAWL}/api/v1/connections`, { headers: bearer });
      const dir = await dirRes.json();
      const shared = (dir.items || []).map((c) =>
        `${c.institutionName} (${c.institutionType})${c.nickname ? ` · ${c.nickname}` : ''} — last synced ${c.lastSyncedAt ?? 'never'}`,
      ).join('\n');

      // 3) Read the account data itself.
      const dataRes = await fetch(`${ACCRAWL}/api/v1/connections/${CONNECTION_ID}/accounts`, { headers: bearer });
      const data = await dataRes.json();

      // 4) Demonstrate the boundary: the API reads, and only reads. There is no refresh endpoint, and the
      //    crawl/session/OTP surface belongs to the account owner's own console — a token cannot reach it.
      const refused = [];
      for (const [method, p] of [
        ['POST', `/api/v1/connections/${CONNECTION_ID}/refresh`],
        ['POST', `/api/connections/${CONNECTION_ID}/crawl`],
        ['GET', '/api/sessions/any'],
      ]) {
        const r = await fetch(`${ACCRAWL}${p}`, { method, headers: bearer });
        refused.push(`${method} ${p} → HTTP ${r.status}`);
      }

      const masked = String(token.access_token).slice(0, 10) + '…';
      // The access token is short-lived by design, so say so in units a reader can act on. Dividing by a
      // day printed "expires in 0 days" the moment it stopped being the grant's ~90-day clock.
      const lifetime = (seconds) => (seconds >= 3600
        ? `${Math.round(seconds / 3600)}h`
        : `${Math.max(1, Math.round(seconds / 60))}m`);
      return send(res, 200, page('Connected', `<h1 class="ok">Connected to Accrawl ✓</h1>
        <p>Access token (${token.scope}, expires in ${lifetime(token.expires_in)} — refresh with the
        refresh_token before then): <code>${masked}</code></p>
        <p>Connections shared with this app, via <code>GET /api/v1/connections</code> (HTTP ${dirRes.status}):</p>
        <pre>${shared}</pre>
        <p>Accounts read via <code>GET /api/v1/connections/${CONNECTION_ID}/accounts</code> (HTTP ${dataRes.status}):</p>
        <pre>${JSON.stringify(data, null, 2)}</pre>
        <p>The API reads, and only reads — retrieval stays with the account owner:</p>
        <pre>${refused.join('\n')}</pre>
        <p><a href="/">Home</a></p>`));
    } catch (e) {
      return send(res, 500, page('Error', `<h1 class="err">Flow failed</h1><pre>${String(e && e.stack || e)}</pre>`));
    }
  }

  send(res, 404, page('Not found', '<h1>404</h1>'));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[oauth-consumer] Budget Buddy listening on ${SELF}  (accrawl=${ACCRAWL}, client=${CLIENT_ID || '<unset>'})`);
});
