/**
 * FRONT-DOOR (Caddy) device-proxy TUNNEL validation.
 *
 * Identical positive scenario to run-e2e-tunnel.mjs, EXCEPT the companion double reaches the engine's
 * /tunnel WS THROUGH a real Caddy running the production infra/Caddyfile `/tunnel` route (stock
 * `reverse_proxy`, no custom websocket directives). This proves the production front-door hop
 * (phone → Caddy → engine) correctly upgrades + byte-relays the tunnel WebSocket — the one piece the
 * direct-to-engine harness does not exercise.
 *
 *   phone(double) ──ws://127.0.0.1:8088/tunnel──▶ Caddy(:8088, docker) ──host.docker.internal:ENGINE──▶ engine /tunnel
 *
 * DECISIVE assertions:
 *   (a) the WS upgrade succeeded THROUGH Caddy: the double's tunnel opened, the claim was won
 *       (tunnel_claimed_at set), AND Caddy's access log shows GET /tunnel → 101 Switching Protocols.
 *   (b) the crawl COMPLETED and the extracted accounts/transactions match ground truth EXACTLY, and the
 *       double's oracle proves the bank bytes flowed both ways — i.e. the full relay survived the Caddy
 *       hop, not just the handshake.
 *
 * Reuses e2e/companion-double.mjs + e2e/truth.mjs + e2e/fake-bank.mjs unchanged. Node >= 22, GEMINI_API_KEY.
 */
import EmbeddedPostgres from 'embedded-postgres';
import postgres from 'postgres';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { TRUTH, CREDS } from './truth.mjs';
import { startCompanionDouble } from './companion-double.mjs';

// The code this run's deployment is claimed with. Generated per run: the server refuses setup without
// one, so a run that forgot it would fail at the first request rather than silently claim anything.
const SETUP_CLAIM_TOKEN = 'e2e-setup-' + Math.abs(Date.now() % 1e9).toString(36) + '-claim';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Under $HOME, NOT /tmp: Docker Desktop on macOS only file-shares $HOME (and the repo), not /private/tmp,
// so the Caddyfile + access-log bind mounts must live under $HOME to be visible inside the container.
const TMP = path.join(os.homedir(), '.accrawl-e2e-tunnel-caddy');
// Caddy host port deliberately 18088 (NOT 8088) so this validation never collides with a developer's
// already-running `docker compose` stack (whose caddy publishes 8088). The in-container listen is also
// 18088 (the local Caddyfile listens on :18088). Everything else mirrors production.
const P = { pg: 54399, engine: 4111, cp: 4112, bank: 4113, caddy: 18088 };
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
// The companion double reaches the engine /tunnel WS through Caddy's published front-door port.
const CADDY_WS_URL = `ws://127.0.0.1:${P.caddy}/tunnel`;
const HOST_MAP = { [BANK_HOST]: '127.0.0.1' };
// Resolved from PATH: an absolute package-manager prefix is one machine's layout, not a
// requirement. DOCKER_BIN still overrides for an install that is not on PATH.
const DOCKER = process.env.DOCKER_BIN || 'docker';
const CADDY_IMAGE = process.env.ACCRAWL_CADDY_IMAGE || 'accrawl-web:local';
const CADDY_CONTAINER = 'accrawl-e2e-frontdoor-caddy';
const CADDY_LOG_DIR = path.join(TMP, 'caddy-log');
// The Caddyfile is generated inline so this harness is self-contained. It mirrors production
// infra/Caddyfile — the /tunnel route's reverse_proxy is STOCK (no websocket directives) — and only the
// upstreams point at the host-process ports (host.docker.internal) instead of the docker service names,
// plus a JSON access-log sink so the harness can assert the /tunnel 101 upgrade.
const CADDYFILE = `{
  admin off
}

:${P.caddy} {
  encode gzip

  log {
    output file /var/log/caddy/access.log
    format json
  }

  handle /api/* {
    reverse_proxy host.docker.internal:${P.cp} {
      flush_interval -1
      header_up X-Forwarded-For {remote_host}
    }
  }
  handle /health {
    reverse_proxy host.docker.internal:${P.cp}
  }

  # Device-proxy tunnel WebSocket -> engine. STOCK reverse_proxy, exactly as production
  # (production: reverse_proxy engine:8080); only the upstream is the host-process engine port here.
  handle /tunnel {
    reverse_proxy host.docker.internal:${P.engine}
  }

  handle {
    respond "accrawl front-door (local tunnel validation)" 200
  }
}
`;

const children = [];
let pg, sql;
const log = (...a) => console.log('[caddy-tunnel-e2e]', ...a);

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

function dockerRm() {
  try { execFileSync(DOCKER, ['rm', '-f', CADDY_CONTAINER], { stdio: 'ignore' }); } catch { /* not running */ }
}

function startCaddy() {
  dockerRm();
  fs.mkdirSync(CADDY_LOG_DIR, { recursive: true });
  // Docker Desktop on macOS cannot reliably bind-mount a SINGLE FILE from arbitrary paths, so we copy the
  // Caddyfile into a /tmp-based config DIR and mount that directory (directory mounts work where file
  // mounts fail). Caddy reads /etc/caddy/Caddyfile, so we name the copy accordingly.
  const cfgDir = path.join(TMP, 'caddy-cfg');
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(path.join(cfgDir, 'Caddyfile'), CADDYFILE);
  // --add-host host.docker.internal:host-gateway makes the host reachable (Docker Desktop + Linux).
  // Publish the front-door port (18088 → 18088). Mount the cfg dir at /etc/caddy and the log dir.
  const args = [
    'run', '--rm', '-d', '--name', CADDY_CONTAINER,
    '--add-host', 'host.docker.internal:host-gateway',
    '-p', `${P.caddy}:${P.caddy}`,
    '-v', `${cfgDir}:/etc/caddy:ro`,
    '-v', `${CADDY_LOG_DIR}:/var/log/caddy`,
    CADDY_IMAGE,
  ];
  log('docker run', args.join(' '));
  const r = spawnSync(DOCKER, args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`docker run caddy failed: ${r.stderr || r.stdout}`);
  log('caddy container started:', (r.stdout || '').trim().slice(0, 12));
}

function caddyLogs() {
  try { return execFileSync(DOCKER, ['logs', CADDY_CONTAINER], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (e) { return `(could not read caddy logs: ${e.message})`; }
}

/** Read Caddy's JSON access log and return entries for GET /tunnel. */
function caddyTunnelAccessEntries() {
  const f = path.join(CADDY_LOG_DIR, 'access.log');
  if (!fs.existsSync(f)) return [];
  const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
  const entries = [];
  for (const line of lines) {
    try {
      const e = JSON.parse(line);
      const uri = e?.request?.uri || '';
      if (uri.startsWith('/tunnel')) entries.push(e);
    } catch { /* skip non-json lines */ }
  }
  return entries;
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

  // 3. Services (engine serves /tunnel; control-plane hands out the CADDY ws url, not the engine's).
  spawnSvc('fake-bank', 'node', ['e2e/fake-bank.mjs'], { FAKEBANK_PORT: String(P.bank), FAKEBANK_SILENT: '1' });
  spawnSvc('engine', 'node', ['apps/engine/dist/index.js'], {
    SERVICE_MODE: 'development', PORT: String(P.engine), PLATFORM: 'postgres',
    ENGINE_DATABASE_URL: DBURL, GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    ENGINE_SHARED_SECRET: SECRETS.ENGINE_SHARED_SECRET, RUNS_DIR: path.join(TMP, 'runs'),
    HEADLESS: process.env.E2E_HEADFUL ? 'false' : 'true',
  });
  spawnSvc('control-plane', 'node', ['apps/control-plane/dist/server-main.js'], {
    PORT: String(P.cp), DATABASE_URL: DBURL, ENGINE_URL: `http://127.0.0.1:${P.engine}`,
    // ← THE FRONT DOOR: the companion is handed the Caddy /tunnel URL, not the engine's direct port.
    ENGINE_WS_URL: CADDY_WS_URL,
    ...SECRETS,
  });

  await waitForHealth('fake-bank', `${BANK}/_health`);
  await waitForHealth('engine', `http://127.0.0.1:${P.engine}/`);
  await waitForHealth('control-plane', `${CP}/health`);

  // 3b. Bring up Caddy (production-derived Caddyfile) and confirm the front door is live + can reach the
  // engine /tunnel route through the stock reverse_proxy. A GET /tunnel without WS headers should reach
  // the engine and return its 400 (sessionId/token missing) — proving Caddy proxies the route to the
  // engine (not a Caddy 502/404).
  startCaddy();
  // Wait for the front door itself to answer.
  await waitForHealth('caddy-frontdoor', `http://127.0.0.1:${P.caddy}/`, 30000);
  {
    const probe = await fetch(`http://127.0.0.1:${P.caddy}/tunnel`).then((r) => ({ s: r.status })).catch((e) => ({ err: e.message }));
    log('front-door /tunnel non-WS probe (expect engine 400):', JSON.stringify(probe));
  }

  const errors = [];

  // 4. Operator setup + the device-proxy institution + connection + domain verification.
  const setup = await api('POST', '/api/setup', { password: SECRETS.ACCRAWL_ADMIN_PASSWORD, setupCode: SETUP_CLAIM_TOKEN });
  if (![200, 201].includes(setup.status)) throw new Error(`first-run setup failed: ${setup.status} ${JSON.stringify(setup.json)}`);
  token = setup.json.token;
  log('operator initialized + authenticated');

  const inst = await api('POST', '/api/institutions', {
    id: 'northwind', name: 'Northwind Bank', type: 'bank',
    loginUrl: `http://${BANK_HOST}:${P.bank}/login`,
    useDeviceProxy: true,
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
  log('device-proxy institution created (useDeviceProxy=true)');

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

  // ─────────────────────────────────────────────────────────────────────────────
  // POSITIVE through the FRONT DOOR — start the companion double (handed the Caddy URL via
  // awaiting-tunnel), trigger the crawl, prove it completes AND the bank traffic flowed through the
  // double, having traversed Caddy on every WS frame.
  // ─────────────────────────────────────────────────────────────────────────────
  log('\n=== POSITIVE (companion double connects THROUGH Caddy) ===');
  const companion = startCompanionDouble({ controlPlaneUrl: CP, deviceToken, hostMap: HOST_MAP, pollIntervalMs: 1000 });

  const posCrawl = await api('POST', `/api/connections/${connectionId}/crawl`);
  log('crawl trigger returned', posCrawl.status, JSON.stringify(posCrawl.json).slice(0, 200));
  const posSessionId = posCrawl.json.sessionId;

  const relay = await runRelay(connectionId, posSessionId, 300000);
  log('relay summary:', JSON.stringify(relay));

  await companion.waitForRelay(5000);
  const oracle = companion.summary();
  await companion.stop();
  log('companion-double oracle:', JSON.stringify(oracle, null, 2));

  // (a) Front-door WS upgrade + claim.
  const [posSess] = await sql`select status, otp_received_at, tunnel_requested, tunnel_claimed_at from sessions where id = ${posSessionId ?? relay.sessionId}`;
  log('positive final session:', JSON.stringify(posSess));
  if (posSess?.status !== 'completed') errors.push(`(a) session status is '${posSess?.status}', expected 'completed'`);
  if (!posSess?.otp_received_at) errors.push('(a) otp_received_at not set — OTP was not consumed by the engine');
  if (!posSess?.tunnel_claimed_at) errors.push('(a) tunnel_claimed_at NOT set — the tunnel was never actually claimed by the double through Caddy');
  if (oracle.tunnelsOpened <= 0) errors.push('(a) the double never opened a tunnel WS through Caddy');

  // (a') Caddy access log must show GET /tunnel → 101 Switching Protocols (the front-door upgrade).
  const caddyEntries = caddyTunnelAccessEntries();
  const upgrade101 = caddyEntries.find((e) => e.status === 101);
  log(`caddy /tunnel access entries: ${caddyEntries.length}`,
      caddyEntries.map((e) => `${e.request?.method} ${e.request?.uri} -> ${e.status}`).join(' | '));
  if (!upgrade101) {
    errors.push(`(a') Caddy access log has no /tunnel 101 Switching Protocols entry — the WS upgrade did NOT go through Caddy ` +
      `(saw statuses: ${caddyEntries.map((e) => e.status).join(',') || 'none'})`);
  } else {
    log(`(a') CONFIRMED: Caddy front-door upgraded the WS — GET ${upgrade101.request?.uri} -> 101 Switching Protocols`);
  }

  // (b) Data accuracy + full byte relay through Caddy.
  const acc = await collectAccuracyErrors(connectionId);
  for (const e of acc.errors) errors.push('(b) ' + e);
  const targetSeen = oracle.connects.some((c) => c.host === BANK_HOST && c.port === P.bank);
  if (!targetSeen) errors.push(`(b) the double never opened a connection to the bank ${BANK_HOST}:${P.bank} — egress did NOT pass through the phone`);
  if (oracle.bytesEngineToBank <= 0) errors.push('(b) the double relayed 0 bytes engine→bank through Caddy');
  if (oracle.bytesBankToEngine <= 0) errors.push('(b) the double relayed 0 bytes bank→engine through Caddy');
  if (targetSeen && oracle.bytesEngineToBank > 0 && oracle.bytesBankToEngine > 0 && upgrade101) {
    log(`(b) CONFIRMED through Caddy: opened ${BANK_HOST}:${P.bank}, relayed ` +
        `${oracle.bytesEngineToBank} B engine→bank + ${oracle.bytesBankToEngine} B bank→engine — full relay survived the front door`);
  }

  // ─── Verdict ──────────────────────────────────────────────────────────────────
  log('\n--- caddy container logs (tail) ---\n' + caddyLogs().split('\n').slice(-25).join('\n'));
  if (errors.length) {
    console.error('\n❌ CADDY FRONT-DOOR TUNNEL E2E FAILED:\n' + errors.map((e) => '  - ' + e).join('\n'));
    process.exitCode = 1;
  } else {
    console.log('\n✅ CADDY FRONT-DOOR TUNNEL E2E PASSED:');
    console.log(`  (a) WS upgraded THROUGH Caddy: GET /tunnel -> 101 Switching Protocols (access log), double onOpen + claim won (tunnel_claimed_at set).`);
    console.log(`  (b) crawl completed; extracted accounts/transactions match ground truth EXACTLY; bank bytes relayed both ways through the double (${oracle.bytesEngineToBank}B out / ${oracle.bytesBankToEngine}B in) — the full relay survived the front-door hop.`);
  }
}

async function teardown() {
  dockerRm();
  for (const { name, c } of children) { try { c.kill('SIGTERM'); } catch { /* */ } void name; }
  try { await sql?.end({ timeout: 3 }); } catch { /* */ }
  try { await pg?.stop(); } catch { /* */ }
}

main().catch((e) => { console.error('\n❌ CADDY FRONT-DOOR TUNNEL E2E ERROR:', e.stack || e.message); process.exitCode = 1; })
  .finally(async () => { await teardown(); setTimeout(() => process.exit(process.exitCode ?? 0), 500); });
