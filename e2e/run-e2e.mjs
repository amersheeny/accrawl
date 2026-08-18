/**
 * Accrawl end-to-end validation — the REAL thing.
 *
 * Stands up a real Postgres (embedded-postgres, no docker), spawns the engine + control-plane as
 * separate processes sharing that DB, serves a fake bank, then drives the actual product HTTP API:
 *   operator login -> create institution -> create connection (creds encrypted) -> verify login domain
 *   -> POST /connections/:id/crawl. The engine logs into the fake bank with Playwright + the LLM agent,
 *   hits the 2FA page, and blocks on the OTP. The default in-process relay watches the shared DB, captures
 *   the SMS body the bank "sent", and submits it through the real POST /sessions/:id/otp route. With
 *   COMPANION_RELAY enabled, the real Companion app receives that SMS on a leased Android emulator and
 *   forwards its raw body through the device-authenticated route. With E2E_MANUAL_OTP enabled, NOTHING is
 *   paired at all and the operator types the code into the console — the floor every self-hoster gets,
 *   and the one path that proves a crawl still reaches waiting_for_otp with no phone in the picture. In
 *   the relayed paths the control-plane extracts
 *   the code with the configured LLM, and the engine reads it, finishes, and stages the extraction;
 *   validates + stores it. We then assert the canonical accounts/transactions match the bank's truth and
 *   that the session actually passed through waiting_for_otp -> logging_in -> completed.
 *
 * Run via run-e2e.sh (which requires GEMINI_API_KEY in the environment and builds first).
 */
import EmbeddedPostgres from 'embedded-postgres';
import postgres from 'postgres';
import { spawn, execFile } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { TRUTH, CREDS } from './truth.mjs';

/**
 * OCR every persisted screenshot and return the files in which the live OTP code is VISIBLE (rendered pixels).
 * This is the ONLY check that can see the exact leak a broken DOM mask produces — a byte scan can't read pixels.
 * Upscales + grayscales each shot (the code renders small in a fullpage capture) so tesseract can read it; the
 * fake bank renders its OTP field large so a leaked code is unambiguously legible. Throws if OCR can't run at all
 * — the caller turns that into a failure, never a silent "clean" (a scan that can't see the leak is worse than none).
 */
async function ocrScreenshotsForCode(shotFiles, code) {
  if (!shotFiles.length) return [];
  const { createWorker } = await import('tesseract.js');
  const sharp = (await import('sharp')).default;
  const worker = await createWorker('eng');
  const hits = [];
  try {
    for (const f of shotFiles) {
      let buf;
      try {
        buf = await sharp(f).resize({ width: 2400, withoutEnlargement: false }).grayscale().normalize().sharpen().toBuffer();
      } catch { continue; } // unreadable/empty file (a fail-closed suppression writes nothing) — skip
      const { data: { text } } = await worker.recognize(buf);
      if (text.replace(/\s+/g, '').includes(code)) hits.push(f);
    }
  } finally {
    await worker.terminate();
  }
  return hits;
}

// The code this run's deployment is claimed with. Generated per run: the server refuses setup without
// one, so a run that forgot it would fail at the first request rather than silently claim anything.
const SETUP_CLAIM_TOKEN = 'e2e-setup-' + Math.abs(Date.now() % 1e9).toString(36) + '-claim';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = '/tmp/accrawl-e2e';
const P = { pg: 54399, engine: 4101, cp: 4102, bank: 4103, web: 4108 };
const BANK_HOST = 'northwind-bank.com';
const SECRETS = {
  ENGINE_SHARED_SECRET: 'e2e-engine-shared-secret-0001',
  CREDENTIAL_ENC_KEY: '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff',
  ACCRAWL_ADMIN_PASSWORD: 'e2e-operator-password',
  SESSION_SECRET: 'e2e-session-signing-secret-please-change',
};
const DBURL = `postgres://accrawl:accrawl@127.0.0.1:${P.pg}/accrawl`;
/** The engine connects under its own least-privilege role, exactly as the compose deployment does, so a
 *  statement reaching for something nobody granted fails here rather than in someone's install. Connecting
 *  as the admin role is why a deployment that could record nothing at all still passed this suite. */
const ENGINE_DB_PASSWORD = 'e2e-engine-role-password';
const ENGINE_DBURL = `postgres://accrawl_engine:${ENGINE_DB_PASSWORD}@127.0.0.1:${P.pg}/accrawl`;
const CP = `http://127.0.0.1:${P.cp}`;
const BANK = `http://127.0.0.1:${P.bank}`;
const WEB = `http://127.0.0.1:${P.web}`;
const WEB_DIST = path.join(ROOT, 'apps/web/dist');
// The push project the Companion's test build registers with. No default: a project identifier belongs
// to whoever runs this, not to the repository, and a wrong one fails as a silent no-wake rather than
// loudly, so the relay run asks for it instead of guessing.
/**
 * What the control plane this run starts must hand a paired Companion.
 *
 * The app carries no push project of its own — it asks the deployment it pairs with — so the harness
 * has to answer, and has to answer completely: the endpoint offers all four values or none, because a
 * partial answer registers the app somewhere the sender cannot reach. Missing values fail here, loudly,
 * rather than two minutes later as an OTP that never arrives.
 */
/**
 * Locate the Android client configuration the Companion build already consumes, and read the four
 * settings out of it.
 *
 * This exists because the relay run CANNOT proceed without building the Companion, and the Companion
 * cannot be built without that configuration — so on any machine where this gate can run at all, the
 * values are already present. Requiring a human to copy four fields out of a file the build reads
 * anyway is a step whose only possible outcomes are "done from memory" or "forgotten", and forgotten
 * is what turns a mandatory gate into a question asked of whoever is nearest.
 *
 * The file is found by its STRUCTURE, never by its name: which push vendor a deployment uses decides
 * what that file is called, and this repository does not name vendors. Set
 * COMPANION_PUSH_CLIENT_CONFIG to point at it directly when it lives outside the build tree.
 */
function readAndroidClientConfig() {
  const explicit = process.env.COMPANION_PUSH_CLIENT_CONFIG?.trim();
  const candidates = [];
  if (explicit) {
    candidates.push(path.resolve(ROOT, explicit));
  } else {
    // The Android flavor source sets, which is where a build-time client configuration belongs.
    const sourceSets = path.join(ROOT, 'companion/android/app/src');
    let flavors = [];
    try {
      flavors = fs.readdirSync(sourceSets, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch { /* no Android source tree here */ }
    for (const flavor of flavors) {
      let files = [];
      try {
        files = fs.readdirSync(path.join(sourceSets, flavor))
          .filter((name) => name.endsWith('.json'));
      } catch { continue; }
      for (const name of files) candidates.push(path.join(sourceSets, flavor, name));
    }
  }

  for (const candidate of candidates) {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(candidate, 'utf8'));
    } catch { continue; }
    // Match the package this run actually installs. Build flavors carry DIFFERENT application ids, and
    // each flavor's configuration registers only its own — hand the app an id belonging to a sibling
    // flavor and it registers somewhere the sender cannot reach, which surfaces as a phone that never
    // wakes rather than as an error. Taking whichever file happened to be read first would make that
    // depend on directory order.
    const client = (parsed?.client ?? []).find(
      (entry) => entry?.client_info?.android_client_info?.package_name === PKG,
    );
    if (!client) continue;
    const settings = {
      COMPANION_PUSH_PROJECT_ID: parsed?.project_info?.project_id,
      COMPANION_PUSH_CLIENT_SENDER_ID: parsed?.project_info?.project_number,
      COMPANION_PUSH_CLIENT_APP_ID: client?.client_info?.mobilesdk_app_id,
      COMPANION_PUSH_CLIENT_API_KEY: client?.api_key?.[0]?.current_key,
    };
    // All four or none — a partial read is exactly the half-registered state this guards against.
    if (Object.values(settings).every((value) => typeof value === 'string' && value.length > 0)) {
      return { source: candidate, settings };
    }
  }
  return null;
}

function requireCompanionPushClient() {
  const client = {
    COMPANION_PUSH_PROJECT_ID: process.env.COMPANION_PUSH_PROJECT_ID?.trim(),
    COMPANION_PUSH_CLIENT_APP_ID: process.env.COMPANION_PUSH_CLIENT_APP_ID?.trim(),
    COMPANION_PUSH_CLIENT_API_KEY: process.env.COMPANION_PUSH_CLIENT_API_KEY?.trim(),
    COMPANION_PUSH_CLIENT_SENDER_ID: process.env.COMPANION_PUSH_CLIENT_SENDER_ID?.trim(),
  };
  if (Object.values(client).some((value) => !value)) {
    const derived = readAndroidClientConfig();
    if (derived) {
      for (const [name, value] of Object.entries(derived.settings)) {
        if (!client[name]) client[name] = value;
      }
      // Name the file, never the values: they are this deployment's identity.
      log(`relay: push client settings read from ${path.relative(ROOT, derived.source)}`);
    }
  }
  const missing = Object.entries(client).filter(([, value]) => !value).map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(
      `COMPANION_RELAY needs ${missing.join(', ')}. The Companion asks this run's control plane which `
      + 'push project to register with, and it answers all four values or none — so without them the '
      + 'app never registers, no wake is delivered, and the run fails later as an unexplained timeout. '
      + 'These are normally read straight out of the Android client configuration in the Companion '
      + 'build tree; set COMPANION_PUSH_CLIENT_CONFIG to that file, or put the four values in .env.',
    );
  }
  return client;
}

const children = [];
let pg, sql, webServer, webBrowser;
const log = (...a) => console.log('[e2e]', ...a);

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

const WEB_CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};

/** Serve the built operator console and proxy its API calls to this run's control plane. This is the same
 * front-door behavior used by run-e2e-web.mjs, kept in-process so the web and Android clients share this
 * run's database, pairing request, and revocation state. */
async function startWebFrontDoor() {
  if (!fs.existsSync(path.join(WEB_DIST, 'index.html'))) {
    throw new Error(`web build missing at ${WEB_DIST}/index.html`);
  }
  webServer = http.createServer((req, res) => {
    const requestUrl = req.url || '/';
    if (requestUrl.startsWith('/api/') || requestUrl === '/health') {
      const proxy = http.request(
        {
          host: '127.0.0.1',
          port: P.cp,
          method: req.method,
          path: requestUrl,
          headers: { ...req.headers, host: `127.0.0.1:${P.cp}` },
        },
        (proxyResponse) => {
          res.writeHead(proxyResponse.statusCode || 502, proxyResponse.headers);
          proxyResponse.pipe(res);
        },
      );
      proxy.on('error', () => {
        res.writeHead(502);
        res.end('proxy error');
      });
      req.pipe(proxy);
      return;
    }
    const cleanPath = decodeURIComponent(requestUrl.split('?')[0]);
    let file = path.join(WEB_DIST, cleanPath);
    if (
      !file.startsWith(WEB_DIST)
      || cleanPath === '/'
      || !fs.existsSync(file)
      || fs.statSync(file).isDirectory()
    ) {
      file = path.join(WEB_DIST, 'index.html');
    }
    fs.readFile(file, (error, body) => {
      if (error) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      res.writeHead(200, {
        'content-type': WEB_CONTENT_TYPES[path.extname(file)] || 'application/octet-stream',
      });
      res.end(body);
    });
  });
  await new Promise((resolve, reject) => {
    webServer.once('error', reject);
    webServer.listen(P.web, '127.0.0.1', resolve);
  });
  await waitForHealth('web console', `${WEB}/health`);
}

async function launchWebBrowser() {
  const require = createRequire(path.join(ROOT, 'apps/engine/package.json'));
  const { chromium } = require('playwright');
  const launchAttempts = [
    { channel: 'chrome', args: ['--no-sandbox'] },
    { args: ['--no-sandbox'] },
  ];
  let lastError;
  for (const options of launchAttempts) {
    try {
      webBrowser = await chromium.launch({ ...options, headless: true });
      return webBrowser;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`could not launch Chrome or Chromium for the web-client E2E: ${lastError?.message ?? lastError}`);
}

let token;
async function api(method, p, body, asToken) {
  // `asToken` sends a specific credential instead of the operator's — the relay device answers the readiness
  // handshake as itself, because that route takes a paired device and nothing else.
  const bearer = asToken ?? token;
  const r = await fetch(`${CP}${p}`, {
    method,
    headers: { 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json; try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  return { status: r.status, json };
}

/** Watch the shared DB for the crawl's session; when the engine requests OTP, capture the bank's
 *  "SMS" and submit the code via the real route — exactly what a relay would do. */
async function runRelay(connectionId) {
  const deadline = Date.now() + 300000;
  let sessionId = null, submitted = false, smsBody = null;
  const statuses = new Set();
  const attemptedSmsEpisodes = new Set();
  // The engine will not navigate to the bank until a relay confirms, on the record, that it is present and
  // can receive an SMS right now — a configured-but-absent phone must never be mistaken for a live one. This
  // relay stands in for that phone, so it pairs a real device and answers that handshake with its token.
  const relayDeviceToken = await pairInProcessRelayDevice(connectionId);
  const acknowledgedEpisodes = new Set();
  while (Date.now() < deadline) {
    if (!sessionId) {
      const rows = await sql`select id from sessions where connection_id = ${connectionId} order by started_at desc limit 1`;
      if (rows[0]) { sessionId = rows[0].id; log('relay: tracking session', sessionId); }
    }
    if (sessionId) {
      const [s] = await sql`select status, otp_requested, otp, otp_request_epoch from sessions where id = ${sessionId}`;
      if (s) {
        statuses.add(s.status);
        // Answer the readiness handshake as soon as the engine arms an OTP episode, and again for each new
        // episode: a re-armed request is a fresh question about whether the phone is still there.
        if (s.otp_requested && !acknowledgedEpisodes.has(s.otp_request_epoch ?? 0)) {
          acknowledgedEpisodes.add(s.otp_request_epoch ?? 0);
          const ready = await api(
            'POST',
            `/api/sessions/${sessionId}/relay-status`,
            { smsPermission: true, ready: true },
            relayDeviceToken,
          );
          log(`relay: POST /sessions/${sessionId}/relay-status { smsPermission: true } -> ${ready.status}`);
        }
        if (
          !submitted
          && s.status === 'waiting_for_otp'
          && s.otp_requested
          && !s.otp
        ) {
          // LLM-FIRST relay: we do NOT parse the code here. We hand the control-plane the RAW SMS body (+ the
          // sender, which it re-binds to the institution's otpSenderPattern, + the request epoch) and let
          // Gemini extract the code server-side — exactly what the companion now does. `sender` is SMS_FROM,
          // the literal the institution's pattern is pinned to, so the server-side sender binding passes.
          const sms = await (await fetch(`${BANK}/_relay/last-sms`)).json();
          if (
            typeof sms.body !== 'string'
            || sms.body.trim() === ''
            || typeof sms.from !== 'string'
            || sms.from.trim() === ''
          ) {
            await sleep(250);
            continue;
          }
          const episodeKey = `${s.otp_request_epoch ?? 0}\0${sms.body}`;
          if (attemptedSmsEpisodes.has(episodeKey)) {
            await sleep(250);
            continue;
          }
          attemptedSmsEpisodes.add(episodeKey);
          smsBody = sms.body; // kept for the post-crawl OTP-leak assertions (we derive the code from it there)
          log(`relay: bank sent an SMS from ${sms.from}; relaying its raw body for LLM extraction`);
          const r = await api('POST', `/api/sessions/${sessionId}/otp`, {
            smsBody: sms.body, sender: SMS_FROM, otpRequestEpoch: s.otp_request_epoch ?? 0,
          });
          log(`relay: POST /sessions/${sessionId}/otp { smsBody, sender, otpRequestEpoch } -> ${r.status} ${JSON.stringify(r.json)}`);
          // 202 = a code was LLM-extracted + submitted; 200 = no code found (would stay waiting). Only 202 is a real submit.
          if (r.status === 202) submitted = true;
          else if (![200, 409].includes(r.status)) {
            throw new Error(
              `relay submission failed unexpectedly: ${r.status} ${JSON.stringify(r.json)}`,
            );
          }
        }
        if (['completed', 'failed', 'cancelled'].includes(s.status)) break;
      }
    }
    await sleep(1000);
  }
  return { sessionId, statuses: [...statuses], submitted, smsBody };
}

/**
 * The floor every self-hoster gets: no phone paired at all, and the operator reads the code off their own
 * handset and types it into the console. Nothing here pairs a device or answers the readiness handshake,
 * because there is nothing that could — which is the whole point. A crawl that waits for a confirmation
 * only a paired phone can send would never reach waiting_for_otp, and this run would time out.
 */
async function runManualOtpRelay(connectionId) {
  const deadline = Date.now() + 300000;
  let sessionId = null, submitted = false, smsBody = null;
  const statuses = new Set();
  while (Date.now() < deadline) {
    if (!sessionId) {
      const rows = await sql`select id from sessions where connection_id = ${connectionId} order by started_at desc limit 1`;
      if (rows[0]) { sessionId = rows[0].id; log('manual: tracking session', sessionId); }
    }
    if (sessionId) {
      const [s] = await sql`select status, otp_requested, otp from sessions where id = ${sessionId}`;
      if (s) {
        statuses.add(s.status);
        if (!submitted && s.status === 'waiting_for_otp' && s.otp_requested && !s.otp) {
          const sms = await (await fetch(`${BANK}/_relay/last-sms`)).json();
          if (typeof sms.body !== 'string' || sms.body.trim() === '') {
            await sleep(250);
            continue;
          }
          smsBody = sms.body;
          // The operator's eyes, in code: read the digits out of the message and type them in.
          const code = (sms.body.match(/\d{4,10}/g) ?? []).sort((a, b) => b.length - a.length)[0];
          if (!code) throw new Error(`no code could be read from the bank's SMS: ${sms.body}`);
          const r = await api('POST', `/api/sessions/${sessionId}/otp`, { code });
          log(`manual: POST /sessions/${sessionId}/otp { code } -> ${r.status} ${JSON.stringify(r.json)}`);
          if (r.status === 202) submitted = true;
          else if (r.status !== 409) {
            throw new Error(`manual submission failed unexpectedly: ${r.status} ${JSON.stringify(r.json)}`);
          }
        }
        if (['completed', 'failed', 'cancelled'].includes(s.status)) break;
      }
    }
    await sleep(1000);
  }
  return { sessionId, statuses: [...statuses], submitted, smsBody, via: 'manual-console' };
}

// ─── Companion relay (real device path) ─────────────────────────────────────────────────────────────
// COMPANION_RELAY=1 routes the 2FA code through the actual Accrawl Companion app on an Android emulator
// instead of the in-process Node relay above: the harness pairs a device, configures + launches the
// companion on the emulator, and an SMS bridge injects the bank's OTP "SMS" via the emulator console. The
// companion captures it and forwards the raw body through the device-authenticated OTP route. The
// control-plane extracts and submits the code — proving the full phone-relay path end to end.
const SERIAL = process.env.EMULATOR_SERIAL;
const LEASE_SCRIPT = process.env.EMULATOR_LEASE_SCRIPT;
const MAIN_ACTIVITY = 'app.accrawl.accrawl_companion.MainActivity';
const PKG = process.env.COMPANION_PKG || 'app.accrawl.accrawl_companion.qa';
const QA_APK = process.env.COMPANION_QA_APK || path.join(
  ROOT,
  'companion/build/app/outputs/flutter-apk/app-qa-debug.apk',
);
const SECURE_PKG = 'app.accrawl.accrawl_companion';
const SECURE_APK = process.env.COMPANION_SECURE_APK || path.join(
  ROOT,
  'companion/build/app/outputs/flutter-apk/app-secure-debug.apk',
);
const DEVICE_PIN = process.env.COMPANION_DEVICE_PIN || '2468';
// The number the bank's "SMS" arrives FROM at the emulator. The fake bank uses an alphanumeric sender
// ("NORTHWIND"), but `emu sms send` only accepts a numeric originating address, so the bridge delivers it
// from this fixed number — and the institution's otpSenderPattern (below) is pinned to match it, so the
// companion's sender-binding check passes (the relay only fires when the SMS sender matches the bank).
const SMS_FROM = process.env.SMS_FROM || '18005550123';

function leaseAdb(args, encoding = 'utf8') {
  return new Promise((resolve, reject) => {
    if (!SERIAL) {
      reject(new Error('COMPANION_RELAY requires EMULATOR_SERIAL from the current emulator lease'));
      return;
    }
    if (!LEASE_SCRIPT) {
      reject(new Error('COMPANION_RELAY requires EMULATOR_LEASE_SCRIPT so every adb action is ownership-checked'));
      return;
    }
    execFile(
      LEASE_SCRIPT,
      ['adb', '--', ...args],
      { encoding, maxBuffer: 16 << 20 },
      (error, stdout, stderr) => error
        ? reject(new Error(String(stderr || error.message)))
        : resolve(stdout),
    );
  });
}

async function adb(args) {
  const output = await leaseAdb(args);
  return String(output || '').trim();
}

async function assertCurrentEmulatorLease() {
  if (!LEASE_SCRIPT || !SERIAL) {
    throw new Error('companion E2E requires the current emulator lease');
  }
  const leasedSerial = await new Promise((resolve, reject) => {
    execFile(
      LEASE_SCRIPT,
      ['mine'],
      { maxBuffer: 1 << 20 },
      (error, stdout, stderr) => error
        ? reject(new Error(String(stderr || error.message)))
        : resolve(String(stdout || '').trim()),
    );
  });
  if (leasedSerial !== SERIAL) {
    throw new Error(
      `EMULATOR_SERIAL ${SERIAL} does not match the current lease ${leasedSerial || '(none)'}`,
    );
  }
}

function xmlDecode(value) {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replaceAll('&amp;', '&');
}

async function uiXml() {
  const hierarchyPath = '/sdcard/accrawl-window.xml';
  const deadline = Date.now() + 5_000;
  let lastError;
  do {
    try {
      // Android can report a successful dump before the automation service has
      // created its output file during app cold start. Remove the prior file so
      // an unsuccessful dump can never return stale UI from the previous state.
      await adb(['shell', 'rm', '-f', hierarchyPath]);
      const dumpOutput = await adb(['shell', 'uiautomator', 'dump', hierarchyPath]);
      const xml = await adb(['shell', 'cat', hierarchyPath]);
      if (!xml.includes('<hierarchy')) {
        throw new Error(`invalid hierarchy output (${dumpOutput || 'no dump status'})`);
      }
      return xml;
    } catch (error) {
      lastError = error;
      if (Date.now() < deadline) await sleep(250);
    }
  } while (Date.now() < deadline);
  throw new Error(
    `Android UI hierarchy was not produced: ${lastError?.message ?? lastError}`,
  );
}

async function waitForUiText(text, timeoutMs = 30_000, pollIntervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  let lastHierarchyError = '';
  while (Date.now() < deadline) {
    try {
      last = await uiXml();
      lastHierarchyError = '';
      if (xmlDecode(last).includes(text)) return last;
    } catch (error) {
      lastHierarchyError = error?.message ?? String(error);
    }
    await sleep(pollIntervalMs);
  }
  const evidence = last
    ? `last hierarchy: ${last.slice(0, 1_000)}`
    : `hierarchy unavailable: ${lastHierarchyError || 'no hierarchy or error returned'}`;
  throw new Error(`companion UI did not show "${text}" (${evidence})`);
}

async function waitForUiTextWithScroll(text, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    last = xmlDecode(await uiXml());
    if (last.includes(text)) return last;
    await swipeUiUp();
    await sleep(500);
  }
  throw new Error(
    `companion UI did not show "${text}" after scrolling (last hierarchy: ${last.slice(0, 1_000)})`,
  );
}

async function waitForUiTextToDisappear(text, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    last = xmlDecode(await uiXml());
    if (!last.includes(text)) return last;
    await sleep(500);
  }
  throw new Error(
    `companion UI still showed "${text}" (last hierarchy: ${last.slice(0, 1_000)})`,
  );
}

async function assertUiTextRemainsVisible(
  text,
  durationMs,
  forbiddenText = null,
) {
  const deadline = Date.now() + durationMs;
  while (Date.now() < deadline) {
    const last = xmlDecode(await uiXml());
    if (!last.includes(text)) {
      throw new Error(
        `companion UI stopped showing "${text}" before the expected inactivity deadline`,
      );
    }
    if (forbiddenText && last.includes(forbiddenText)) {
      throw new Error(
        `companion UI showed "${forbiddenText}" before the expected inactivity deadline`,
      );
    }
    const remaining = deadline - Date.now();
    if (remaining > 0) await sleep(Math.min(15_000, remaining));
  }
  const final = xmlDecode(await uiXml());
  if (!final.includes(text)) {
    throw new Error(
      `companion UI stopped showing "${text}" at the expected inactivity deadline`,
    );
  }
  if (forbiddenText && final.includes(forbiddenText)) {
    throw new Error(
      `companion UI showed "${forbiddenText}" at the expected inactivity deadline`,
    );
  }
  return final;
}

async function waitForNotificationText(text, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    last = await adb(['shell', 'dumpsys', 'notification', '--noredact']);
    if (last.includes(text)) return last;
    await sleep(500);
  }
  throw new Error(
    `Android notification service did not contain "${text}" (last dump: ${last.slice(0, 1_000)})`,
  );
}

async function waitForNotificationTextToDisappear(text, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    last = await adb(['shell', 'dumpsys', 'notification', '--noredact']);
    if (!last.includes(text)) return last;
    await sleep(500);
  }
  throw new Error(
    `Android notification service still contained "${text}" (last dump: ${last.slice(0, 1_000)})`,
  );
}

function nodeBounds(xml, text) {
  for (const node of xml.match(/<node\b[^>]*>/g) ?? []) {
    if (!xmlDecode(node).includes(text)) continue;
    const match = node.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
    if (match) {
      return {
        x: Math.round((Number(match[1]) + Number(match[3])) / 2),
        y: Math.round((Number(match[2]) + Number(match[4])) / 2),
      };
    }
  }
  return null;
}

async function clearMessagesNotifications() {
  // The emulator's default Messages app keeps every reinjected carrier SMS in one expanded notification.
  // Stop that test-only UI before evidence capture so it cannot cover the Accrawl event being asserted. This
  // never clears Android's SMS store or Accrawl's independent broadcast receiver, so the product path remains
  // the same; before delivery it removes stale test-run alerts, and after delivery it removes only Messages UI.
  await adb(['shell', 'am', 'force-stop', 'com.google.android.apps.messaging']);
  await sleep(500);
}

function exactClickableNodeBounds(xml, text) {
  for (const rawNode of xml.match(/<node\b[^>]*>/g) ?? []) {
    const node = xmlDecode(rawNode);
    const description = node.match(/\bcontent-desc="([^"]*)"/)?.[1] ?? '';
    const visibleText = node.match(/\btext="([^"]*)"/)?.[1] ?? '';
    const semanticLabels = description.split(/\r?\n/);
    if (!semanticLabels.includes(text) && visibleText !== text) continue;
    if (!node.includes('clickable="true"') || !node.includes('enabled="true"')) {
      continue;
    }
    const match = node.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
    if (match) {
      return {
        x: Math.round((Number(match[1]) + Number(match[3])) / 2),
        y: Math.round((Number(match[2]) + Number(match[4])) / 2),
      };
    }
  }
  return null;
}

function firstNodeBoundsMatching(xml, predicate) {
  for (const node of xml.match(/<node\b[^>]*>/g) ?? []) {
    if (!predicate(xmlDecode(node))) continue;
    const match = node.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
    if (match) {
      return {
        x: Math.round((Number(match[1]) + Number(match[3])) / 2),
        y: Math.round((Number(match[2]) + Number(match[4])) / 2),
      };
    }
  }
  return null;
}

function editableNodeBounds(xml, index) {
  const editableNodes = (xml.match(/<node\b[^>]*>/g) ?? []).filter(
    (node) => (
      node.includes('class="android.widget.EditText"')
      && node.includes('clickable="true"')
      && node.includes('enabled="true"')
    ),
  );
  const node = editableNodes[index];
  const match = node?.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
  if (!match) return null;
  return {
    x: Math.round((Number(match[1]) + Number(match[3])) / 2),
    y: Math.round((Number(match[2]) + Number(match[4])) / 2),
  };
}

async function swipeUiUp() {
  const output = await adb(['shell', 'wm', 'size']);
  const sizes = [...output.matchAll(/(\d+)x(\d+)/g)];
  const size = sizes.at(-1);
  if (!size) throw new Error(`could not determine emulator screen size: ${output}`);
  const width = Number(size[1]);
  const height = Number(size[2]);
  await adb([
    'shell',
    'input',
    'swipe',
    String(Math.round(width / 2)),
    String(Math.round(height * 0.75)),
    String(Math.round(width / 2)),
    String(Math.round(height * 0.3)),
    '250',
  ]);
}

async function tapUiText(text, timeoutMs = 30_000, scroll = false) {
  const deadline = Date.now() + timeoutMs;
  let lastHierarchyError = '';
  let lastClickableLabels = '';
  let scrollsRemaining = scroll ? 4 : 0;
  while (Date.now() < deadline) {
    try {
      const xml = await uiXml();
      lastHierarchyError = '';
      lastClickableLabels = (xml.match(/<node\b[^>]*clickable="true"[^>]*>/g) ?? [])
        .map((node) => xmlDecode(node))
        .join(' | ')
        .slice(0, 4_000);
      const bounds = exactClickableNodeBounds(xml, text);
      if (bounds) {
        await adb(['shell', 'input', 'tap', String(bounds.x), String(bounds.y)]);
        return;
      }
      if (scrollsRemaining > 0) {
        await swipeUiUp();
        scrollsRemaining -= 1;
      }
    } catch (error) {
      lastHierarchyError = error?.message ?? String(error);
    }
    await sleep(500);
  }
  const evidence = lastHierarchyError
    ? `: Android hierarchy remained unavailable (${lastHierarchyError})`
    : `: clickable nodes were ${lastClickableLabels || '(none)'}`;
  throw new Error(`could not tap companion UI text "${text}"${evidence}`);
}

async function enterText(label, value, editableIndex) {
  const deadline = Date.now() + 30_000;
  let scrollsRemaining = 4;
  let bounds = null;
  while (Date.now() < deadline && !bounds) {
    const xml = await uiXml();
    bounds = nodeBounds(xml, label) ?? editableNodeBounds(xml, editableIndex);
    if (!bounds && scrollsRemaining > 0) {
      await swipeUiUp();
      scrollsRemaining -= 1;
    }
    if (!bounds) await sleep(500);
  }
  if (!bounds) throw new Error(`could not find companion input "${label}"`);
  await adb(['shell', 'input', 'tap', String(bounds.x), String(bounds.y)]);
  await adb(['shell', 'input', 'keyevent', 'KEYCODE_MOVE_END']);
  await adb(['shell', 'input', 'text', value]);
}

async function completeDeviceCredentialPrompt() {
  const deadline = Date.now() + 20_000;
  let last = '';
  let lastHierarchyError = '';
  while (Date.now() < deadline) {
    try {
      last = xmlDecode(await uiXml());
      lastHierarchyError = '';
    } catch (error) {
      lastHierarchyError = error?.message ?? String(error);
      await sleep(250);
      continue;
    }
    const useCredential = [
      'Use PIN',
      'Use screen lock',
      'Use device PIN',
    ].map((label) => nodeBounds(last, label)).find(Boolean);
    if (useCredential) {
      await adb([
        'shell',
        'input',
        'tap',
        String(useCredential.x),
        String(useCredential.y),
      ]);
      await sleep(500);
      continue;
    }

    const passwordField = firstNodeBoundsMatching(
      last,
      (node) => node.includes('class="android.widget.EditText"')
        && node.includes('password="true"'),
    );
    const pinScreen = [
      'Enter PIN',
      'Enter your PIN',
      'Confirm your PIN',
      'Confirm your screen lock',
      "Verify it's you",
      'Verify it’s you',
    ].some((label) => last.includes(label));
    if (passwordField || pinScreen) {
      if (passwordField) {
        await adb([
          'shell',
          'input',
          'tap',
          String(passwordField.x),
          String(passwordField.y),
        ]);
      }
      await adb(['shell', 'input', 'text', DEVICE_PIN]);
      await adb(['shell', 'input', 'keyevent', 'KEYCODE_ENTER']);
      return true;
    }
    await sleep(400);
  }
  throw new Error(
    `Android did not present a supported screen-lock credential prompt `
    + (
      last
        ? `(last hierarchy: ${last.slice(0, 4_000)})`
        : `(hierarchy unavailable: ${lastHierarchyError || 'no hierarchy returned'})`
    ),
  );
}

async function screenshot(name) {
  const output = path.join(TMP, `${name}.png`);
  const data = await leaseAdb(['exec-out', 'screencap', '-p'], 'buffer');
  fs.writeFileSync(output, data);
  log('captured rendered companion state', output);
  return output;
}

async function createConnectionThroughWeb() {
  await startWebFrontDoor();
  const browser = await launchWebBrowser();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', (error) => log('web page error:', error.message));
  await page.addInitScript((operatorToken) => {
    localStorage.setItem('accrawl.token', operatorToken);
  }, token);

  await page.goto(`${WEB}/institutions`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: 'Institutions' }).waitFor();
  const institutionForm = page.locator('form').filter({
    has: page.getByRole('button', { name: 'Add institution' }),
  });
  await institutionForm.getByPlaceholder('e.g. First National Bank').fill('Northwind Bank');
  await institutionForm.getByPlaceholder('https://login.yourbank.com/').fill(
    `http://${BANK_HOST}:${P.bank}/login`,
  );
  await institutionForm.getByRole('checkbox', {
    name: 'Asks for a 2FA code (SMS or email) at sign-in',
  }).check();
  await institutionForm.getByPlaceholder('e.g. FNBANK').fill(SMS_FROM);
  await institutionForm.getByRole('textbox', {
    name: 'Instructions for the crawler (optional)',
    exact: true,
  }).fill(
    'Sign in with the provided username and password. You will then be asked for a 6-digit '
    + 'two-factor code sent by SMS — request the OTP and enter it. After login, open the accounts '
    + 'dashboard and extract every account (name, masked number, balance, currency) and every recent '
    + 'transaction (date, description, amount).',
  );
  await institutionForm.getByRole('button', { name: 'Add institution' }).click();
  const institutionRow = page.getByRole('row').filter({ hasText: 'Northwind Bank' });
  await institutionRow.waitFor();
  const [institution] = await sql`
    select id, canonical_domain
      from institutions
      where name = 'Northwind Bank'
      order by created_at desc
      limit 1`;
  if (!institution || institution.canonical_domain !== BANK_HOST) {
    throw new Error(
      `web institution form stored an unexpected canonical domain: ${JSON.stringify(institution)}`,
    );
  }

  await page.goto(`${WEB}/connections`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: 'Connections' }).waitFor();
  const connectionForm = page.locator('form').filter({
    has: page.getByRole('button', { name: 'Add connection' }),
  });
  await connectionForm.getByRole('combobox', {
    name: 'Institution *',
    exact: true,
  }).selectOption({ label: 'Northwind Bank' });
  await connectionForm.getByRole('textbox', {
    name: 'Username *',
    exact: true,
  }).fill(CREDS.username);
  await connectionForm.getByLabel('Password *', { exact: true }).fill(CREDS.password);
  await connectionForm.getByRole('button', { name: 'Add connection' }).click();
  await page.getByText(
    'Connection added. Confirm the sign-in domain below, then start your first crawl.',
    { exact: true },
  ).waitFor();
  const [connection] = await sql`
    select id, login_domain_verified
      from connections
      where institution_id = ${institution.id}
      order by created_at desc
      limit 1`;
  if (!connection || connection.login_domain_verified) {
    throw new Error(
      `web connection form did not create the expected unverified connection: ${JSON.stringify(connection)}`,
    );
  }

  const connectionRow = page.getByRole('row').filter({ hasText: 'Northwind Bank' });
  // The POST response can complete just before React commits the refreshed table. Wait for the actual row
  // rather than sampling the DOM once and turning a healthy create into a timing-dependent E2E failure.
  await connectionRow.waitFor({ state: 'visible', timeout: 30_000 });
  const rowCount = await connectionRow.count();
  if (rowCount !== 1) {
    throw new Error(`web connections page rendered ${rowCount} Northwind rows, expected 1`);
  }
  await connectionRow.getByRole('button', { name: 'Confirm domain' }).click();
  const confirmationDialog = page.getByRole('dialog');
  await confirmationDialog.getByPlaceholder(BANK_HOST).fill(BANK_HOST);
  await confirmationDialog.getByRole('button', {
    name: 'Confirm domain',
    exact: true,
  }).click();
  await page.getByText(
    'Sign-in domain confirmed — you can crawl now.',
    { exact: true },
  ).waitFor();
  const [verified] = await sql`
    select login_domain_verified
      from connections
      where id = ${connection.id}`;
  if (!verified?.login_domain_verified) {
    throw new Error('web domain-confirmation flow did not verify the connection');
  }

  const output = path.join(TMP, 'web-connection-ready.png');
  await page.screenshot({ path: output, fullPage: true });
  log('web console created and domain-verified the bank connection', output);
  return { connectionId: connection.id, page };
}

async function triggerCrawlThroughWeb(connectionId, page) {
  await page.goto(`${WEB}/connections`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: 'Connections' }).waitFor();
  const connectionRow = page.getByRole('row').filter({ hasText: 'Northwind Bank' });
  await connectionRow.waitFor({ state: 'visible', timeout: 30_000 });
  const responsePromise = page.waitForResponse((response) => (
    response.request().method() === 'POST'
    && new URL(response.url()).pathname === `/api/connections/${connectionId}/crawl`
  ));
  await connectionRow.getByRole('button', { name: 'Crawl now' }).click();
  const response = await responsePromise;
  const body = await response.text();
  let json = null;
  try {
    json = body ? JSON.parse(body) : null;
  } catch {
    json = { raw: body };
  }
  return { status: response.status(), json };
}

async function createPairingThroughWeb(connectionId, page) {
  await page.goto(`${WEB}/devices`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: 'Companion', exact: true }).waitFor();
  const pairingForm = page.locator('form').filter({
    has: page.getByRole('button', { name: 'Create pairing request' }),
  });
  await pairingForm.getByPlaceholder('For example, Pixel 8').fill('e2e-emulator');
  const connectionChoice = pairingForm.getByRole('checkbox');
  const choiceCount = await connectionChoice.count();
  if (choiceCount !== 1) {
    throw new Error(`web companion page rendered ${choiceCount} connection choices, expected 1`);
  }
  await connectionChoice.check();
  await pairingForm.getByRole('button', { name: 'Create pairing request' }).click();
  const pairingCodeNode = page.locator('code').filter({ hasText: /^acpair_/ }).first();
  await pairingCodeNode.waitFor();
  const pairingCode = (await pairingCodeNode.textContent())?.trim();
  if (!pairingCode || !/^acpair_[A-Za-z0-9_-]{40,}$/.test(pairingCode)) {
    throw new Error('web companion page did not render the short-lived pairing code');
  }
  const [intent] = await sql`
    select id, connection_grants
    from device_pairing_intents
    where name = 'e2e-emulator'
    order by created_at desc
    limit 1`;
  if (!intent || intent.connection_grants.length !== 1 || intent.connection_grants[0] !== connectionId) {
    throw new Error('web companion page did not create an intent with the selected connection');
  }
  const output = path.join(TMP, 'web-companion-pairing-request.png');
  await page.screenshot({ path: output, fullPage: true });
  log('web console created the exact-connection pairing request', output);
  return { id: intent.id, pairingCode, page };
}

async function validateWebFinancialData(page) {
  await page.goto(`${WEB}/accounts`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: 'Accounts' }).waitFor();

  for (const account of TRUTH.accounts) {
    await page.getByText(account.name, { exact: true }).waitFor();
    const formatted = new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: account.currency,
    }).format(account.balance);
    await page.getByText(formatted, { exact: true }).waitFor();
  }

  const loadingCount = await page.getByText('Loading your accounts…', { exact: true }).count();
  if (loadingCount !== 0) {
    throw new Error('web Accounts page remained in its loading state after the API became idle');
  }

  const seenTransactions = new Set();
  const collectVisibleTransactions = async () => {
    for (const transaction of TRUTH.transactions) {
      if (await page.getByText(transaction.description, { exact: true }).count()) {
        seenTransactions.add(transaction.description);
      }
    }
  };

  const unlinkedButton = page.getByRole('button', {
    name: 'Transactions not linked to an account',
  });
  if (await unlinkedButton.count()) {
    await unlinkedButton.click();
    const unlinkedPanel = page.locator('.panel').filter({
      has: page.getByRole('heading', {
        name: 'Transactions not linked to an account',
      }),
    });
    await unlinkedPanel.waitFor();
    await unlinkedPanel.getByLabel('loading').waitFor({ state: 'detached' });
    await collectVisibleTransactions();
  }
  for (const account of TRUTH.accounts) {
    if (seenTransactions.size === TRUTH.transactions.length) break;
    await page.getByText(account.name, { exact: true }).click();
    const transactionPanel = page.locator('.panel').filter({
      has: page.getByRole('heading', {
        name: `${account.name} — transactions`,
      }),
    });
    await transactionPanel.waitFor();
    await transactionPanel.getByLabel('loading').waitFor({ state: 'detached' });
    await collectVisibleTransactions();
  }
  const missing = TRUTH.transactions
    .map((transaction) => transaction.description)
    .filter((description) => !seenTransactions.has(description));
  if (missing.length) {
    throw new Error(`web Accounts page did not render extracted transactions: ${missing.join(', ')}`);
  }

  const output = path.join(TMP, 'web-accounts-extracted.png');
  await page.screenshot({ path: output, fullPage: true });
  log('web Accounts page rendered the extracted fake-bank balances and transactions', output);
}

async function validateSecureCompanionBuild() {
  await adb(['install', '-r', SECURE_APK]);
  await adb(['shell', 'pm', 'clear', SECURE_PKG]).catch(() => {});
  await adb(['shell', 'am', 'force-stop', SECURE_PKG]);
  await adb(['shell', 'am', 'start', '-n', `${SECURE_PKG}/${MAIN_ACTIVITY}`]);
  await waitForUiText('Pair this phone', 60_000);
  const windowDump = await adb(['shell', 'dumpsys', 'window', 'windows']);
  const windowStart = windowDump.indexOf(`${SECURE_PKG}/`);
  const windowState = windowStart >= 0
    ? windowDump.slice(windowStart, windowStart + 8_000)
    : '';
  if (
    !/\bfl=[^\r\n]*\b(?:FLAG_SECURE|SECURE)\b/.test(windowState)
    && !/\bfl=0x0*2000\b/i.test(windowState)
  ) {
    throw new Error('secure companion window is missing FLAG_SECURE');
  }
  log('secure companion build launched with FLAG_SECURE');
}

/**
 * Pair a virtual relay device through the real pairing API.
 *
 * The engine will not begin an OTP crawl until a relay confirms, on the record, that it is present and able
 * to receive an SMS right now — a configured-but-unavailable phone must not be mistaken for one that can
 * catch the bank's code. The in-process relay stands in for that phone, so it has to be a real paired device
 * with a real device token, not an operator borrowing the route. Every step below is the product's own
 * pairing flow: intent → claim → operator approval → complete.
 */
async function pairInProcessRelayDevice(connectionId) {
  const intent = await api('POST', '/api/devices/pairing-intents', {
    name: 'e2e-in-process-relay',
    connectionGrants: [connectionId],
  });
  if (intent.status < 200 || intent.status >= 300) {
    throw new Error(`relay pairing intent failed: ${intent.status} ${JSON.stringify(intent.json)}`);
  }
  const claim = `acclaim_${crypto.randomBytes(32).toString('base64url')}`;
  const claimed = await api('POST', '/api/devices/pairing/claim', {
    pairingCode: intent.json.pairingCode,
    claim,
  });
  if (claimed.status < 200 || claimed.status >= 300 || !claimed.json?.verificationCode) {
    throw new Error(`relay pairing claim failed: ${claimed.status} ${JSON.stringify(claimed.json)}`);
  }
  const approval = await api('POST', `/api/devices/pairing-intents/${intent.json.id}/approve`);
  if (approval.status < 200 || approval.status >= 300) {
    throw new Error(`relay pairing approval failed: ${approval.status} ${JSON.stringify(approval.json)}`);
  }
  const completed = await api('POST', '/api/devices/pairing/complete', {
    pairingCode: intent.json.pairingCode,
    claim,
  });
  if (completed.status < 200 || completed.status >= 300 || !completed.json?.deviceToken) {
    // Never echo the body: on success it carries the device credential itself.
    throw new Error(`relay pairing completion failed: HTTP ${completed.status}`);
  }
  log(`relay: paired a virtual device for the readiness handshake`);
  return completed.json.deviceToken;
}

async function setupCompanion(connectionId, webPairing) {
  await assertCurrentEmulatorLease();
  let intent;
  if (webPairing) {
    intent = {
      status: 201,
      json: {
        id: webPairing.id,
        pairingCode: webPairing.pairingCode,
      },
    };
  } else {
    intent = await api('POST', '/api/devices/pairing-intents', {
      name: 'e2e-emulator',
      connectionGrants: [connectionId],
    });
    if (intent.status < 200 || intent.status >= 300) {
      throw new Error(`device pairing request failed: ${intent.status} ${JSON.stringify(intent.json)}`);
    }
  }
  // The emulator reaches the host's control-plane via the special alias 10.0.2.2. On some system images the
  // 10.0.2.2 NAT path is unreliable for the native HTTP stack (the Flutter Dart poller still works, but the
  // Kotlin NativeRelay/TunnelService can't open a socket); DEVICE_CP_BASE_URL lets the harness point the
  // device at the host through an `adb reverse` mapping (e.g. http://127.0.0.1:4102) instead.
  const baseUrl = process.env.DEVICE_CP_BASE_URL || `http://127.0.0.1:${P.cp}`;
  await adb(['install', '-r', QA_APK]);
  await adb(['reverse', `tcp:${P.cp}`, `tcp:${P.cp}`]);
  const lockResult = await adb(['shell', 'locksettings', 'set-pin', DEVICE_PIN]).catch(
    async () => adb(['shell', 'locksettings', 'set-pin', '--old', DEVICE_PIN, DEVICE_PIN]),
  );
  log('companion Android screen-lock PIN configured:', lockResult || 'ok');
  await adb(['shell', 'pm', 'clear', PKG]).catch(() => {});
  await adb(['shell', 'pm', 'grant', PKG, 'android.permission.RECEIVE_SMS']);
  await adb(['shell', 'pm', 'grant', PKG, 'android.permission.POST_NOTIFICATIONS']).catch(() => {});
  await adb(['shell', 'dumpsys', 'deviceidle', 'whitelist', `+${PKG}`]);
  await adb(['shell', 'am', 'force-stop', PKG]);
  await adb(['shell', 'am', 'start', '-n', `${PKG}/${MAIN_ACTIVITY}`]);
  await waitForUiText('Pair this phone', 60_000);
  await enterText('Console address', baseUrl, 0);
  await enterText('Pairing code', intent.json.pairingCode, 1);
  await tapUiText('Continue');

  const claimDeadline = Date.now() + 30_000;
  let claimed;
  while (Date.now() < claimDeadline) {
    const state = await api('GET', `/api/devices/pairing-intents/${intent.json.id}`);
    if (state.status === 200 && state.json.status === 'waiting_for_approval') {
      claimed = state.json;
      break;
    }
    await sleep(500);
  }
  if (!claimed?.verificationCode) throw new Error('companion did not claim the pairing request');
  await waitForUiText(claimed.verificationCode);
  if (webPairing) {
    await webPairing.page.getByText(claimed.verificationCode, { exact: true }).waitFor();
    const output = path.join(TMP, 'web-companion-verification-code.png');
    await webPairing.page.screenshot({ path: output, fullPage: true });
    await webPairing.page.getByRole('button', { name: 'Approve phone' }).click();
    await webPairing.page
      .getByText('Approved. Keep Accrawl Companion open while it finishes pairing.')
      .waitFor();
    log('web console compared and approved the phone', output);
  } else {
    const approval = await api('POST', `/api/devices/pairing-intents/${intent.json.id}/approve`);
    if (approval.status < 200 || approval.status >= 300) {
      throw new Error(`device approval failed: ${approval.status} ${JSON.stringify(approval.json)}`);
    }
  }

  await completeDeviceCredentialPrompt();
  await waitForUiText('No accounts yet', 60_000);
  const pairedAccountScreen = xmlDecode(await uiXml());
  if (pairedAccountScreen.includes('Unlock financial data')) {
    throw new Error('pairing authentication did not carry into the financial session');
  }
  await screenshot('companion-empty-accounts-light');
  await tapUiText('Transactions');
  await waitForUiText('No transactions yet');
  await screenshot('companion-empty-transactions-light');
  await tapUiText('Relay');
  await waitForUiText('System status');
  await waitForUiText('SMS code requests');
  await screenshot('companion-relay-system-status');
  await waitForNotificationTextToDisappear('Watching for SMS codes');
  await adb(['shell', 'cmd', 'statusbar', 'expand-notifications']);
  await sleep(500);
  await screenshot('companion-idle-no-session-notification');
  await adb(['shell', 'cmd', 'statusbar', 'collapse']);
  if (webPairing) {
    await webPairing.page.getByText('Pairing complete.', { exact: true }).waitFor({ timeout: 30_000 });
    const output = path.join(TMP, 'web-companion-paired.png');
    await webPairing.page.screenshot({ path: output, fullPage: true });
    log('web console observed completed pairing', output);
  }
  const pushDeadline = Date.now() + 30_000;
  let pushRegistered = false;
  while (Date.now() < pushDeadline) {
    const [device] = await sql`
      select push_transport, push_token
      from devices
      where revoked_at is null
      order by paired_at desc
      limit 1`;
    if (device?.push_transport === 'fcm' && device?.push_token) {
      pushRegistered = true;
      break;
    }
    await sleep(500);
  }
  if (!pushRegistered) {
    throw new Error('companion did not register an FCM installation before the crawl');
  }
  log(`companion paired through verified request + launched on ${SERIAL} -> ${baseUrl}`);
  await sleep(parseInt(process.env.COMPANION_WARMUP_MS || '4000', 10));
}

async function runCompanionRelay(connectionId) {
  const deadline = Date.now() + 300000;
  let sessionId = null;
  let bridge = null;
  let activeNotificationCaptured = false;
  const statuses = new Set();
  while (Date.now() < deadline) {
    const [s] = await sql`select id, status from sessions where connection_id = ${connectionId} order by started_at desc limit 1`;
    if (s) {
      sessionId = s.id;
      statuses.add(s.status);
      // Deliver the SMS only once the session is actually awaiting a code: the companion processes a
      // captured SMS once, on arrival, so the awaiting session must already exist when it checks.
      if (!bridge && s.status === 'waiting_for_otp') {
        log('companion-relay: session is awaiting OTP — delivering the bank SMS to the device', sessionId);
        await waitForNotificationText('Watching for SMS codes');
        await adb(['shell', 'cmd', 'statusbar', 'expand-notifications']);
        await sleep(500);
        await clearMessagesNotifications();
        await waitForUiText('Watching for SMS codes');
        await screenshot('companion-otp-active-foreground-notification');
        await adb(['shell', 'cmd', 'statusbar', 'collapse']);
        activeNotificationCaptured = true;
        bridge = spawnSvc(
          'sms-bridge',
          'node',
          ['e2e/sms-to-emulator.mjs', BANK, SERIAL],
          {
            SMS_FROM,
            EMULATOR_LEASE_SCRIPT: LEASE_SCRIPT,
            EMU_SESSION: process.env.EMU_SESSION,
          },
        );
      }
      if (['completed', 'failed', 'cancelled'].includes(s.status)) break;
    }
    await sleep(1000);
  }
  try { bridge?.kill('SIGTERM'); } catch { /* already gone */ }
  if (activeNotificationCaptured) {
    await waitForNotificationTextToDisappear('Watching for SMS codes');
    await clearMessagesNotifications();
    await adb(['shell', 'cmd', 'statusbar', 'expand-notifications']);
    await sleep(500);
    await screenshot('companion-terminal-no-session-notification');
    await adb(['shell', 'cmd', 'statusbar', 'collapse']);
  }
  const [s] = sessionId ? await sql`select otp_received_at from sessions where id = ${sessionId}` : [null];
  return { sessionId, statuses: [...statuses], submitted: !!s?.otp_received_at, via: 'companion-app-on-emulator' };
}

async function validateCompanionFinancialData(relaySessionId) {
  if (!relaySessionId) {
    throw new Error('companion crawl detail requires the completed relay session id');
  }
  await tapUiText('Accounts');
  const accountScreen = xmlDecode(await uiXml());
  if (accountScreen.includes('Unlock financial data')) {
    await tapUiText('Unlock');
    await completeDeviceCredentialPrompt();
    await waitForUiTextToDisappear('Unlock financial data');
  }
  await adb(['shell', 'input', 'swipe', '540', '500', '540', '1500', '500']);
  for (const account of TRUTH.accounts) {
    await waitForUiText(account.name, 60_000);
  }
  let xml = xmlDecode(await uiXml());
  for (const account of TRUTH.accounts) {
    const formatted = new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: account.currency,
    }).format(account.balance);
    if (!xml.includes(formatted)) {
      throw new Error(`companion account UI did not render ${formatted} for ${account.name}`);
    }
  }
  await screenshot('companion-accounts-light');

  await tapUiText('Transactions');
  for (const transaction of TRUTH.transactions) {
    await waitForUiText(transaction.description, 60_000);
  }
  await screenshot('companion-transactions-light');

  await tapUiText('Relay');
  await waitForUiText('Recent crawls');
  await waitForUiTextWithScroll('Northwind Bank', 60_000);
  await tapUiText('Northwind Bank', 30_000, true);
  await waitForUiText('Steps', 60_000);
  const [firstStep] = await sql`
    select log
      from session_steps
      where session_id = ${relaySessionId}
      order by step_number asc
      limit 1`;
  const firstStepLabel = firstStep?.log?.description?.trim()
    || firstStep?.log?.action;
  if (!firstStepLabel) {
    throw new Error('completed companion crawl has no recorded step to render');
  }
  await waitForUiText(firstStepLabel, 60_000);
  await screenshot('companion-crawl-steps-light');

  await tapUiText('Screenshots');
  await waitForUiTextToDisappear('Loading screenshot…', 60_000);
  xml = xmlDecode(await uiXml());
  if (xml.includes('Couldn’t load this screenshot.')) {
    throw new Error('companion crawl detail failed to render a recorded screenshot');
  }
  await screenshot('companion-crawl-screenshots-light');

  await tapUiText('Results');
  await waitForUiText(TRUTH.accounts[0].name, 60_000);
  await waitForUiTextWithScroll(TRUTH.transactions[0].description, 60_000);
  await screenshot('companion-crawl-results-light');
  await adb(['shell', 'input', 'keyevent', 'KEYCODE_BACK']);
  await waitForUiText('Recent crawls');

  await tapUiText('Transactions');

  await tapUiText('Hide amounts');
  await waitForUiText('Amount hidden');
  xml = xmlDecode(await uiXml());
  const visibleFinancialAmounts = [
    ...TRUTH.accounts.map((account) => ({
      amount: account.balance,
      currency: account.currency,
      label: account.name,
    })),
    ...TRUTH.transactions.map((transaction) => ({
      amount: transaction.amount,
      currency: transaction.currency ?? TRUTH.accounts[0].currency,
      label: transaction.description,
    })),
  ];
  for (const value of visibleFinancialAmounts) {
    const formatted = new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: value.currency,
    }).format(value.amount);
    if (xml.includes(formatted)) {
      throw new Error(
        `privacy mode left ${formatted} for ${value.label} in Android accessibility semantics`,
      );
    }
  }
  await screenshot('companion-transactions-private');

  await adb(['shell', 'cmd', 'uimode', 'night', 'yes']);
  await sleep(1_500);
  await screenshot('companion-transactions-private-dark');
  await adb(['shell', 'settings', 'put', 'system', 'font_scale', '1.5']);
  await sleep(1_500);
  await tapUiText('Accounts');
  await screenshot('companion-accounts-private-dark-large-text');
  await adb(['shell', 'settings', 'put', 'system', 'font_scale', '1.0']);
  await adb(['shell', 'cmd', 'uimode', 'night', 'no']);

  await adb(['shell', 'input', 'keyevent', 'KEYCODE_HOME']);
  await sleep(1_000);
  await adb(['shell', 'am', 'start', '-n', `${PKG}/${MAIN_ACTIVITY}`]);
  await waitForUiText(TRUTH.accounts[0].name, 30_000);
  const resumedAccountScreen = xmlDecode(await uiXml());
  if (resumedAccountScreen.includes('Unlock financial data')) {
    throw new Error('a brief interruption unexpectedly locked financial data');
  }

  await assertUiTextRemainsVisible(
    TRUTH.accounts[0].name,
    60_000,
    'Unlock financial data',
  );
  await tapUiText('Transactions');
  await waitForUiText(TRUTH.transactions[0].description, 30_000);
  await tapUiText('Accounts');
  await waitForUiText(TRUTH.accounts[0].name, 30_000);
  await assertUiTextRemainsVisible(
    TRUTH.accounts[0].name,
    270_000,
    'Unlock financial data',
  );
  await screenshot('companion-session-retained-after-activity');
  const retainedAfterScreenshot = xmlDecode(await uiXml());
  if (
    !retainedAfterScreenshot.includes(TRUTH.accounts[0].name)
    || retainedAfterScreenshot.includes('Unlock financial data')
  ) {
    throw new Error('companion did not remain unlocked past the original inactivity deadline');
  }
  await waitForUiText('Unlock financial data', 60_000, 5_000);
  await tapUiText('Unlock');
  await completeDeviceCredentialPrompt();
  await waitForUiText(TRUTH.accounts[0].name, 60_000);

  await tapUiText('Phone access');
  await waitForUiText("Revoke this phone's access");
  await tapUiText('Revoke access');
  await waitForUiText('Pair this phone', 30_000);
  const [revoked] = await sql`
    select d.revoked_at as device_revoked_at, k.revoked_at as financial_revoked_at
      from devices d
      left join api_keys k on k.device_id = d.id
      where d.name = 'e2e-emulator'
      order by d.paired_at desc
      limit 1`;
  if (!revoked?.device_revoked_at || !revoked?.financial_revoked_at) {
    throw new Error('phone self-revocation did not revoke both linked credentials');
  }
  await validateSecureCompanionBuild();
  log('companion rendered financial data, retained access through a brief interruption, locked after five minutes of inactivity, and revoked both credentials');
}

function approx(a, b) { return Math.abs(a - b) < 0.005; }

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

  // 2. Migrations (apply the generated SQL in order)
  const migDir = path.join(ROOT, 'apps/control-plane/migrations');
  for (const f of fs.readdirSync(migDir).filter((x) => x.endsWith('.sql')).sort()) {
    const text = fs.readFileSync(path.join(migDir, f), 'utf8');
    for (const stmt of text.split('--> statement-breakpoint')) {
      const s = stmt.trim();
      if (s) await sql.unsafe(s);
    }
    log('applied migration', f);
  }

  // 2b. The engine's least-privilege role, from the real grant code the deploy scripts run.
  const { applyEngineGrants } = await import(
    path.join(ROOT, 'apps/control-plane/dist/db/engine-grants.js')
  );
  await applyEngineGrants(sql, ENGINE_DB_PASSWORD);
  log('applied engine role grants');

  // 3. Services
  spawnSvc('fake-bank', 'node', ['e2e/fake-bank.mjs'], { FAKEBANK_PORT: String(P.bank), FAKEBANK_SILENT: '1' });
  spawnSvc('engine', 'node', ['apps/engine/dist/index.js'], {
    SERVICE_MODE: 'development', PORT: String(P.engine), PLATFORM: 'postgres',
    ENGINE_DATABASE_URL: ENGINE_DBURL, GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    ENGINE_SHARED_SECRET: SECRETS.ENGINE_SHARED_SECRET, RUNS_DIR: path.join(TMP, 'runs'),
    CONTROL_PLANE_INTERNAL_ORIGIN: `http://127.0.0.1:${P.cp}`,
    HEADLESS: process.env.E2E_HEADFUL ? 'false' : 'true',
    EXTRA_CHROMIUM_ARGS: `--host-resolver-rules=MAP ${BANK_HOST} 127.0.0.1`,
    // The institution is deliberately on loopback here, so say so. The engine verifies the address the
    // browser actually connected to, and an undeclared private peer is refused as a DNS rebind.
    ACCRAWL_ALLOW_PRIVATE_CRAWL_TARGETS: BANK_HOST,
  });
  spawnSvc('control-plane', 'node', ['apps/control-plane/dist/server-main.js'], {
    PORT: String(P.cp), DATABASE_URL: DBURL, ENGINE_URL: `http://127.0.0.1:${P.engine}`,
    RUNS_DIR: path.join(TMP, 'runs'),
    // The control-plane now LLM-extracts the OTP from the relayed SMS body, so it needs the Gemini key too.
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    // Both relay paths pair over loopback HTTP in this harness — the in-process relay has to pair a real
    // device now that the engine requires a live readiness handshake, and pairing refuses plain HTTP by
    // default. Scoped to the e2e's own control plane; production keeps the HTTPS requirement.
    ACCRAWL_COMPANION_ALLOW_INSECURE_HTTP: '1',
    // The fake bank is plain HTTP on this host; a real institution must use https.
    ACCRAWL_ALLOW_INSECURE_LOGIN_URL: '1',
    SETUP_CLAIM_TOKEN,
    ...(process.env.COMPANION_RELAY ? {
      ...requireCompanionPushClient(),
    } : {}),
    ...SECRETS,
  });

  await waitForHealth('fake-bank', `${BANK}/_health`);
  await waitForHealth('engine', `http://127.0.0.1:${P.engine}/`);
  await waitForHealth('control-plane', `${CP}/health`);

  // 4. Drive the real product API
  // First-run setup creates the operator. The admin password is no longer an env var — it is set once here
  // and stored as an argon2id hash; the fresh per-run DB is always uninitialized, so setup returns the
  // operator token directly (no separate login needed).
  const setup = await api('POST', '/api/setup', { password: SECRETS.ACCRAWL_ADMIN_PASSWORD, setupCode: SETUP_CLAIM_TOKEN });
  if (![200, 201].includes(setup.status)) throw new Error(`first-run setup failed: ${setup.status} ${JSON.stringify(setup.json)}`);
  token = setup.json.token;
  log('operator initialized + authenticated (first-run setup)');

  let connectionId;
  let webPage = null;
  if (process.env.COMPANION_RELAY) {
    const webSetup = await createConnectionThroughWeb();
    connectionId = webSetup.connectionId;
    webPage = webSetup.page;
  } else {
    const inst = await api('POST', '/api/institutions', {
      id: 'northwind', name: 'Northwind Bank', type: 'bank',
      loginUrl: `http://${BANK_HOST}:${P.bank}/login`,
      requires2fa: true,
      // The sender binding is a case-insensitive EXACT match (server + companion both use senderMatches — a
      // trimmed equality, NEVER a regex or substring), so the pattern must EQUAL the sender exactly: the plain
      // SMS_FROM number. The bank SMS arrives FROM SMS_FROM at the emulator (companion path) and the in-process
      // relay posts sender=SMS_FROM too, so the exact-match sender binding passes on both paths — proving the
      // binding while keeping the relay firing in the e2e.
      otpSenderPattern: SMS_FROM,
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
    log('institution created; canonicalDomain =', inst.json.canonicalDomain ?? '(derived server-side)');

    const conn = await api('POST', '/api/connections', { institutionId, username: CREDS.username, password: CREDS.password });
    if (![200, 201].includes(conn.status)) throw new Error(`create connection failed: ${conn.status} ${JSON.stringify(conn.json)}`);
    connectionId = conn.json.id;
    log('connection created', connectionId);

    const verify = await api('POST', `/api/connections/${connectionId}/verify-domain`, { canonicalDomain: BANK_HOST });
    if (![200, 204].includes(verify.status)) throw new Error(`verify-domain failed: ${verify.status} ${JSON.stringify(verify.json)}`);
    log('login domain verified (anti-phishing gate satisfied)');
  }

  // 5. Fire the crawl + deliver the 2FA code. Default: an in-process relay. COMPANION_RELAY=1: the real
  //    Accrawl Companion app on an emulator captures the SMS and forwards its raw body through the
  //    device-authenticated route for control-plane extraction and submission.
  log('triggering crawl…');
  let webPairing = null;
  if (process.env.COMPANION_RELAY) {
    webPairing = await createPairingThroughWeb(connectionId, webPage);
    await setupCompanion(connectionId, webPairing);
  }
  const crawlP = process.env.COMPANION_RELAY
    ? triggerCrawlThroughWeb(connectionId, webPage)
    : api('POST', `/api/connections/${connectionId}/crawl`);
  let relay;
  if (process.env.COMPANION_RELAY) relay = await runCompanionRelay(connectionId);
  else if (process.env.E2E_MANUAL_OTP) relay = await runManualOtpRelay(connectionId);
  else relay = await runRelay(connectionId);
  const crawl = await crawlP;
  log('crawl returned', crawl.status, JSON.stringify(crawl.json).slice(0, 400));
  log(
    'relay summary:',
    JSON.stringify({
      sessionId: relay.sessionId,
      statuses: relay.statuses,
      submitted: relay.submitted,
      via: relay.via ?? 'in-process',
    }),
  );

  // 6. Assert
  const errors = [];
  if (!relay.submitted) errors.push('OTP was never submitted (engine never requested it / relay missed it)');
  if (!relay.statuses.includes('waiting_for_otp')) errors.push(`session never entered waiting_for_otp (saw: ${relay.statuses.join(',')})`);

  const [sess] = await sql`select status, otp_received_at from sessions where id = ${relay.sessionId}`;
  log('final session:', JSON.stringify(sess));
  if (sess?.status !== 'completed') errors.push(`session status is '${sess?.status}', expected 'completed'`);
  if (!sess?.otp_received_at) errors.push('otp_received_at not set — OTP was not actually consumed by the engine');

  const accts = (await sql`select data from accounts where connection_id = ${connectionId}`).map((r) => r.data);
  const txns = (await sql`select data from transactions where connection_id = ${connectionId}`).map((r) => r.data);
  log(`extracted ${accts.length} accounts, ${txns.length} transactions`);
  log('ACCOUNTS:', JSON.stringify(accts, null, 2));
  log('TRANSACTIONS:', JSON.stringify(txns, null, 2));

  // value-presence assertions (robust to field-name formatting; strict on the numbers)
  const acctStr = JSON.stringify(accts);
  for (const a of TRUTH.accounts) {
    const balOk = accts.some((x) => JSON.stringify(x).includes(String(a.balance)) || Object.values(x).some((v) => typeof v === 'number' && approx(v, a.balance)));
    if (!balOk) errors.push(`account balance ${a.balance} (${a.name}) not found in extracted accounts`);
    if (!acctStr.includes(a.name)) errors.push(`account name "${a.name}" not found in extracted accounts`);
  }

  // The credit card appears on the dashboard only as a charge tile (never a row in the accounts
  // table), so these assertions are the product-coverage guarantee: the crawl must record it as its
  // OWN account, type credit, balance = amount OWED as a POSITIVE number, and must follow the
  // /cards link for its transactions.
  const cardAcct = accts.find((x) => JSON.stringify(x).includes(TRUTH.card.name));
  if (!cardAcct) {
    errors.push(`credit card "${TRUTH.card.name}" was not recorded as an account — the dashboard tile was dropped`);
  } else {
    if (cardAcct.type !== 'credit') errors.push(`card account type is '${cardAcct.type}', expected 'credit'`);
    if (!approx(cardAcct.balance, TRUTH.card.owed)) {
      errors.push(`card balance is ${cardAcct.balance}, expected the amount owed as a POSITIVE ${TRUTH.card.owed}`);
    }
  }
  const expectedAccounts = TRUTH.accounts.length + 1;
  if (accts.length !== expectedAccounts) errors.push(`expected ${expectedAccounts} accounts, stored ${accts.length}`);

  const txnStr = JSON.stringify(txns);
  for (const t of TRUTH.transactions) {
    // Signed, not absolute. Sign is what separates a charge from a refund, so a
    // crawl that stored +82.31 for a -82.31 debit used to pass this unchanged.
    const amtOk = txns.some((x) => Object.values(x).some((v) => typeof v === 'number' && approx(v, t.amount))) || txnStr.includes(String(t.amount));
    if (!amtOk) errors.push(`transaction amount ${t.amount} (${t.description}) not found in extracted transactions`);
  }
  for (const t of TRUTH.card.transactions) {
    const match = txns.find((x) => Object.values(x).some((v) => typeof v === 'number' && approx(v, t.amount)));
    if (!match) {
      errors.push(`card transaction ${t.amount} (${t.description}) not found — the /cards activity page was not extracted`);
    } else if (cardAcct && match.providerAccountId !== cardAcct.providerAccountId) {
      errors.push(`card transaction ${t.amount} (${t.description}) is attributed to providerAccountId "${match.providerAccountId}", expected the card's "${cardAcct.providerAccountId}"`);
    }
  }
  const expectedTransactions = TRUTH.transactions.length + TRUTH.card.transactions.length;
  if (txns.length !== expectedTransactions) {
    errors.push(`expected exactly ${expectedTransactions} transactions, stored ${txns.length}`);
  }

  if (process.env.COMPANION_RELAY && errors.length === 0) {
    await validateWebFinancialData(webPairing.page);
    await validateCompanionFinancialData(relay.sessionId);
  }

  // 6b. OTP-LEAK assertions (DEFECT-2 + DEFECT-3): the live 2FA code must NOT have been persisted or logged
  // anywhere the crawl or relay writes it. The real code is the one the engine consumed — read it from
  // sessions.otp (the relay handoff column, the ONE legitimate place it lives). We then assert it is absent
  // from:
  //   (a) the engine process log and emulator SMS-bridge log (DEFECT-3: the old `12****` line leaked the
  //       first two digits);
  //   (b) every persisted session_steps.log JSON (the step log must carry the OTP_CODE placeholder, never the
  //       real digits — i.e. no leak via action value / feedback / description);
  //   (c) the persisted per-step screenshot JPEGs under RUNS_DIR (DEFECT-2: the post-fill screenshot must not
  //       show the code) — checked TWO ways: a raw-byte scan for an attribute/alt-text embed, AND OCR of the
  //       rendered pixels (the DOM mask must keep the digits out of the image; OCR is what actually verifies it).
  // The consumed code: derive it from the SMS the relay delivered (the bank's verification code). We do NOT
  // read sessions.otp — the control-plane NULLS that column once the engine consumes the code (correct: don't
  // leave a live 2FA secret at rest), so it is null by the time we assert. The SMS body the relay captured is
  // the ground-truth source. Pick the longest 4–10 digit run (the verification code; "5 minutes" etc. are
  // short incidental numbers). Fall back to sessions.otp only if the relay didn't record a body.
  let realOtp = null;
  if (relay.smsBody) {
    const runs = (relay.smsBody.match(/\d{4,10}/g) ?? []).sort((a, b) => b.length - a.length);
    realOtp = runs[0] ?? null;
  }
  if (!realOtp) {
    const [otpRow] = await sql`select otp from sessions where id = ${relay.sessionId}`;
    realOtp = otpRow?.otp ?? null;
  }
  if (!realOtp) {
    // Companion path: the harness never saw the SMS body (the device captured it on-device) AND the
    // control-plane nulls sessions.otp once the engine consumes the code — so read the consumed code from the
    // fake bank's simulated carrier record (its /_relay/last-sms, the same source the relay delivered from).
    // The fake bank is still running at this point (it is torn down after the assertions).
    try {
      const lastSms = await (await fetch(`${BANK}/_relay/last-sms`)).json();
      if (lastSms?.code && /^\d{4,10}$/.test(String(lastSms.code))) realOtp = String(lastSms.code);
    } catch { /* fake bank may already be down on a fast exit — fall through to the error below */ }
  }
  if (!realOtp || !/^\d{4,10}$/.test(realOtp)) {
    errors.push(`could not determine the consumed OTP (from the relayed SMS or sessions.otp) to run the leak assertions (got ${JSON.stringify(realOtp)})`);
  } else {
    log(`OTP-leak check: asserting the consumed code (length ${realOtp.length}) does not appear in logs / step logs / screenshots`);
    // (a) process and bridge logs
    const engineLogPath = path.join(TMP, 'engine.log');
    let engineLog = '';
    try { engineLog = fs.readFileSync(engineLogPath, 'utf8'); } catch { /* log may be absent on a fast exit */ }
    if (engineLog.includes(realOtp)) errors.push('LEAK: the engine process log contains the live OTP code');
    const smsBridgeLogPath = path.join(TMP, 'sms-bridge.log');
    let smsBridgeLog = '';
    try { smsBridgeLog = fs.readFileSync(smsBridgeLogPath, 'utf8'); } catch { /* absent on the in-process relay path */ }
    if (smsBridgeLog.includes(realOtp)) errors.push('LEAK: the SMS bridge log contains the live OTP code');
    // Guard the SPECIFIC old DEFECT-3 form too: the "[Agent] OTP received: 12****" line that logged the first
    // OTP digits as a "<digits>****" mask. We check the agent's OTP-received MESSAGE only, with the logger's
    // leading "[<sessionId>] " prefix stripped — that prefix legitimately carries the session UUID's hex
    // digits, which is not the code. After stripping it, the message must contain no digit-then-asterisk mask
    // AND no digit at all (the fixed message is fully digit-free). The exact-code byte check above is the
    // primary guard; this catches a mask-prefix regression on the agent line specifically.
    const STRIP_LOG_PREFIX = /^\[[^\]]*\]\s*/; // the SessionLogger's "[<sessionId>] " prefix
    const agentOtpMsgs = engineLog.split('\n')
      .filter((l) => l.includes('[Agent] OTP received'))
      .map((l) => l.replace(STRIP_LOG_PREFIX, ''));
    if (agentOtpMsgs.some((m) => /\d+\*/.test(m))) errors.push('LEAK: an "[Agent] OTP received" message logs a masked OTP prefix (DEFECT-3 regressed)');
    if (agentOtpMsgs.some((m) => /\d/.test(m))) errors.push('LEAK: an "[Agent] OTP received" message contains a digit');
    // (b) persisted step logs
    const stepRows = await sql`select log from session_steps where session_id = ${relay.sessionId}`;
    const stepBlob = JSON.stringify(stepRows.map((r) => r.log));
    if (stepBlob.includes(realOtp)) errors.push('LEAK: a persisted session_steps.log contains the live OTP code');
    // (c) persisted screenshots — TWO independent checks, because the real leak is RENDERED PIXELS:
    //   (c1) raw bytes — catches a value-attribute / alt-text / EXIF embed of the code string.
    //   (c2) OCR of the rendered image — the ONLY check that sees the code being VISIBLE in the screenshot,
    //        which is exactly what a broken DOM mask produces and a byte scan can NEVER detect (pixels aren't
    //        text). This was the false-"clean" hole: the mask was silently non-functional and the byte scan
    //        couldn't see the digits it rendered. OCR is REQUIRED here — if it can't run, that's a failure, not
    //        a pass (a scan that can't see the leak is worse than no scan).
    const runsDir = path.join(TMP, 'runs');
    let shotFiles = [];
    try {
      const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
        const p = path.join(d, e.name);
        return e.isDirectory() ? walk(p) : [p];
      });
      shotFiles = fs.existsSync(runsDir) ? walk(runsDir).filter((f) => /\.(jpe?g|png|webp)$/i.test(f)) : [];
    } catch { /* runs dir may not exist on some platforms */ }
    // (c1) bytes
    let shotLeak = false;
    for (const f of shotFiles) {
      try { if (fs.readFileSync(f, 'latin1').includes(realOtp)) { shotLeak = true; break; } } catch { /* skip unreadable */ }
    }
    if (shotLeak) errors.push('LEAK: a persisted screenshot file contains the live OTP code as raw bytes');
    // (c2) OCR — read the rendered pixels and assert the code is not visible in any screenshot.
    try {
      const ocrHits = await ocrScreenshotsForCode(shotFiles, realOtp);
      if (ocrHits.length) {
        errors.push(`LEAK: the live OTP code is VISIBLE (read by OCR) in ${ocrHits.length} screenshot(s): ${ocrHits.map((h) => path.basename(h)).join(', ')}`);
      }
      log(`OTP-leak check: OCR'd ${shotFiles.length} screenshots for the rendered code — ${ocrHits.length ? 'LEAK FOUND' : 'clean'}`);
    } catch (ocrErr) {
      errors.push(`OTP-leak check: could not OCR the screenshots to verify the code is not rendered (${ocrErr?.message ?? ocrErr}) — cannot certify the screenshots clean`);
    }
    log(`OTP-leak check: scanned engine log (${engineLog.length} chars), SMS bridge log (${smsBridgeLog.length} chars), ${stepRows.length} step logs, ${shotFiles.length} screenshots — ${errors.some((e) => e.startsWith('LEAK')) ? 'LEAK FOUND' : 'clean'}`);
  }

  if (errors.length) {
    console.error('\n❌ E2E FAILED:\n' + errors.map((e) => '  - ' + e).join('\n'));
    process.exitCode = 1;
  } else {
    console.log('\n✅ E2E PASSED — real crawl through live OTP handshake extracted the bank data exactly.');
  }
}

async function teardown() {
  try { await webBrowser?.close(); } catch { /* browser may not have started */ }
  try {
    if (webServer) await new Promise((resolve) => webServer.close(() => resolve()));
  } catch { /* front door may not have started */ }
  for (const { name, c } of children) { try { c.kill('SIGTERM'); } catch { /* */ } }
  try { await sql?.end({ timeout: 3 }); } catch { /* */ }
  try { await pg?.stop(); } catch { /* */ }
  // Give the device its space back. A relay run installs two builds and, without this, every run left
  // them behind — so a device that served several runs eventually refused the next install with
  // INSTALL_FAILED_INSUFFICIENT_STORAGE, which reads as a broken gate rather than as a full disk.
  // The run installs them itself, so removing them costs the next run nothing.
  if (process.env.COMPANION_RELAY) {
    for (const pkg of [PKG, PKG.replace(/\.qa$/, '')]) {
      try { await adb(['uninstall', pkg]); } catch { /* not installed, or the device is already gone */ }
    }
  }
}

main().catch((e) => { console.error('\n❌ E2E ERROR:', e.message); process.exitCode = 1; })
  .finally(async () => { await teardown(); setTimeout(() => process.exit(process.exitCode ?? 0), 500); });
