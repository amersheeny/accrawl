/**
 * Fake bank website for end-to-end validation.
 *
 * A self-contained site the crawl engine logs into for real (Playwright + the LLM agent):
 *   GET  /            -> redirect to /login (or /dashboard if already authed)
 *   GET  /login       -> username + password form
 *   POST /login       -> validates creds, generates a 6-digit OTP, "sends" it out-of-band
 *                        (exposed at /_relay/last-sms for the simulated SMS relay), -> /otp
 *   GET  /otp         -> 2FA code entry form ("we sent a code to your phone")
 *   POST /otp         -> validates the code, -> /dashboard
 *   GET  /dashboard   -> the account balances + recent transactions (deterministic known data)
 *   GET  /_relay/last-sms -> JSON of the last "SMS" (what the relay captures)
 *   GET  /_health     -> ok
 *
 * The data below is the ground truth the e2e asserts the crawl extracted EXACTLY. The OTP is random
 * per login, so a passing run proves the engine read the actually-sent code and typed it in — not a
 * fixed value. Zero dependencies (node:http) so it can't drift from the product under test.
 */
import http from 'node:http';
import { randomInt, randomUUID } from 'node:crypto';
import { TRUTH, CREDS, PHONE_LAST4 } from './truth.mjs';

const PORT = parseInt(process.env.FAKEBANK_PORT || '4103', 10);
const USERNAME = process.env.FAKEBANK_USER || CREDS.username;
const PASSWORD = process.env.FAKEBANK_PASS || CREDS.password;

const sessions = new Map(); // sid -> { stage: 'awaiting_otp'|'authed', otp }
let lastSms = null;

function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · Northwind Bank</title></head>
<body style="font-family:system-ui,sans-serif;max-width:640px;margin:40px auto;padding:0 16px">
<header><h1 style="color:#1a3e72">Northwind Bank</h1></header>
<main>${body}</main></body></html>`;
}

function send(res, status, html, headers = {}) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headers });
  res.end(html);
}
function redirect(res, location, setCookie) {
  const headers = { location };
  if (setCookie) headers['set-cookie'] = setCookie;
  res.writeHead(302, headers);
  res.end();
}
function cookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((c) => {
    const i = c.indexOf('=');
    if (i > 0) out[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim());
  });
  return out;
}
function body(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      const params = {};
      new URLSearchParams(data).forEach((v, k) => { params[k] = v; });
      resolve(params);
    });
  });
}
function session(req) {
  const sid = cookies(req).sid;
  return sid ? sessions.get(sid) : undefined;
}

const LOGIN_FORM = page('Sign in', `
  <h2>Sign in to online banking</h2>
  <form method="post" action="/login">
    <p><label for="username">Username</label><br>
      <input id="username" name="username" type="text" autocomplete="username" style="width:100%;padding:8px"></p>
    <p><label for="password">Password</label><br>
      <input id="password" name="password" type="password" autocomplete="current-password" style="width:100%;padding:8px"></p>
    <p><button type="submit" style="padding:10px 20px">Sign in</button></p>
  </form>`);

function otpForm(error = '') {
  return page('Two-factor', `
  <h2>Two-factor authentication</h2>
  <p>For your security, we sent a 6-digit verification code by SMS to your phone ending in <strong>${PHONE_LAST4}</strong>.</p>
  ${error ? `<p style="color:#b00" role="alert">${error}</p>` : ''}
  <form method="post" action="/otp">
    <p><label for="otp-code">Verification code</label><br>
      <input id="otp-code" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" style="width:100%;padding:12px;font-size:40px;letter-spacing:12px;font-family:monospace"></p>
    <p><button type="submit" style="padding:10px 20px">Verify</button></p>
  </form>`);
}

function dashboard() {
  const acctRows = TRUTH.accounts.map((a) =>
    `<tr><td>${a.name}</td><td>${a.number}</td><td style="text-align:right">$${a.balance.toLocaleString('en-US', { minimumFractionDigits: 2 })}</td><td>${a.currency}</td></tr>`).join('');
  const txnRows = TRUTH.transactions.map((t) =>
    `<tr><td>${t.date}</td><td>${t.description}</td><td style="text-align:right">${t.amount < 0 ? '-' : ''}$${Math.abs(t.amount).toLocaleString('en-US', { minimumFractionDigits: 2 })}</td></tr>`).join('');
  // The card is deliberately NOT a row in the accounts table: it appears only as a charge tile
  // inside the checking-account context, the shape real bank dashboards use. A correct crawl must
  // still record it as its own account and follow the link for its transactions.
  return page('Accounts', `
  <h2>Your accounts</h2>
  <table border="1" cellpadding="8" cellspacing="0" style="width:100%;border-collapse:collapse">
    <thead><tr><th>Account</th><th>Number</th><th>Balance</th><th>Currency</th></tr></thead>
    <tbody>${acctRows}</tbody>
  </table>
  <div style="margin-top:16px;border:1px solid #ccc;padding:12px;background:#fafafa">
    <b>Cards</b> — ${TRUTH.card.name} ${TRUTH.card.number}: balance due
    $${TRUTH.card.owed.toLocaleString('en-US', { minimumFractionDigits: 2 })}
    &nbsp;<a href="/cards">View card activity</a>
  </div>
  <h2 style="margin-top:32px">Recent transactions</h2>
  <table border="1" cellpadding="8" cellspacing="0" style="width:100%;border-collapse:collapse">
    <thead><tr><th>Date</th><th>Description</th><th>Amount</th></tr></thead>
    <tbody>${txnRows}</tbody>
  </table>
  <p style="margin-top:24px"><a href="/logout">Sign out</a></p>`);
}

function cardsPage() {
  const rows = TRUTH.card.transactions.map((t) =>
    `<tr><td>${t.date}</td><td>${t.description}</td><td style="text-align:right">${t.amount < 0 ? '-' : ''}$${Math.abs(t.amount).toLocaleString('en-US', { minimumFractionDigits: 2 })}</td></tr>`).join('');
  // Like many real card pages, no per-row reference number is shown.
  return page('Cards', `
  <h2>${TRUTH.card.name} ${TRUTH.card.number}</h2>
  <p>Current balance due: <b>$${TRUTH.card.owed.toLocaleString('en-US', { minimumFractionDigits: 2 })}</b> (${TRUTH.card.currency})</p>
  <h3 style="margin-top:24px">Card activity</h3>
  <table border="1" cellpadding="8" cellspacing="0" style="width:100%;border-collapse:collapse">
    <thead><tr><th>Date</th><th>Description</th><th>Amount</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <p style="margin-top:24px"><a href="/dashboard">Back to accounts</a> · <a href="/logout">Sign out</a></p>`);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;
  const sess = session(req);

  if (path === '/_health') return send(res, 200, 'ok');
  if (path === '/_relay/last-sms') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(lastSms || {}));
  }

  if (path === '/' ) return redirect(res, sess?.stage === 'authed' ? '/dashboard' : '/login');
  if (path === '/login' && req.method === 'GET') return send(res, 200, LOGIN_FORM);

  if (path === '/login' && req.method === 'POST') {
    const { username, password } = await body(req);
    if (username === USERNAME && password === PASSWORD) {
      const sid = randomUUID();
      const otp = String(randomInt(0, 1_000_000)).padStart(6, '0');
      sessions.set(sid, { stage: 'awaiting_otp', otp });
      lastSms = {
        to: '+1555' + PHONE_LAST4 + '000', from: 'NORTHWIND',
        body: `Northwind Bank: your verification code is ${otp}. It expires in 5 minutes. Do not share it.`,
        code: otp, ts: new Date().toISOString(),
      };
      return redirect(res, '/otp', `sid=${sid}; HttpOnly; Path=/`);
    }
    return send(res, 401, page('Sign in', '<p style="color:#b00">Incorrect username or password.</p>' + LOGIN_FORM));
  }

  if (path === '/otp' && req.method === 'GET') {
    if (!sess) return redirect(res, '/login');
    if (sess.stage === 'authed') return redirect(res, '/dashboard');
    return send(res, 200, otpForm());
  }
  if (path === '/otp' && req.method === 'POST') {
    if (!sess) return redirect(res, '/login');
    const { code } = await body(req);
    if (sess.stage === 'awaiting_otp' && code && code.trim() === sess.otp) {
      sess.stage = 'authed';
      return redirect(res, '/dashboard');
    }
    return send(res, 401, otpForm('That code is incorrect. Please try again.'));
  }

  if (path === '/dashboard') {
    if (sess?.stage !== 'authed') return redirect(res, '/login');
    return send(res, 200, dashboard());
  }
  if (path === '/cards') {
    if (sess?.stage !== 'authed') return redirect(res, '/login');
    return send(res, 200, cardsPage());
  }
  if (path === '/logout') {
    if (sess) sessions.delete(cookies(req).sid);
    return redirect(res, '/login');
  }

  send(res, 404, page('Not found', '<p>Not found.</p>'));
});

if (process.env.FAKEBANK_SILENT !== '1') {
  server.on('listening', () => console.log(`[fake-bank] Northwind Bank on http://localhost:${PORT} (user=${USERNAME})`));
}
server.listen(PORT);

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
