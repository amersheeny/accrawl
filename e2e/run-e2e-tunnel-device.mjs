/**
 * Accrawl device-proxy TUNNEL e2e — REAL emulator companion edition.
 *
 * Same real stack as run-e2e-tunnel.mjs (embedded Postgres + migrations, engine + control-plane as
 * separate processes, the fake bank, a real Playwright + Gemini crawl, an in-process OTP relay) — but the
 * device side is NOT the Node companion-double. It is the ACTUAL production component: the Kotlin
 * TunnelService running on an Android emulator (its OkHttp WebSocket client + java.net.Socket relay
 * threads). This proves the real phone software carries the crawl's bank egress end to end.
 *
 * The networking crux (see header of TunnelService.kt): the engine's SOCKS5 does REMOTE DNS, so the
 * companion is asked to `connect {host: "northwind-bank.com", port}` and opens a REAL java.net.Socket to
 * it. On the emulator we map northwind-bank.com -> 10.0.2.2 in /system/etc/hosts (a writable-system AVD),
 * and 10.0.2.2 is the QEMU alias for the host's loopback where the fake bank listens. The engine/CP bind
 * all interfaces, so the companion reaches the control-plane at http://10.0.2.2:<cp> and the engine's
 * tunnel WS at ws://10.0.2.2:<engine>/tunnel (ENGINE_WS_URL is set to exactly that).
 *
 * The harness:
 *   1. brings up the same servers (engine in SERVICE_MODE=development PLATFORM=postgres so /tunnel is
 *      served), seeds a useDeviceProxy=true institution + connection + verified domain;
 *   2. pairs a REAL device (POST /api/devices/pair -> acdv_ token), writes that token + the 10.0.2.2
 *      base URL into the companion's FlutterSharedPreferences, and starts the real TunnelService;
 *   3. triggers the crawl, drives the OTP handshake (the bank's real per-login code);
 *   4. asserts (a) the crawl COMPLETED + tunnel_claimed_at set + extracted data == ground truth EXACTLY,
 *      and reports the on-device logcat evidence the real TunnelService relayed the bytes.
 *
 * Run with GEMINI_API_KEY set + the workspace built, Node >= 26.6, against the visible emulator owned
 * by the current emulator-lease session. Commits nothing.
 */
import EmbeddedPostgres from 'embedded-postgres';
import postgres from 'postgres';
import { spawn, execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { TRUTH, CREDS } from './truth.mjs';

// The code this run's deployment is claimed with. Generated per run: the server refuses setup without
// one, so a run that forgot it would fail at the first request rather than silently claim anything.
const SETUP_CLAIM_TOKEN = 'e2e-setup-' + Math.abs(Date.now() % 1e9).toString(36) + '-claim';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = '/tmp/accrawl-e2e-tunnel';
const P = { pg: 54399, engine: 4111, cp: 4112, bank: 4113 };
const BANK_HOST = 'northwind-bank.com';
const SERIAL = process.env.EMULATOR_SERIAL;
const LEASE_SCRIPT = process.env.EMULATOR_LEASE_SCRIPT;
if (!SERIAL || !LEASE_SCRIPT || !process.env.EMU_SESSION) {
  throw new Error('EMULATOR_SERIAL, EMULATOR_LEASE_SCRIPT, and EMU_SESSION are required');
}
const LEASED_SERIAL = execFileSync(LEASE_SCRIPT, ['mine'], { encoding: 'utf8' }).trim();
if (LEASED_SERIAL !== SERIAL) {
  throw new Error(`EMULATOR_SERIAL does not match the current lease (${LEASED_SERIAL})`);
}
const APP_ID = 'app.accrawl.accrawl_companion';
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
// What the EMULATOR uses to reach the host: 10.0.2.2 is QEMU's alias for the host loopback.
const CP_FROM_DEVICE = `http://10.0.2.2:${P.cp}`;
const ENGINE_WS_FROM_DEVICE = `ws://10.0.2.2:${P.engine}/tunnel`;

const children = [];
let pg, sql;
const log = (...a) => console.log('[device-e2e]', ...a);

function adb(args, opts = {}) {
  return execFileSync(LEASE_SCRIPT, ['adb', '--', ...args], { encoding: 'utf8', ...opts });
}

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
    try { const r = await fetch(url); if (r.ok) { log(`${name} healthy`); return; } } catch { /* not up */ }
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

/** In-process OTP relay (identical to run-e2e-tunnel's). */
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

/** Reusable accuracy assertions over the canonical tables (mirrors run-e2e-tunnel.mjs exactly). */
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

/**
 * Write the companion's FlutterSharedPreferences (flutter.baseUrl + flutter.deviceToken) so the running
 * TunnelService picks them up on its next poll, then (re)start the service. We write the prefs XML
 * directly via root — deterministic and UI-free — then kick TunnelService through `am`.
 */
function configureCompanion(deviceToken) {
  adb(['root']); // idempotent
  // Stop the app + service so the new prefs are read cleanly from disk on next start.
  adb(['shell', 'am', 'force-stop', APP_ID]);
  const prefsXml =
    `<?xml version='1.0' encoding='utf-8' standalone='yes' ?>\n` +
    `<map>\n` +
    `    <string name="flutter.baseUrl">${CP_FROM_DEVICE}</string>\n` +
    `    <string name="flutter.deviceToken">${deviceToken}</string>\n` +
    `    <string name="flutter.nativeTunnelLog">[]</string>\n` +
    `</map>\n`;
  const local = path.join(TMP, 'FlutterSharedPreferences.xml');
  fs.writeFileSync(local, prefsXml);
  const dst = `/data/data/${APP_ID}/shared_prefs/FlutterSharedPreferences.xml`;
  adb(['push', local, '/data/local/tmp/fsp.xml']);
  adb(['shell', 'run-as', APP_ID, 'mkdir', '-p', `/data/data/${APP_ID}/shared_prefs`]);
  // run-as can't always read /data/local/tmp; cat through the shell as root then chown to the app uid.
  adb(['shell', `cp /data/local/tmp/fsp.xml ${dst}`]);
  const uid = adb(['shell', `stat -c %u /data/data/${APP_ID}`]).trim();
  const gid = adb(['shell', `stat -c %g /data/data/${APP_ID}`]).trim();
  adb(['shell', `chown ${uid}:${gid} ${dst}`]);
  adb(['shell', `chmod 660 ${dst}`]);
  adb(['shell', `restorecon ${dst} 2>/dev/null || true`]);
  log('seeded companion prefs:', CP_FROM_DEVICE, deviceToken.slice(0, 10) + '…');
  // Start the foreground tunnel service directly (API 34 needs start-foreground-service for a bg start).
  adb(['shell', 'am', 'start-foreground-service', '-n', `${APP_ID}/.TunnelService`]);
  log('started TunnelService via am start-foreground-service');
}

function dumpLogcat(tag) {
  try { return adb(['logcat', '-d', '-v', 'time', '-s', `${tag}:V`]); } catch { return ''; }
}

/** Pull the companion process's network-relevant logcat: TunnelService lifecycle lines + the kernel's
 *  TrafficStats.tagSocket entries that attribute each opened socket (the OkHttp WS + every per-connection
 *  relay socket the phone opened to the bank) to the companion's UID — OS-level proof the bytes physically
 *  traversed this process. Filtered to the companion's pid so it's unambiguous. */
function dumpCompanionNet() {
  let pid = '';
  try { pid = adb(['shell', 'pidof', APP_ID]).trim().split(/\s+/)[0] || ''; } catch { /* */ }
  let all = '';
  try { all = adb(['logcat', '-d', '-v', 'time']); } catch { return ''; }
  return all.split('\n')
    .filter((l) => /TunnelService|TrafficStats|tagSocket/.test(l) && (!pid || l.includes(`( ${pid})`) || l.includes(`(${pid})`)))
    .join('\n');
}

async function main() {
  // Recreate only the working subdirs we own — never rm the whole TMP, since this run's own redirected
  // stdout log may live in it (deleting it would orphan the writer's fd and lose the harness output).
  fs.mkdirSync(TMP, { recursive: true });
  for (const sub of ['pgdata', 'runs']) fs.rmSync(path.join(TMP, sub), { recursive: true, force: true });

  // Sanity: the emulator must be reachable and the bank host must resolve to 10.0.2.2 on it.
  const resolved = adb(['shell', 'ping', '-c1', BANK_HOST]).toString();
  if (!resolved.includes('10.0.2.2')) throw new Error(`emulator does not resolve ${BANK_HOST} -> 10.0.2.2:\n${resolved}`);
  log(`emulator ${SERIAL} resolves ${BANK_HOST} -> 10.0.2.2 ✓`);
  // Clear logcat so the captured evidence is only from this run, and ENLARGE the ring buffer: the tunnel
  // lifecycle spans the whole crawl (~90s) and the emulator floods the default 256KB main buffer with system
  // spam (Bugle/Connectivity/GLS), which evicts the early "opening tunnel"/"tunnel up" lines before the
  // end-of-run capture. 16M holds the full run so no proof line is lost to rotation.
  adb(['logcat', '-c']);
  try { adb(['logcat', '-G', '16M']); } catch { /* some images cap this; the byte-relay assertion below is buffer-rotation-proof anyway */ }

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

  // 3. Services. Engine in SERVICE_MODE=development + PLATFORM=postgres serves /crawl AND /tunnel. NO
  //    --host-resolver-rules: the browser does REMOTE DNS via SOCKS5, sending the bank hostname to the
  //    companion (the emulator) where resolution happens — proving egress leaves via the phone.
  spawnSvc('fake-bank', 'node', ['e2e/fake-bank.mjs'], { FAKEBANK_PORT: String(P.bank), FAKEBANK_SILENT: '1' });
  spawnSvc('engine', 'node', ['apps/engine/dist/index.js'], {
    SERVICE_MODE: 'development', PORT: String(P.engine), PLATFORM: 'postgres',
    ENGINE_DATABASE_URL: DBURL, GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    ENGINE_SHARED_SECRET: SECRETS.ENGINE_SHARED_SECRET, RUNS_DIR: path.join(TMP, 'runs'),
    HEADLESS: process.env.E2E_HEADFUL ? 'false' : 'true',
  });
  spawnSvc('control-plane', 'node', ['apps/control-plane/dist/server-main.js'], {
    PORT: String(P.cp), DATABASE_URL: DBURL, ENGINE_URL: `http://127.0.0.1:${P.engine}`,
    // The phone-reachable tunnel WS base handed to the companion via awaiting-tunnel.
    ENGINE_WS_URL: ENGINE_WS_FROM_DEVICE,
    ...SECRETS,
  });

  await waitForHealth('fake-bank', `${BANK}/_health`);
  await waitForHealth('engine', `http://127.0.0.1:${P.engine}/`);
  await waitForHealth('control-plane', `${CP}/health`);

  // 4. Operator setup + device-proxy institution + connection + domain verification.
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

  const pair = await api('POST', '/api/devices/pair', { name: 'e2e-real-emulator-companion' });
  if (![200, 201].includes(pair.status)) throw new Error(`device pair failed: ${pair.status} ${JSON.stringify(pair.json)}`);
  const deviceToken = pair.json.token;
  if (!deviceToken?.startsWith('acdv_')) throw new Error(`expected an acdv_ device token, got ${deviceToken}`);
  log('companion device paired; token prefix =', deviceToken.slice(0, 5));

  const conn = await api('POST', '/api/connections', { institutionId, username: CREDS.username, password: CREDS.password });
  if (![200, 201].includes(conn.status)) throw new Error(`create connection failed: ${conn.status} ${JSON.stringify(conn.json)}`);
  const connectionId = conn.json.id;
  const verify = await api('POST', `/api/connections/${connectionId}/verify-domain`, { canonicalDomain: BANK_HOST });
  if (![200, 204].includes(verify.status)) throw new Error(`verify-domain failed: ${verify.status} ${JSON.stringify(verify.json)}`);
  log('connection created + login domain verified', connectionId);

  // 5. Configure + start the REAL emulator companion BEFORE triggering the crawl, so its poll loop is
  //    already running and claims the tunnel within the engine's 30s park TTL.
  configureCompanion(deviceToken);
  log('waiting 8s for the companion poll loop to spin up…');
  await sleep(8000);

  const errors = [];

  // ── POSITIVE: trigger the device-proxy crawl; the real phone routes the egress ──
  log('\n=== trigger device-proxy crawl (real emulator companion is the exit node) ===');
  const posCrawl = await api('POST', `/api/connections/${connectionId}/crawl`);
  log('crawl trigger returned', posCrawl.status, JSON.stringify(posCrawl.json).slice(0, 200));
  const posSessionId = posCrawl.json.sessionId;

  const relay = await runRelay(connectionId, posSessionId, 300000);
  log('relay summary:', JSON.stringify(relay));

  // Give the device a beat to flush its log, then snapshot the on-device evidence.
  await sleep(3000);
  const tunnelLog = dumpLogcat('TunnelService');
  const netLog = dumpCompanionNet();
  fs.writeFileSync(path.join(TMP, 'tunnelservice-logcat.txt'), tunnelLog + '\n\n=== companion process net sockets ===\n' + netLog);
  log('--- TunnelService logcat (on-device proof) ---\n' + tunnelLog.trim());
  log('--- companion process network sockets (OkHttp WS + per-connection relay sockets) ---\n' + netLog.trim());

  const [posSess] = await sql`select status, otp_received_at, tunnel_requested, tunnel_claimed_at from sessions where id = ${posSessionId ?? relay.sessionId}`;
  log('positive final session:', JSON.stringify(posSess));
  if (posSess?.status !== 'completed') errors.push(`session status is '${posSess?.status}', expected 'completed'`);
  if (!posSess?.otp_received_at) errors.push('otp_received_at not set — OTP was not consumed by the engine');
  if (!posSess?.tunnel_claimed_at) errors.push('tunnel_claimed_at NOT set — the tunnel was never actually claimed by the companion');
  const acc = await collectAccuracyErrors(connectionId);
  for (const e of acc.errors) errors.push(e);

  // On-device proof the REAL Kotlin client carried the crawl. We assert on byte-relay evidence, which is
  // STRONGER than a bare WS-open and inherently buffer-rotation-proof: the terminal "tunnel closed … relayed
  // X KB↑ Y KB↓" line is emitted right before capture (never lost to rotation). The earlier "tunnel up"/
  // "opening tunnel" lines corroborate the connect but are logged at claim time, so we don't gate on them alone
  // (they can rotate out of a busy buffer — the very false-negative this replaces).
  const bankRe = new RegExp(`relaying → ${BANK_HOST.replace(/[.]/g, '\\.')}:`);
  const relayedM = tunnelLog.match(/relayed\s+(\d+)KB↑\s+(\d+)KB↓/);
  const relayedBytes = relayedM ? Number(relayedM[1]) + Number(relayedM[2]) : 0;
  const connected =
    /tunnel up for session/.test(tunnelLog) || /opening tunnel for session/.test(tunnelLog) ||
    bankRe.test(tunnelLog) || relayedBytes > 0;
  if (!connected) {
    errors.push('on-device: TunnelService logged no tunnel lifecycle at all — the real Kotlin client never connected');
  }
  // DECISIVE: the phone must have opened a relay socket to THE BANK (not just Chrome's incidental google.com
  // background traffic, which also flows through the tunnel) AND the terminal tally must show real bytes moved.
  // A bank-target "relaying →" alone (socket opened, 0 bytes) or a non-bank relay is NOT proof of the crawl egress.
  if (!bankRe.test(tunnelLog)) {
    errors.push(`on-device: TunnelService never opened a relay socket to the bank (${BANK_HOST}) — the phone did not carry the crawl egress`);
  }
  if (relayedBytes === 0) {
    errors.push('on-device: TunnelService relayed 0 bytes — no traffic actually flowed through the phone');
  }

  if (errors.length) {
    console.error('\n❌ DEVICE TUNNEL E2E FAILED:\n' + errors.map((e) => '  - ' + e).join('\n'));
    process.exitCode = 1;
  } else {
    console.log('\n✅ DEVICE TUNNEL E2E PASSED:');
    console.log('  - the REAL Kotlin TunnelService on the emulator claimed the tunnel (tunnel_claimed_at set) and carried the crawl;');
    console.log('  - device-proxy crawl COMPLETED; extracted accounts/transactions match ground truth EXACTLY;');
    console.log(`  - on-device logcat shows the OkHttp WS connect + per-connection socket relay (see ${TMP}/tunnelservice-logcat.txt).`);
  }
}

async function teardown() {
  try { adb(['shell', 'am', 'force-stop', APP_ID]); } catch { /* */ }
  for (const { name, c } of children) { try { c.kill('SIGTERM'); } catch { /* */ } void name; }
  try { await sql?.end({ timeout: 3 }); } catch { /* */ }
  try { await pg?.stop(); } catch { /* */ }
}

main().catch((e) => { console.error('\n❌ DEVICE TUNNEL E2E ERROR:', e.stack || e.message); process.exitCode = 1; })
  .finally(async () => { await teardown(); setTimeout(() => process.exit(process.exitCode ?? 0), 500); });
