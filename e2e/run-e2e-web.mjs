/**
 * Accrawl WEB-UI end-to-end validation — drive the real React operator console through a real browser.
 *
 * run-e2e.mjs proves the crawl via the HTTP API. This proves the same thing through the actual web UI a
 * self-hoster uses: it stands up the same real stack (embedded Postgres + engine + control-plane + fake
 * bank), serves the built SPA behind a Caddy-like front door (static files + /api & /health reverse proxy
 * with SSE pass-through), then launches Playwright/Chromium and clicks through the entire operator flow:
 *
 *   first-run setup (create operator password) -> author an institution INCLUDING its playbook + 2FA
 *   -> add a connection (creds) -> confirm the login domain (anti-phishing type-to-confirm modal)
 *   -> Crawl now -> land on the live session monitor -> TYPE the 2FA code into the OTP card -> watch
 *   the run reach completion -> assert the canonical accounts/transactions match the bank's truth exactly.
 *
 * A PNG screenshot is captured at every step (proof the UI actually rendered each state). The 2FA code is
 * taken from the fake bank's out-of-band /_relay/last-sms (what a real relay would capture) and entered by
 * hand through the UI — validating the plan's first-tier OTP path (manual web-console entry, no companion).
 *
 * Run via: GEMINI_API_KEY=… node e2e/run-e2e-web.mjs   (Node >= 22; build the workspace first).
 */
import EmbeddedPostgres from 'embedded-postgres';
import postgres from 'postgres';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { TRUTH, CREDS } from './truth.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = '/tmp/accrawl-e2e-web';
const SHOTS = path.join(TMP, 'shots');
// Fresh port block (4201-4208) so this never clashes with a running docker stack or a stale run-e2e.
const P = { pg: 54399, engine: 4201, cp: 4202, bank: 4203, web: 4208 };
const BANK_HOST = 'northwind-bank.com';
const SMS_FROM = '18005550123';
const SECRETS = {
  ENGINE_SHARED_SECRET: 'e2e-engine-shared-secret-0001',
  CREDENTIAL_ENC_KEY: '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff',
  ACCRAWL_ADMIN_PASSWORD: 'e2e-operator-password',
  SESSION_SECRET: 'e2e-session-signing-secret-please-change',
};
const DBURL = `postgres://accrawl:accrawl@127.0.0.1:${P.pg}/accrawl`;
const CP = `http://127.0.0.1:${P.cp}`;
const BANK = `http://127.0.0.1:${P.bank}`;
const WEB = `http://127.0.0.1:${P.web}`;
const DIST = path.join(ROOT, 'apps/web/dist');

// USE_CADDY=1 serves the SPA + proxies /api through a REAL production-mirroring Caddy container (the shipped
// front-door), instead of the in-process node front door — validating that the actual Caddyfile serves the
// operator console AND streams the SSE live-monitor (flush_interval -1) end to end.
const USE_CADDY = !!process.env.USE_CADDY;
// Resolved from PATH: an absolute package-manager prefix is one machine's layout, not a
// requirement. DOCKER_BIN still overrides for an install that is not on PATH.
const DOCKER = process.env.DOCKER_BIN || 'docker';
const CADDY_IMAGE = process.env.ACCRAWL_CADDY_IMAGE || 'accrawl-web:local';
const CADDY_CONTAINER = 'accrawl-e2e-web-caddy';

const children = [];
let pg, sql, frontDoor, browser;
const log = (...a) => console.log('[web-e2e]', ...a);

function spawnSvc(name, cmd, args, env) {
  const out = fs.createWriteStream(path.join(TMP, `${name}.log`));
  const c = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, ...env } });
  c.stdout.pipe(out); c.stderr.pipe(out);
  c.on('exit', (code) => log(`${name} exited (${code})`));
  children.push({ name, c });
  return c;
}

async function waitForHealth(name, url, ms = 30000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try { const r = await fetch(url); if (r.ok) { log(`${name} healthy`); return; } } catch { /* not up yet */ }
    await sleep(500);
  }
  throw new Error(`${name} did not become healthy at ${url} (see ${TMP}/${name}.log)`);
}

const CTYPE = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.png': 'image/png', '.woff2': 'font/woff2', '.woff': 'font/woff', '.map': 'application/json',
};

/**
 * The Caddy stand-in: /api & /health reverse-proxy to the control-plane (streamed, so SSE flows live);
 * everything else serves the built SPA, falling back to index.html for client-side routes. Kept intentionally
 * tiny — this only has to be faithful to infra/Caddyfile's two behaviours (proxy + SPA fallback).
 */
function startFrontDoor() {
  const server = http.createServer((req, res) => {
    const url = req.url || '/';
    if (url.startsWith('/api/') || url === '/health') {
      const proxyReq = http.request(
        { host: '127.0.0.1', port: P.cp, method: req.method, path: url, headers: { ...req.headers, host: `127.0.0.1:${P.cp}` } },
        (proxyRes) => { res.writeHead(proxyRes.statusCode || 502, proxyRes.headers); proxyRes.pipe(res); },
      );
      proxyReq.on('error', () => { res.writeHead(502); res.end('proxy error'); });
      req.pipe(proxyReq);
      return;
    }
    // Static SPA. Resolve within DIST; unknown non-asset paths fall back to index.html (client routing).
    const clean = decodeURIComponent(url.split('?')[0]);
    let file = path.join(DIST, clean);
    if (!file.startsWith(DIST) || clean === '/' || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      file = path.join(DIST, 'index.html');
    }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'content-type': CTYPE[path.extname(file)] || 'application/octet-stream' });
      res.end(buf);
    });
  });
  return new Promise((resolve) => server.listen(P.web, '127.0.0.1', () => resolve(server)));
}

function dockerRmCaddy() {
  try { execFileSync(DOCKER, ['rm', '-f', CADDY_CONTAINER], { stdio: 'ignore' }); } catch { /* not running */ }
}

/**
 * Serve the SPA + proxy /api through a REAL Caddy container whose Caddyfile MIRRORS production infra/Caddyfile
 * (SPA file_server with index.html fallback; /api reverse_proxy with `flush_interval -1` so SSE streams live;
 * upstream is the host control-plane via host.docker.internal instead of the docker service name). This
 * validates the shipped front-door — the exact serving + SSE-flush behavior a self-hoster's `docker compose`
 * gets — not just a hand-rolled node mirror.
 */
function startCaddyFrontDoor() {
  dockerRmCaddy();
  // Docker Desktop on macOS only bind-mounts from shared paths ($HOME et al.), NOT arbitrary /tmp — so the
  // Caddyfile config dir MUST live under $HOME to be visible in the container (the SPA dist under the repo is
  // already fine). Each directive block is multi-line: Caddy rejects an inline `handle /x { directive }`.
  const cfgDir = path.join(os.homedir(), '.accrawl-e2e-web-caddy', 'cfg');
  fs.mkdirSync(cfgDir, { recursive: true });
  const caddyfile = `{
	admin off
}
:${P.web} {
	encode gzip
	handle /api/* {
		reverse_proxy host.docker.internal:${P.cp} {
			flush_interval -1
			header_up X-Forwarded-For {remote_host}
		}
	}
	handle /health {
		reverse_proxy host.docker.internal:${P.cp}
	}
	handle {
		root * /srv
		try_files {path} /index.html
		file_server
	}
}
`;
  fs.writeFileSync(path.join(cfgDir, 'Caddyfile'), caddyfile);
  const args = [
    'run', '--rm', '-d', '--name', CADDY_CONTAINER,
    '--add-host', 'host.docker.internal:host-gateway',
    '-p', `${P.web}:${P.web}`,
    '-v', `${cfgDir}:/etc/caddy:ro`,
    '-v', `${DIST}:/srv:ro`, // the built SPA
    CADDY_IMAGE,
  ];
  log('docker run', args.join(' '));
  const r = spawnSync(DOCKER, args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`docker run caddy failed: ${r.stderr || r.stdout}`);
  log('real Caddy front-door started:', (r.stdout || '').trim().slice(0, 12));
}

function approx(a, b) { return Math.abs(a - b) < 0.005; }

let shotN = 0;
async function shot(page, name) {
  const f = path.join(SHOTS, `${String(++shotN).padStart(2, '0')}-${name}.png`);
  await page.screenshot({ path: f, fullPage: true });
  log('screenshot', path.basename(f));
}

async function cleanup() {
  try { await browser?.close(); } catch { /* */ }
  try { frontDoor?.close(); } catch { /* */ }
  if (USE_CADDY) dockerRmCaddy();
  for (const { c } of children) { try { c.kill('SIGTERM'); } catch { /* */ } }
  try { await sql?.end({ timeout: 3 }); } catch { /* */ }
  try { await pg?.stop(); } catch { /* */ }
}

async function main() {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(SHOTS, { recursive: true });

  if (!fs.existsSync(path.join(DIST, 'index.html'))) {
    throw new Error(`web build missing at ${DIST}/index.html — run \`pnpm --filter @accrawl/web build\` first.`);
  }
  if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is required (the engine crawl needs it).');

  // 1. Real Postgres + migrations
  log('starting embedded postgres…');
  pg = new EmbeddedPostgres({ databaseDir: path.join(TMP, 'pgdata'), user: 'accrawl', password: 'accrawl', port: P.pg, persistent: false });
  await pg.initialise(); await pg.start(); await pg.createDatabase('accrawl');
  sql = postgres(DBURL, { max: 4 });
  const migDir = path.join(ROOT, 'apps/control-plane/migrations');
  for (const f of fs.readdirSync(migDir).filter((x) => x.endsWith('.sql')).sort()) {
    for (const stmt of fs.readFileSync(path.join(migDir, f), 'utf8').split('--> statement-breakpoint')) {
      const s = stmt.trim(); if (s) await sql.unsafe(s);
    }
  }
  log('migrations applied');

  // 2. Services (engine resolves the bank host via Chromium's host-resolver-rules, like run-e2e)
  spawnSvc('fake-bank', 'node', ['e2e/fake-bank.mjs'], { FAKEBANK_PORT: String(P.bank), FAKEBANK_SILENT: '1' });
  spawnSvc('engine', 'node', ['apps/engine/dist/index.js'], {
    SERVICE_MODE: 'development', PORT: String(P.engine), PLATFORM: 'postgres',
    ENGINE_DATABASE_URL: DBURL, GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    ENGINE_SHARED_SECRET: SECRETS.ENGINE_SHARED_SECRET, RUNS_DIR: path.join(TMP, 'runs'),
    HEADLESS: 'true', EXTRA_CHROMIUM_ARGS: `--host-resolver-rules=MAP ${BANK_HOST} 127.0.0.1`,
  });
  spawnSvc('control-plane', 'node', ['apps/control-plane/dist/server-main.js'], {
    PORT: String(P.cp), DATABASE_URL: DBURL, ENGINE_URL: `http://127.0.0.1:${P.engine}`,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY, ...SECRETS,
  });
  await waitForHealth('fake-bank', `${BANK}/_health`);
  await waitForHealth('engine', `http://127.0.0.1:${P.engine}/`);
  await waitForHealth('control-plane', `${CP}/health`);

  // 3. Front door (real production Caddy if USE_CADDY, else in-process node mirror) + browser
  if (USE_CADDY) {
    startCaddyFrontDoor();
    await waitForHealth('caddy front-door', `${WEB}/health`);
  } else {
    frontDoor = await startFrontDoor();
  }
  log(`front door (${USE_CADDY ? 'REAL Caddy' : 'node mirror'}) serving SPA + proxy at`, WEB);
  const require = createRequire(path.join(ROOT, 'apps/engine/package.json'));
  const { chromium } = require('playwright');
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  // The console uses in-app modals (type-to-confirm) instead of browser dialogs — nothing to accept here.
  page.on('pageerror', (e) => log('PAGE ERROR:', e.message));
  page.on('console', (m) => { if (m.type() === 'error') log('console.error:', m.text()); });

  const errors = [];

  // 4. First-run setup
  await page.goto(`${WEB}/setup`, { waitUntil: 'networkidle' });
  const pws = page.locator('input[type="password"]');
  await pws.nth(0).fill(SECRETS.ACCRAWL_ADMIN_PASSWORD);
  await pws.nth(1).fill(SECRETS.ACCRAWL_ADMIN_PASSWORD);
  await shot(page, 'setup');
  await page.getByRole('button', { name: /create/i }).click();
  await page.waitForURL('**/connections', { timeout: 15000 });
  log('operator created + signed in via the UI');
  await shot(page, 'connections-empty');

  // 5. Author the institution THROUGH THE UI — including the playbook + 2FA. There is no id field:
  // the console derives the internal id from the name (slugify → 'northwind-bank').
  await page.goto(`${WEB}/institutions`, { waitUntil: 'networkidle' });
  await page.getByPlaceholder('e.g. First National Bank').fill('Northwind Bank');
  await page.getByPlaceholder('https://login.yourbank.com/').fill(`http://${BANK_HOST}:${P.bank}/login`);
  await page.getByRole('checkbox').check(); // asks for a 2FA code at sign-in
  await page.getByPlaceholder('e.g. FNBANK').fill(SMS_FROM);
  await page.locator('textarea').fill(
    'Sign in with the provided username and password. You will then be asked for a 6-digit two-factor code ' +
    'sent by SMS — request the OTP and enter it. After login, open the accounts dashboard and extract every ' +
    'account (name, masked number, balance, currency) and every recent transaction (date, description, amount).',
  );
  await shot(page, 'institution-form');
  await page.getByRole('button', { name: /add institution/i }).click();
  await page.getByRole('cell', { name: /Northwind Bank/ }).waitFor({ timeout: 10000 });
  log('institution authored via the UI (with playbook + 2FA)');
  await shot(page, 'institution-created');

  // 6. Add the connection THROUGH THE UI. User-owned institution ids are server-generated,
  // so select the rendered institution name instead of assuming an implementation-specific id.
  await page.goto(`${WEB}/connections`, { waitUntil: 'networkidle' });
  await page.locator('select').first().selectOption({ label: 'Northwind Bank' });
  await page.getByLabel(/Username/).fill(CREDS.username);
  await page.getByLabel(/Password/).fill(CREDS.password);
  await page.getByRole('button', { name: /add connection/i }).click();
  await page.getByRole('cell', { name: /Northwind Bank/ }).waitFor({ timeout: 10000 });
  log('connection created via the UI');
  await shot(page, 'connection-created');

  // 7. Confirm the login domain (anti-phishing): the type-to-confirm modal wants the domain typed back.
  await page.getByRole('button', { name: /confirm domain/i }).click();
  await page.getByRole('dialog').getByRole('textbox').fill(BANK_HOST);
  await page.getByRole('dialog').getByRole('button', { name: /confirm domain/i }).click();
  await page.getByText(/domain confirmed/i).waitFor({ timeout: 10000 });
  log('login domain verified via the UI');
  await shot(page, 'domain-verified');

  // 8. Crawl now → live monitor
  await page.getByRole('button', { name: 'Crawl now' }).click();
  await page.waitForURL('**/sessions/**', { timeout: 20000 });
  const sessionId = page.url().split('/sessions/')[1];
  log('crawl dispatched; monitoring session', sessionId);
  await shot(page, 'session-monitor');

  // 9. Relay the 2FA code THROUGH THE UI: wait until the engine asks for it, take the code the bank "sent",
  //    type it into the manual-OTP field, submit. This exercises the plan's first-tier OTP path.
  const otpDeadline = Date.now() + 180000;
  let otpTyped = false;
  while (Date.now() < otpDeadline) {
    const [s] = await sql`select status, otp from sessions where id = ${sessionId}`;
    if (s?.status && ['completed', 'failed', 'cancelled'].includes(s.status)) break;
    // Submit ONLY while status === 'waiting_for_otp' with no code yet — that is the exact state the manual
    // OTP route accepts (session-io: anything else is a 409 not_active). otp_requested flips true a beat
    // earlier, so gating on it would race the state machine.
    if (!otpTyped && s?.status === 'waiting_for_otp' && !s?.otp) {
      // The bank records the SMS on POST /login; a not-yet-ready /_relay/last-sms returns {} — keep polling.
      const sms = await (await fetch(`${BANK}/_relay/last-sms`)).json().catch(() => ({}));
      const code = sms?.body ? (sms.body.match(/\b(\d{4,8})\b/) || [])[1] : null;
      if (code) {
        log(`bank sent a verification SMS from ${sms.from}; typing its code into the UI OTP field`);
        await page.getByPlaceholder('Enter code').fill(code);
        await page.getByRole('button', { name: /submit code/i }).click();
        // Confirm acceptance. If a rare stale-state 409 slips through, don't crash — leave otpTyped false and
        // retry on the next poll while the session is still waiting.
        try {
          await page.getByText(/Code sent/).waitFor({ timeout: 8000 });
          otpTyped = true;
          await shot(page, 'otp-submitted');
        } catch { log('OTP submit not yet confirmed (state race) — will retry'); }
      }
    }
    await sleep(1000);
  }
  if (!otpTyped) errors.push('never typed an OTP (engine never requested it / relay missed it)');

  // 10. Wait for the monitor to show the completed outcome, then screenshot the finished state.
  // 'completed' is only written AFTER the extraction is promoted, so this also proves data-readiness.
  try {
    await page.getByText(/Crawl completed\./).waitFor({ timeout: 60000 });
  } catch { /* fall through to the DB assertions, which are the real oracle */ }
  await shot(page, 'session-finished');

  // 11. Assert — the DB is the oracle for the numbers; the UI must also reflect the completed session.
  const [sess] = await sql`select status, otp_received_at from sessions where id = ${sessionId}`;
  log('final session:', JSON.stringify(sess));
  if (sess?.status !== 'completed') errors.push(`session status is '${sess?.status}', expected 'completed'`);
  if (!sess?.otp_received_at) errors.push('otp_received_at not set — the typed OTP was not consumed by the engine');

  const [conn] = await sql`select id from connections order by created_at desc limit 1`;
  const accts = (await sql`select data from accounts where connection_id = ${conn.id}`).map((r) => r.data);
  const txns = (await sql`select data from transactions where connection_id = ${conn.id}`).map((r) => r.data);
  log(`extracted ${accts.length} accounts, ${txns.length} transactions`);
  log('ACCOUNTS:', JSON.stringify(accts, null, 2));
  log('TRANSACTIONS:', JSON.stringify(txns, null, 2));

  const acctStr = JSON.stringify(accts);
  for (const a of TRUTH.accounts) {
    const balOk = accts.some((x) => JSON.stringify(x).includes(String(a.balance)) || Object.values(x).some((v) => typeof v === 'number' && approx(v, a.balance)));
    if (!balOk) errors.push(`account balance ${a.balance} (${a.name}) not found`);
    if (!acctStr.includes(a.name)) errors.push(`account name "${a.name}" not found`);
  }
  // The card is a dashboard tile, never an accounts-table row — it must still be its own account
  // (type credit, balance = amount owed, positive) with its /cards activity extracted.
  const cardAcct = accts.find((x) => JSON.stringify(x).includes(TRUTH.card.name));
  if (!cardAcct) errors.push(`credit card "${TRUTH.card.name}" was not recorded as an account`);
  else if (!approx(cardAcct.balance, TRUTH.card.owed)) errors.push(`card balance is ${cardAcct.balance}, expected +${TRUTH.card.owed}`);
  const expectedAccounts = TRUTH.accounts.length + 1;
  if (accts.length !== expectedAccounts) errors.push(`expected ${expectedAccounts} accounts, stored ${accts.length}`);

  const txnStr = JSON.stringify(txns);
  for (const t of [...TRUTH.transactions, ...TRUTH.card.transactions]) {
    // Signed, not absolute — see run-e2e.mjs. A sign flip is a financial error,
    // not a formatting one, and the absolute comparison accepted it.
    const amtOk = txns.some((x) => Object.values(x).some((v) => typeof v === 'number' && approx(v, t.amount))) || txnStr.includes(String(t.amount));
    if (!amtOk) errors.push(`transaction amount ${t.amount} (${t.description}) not found`);
    if (!txnStr.includes(t.description)) errors.push(`transaction "${t.description}" not found`);
  }
  const expectedTransactions = TRUTH.transactions.length + TRUTH.card.transactions.length;
  if (txns.length !== expectedTransactions) errors.push(`expected ${expectedTransactions} transactions, stored ${txns.length}`);

  // The connections table should now show the completed crawl (UI reflects the backend result).
  await page.goto(`${WEB}/connections`, { waitUntil: 'networkidle' });
  await shot(page, 'connections-after');
  const bodyText = await page.locator('body').innerText();
  if (!/completed/i.test(bodyText)) errors.push('connections page does not show the completed crawl');

  if (errors.length) {
    log('❌ FAILURES:'); for (const e of errors) log('  -', e);
    throw new Error(`${errors.length} assertion(s) failed`);
  }
  log('✅ WEB-UI E2E PASSED — authored + crawled + extracted exactly, all through the browser.');
  log('screenshots in', SHOTS);
}

main().then(() => cleanup()).then(() => process.exit(0)).catch(async (e) => {
  log('FATAL', e?.stack || e);
  try { const p = (await browser?.pages?.())?.[0]; if (p) await p.screenshot({ path: path.join(SHOTS, '99-failure.png'), fullPage: true }); } catch { /* */ }
  await cleanup(); process.exit(1);
});
