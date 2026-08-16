/**
 * Session routes: read a session, submit a 2FA code, and stream live events.
 *
 *   GET  /api/sessions/:id            -> session view
 *   POST /api/sessions/:id/otp        { code }  -> 202 accepted | 404 | 409 (not active)
 *   GET  /api/sessions/:id/events     -> SSE: replays from Last-Event-ID, polls until the session ends
 *
 * A crawl session is the record of HOW data was retrieved, so this whole surface belongs to the deployment
 * owner: the operator in the console, or their own paired companion (a `read:companion` credential issued by
 * pairing). The public API never reaches it — it serves already-retrieved data and nothing else.
 */
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { stat as fsStat } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HOSTED_COPY, deriveTunnelKey, signTunnelToken } from '@accrawl/contracts';
import { db } from '../db/client';
import {
  requireOperator,
  requireOperatorOrApiKey,
  requireOperatorOrDevice,
  requireDevice,
} from '../auth/middleware';
import {
  submitOtpFromSms,
  listAwaitingOtpSessions,
  listAwaitingTunnelSessions,
  listRecentSessions,
  markOtpRelayStatus,
  type SubmitOtpFromSmsResult,
} from '../data/session-io';
import { listDeviceProxyConnections, pickPairedDevice } from '../data/devices';
import { currentTenant } from '../tenancy/context';
import { screenshotArchive } from '../storage/screenshot-archive';
import { actorCanAccessConnection, actorCanAccessSession } from '../auth/authorization';
import { getUserDataStore } from '../storage';
import { config } from '../config';
import { deviceSessionStore } from '../data/device-session-store';
import { extractOtpFromSms } from '../data/otp-extract';

const TERMINAL = ['completed', 'failed', 'cancelled'];
// The OTP-submit body is a discriminated union of two relays:
//  - MANUAL ({ code }): the operator types a code in the web console. `idempotencyKey` (optional) lets a
//    retried POST land as a no-op instead of a second burned 2FA attempt; it can also come in the
//    conventional `idempotency-key` header (the header wins when both are present).
//  - SMS ({ smsBody, sender, otpRequestEpoch }): a paired companion relays the RAW SMS body (it no longer
//    parses the code itself — the control-plane LLM-extracts it). The server validates the sender against the
//    institution's learned otpSenderPattern, checks the request episode, asks Gemini for the code, and submits
//    it; the idempotency key is derived server-side and scoped to (sessionId|otpRequestEpoch|sha256(body)),
//    so a redelivered SMS within one episode is a no-op while a fresh request (new epoch) is accepted.
// Discriminating on the presence of `code` vs `smsBody` keeps the manual path byte-compatible with old web
// clients while adding the SMS path.
const manualOtpSchema = z.object({
  code: z.string().min(1).max(32),
  idempotencyKey: z.string().min(1).max(200).optional(),
});
const smsOtpSchema = z.object({
  smsBody: z.string().min(1).max(2000),
  sender: z.string().min(1).max(256),
  otpRequestEpoch: z.number().int().min(0),
});
const relayStatusSchema = z.object({
  smsPermission: z.boolean(),
  ready: z.boolean().optional().default(true),
});

// Defense-in-depth cap on MANUAL { code } submissions per session, so the operator console
// cannot rapid-fire code guesses far beyond what a real 2FA flow needs. The bank's own attempt limit + the
// session otp-handshake state remain the primary gate; this bounds the in-process guessing surface. Counts
// only the manual branch (the SMS relay is sender-bound + LLM-validated). In-memory, per instance.
const MAX_OTP_ATTEMPTS = 10;
const otpAttempts = new Map<string, number>();
function bumpOtpAttempts(sessionId: string): number {
  if (otpAttempts.size > 10_000) otpAttempts.clear(); // crude memory bound over a long-lived process
  const n = (otpAttempts.get(sessionId) ?? 0) + 1;
  otpAttempts.set(sessionId, n);
  return n;
}

/**
 * Cap on how many messages a paired phone may relay for one session.
 *
 * Kept apart from the manual counter above on purpose. A relayed message that does not match the sender,
 * arrives for a stale episode, or carries no code deliberately costs the owner nothing — burning a 2FA
 * attempt on a marketing text would lock them out of their own bank. That leniency is right, and it also
 * meant nothing bounded the branch at all: a stolen device token could relay unique bodies forever, and
 * each one reached the model and could overwrite a code the session was still waiting for.
 *
 * A phone has one message to relay, occasionally a few if the institution resends. Ten is far above what
 * the flow needs and far below what an attack does.
 */
const MAX_SMS_RELAYS = 10;
const smsRelays = new Map<string, number>();
function bumpSmsRelays(sessionId: string): number {
  if (smsRelays.size > 10_000) smsRelays.clear(); // same crude memory bound as the manual counter
  const n = (smsRelays.get(sessionId) ?? 0) + 1;
  smsRelays.set(sessionId, n);
  return n;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function actorOwnerSubject(req: Parameters<typeof actorCanAccessSession>[1]): string {
  const subject = req.operatorSubject ?? req.device?.ownerSubject ?? req.apiKey?.ownerSubject;
  if (!subject) throw new Error('authenticated actor owner subject is missing');
  return subject;
}

export async function sessionRoutes(app: FastifyInstance): Promise<void> {
  // Sessions awaiting a 2FA code — polled by the companion device to know where to relay one (operator or
  // device auth). Registered as a STATIC path so it wins over /api/sessions/:id in the router.
  app.get('/api/sessions/awaiting-otp', { preHandler: requireOperatorOrDevice }, async (req) => {
    const hostedSessions = deviceSessionStore();
    const sessions = req.device
      ? hostedSessions
        ? await (await hostedSessions()).listAwaitingOtpSessions(req.device)
        : await listAwaitingOtpSessions(
          db,
          actorOwnerSubject(req),
          req.device,
        )
      : await (await getUserDataStore())
        .listAwaitingOtpSessions(actorOwnerSubject(req));
    return {
      sessions,
    };
  });

  // Explicit paired-phone handshake for an armed OTP request. Reading the awaiting list is deliberately
  // insufficient: the worker starts browser navigation only after the phone confirms that RECEIVE_SMS is
  // currently granted. This prevents a configured-but-unavailable companion from being mistaken for one
  // that can catch the bank's code.
  app.post('/api/sessions/:id/relay-status', { preHandler: requireDevice }, async (req, reply) => {
    const parsed = relayStatusSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send();
    const id = (req.params as { id: string }).id;
    const hostedSessions = deviceSessionStore();
    const accepted = hostedSessions
      ? await (await hostedSessions()).markOtpRelayStatus(
        req.device!,
        id,
        parsed.data.smsPermission,
        parsed.data.ready,
      )
      : await markOtpRelayStatus(
        db,
        id,
        req.device!,
        parsed.data.smsPermission,
        parsed.data.ready,
      );
    return accepted ? reply.code(204).send() : reply.code(404).send();
  });

  // Sessions awaiting a device-proxy tunnel — polled by the companion to know which sessions to open a
  // tunnel for. A FRESH, session+device-bound token is minted per call (short TTL; single-use is enforced
  // by the engine's CAS on tunnel_claimed_at). The token's `did` binds to the device that will actually
  // connect: when a companion polls, that is the authenticated device; when the operator polls, use the
  // newest active device. Only sessions durably bound to that exact device are returned. If no device is
  // paired or the HMAC root is unavailable, nothing can be claimed.
  app.get('/api/sessions/awaiting-tunnel', { preHandler: requireOperatorOrDevice }, async (req) => {
    // Device callers always receive deviceProxyConnections (empty = the watch service has nothing to
    // do and should stop) — including on every early return, so a hosted/unconfigured deployment
    // reads unambiguously as "capability off" rather than "temporarily no sessions".
    const emptyForDevice = req.device
      ? { sessions: [], deviceProxyConnections: [] }
      : { sessions: [] };
    // The device proxy tunnels a browser through a paired phone, and the claim it hands out is checked
    // against a row in the database this deployment runs. A deployment that keeps its records elsewhere
    // has nowhere to enforce that single use, so the capability is off rather than unguarded.
    if (config.persistenceBackend !== 'postgres') return emptyForDevice;
    const tenant = currentTenant();
    if (!tenant.engineSharedSecret) return emptyForDevice;
    const ownerSubject = actorOwnerSubject(req);
    const deviceId = req.device?.id ?? (await pickPairedDevice(db, ownerSubject))?.id;
    if (!deviceId) return emptyForDevice;
    const key = deriveTunnelKey(tenant.engineSharedSecret);
    const awaiting = await listAwaitingTunnelSessions(
      db,
      ownerSubject,
      deviceId,
      req.device?.credentialHash,
    );
    // deviceProxyConnections tells the companion whether its watch service needs to exist at all —
    // included only for the device caller (the phone), which is the party that acts on it.
    const deviceProxyConnections = req.device
      ? (await listDeviceProxyConnections(db, req.device)).map((c) => ({ label: c.label }))
      : undefined;
    return {
      sessions: awaiting.map((s) => ({
        sessionId: s.id,
        // The crawl's human label, matching the companion's precedence everywhere else: the
        // connection nickname when set, else the institution name.
        label: s.nickname?.trim() || s.institutionName,
        tunnelToken: signTunnelToken(key, { sid: s.id, did: deviceId }),
        engineWsUrl: tenant.engineWsUrl,
      })),
      ...(deviceProxyConnections ? { deviceProxyConnections } : {}),
    };
  });

  // Recent crawl outcomes for the companion activity view. This endpoint returns crawl metadata; the
  // companion's separately scoped financial endpoints serve accounts, balances, and transactions. STATIC
  // path — register before /:id so the router prefers it.
  app.get('/api/sessions/recent', { preHandler: requireOperatorOrDevice }, async (req) => {
    const hostedSessions = deviceSessionStore();
    const rows = req.device
      ? hostedSessions
        ? await (await hostedSessions()).listRecentSessions(req.device, 30)
        : await listRecentSessions(
          db,
          30,
          actorOwnerSubject(req),
          req.device,
        )
      : await (await getUserDataStore())
        .listRecentSessions(actorOwnerSubject(req), 30);
    return {
      sessions: rows.map((s) => ({
        id: s.id,
        institutionName: s.institutionName,
        nickname: s.nickname,
        status: s.status,
        startedAt: s.startedAt,
        completedAt: s.completedAt,
        error: s.error,
      })),
    };
  });

  // Session status (the console's live monitor and the companion's activity view: waiting_for_otp /
  // completed / failed). Operator (any of their sessions) OR the paired companion's `read:companion`
  // credential. not-found / not-granted are a uniform 403 for a credential so an unowned id is not an oracle.
  app.get('/api/sessions/:id', { preHandler: requireOperatorOrApiKey('read:companion') }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!(await actorCanAccessSession(db, req, id))) {
      return reply.code(req.apiKey ? 403 : 404).send({
        error: req.apiKey
          ? 'api key is not authorized for this session'
          : 'We couldn’t find this crawl. Refresh the page; it may have already ended or been removed.',
      });
    }
    const view = await (await getUserDataStore()).getSessionView(id);
    if (!view) {
      return reply.code(404).send({
        error: 'We couldn’t find this crawl. Refresh the page; it may have already ended or been removed.',
      });
    }
    // Engine liveness and model spend are operator diagnostics: the console shows them, the companion's
    // activity view neither uses nor should receive them.
    if (req.apiKey) {
      const { heartbeatAt: _heartbeatAt, cost: _cost, ...companionView } = view;
      return companionView;
    }
    return view;
  });

  // The recorded step timeline for a session (action, description, timings, extraction counts, whether a
  // screenshot exists per step) — the console renders this as the crawl's progress/history. Same auth +
  // grant model as GET /:id (safe metadata; the screenshots themselves are served by the route below).
  app.get('/api/sessions/:id/steps', { preHandler: requireOperatorOrApiKey('read:companion') }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!(await actorCanAccessSession(db, req, id))) {
      return reply.code(req.apiKey ? 403 : 404).send({
        error: req.apiKey
          ? 'api key is not authorized for this session'
          : 'We couldn’t find this crawl. Refresh the page; it may have already ended or been removed.',
      });
    }
    const store = await getUserDataStore();
    if (!(await store.getSessionView(id))) {
      return reply.code(404).send({
        error: 'We couldn’t find this crawl. Refresh the page; it may have already ended or been removed.',
      });
    }
    return { steps: await store.listSessionSteps(id) };
  });

  // A step's screenshot (JPEG the engine captured), streamed from the shared screenshots dir. The stored
  // ref is DATA, not a trusted path: absolute paths / traversal are rejected and the resolved file must
  // stay inside SCREENSHOT_DIR. Screenshots show the user's own bank pages — operator or a granted key.
  app.get('/api/sessions/:id/steps/:step/screenshot', { preHandler: requireOperatorOrApiKey('read:companion') }, async (req, reply) => {
    const { id, step } = req.params as { id: string; step: string };
    const stepNumber = Number.parseInt(step, 10);
    if (!Number.isInteger(stepNumber) || stepNumber < 0) return reply.code(400).send({ error: 'invalid step number' });
    if (!(await actorCanAccessSession(db, req, id))) {
      return reply.code(req.apiKey ? 403 : 404).send({
        error: req.apiKey
          ? 'api key is not authorized for this session'
          : 'We couldn’t find this crawl. Refresh the page; it may have already ended or been removed.',
      });
    }
    const tenant = currentTenant();
    const baseDir = tenant.screenshotDir;
    const archive = screenshotArchive();
    if (!baseDir && !archive) {
      return reply.code(404).send({ error: 'screenshots are not available on this deployment (SCREENSHOT_DIR is not set)' });
    }
    const ref = await (await getUserDataStore())
      .getStepScreenshotRef(id, stepNumber);
    if (!ref) return reply.code(404).send({ error: 'no screenshot for this step' });
    if (path.isAbsolute(ref) || ref.split(/[\\/]/).includes('..')) return reply.code(404).send({ error: 'no screenshot for this step' });
    if (archive) {
      const stored = await archive.open(ref);
      if (!stored) return reply.code(404).send({ error: 'screenshot file not found' });
      return reply
        .header('content-type', stored.contentType)
        .header('cache-control', 'private, max-age=3600')
        .send(stored.body);
    }
    const abs = path.resolve(baseDir!, ref);
    if (abs !== path.resolve(baseDir!) && !abs.startsWith(path.resolve(baseDir!) + path.sep)) {
      return reply.code(404).send({ error: 'no screenshot for this step' });
    }
    let stream: ReturnType<typeof createReadStream>;
    try {
      await fsStat(abs); // 404 (not a hung stream) when the file is missing
      stream = createReadStream(abs);
    } catch {
      return reply.code(404).send({ error: 'screenshot file not found' });
    }
    return reply
      .header('content-type', abs.endsWith('.png') ? 'image/png' : 'image/jpeg')
      .header('cache-control', 'private, max-age=3600') // step screenshots are immutable once written
      .send(stream);
  });

  // A connection's recent sessions, newest first — the console's run history and the way back into a
  // still-running crawl after a reload. Operator, or a consumer key with read:data granted the connection.
  app.get('/api/connections/:id/sessions', { preHandler: requireOperator }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!(await actorCanAccessConnection(db, req, id))) {
      return reply.code(req.apiKey ? 403 : 404).send({
        error: req.apiKey
          ? HOSTED_COPY.apiKeyCannotAccessConnection
          : HOSTED_COPY.connectionNotFound,
      });
    }
    return {
      sessions: await (await getUserDataStore()).listConnectionSessions(id),
    };
  });

  // Crawl history across every connection, newest first, labeled with institution/nickname — the console's
  // History page, and the reliable way back into any still-running crawl. Operator-only (cross-connection).
  app.get('/api/sessions', { preHandler: requireOperator }, async (req) => {
    return {
      sessions: await (await getUserDataStore())
        .listRecentSessions(actorOwnerSubject(req), 50),
    };
  });

  // What one run extracted (its staged records, grouped + capped) — the History page's per-run data view.
  // This IS financial data, so: operator, or a consumer key with read:data granted the session's connection.
  app.get('/api/sessions/:id/records', { preHandler: requireOperatorOrApiKey('read:companion') }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!(await actorCanAccessSession(db, req, id))) {
      return reply.code(req.apiKey ? 403 : 404).send({
        error: req.apiKey
          ? 'api key is not authorized for this session'
          : 'We couldn’t find this crawl. Refresh the page; it may have already ended or been removed.',
      });
    }
    const store = await getUserDataStore();
    if (!(await store.getSessionView(id))) {
      return reply.code(404).send({
        error: 'We couldn’t find this crawl. Refresh the page; it may have already ended or been removed.',
      });
    }
    return await store.getSessionRecords(id);
  });

  // Operator (manual web-UI entry, { code }) OR a paired companion device (SMS auto-relay,
  // { smsBody, sender, otpRequestEpoch }). A one-time passcode is part of HOW a crawl gets in, so it stays
  // between the deployment owner and their institution: no API credential — manual or OAuth — can submit one.
  // The companion relays the raw body and the control-plane LLM-extracts it (validating the sender + request
  // episode server-side first); the operator submits an already-known code.
  app.post('/api/sessions/:id/otp', { preHandler: requireOperatorOrDevice }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const sms = smsOtpSchema.safeParse(req.body);
    if (sms.success) {
      if (!(await actorCanAccessSession(db, req, id))) {
        return reply.code(404).send({
          error: 'We couldn’t find this crawl. Refresh the page; it may have already ended or been removed.',
        });
      }
      // Bounded before anything is read or extracted, so a flood costs neither model calls nor a chance
      // to overwrite a code the session is still waiting for. Still never burns a 2FA attempt.
      if (bumpSmsRelays(id) > MAX_SMS_RELAYS) {
        return reply.code(429).send({ error: 'Accrawl has received the maximum of 10 relayed SMS messages for this session. Enter the code manually in the Accrawl console.' });
      }
      // SMS relay: validate sender + episode, LLM-extract, submit. A non-matching sender, a stale episode, or
      // a body with no code never burns a 2FA attempt — the session stays waiting for a manual code.
      const input = {
        sessionId: id,
        smsBody: sms.data.smsBody,
        sender: sms.data.sender,
        otpRequestEpoch: sms.data.otpRequestEpoch,
      };
      let r: SubmitOtpFromSmsResult;
      const hostedSessions = deviceSessionStore();
      if (req.device && hostedSessions) {
        const store = await hostedSessions();
        const prepared = await store.prepareSmsRelay(req.device, input);
        if (prepared.status === 'ready') {
          const code = await extractOtpFromSms(
            input.smsBody,
            prepared.institutionName,
          );
          r = code
            ? await store.commitSmsRelay(
                req.device,
                input,
                code,
                prepared.idempotencyKey,
              )
            : { status: 'no_otp' };
        } else {
          r = prepared;
        }
      } else {
        r = await submitOtpFromSms(
          db,
          input,
          undefined,
          req.device,
        );
      }
      switch (r.status) {
        case 'unauthorized':
          return reply.code(401).send({
            error: 'access is no longer authorized',
            code: 'access_revoked',
          });
        case 'not_found':
          return reply.code(404).send({
            error: 'We couldn’t find this crawl. Refresh the page; it may have already ended or been removed.',
          });
        case 'not_active':
          return reply.code(409).send({ error: 'session is not awaiting input' });
        case 'sender_mismatch':
          // The SMS didn't come from this institution's known OTP sender — refuse without spending the LLM.
          return reply.code(409).send({ error: 'sms sender does not match the institution' });
        case 'stale_epoch':
          // The engine re-armed the relay since the companion's view — this relay is for a superseded request.
          return reply.code(409).send({ error: 'otp request has moved on' });
        case 'no_otp':
          // The LLM found no code in the body. Not an error — acknowledge so the companion stops retrying this
          // body, but the session stays waiting for the operator to type a code. 200 (not 202): nothing submitted.
          return reply.code(200).send({ status: 'no_otp' });
        case 'accepted':
          break;
      }
      // A code WAS submitted — audit it (the code itself is never recorded, only that a device relayed one).
      await (await getUserDataStore()).writeAudit({
        actorType: req.device ? 'device' : 'operator',
        actorId: req.device?.id ?? req.operatorSubject ?? null,
        action: 'session.otp_submit',
        targetType: 'session',
        targetId: id,
        sourceIp: req.ip,
      });
      return reply.code(202).send({ status: 'accepted' });
    }

    // Manual web-console entry: an operator-typed code. OPERATOR-ONLY — a device must NOT be able to POST a
    // raw { code } on this branch: that would bypass the SMS branch's sender-binding + LLM-extraction +
    // grounding and let a compromised/malicious companion submit an arbitrary code straight into the engine's
    // poll field (burning the user's 2FA attempt with a code of its choosing). The route's preHandler accepts
    // operator OR device, so we enforce operator here for the manual code path specifically; a device must go
    // through the validated SMS relay ({ smsBody, sender, otpRequestEpoch }).
    const parsed = manualOtpSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'code or { smsBody, sender, otpRequestEpoch } is required' });
    // Who may submit a raw { code }: the operator, and only the operator. A device may NOT — it must go
    // through the validated SMS relay.
    if (!req.operator) {
      return reply.code(403).send({ error: 'manual code entry is operator-only; a device must relay the SMS body' });
    }
    if (!(await actorCanAccessSession(db, req, id))) {
      return reply.code(404).send({
        error: 'We couldn’t find this crawl. Refresh the page; it may have already ended or been removed.',
      });
    }
    if (bumpOtpAttempts(id) > MAX_OTP_ATTEMPTS) {
      return reply.code(429).send({ error: 'too many otp attempts for this session' });
    }
    const headerKey = req.headers['idempotency-key'];
    const idempotencyKey = (typeof headerKey === 'string' ? headerKey : undefined) ?? parsed.data.idempotencyKey;
    const store = await getUserDataStore();
    const result = await store.submitOtp(
      id,
      parsed.data.code,
      idempotencyKey,
    );
    if (result === 'not_found') {
      return reply.code(404).send({
        error: 'We couldn’t find this crawl. Refresh the page; it may have already ended or been removed.',
      });
    }
    if (result === 'not_active') return reply.code(409).send({ error: 'session is not awaiting input' });
    // The OTP code itself is NEVER recorded — only that a code was submitted, and by whom.
    await store.writeAudit({
      actorType: 'operator',
      actorId: req.operatorSubject ?? null,
      action: 'session.otp_submit',
      targetType: 'session',
      targetId: id,
      sourceIp: req.ip,
    });
    return reply.code(202).send({ status: 'accepted' });
  });

  // Stop a running crawl in two phases. `cancelling` keeps the per-connection
  // lock while the old worker is fenced; only `cancelled` releases it.
  app.post('/api/sessions/:id/cancel', { preHandler: requireOperator }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!(await actorCanAccessSession(db, req, id))) {
      return reply.code(404).send({
        error: 'We couldn’t find this crawl. Refresh the page; it may have already ended or been removed.',
      });
    }
    const store = await getUserDataStore();
    const result = await store.cancelSession(id);
    if (result === 'not_found') {
      return reply.code(404).send({
        error: 'We couldn’t find this crawl. Refresh the page; it may have already ended or been removed.',
      });
    }
    if (result === 'already_terminal') return reply.code(409).send({ error: 'session is already finished' });
    await store.writeAudit({ actorType: 'operator', actorId: req.operatorSubject, action: 'session.cancel', targetType: 'session', targetId: id, sourceIp: req.ip });
    return reply.code(200).send({ status: 'cancelled' });
  });

  app.get('/api/sessions/:id/events', { preHandler: requireOperator }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!(await actorCanAccessSession(db, req, id))) {
      return reply.code(404).send({
        error: 'We couldn’t find this crawl. Refresh the page; it may have already ended or been removed.',
      });
    }
    const fromHeader = Number(req.headers['last-event-id']);
    const fromQuery = Number((req.query as { since?: string }).since);
    let lastSeq = Number.isFinite(fromHeader) ? fromHeader : Number.isFinite(fromQuery) ? fromQuery : 0;
    const store = await getUserDataStore();

    reply.hijack(); // we drive the raw socket from here
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });

    let closed = false;
    req.raw.on('close', () => { closed = true; });

    try {
      while (!closed) {
        const events = await store.listSessionEvents(id, lastSeq);
        for (const ev of events) {
          reply.raw.write(`id: ${ev.seq}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev.data ?? null)}\n\n`);
          lastSeq = ev.seq;
        }
        const view = await store.getSessionView(id);
        if (!view || (TERMINAL.includes(view.status) && events.length === 0)) {
          reply.raw.write(`event: end\ndata: ${JSON.stringify({ status: view?.status ?? 'gone' })}\n\n`);
          break;
        }
        reply.raw.write(': keepalive\n\n');
        await sleep(1000);
      }
    } catch {
      // client gone / write error — fall through to end()
    } finally {
      reply.raw.end();
    }
  });
}
