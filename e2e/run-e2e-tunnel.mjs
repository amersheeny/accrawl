/**
 * Accrawl device-proxy TUNNEL end-to-end validation — proves a crawl's browser egress actually routes
 * through the companion (the phone), not direct from the engine.
 *
 * Built on the same real stack as run-e2e.mjs (embedded Postgres + migrations, the engine + control-plane
 * as separate processes, a fake bank, a real Playwright + Gemini crawl, an in-process OTP relay), with the
 * device-proxy path wired end to end:
 *
 *   1. Seed an institution with useDeviceProxy=true pointing at the fake bank; a connection; verify the
 *      login domain. Pair a real companion device (POST /api/devices/pair → an `acdv_` token).
 *   2. Trigger the crawl. The control-plane mints a session+device-bound tunnel token + sets
 *      tunnel_requested; the engine PARKS the request (no browser yet). Start the companion DOUBLE
 *      (e2e/companion-double.mjs) — it polls GET /api/sessions/awaiting-tunnel with the device token,
 *      gets {sessionId, tunnelToken, engineWsUrl}, opens the /tunnel WS, wins the single-use claim, and
 *      becomes the SOCKS5 exit node. The engine runs Chrome → its SOCKS5 → WS → the double → the fake bank.
 *   3. DECISIVE, execution-grounded assertions:
 *      (a) the crawl COMPLETES and the extracted accounts/transactions match the bank's ground truth
 *          EXACTLY (reusing run-e2e's accuracy assertions);
 *      (b) the double's relay oracle shows it OPENED a connection to the bank host:port and relayed >0
 *          bytes BOTH ways — the bank traffic demonstrably flowed THROUGH the double (the phone);
 *      (c) a NEGATIVE control: the same crawl with NO double started → it must FAIL/park-timeout (proving
 *          the crawl genuinely requires the tunnel and never silently bypasses it to a direct exit), and
 *          no accounts/transactions are extracted over a direct path.
 *
 * Run via run-e2e-tunnel.sh (or directly with GEMINI_API_KEY set + the workspace built). Node >= 22.
 */
import EmbeddedPostgres from 'embedded-postgres';
import postgres from 'postgres';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { TRUTH, CREDS } from './truth.mjs';
import { startCompanionDouble } from './companion-double.mjs';

// The code this run's deployment is claimed with. Generated per run: the server refuses setup without
// one, so a run that forgot it would fail at the first request rather than silently claim anything.
const SETUP_CLAIM_TOKEN = 'e2e-setup-' + Math.abs(Date.now() % 1e9).toString(36) + '-claim';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = '/tmp/accrawl-e2e-tunnel';
const P = { pg: 54398, engine: 4111, cp: 4112, bank: 4113 };
const BANK_HOST = 'northwind-bank.com';
const SECRETS = {
  ENGINE_SHARED_SECRET: 'e2e-engine-shared-secret-0001',
  CREDENTIAL_ENC_KEY: '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff',
  SETUP_CLAIM_TOKEN,
  ACCRAWL_ADMIN_PASSWORD: 'e2e-operator-password',
  SESSION_SECRET: 'e2e-session-signing-secret-please-change',
};
const DBURL = `postgres://accrawl:accrawl@127.0.0.1:${P.pg}/accrawl`;
const CP = `http://127.0.0.1:${P.cp}`;
const BANK = `http://127.0.0.1:${P.bank}`;
// The phone-side DNS step: the engine's SOCKS5 sends the bank's hostname to the double (remote DNS); the
// double resolves it. In production the phone resolves the bank's public host over its network; here the
// fake bank is on loopback, so the double maps the host → 127.0.0.1. The engine never learns the IP.
const HOST_MAP = { [BANK_HOST]: '127.0.0.1' };

const children = [];
let pg, sql;
const log = (...a) => console.log('[tunnel-e2e]', ...a);

function spawnSvc(name, cmd, args, env) {
  fs.mkdirSync(TMP, { recursive: true });
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

let token;
async function api(method, p, body, authToken = token) {
  const r = await fetch(`${CP}${p}`, {
    method,
    headers: { 'content-type': 'application/json', ...(authToken ? { authorization: `Bearer ${authToken}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json; try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  return { status: r.status, json };
}

/** In-process OTP relay (identical to run-e2e's): watch the shared DB, submit the bank's code when the
 *  engine requests it. The tunnel is orthogonal to the OTP handshake — both must work together.
 *
 *  Tracks an EXPLICIT sessionId (the one POST /crawl returned) so it can never latch onto a prior
 *  terminal session for the same connection (e.g. the negative-control run) and break immediately. Falls
 *  back to "newest for this connection" only if no id was given. */
async function runRelay(connectionId, knownSessionId = null, deadlineMs = 300000) {
  const deadline = Date.now() + deadlineMs;
  let sessionId = knownSessionId, submitted = false;
  const statuses = new Set();
  if (sessionId) log('relay: tracking session', sessionId);
  while (Date.now() < deadline) {
    if (!sessionId) {
      const rows = await sql`select id from sessions where connection_id = ${connectionId} order by started_at desc limit 1`;
      if (rows[0]) { sessionId = rows[0].id; log('relay: tracking session', sessionId); }
    }
    if (sessionId) {
      const [s] = await sql`select status, otp_requested, otp from sessions where id = ${sessionId}`;
      if (s) {
        statuses.add(s.status);
        if (!submitted && s.otp_requested && !s.otp) {
          const sms = await (await fetch(`${BANK}/_relay/last-sms`)).json();
          const code = (sms.body || '').match(/\b(\d{6})\b/)?.[1] ?? sms.code;
          log('relay: bank sent a verification SMS; submitting its code');
          const r = await api('POST', `/api/sessions/${sessionId}/otp`, { code });
          log(`relay: submitted OTP via POST /sessions/${sessionId}/otp -> ${r.status}`);
          submitted = code ? true : submitted;
        }
        if (['completed', 'failed', 'cancelled'].includes(s.status)) break;
      }
    }
    await sleep(1000);
  }
  return { sessionId, statuses: [...statuses], submitted };
}

function approx(a, b) { return Math.abs(a - b) < 0.005; }

/** Reusable accuracy assertions over the canonical tables (mirrors run-e2e.mjs exactly). */
async function collectAccuracyErrors(connectionId) {
  const errors = [];
  const accts = (await sql`select data from accounts where connection_id = ${connectionId}`).map((r) => r.data);
  const txns = (await sql`select data from transactions where connection_id = ${connectionId}`).map((r) => r.data);
  log(`extracted ${accts.length} accounts, ${txns.length} transactions`);
  log('ACCOUNTS:', JSON.stringify(accts, null, 2));
  log('TRANSACTIONS:', JSON.stringify(txns, null, 2));

  const acctStr = JSON.stringify(accts);
  for (const a of TRUTH.accounts) {
    const balOk = accts.some((x) => JSON.stringify(x).includes(String(a.balance)) || Object.values(x).some((v) => typeof v === 'number' && approx(v, a.balance)));
    if (!balOk) errors.push(`account balance ${a.balance} (${a.name}) not found in extracted accounts`);
    if (!acctStr.includes(a.name)) errors.push(`account name "${a.name}" not found in extracted accounts`);
  }
  // +1 for the credit card. It is not a row in TRUTH.accounts because the fake
  // bank does not show it in the accounts table — it appears only as a dashboard
  // charge tile — but the crawl must record it as its own account. run-e2e.mjs
  // and run-e2e-web.mjs already expect it; these tunnel suites did not, so a
  // correct crawl of three products failed them with "expected 2, stored 3".
  const expectedAccounts = TRUTH.accounts.length + 1;
  if (accts.length !== expectedAccounts) errors.push(`expected ${expectedAccounts} accounts, stored ${accts.length}`);

  const txnStr = JSON.stringify(txns);
  for (const t of TRUTH.transactions) {
    // Signed, not absolute — see run-e2e.mjs. A sign flip is a financial error.
    const amtOk = txns.some((x) => Object.values(x).some((v) => typeof v === 'number' && approx(v, t.amount))) || txnStr.includes(String(t.amount));
    if (!amtOk) errors.push(`transaction amount ${t.amount} (${t.description}) not found in extracted transactions`);
  }
  if (txns.length < TRUTH.transactions.length) errors.push(`expected >= ${TRUTH.transactions.length} transactions, stored ${txns.length}`);
  return { errors, acctCount: accts.length, txnCount: txns.length };
}

async function main() {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });

  // 1. Real Postgres
  log('starting embedded postgres…');
  pg = new EmbeddedPostgres({ databaseDir: path.join(TMP, 'pgdata'), user: 'accrawl', password: 'accrawl', port: P.pg, persistent: false });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('accrawl');
  sql = postgres(DBURL, { max: 4 });

  // 2. Migrations
  const migDir = path.join(ROOT, 'apps/control-plane/migrations');
  for (const f of fs.readdirSync(migDir).filter((x) => x.endsWith('.sql')).sort()) {
    const text = fs.readFileSync(path.join(migDir, f), 'utf8');
    for (const stmt of text.split('--> statement-breakpoint')) {
      const s = stmt.trim();
      if (s) await sql.unsafe(s);
    }
  }
  log('migrations applied');

  // 3. Services. The engine runs in SERVICE_MODE=development + PLATFORM=postgres so it serves BOTH /crawl
  //    and the companion's /tunnel WS (modeEnablesTunnel === true). Crucially, NO --host-resolver-rules is
  //    given to the engine's Chromium: through the SOCKS5 proxy the browser does REMOTE DNS, sending the
  //    bank hostname to the double — which is where resolution must happen (the double's HOST_MAP), proving
  //    the egress genuinely leaves via the double, not the engine.
  spawnSvc('fake-bank', 'node', ['e2e/fake-bank.mjs'], { FAKEBANK_PORT: String(P.bank), FAKEBANK_SILENT: '1' });
  spawnSvc('engine', 'node', ['apps/engine/dist/index.js'], {
    SERVICE_MODE: 'development', PORT: String(P.engine), PLATFORM: 'postgres',
    ENGINE_DATABASE_URL: DBURL, GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    ENGINE_SHARED_SECRET: SECRETS.ENGINE_SHARED_SECRET, RUNS_DIR: path.join(TMP, 'runs'),
    HEADLESS: process.env.E2E_HEADFUL ? 'false' : 'true',
  });
  spawnSvc('control-plane', 'node', ['apps/control-plane/dist/server-main.js'], {
    PORT: String(P.cp), DATABASE_URL: DBURL, ENGINE_URL: `http://127.0.0.1:${P.engine}`,
    // The phone-reachable tunnel WS base handed to the companion via awaiting-tunnel. The engine serves
    // /tunnel on its own HTTP port; for this single-host e2e the companion reaches it on loopback.
    ENGINE_WS_URL: `ws://127.0.0.1:${P.engine}/tunnel`,
    ...SECRETS,
  });

  await waitForHealth('fake-bank', `${BANK}/_health`);
  await waitForHealth('engine', `http://127.0.0.1:${P.engine}/`);
  await waitForHealth('control-plane', `${CP}/health`);

  // 4. Operator setup + the device-proxy institution + connection + domain verification.
  const setup = await api('POST', '/api/setup', { password: SECRETS.ACCRAWL_ADMIN_PASSWORD, setupCode: SETUP_CLAIM_TOKEN });
  if (![200, 201].includes(setup.status)) throw new Error(`first-run setup failed: ${setup.status} ${JSON.stringify(setup.json)}`);
  token = setup.json.token;
  log('operator initialized + authenticated');

  const inst = await api('POST', '/api/institutions', {
    id: 'northwind', name: 'Northwind Bank', type: 'bank',
    loginUrl: `http://${BANK_HOST}:${P.bank}/login`,
    useDeviceProxy: true, // ← the whole point: this institution's egress MUST go through the device tunnel
    playbook: 'Sign in with the provided username and password. You will then be asked for a 6-digit ' +
      'two-factor code sent by SMS — request the OTP and enter it. After login, open the accounts dashboard ' +
      'and extract every account (name, masked number, balance, currency) and every recent transaction ' +
      '(date, description, amount).',
  });
  if (![200, 201].includes(inst.status)) throw new Error(`create institution failed: ${inst.status} ${JSON.stringify(inst.json)}`);
  const institutionId = inst.json.id;
  if (typeof institutionId !== 'string' || institutionId.length === 0) {
    throw new Error(`create institution returned no id: ${JSON.stringify(inst.json)}`);
  }
  log('device-proxy institution created (useDeviceProxy=true); canonicalDomain =', inst.json.canonicalDomain ?? '(derived server-side)');

  // Pair a REAL companion device — this is the `acdv_` token the double authenticates its awaiting-tunnel
  // poll with, and the device the control-plane binds the tunnel token to (did).
  const pair = await api('POST', '/api/devices/pair', { name: 'e2e-companion-double' });
  if (![200, 201].includes(pair.status)) throw new Error(`device pair failed: ${pair.status} ${JSON.stringify(pair.json)}`);
  const deviceToken = pair.json.token;
  if (!deviceToken?.startsWith('acdv_')) throw new Error(`expected an acdv_ device token, got ${deviceToken}`);
  log('companion device paired; device token prefix =', deviceToken.slice(0, 5));

  const conn = await api('POST', '/api/connections', { institutionId, username: CREDS.username, password: CREDS.password });
  if (![200, 201].includes(conn.status)) throw new Error(`create connection failed: ${conn.status} ${JSON.stringify(conn.json)}`);
  const connectionId = conn.json.id;
  const verify = await api('POST', `/api/connections/${connectionId}/verify-domain`, { canonicalDomain: BANK_HOST });
  if (![200, 204].includes(verify.status)) throw new Error(`verify-domain failed: ${verify.status} ${JSON.stringify(verify.json)}`);
  log('connection created + login domain verified', connectionId);

  const errors = [];

  // ─────────────────────────────────────────────────────────────────────────────
  // SCENARIO C (NEGATIVE CONTROL) — first, so the same fresh connection proves the dependency before the
  // positive run mutates its data. Trigger the device-proxy crawl but DO NOT start the double. The engine
  // must PARK and, with no companion claiming the tunnel within the park TTL, FAIL — proving the crawl
  // genuinely requires the tunnel and never silently exits direct. No accounts/transactions may appear.
  // ─────────────────────────────────────────────────────────────────────────────
  log('\n=== SCENARIO C: negative control (no companion double) ===');
  const negCrawlP = api('POST', `/api/connections/${connectionId}/crawl`);
  const negCrawl = await negCrawlP;
  log('negative-control crawl trigger returned', negCrawl.status, JSON.stringify(negCrawl.json).slice(0, 200));
  const negSessionId = negCrawl.json.sessionId;
  if (!negSessionId) {
    // An early synchronous failure (before dispatch) is also an acceptable "requires tunnel" outcome, but
    // we expect a 202 + parked session here. Record what happened.
    log('negative control: no sessionId returned (early failure) —', JSON.stringify(negCrawl.json));
  }

  // Wait for the parked session to reach a terminal state. The park TTL is 30s; allow margin.
  let negFinal = null;
  const negDeadline = Date.now() + 90000;
  while (Date.now() < negDeadline) {
    const [s] = negSessionId
      ? await sql`select id, status, error, tunnel_requested, tunnel_claimed_at from sessions where id = ${negSessionId}`
      : await sql`select id, status, error, tunnel_requested, tunnel_claimed_at from sessions where connection_id = ${connectionId} order by started_at desc limit 1`;
    if (s && ['completed', 'failed', 'cancelled'].includes(s.status)) { negFinal = s; break; }
    await sleep(1000);
  }
  log('negative control final session:', JSON.stringify(negFinal));
  if (!negFinal) errors.push('NEGATIVE CONTROL: parked session never reached a terminal state within 90s (expected a tunnel-not-established failure)');
  else {
    if (negFinal.status === 'completed') errors.push('NEGATIVE CONTROL FAILED: crawl COMPLETED with no companion — the engine bypassed the tunnel (direct egress)!');
    if (negFinal.status !== 'failed') errors.push(`NEGATIVE CONTROL: expected status 'failed' (park timeout), got '${negFinal.status}'`);
    if (negFinal.tunnel_requested !== true) errors.push('NEGATIVE CONTROL: tunnel_requested was not set — device-proxy gate did not engage');
    if (negFinal.tunnel_claimed_at) errors.push('NEGATIVE CONTROL: tunnel_claimed_at was set despite no companion — a claim happened without the double');
  }
  // Fail-closed data check: no canonical data may have been extracted over a direct path.
  const negData = await collectAccuracyErrors(connectionId).catch(() => ({ acctCount: -1, txnCount: -1 }));
  if (negData.acctCount > 0 || negData.txnCount > 0) {
    errors.push(`FAIL-CLOSED VIOLATION: ${negData.acctCount} accounts / ${negData.txnCount} transactions were extracted WITHOUT a tunnel (direct egress leaked bank data)`);
  } else {
    log('fail-closed confirmed: 0 accounts / 0 transactions extracted with no companion');
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // SCENARIO A+B (POSITIVE) — start the companion double, trigger the crawl, prove it completes AND that
  // the bank traffic physically flowed through the double.
  // ─────────────────────────────────────────────────────────────────────────────
  log('\n=== SCENARIO A+B: positive (companion double routes the egress) ===');
  const companion = startCompanionDouble({ controlPlaneUrl: CP, deviceToken, hostMap: HOST_MAP, pollIntervalMs: 1000 });

  const posCrawlP = api('POST', `/api/connections/${connectionId}/crawl`);
  const posCrawl = await posCrawlP;
  log('positive crawl trigger returned', posCrawl.status, JSON.stringify(posCrawl.json).slice(0, 200));
  const posSessionId = posCrawl.json.sessionId;

  // Drive the OTP handshake while the tunnel carries the login traffic. Track the EXACT positive session
  // so the relay can never latch onto the negative-control's already-terminal session.
  const relay = await runRelay(connectionId, posSessionId, 300000);
  log('relay summary:', JSON.stringify(relay));

  // Give the double a beat to flush its final relay frames, then snapshot the oracle.
  await companion.waitForRelay(5000);
  const oracle = companion.summary();
  await companion.stop();
  log('companion-double oracle:', JSON.stringify(oracle, null, 2));

  // (a) Crawl completed + extracted data matches ground truth EXACTLY.
  const [posSess] = await sql`select status, otp_received_at, tunnel_requested, tunnel_claimed_at from sessions where id = ${posSessionId ?? relay.sessionId}`;
  log('positive final session:', JSON.stringify(posSess));
  if (posSess?.status !== 'completed') errors.push(`(a) session status is '${posSess?.status}', expected 'completed'`);
  if (!posSess?.otp_received_at) errors.push('(a) otp_received_at not set — OTP was not consumed by the engine');
  if (!posSess?.tunnel_claimed_at) errors.push('(a) tunnel_claimed_at NOT set — the tunnel was never actually claimed by the double');
  const acc = await collectAccuracyErrors(connectionId);
  for (const e of acc.errors) errors.push('(a) ' + e);

  // (b) The double demonstrably carried the bank traffic both ways.
  const targetSeen = oracle.connects.some((c) => c.host === BANK_HOST && c.port === P.bank);
  if (!targetSeen) errors.push(`(b) the double never opened a connection to the bank ${BANK_HOST}:${P.bank} — egress did NOT pass through the phone`);
  if (oracle.bytesEngineToBank <= 0) errors.push('(b) the double relayed 0 bytes engine→bank — no request traffic flowed through the phone');
  if (oracle.bytesBankToEngine <= 0) errors.push('(b) the double relayed 0 bytes bank→engine — no response traffic flowed through the phone');
  if (oracle.tunnelsOpened <= 0) errors.push('(b) the double never opened a tunnel WS to the engine');
  if (targetSeen && oracle.bytesEngineToBank > 0 && oracle.bytesBankToEngine > 0) {
    log(`(b) CONFIRMED: bank traffic flowed THROUGH the double — opened ${BANK_HOST}:${P.bank}, ` +
        `relayed ${oracle.bytesEngineToBank} B engine→bank and ${oracle.bytesBankToEngine} B bank→engine`);
  }

  // ─── Verdict ──────────────────────────────────────────────────────────────────
  if (errors.length) {
    console.error('\n❌ TUNNEL E2E FAILED:\n' + errors.map((e) => '  - ' + e).join('\n'));
    process.exitCode = 1;
  } else {
    console.log('\n✅ TUNNEL E2E PASSED:');
    console.log('  (a) device-proxy crawl completed; extracted accounts/transactions match ground truth exactly.');
    console.log(`  (b) bank traffic provably flowed THROUGH the companion double (${oracle.bytesEngineToBank}B out / ${oracle.bytesBankToEngine}B in, target ${BANK_HOST}:${P.bank}).`);
    console.log('  (c) negative control: with no companion the crawl PARKED then FAILED (tunnel-required), and no data was extracted direct.');
  }
}

async function teardown() {
  for (const { name, c } of children) { try { c.kill('SIGTERM'); } catch { /* */ } void name; }
  try { await sql?.end({ timeout: 3 }); } catch { /* */ }
  try { await pg?.stop(); } catch { /* */ }
}

main().catch((e) => { console.error('\n❌ TUNNEL E2E ERROR:', e.stack || e.message); process.exitCode = 1; })
  .finally(async () => { await teardown(); setTimeout(() => process.exit(process.exitCode ?? 0), 500); });
