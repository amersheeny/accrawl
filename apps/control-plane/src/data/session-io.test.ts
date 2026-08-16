import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import * as schema from '../db/schema';
import type { Db } from '../db/client';
import { actorCanAccessSession } from '../auth/authorization';
import { getSessionView, submitOtp, listSessionEvents, listAwaitingOtpSessions, markOtpRelayStatus, submitOtpFromSms, senderMatches, otpSmsIdempotencyKey } from './session-io';
import type { OtpModelCall } from './otp-extract';

/** A mock Gemini call returning a fixed `{ otp }` — stands in for the live model so these tests never hit the
 *  API. `extractedCalls` lets a test assert the model WAS / WAS NOT consulted (e.g. a sender mismatch must be
 *  rejected before spending an LLM call). */
function mockModel(otp: unknown, counter?: { n: number }): OtpModelCall {
  return async () => { if (counter) counter.n += 1; return { otp }; };
}

describe('session io (pglite)', () => {
  let client: PGlite;
  let db: Db;
  let connId: string;
  let sessionId: string;

  beforeAll(async () => {
    client = new PGlite();
    db = drizzle(client, { schema }) as unknown as Db;
    const dir = path.resolve(__dirname, '../../migrations');
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
      await client.exec(fs.readFileSync(path.join(dir, f), 'utf8'));
    }
  });
  afterAll(async () => { await client.close(); });
  beforeEach(async () => {
    await client.exec('truncate institutions cascade');
    await client.exec('truncate devices cascade');
    await client.exec(`insert into institutions (id,name,login_url,canonical_domain,type) values ('b','B','https://b.com','b.com','bank')`);
    const c = await client.query<{ id: string }>(`insert into connections (institution_id, username_ct, password_ct) values ('b','u','p') returning id`);
    connId = c.rows[0].id;
    const s = await client.query<{ id: string }>(`insert into sessions (connection_id, status, current_step, step_count) values ($1,'waiting_for_otp','Waiting for OTP',3) returning id`, [connId]);
    sessionId = s.rows[0].id;
  });

  it('getSessionView returns status/step but never the otp value', async () => {
    const v = await getSessionView(db, sessionId);
    expect(v?.status).toBe('waiting_for_otp');
    expect(v?.currentStep).toBe('Waiting for OTP');
    expect(v?.stepCount).toBe(3);
    expect(JSON.stringify(v)).not.toContain('otp_secret');
    expect(await getSessionView(db, '00000000-0000-0000-0000-000000000000')).toBeNull();
  });

  it('submitOtp writes the code while active; rejects unknown + terminal sessions', async () => {
    expect(await submitOtp(db, sessionId, '123456')).toBe('accepted');
    const [s] = await db.select().from(schema.sessions).where(eq(schema.sessions.id, sessionId));
    expect(s.otp).toBe('123456'); // the engine's OtpProvider polls this

    expect(await submitOtp(db, '00000000-0000-0000-0000-000000000000', '1')).toBe('not_found');

    await db.update(schema.sessions).set({ status: 'completed' }).where(eq(schema.sessions.id, sessionId));
    expect(await submitOtp(db, sessionId, '999')).toBe('not_active');
  });

  it('submitOtp dedupes a same-key retry into a no-op (never a second 2FA attempt)', async () => {
    expect(await submitOtp(db, sessionId, '111111', 'k1')).toBe('accepted');
    let [s] = await db.select().from(schema.sessions).where(eq(schema.sessions.id, sessionId));
    expect(s.otp).toBe('111111');

    // Engine consumed the code and advanced. A same-key retry is recognised as already-done → 'accepted'
    // (no-op) and does NOT overwrite the otp; a DIFFERENT key on a now-inactive session is 'not_active'.
    await db.update(schema.sessions).set({ status: 'extracting' }).where(eq(schema.sessions.id, sessionId));
    expect(await submitOtp(db, sessionId, '999999', 'k1')).toBe('accepted');
    [s] = await db.select().from(schema.sessions).where(eq(schema.sessions.id, sessionId));
    expect(s.otp).toBe('111111'); // unchanged — the retry was a true no-op
    expect(await submitOtp(db, sessionId, '999999', 'k2')).toBe('not_active');
  });

  it('listAwaitingOtpSessions surfaces the exact connection and OTP sender state', async () => {
    await db.update(schema.institutions).set({ otpSenderPattern: 'BANKCO' }).where(eq(schema.institutions.id, 'b'));
    await db.update(schema.connections).set({ nickname: 'Primary current' }).where(eq(schema.connections.id, connId));
    await db.update(schema.sessions).set({ otpRequestEpoch: 4, otpRequested: true }).where(eq(schema.sessions.id, sessionId));
    const awaiting = await listAwaitingOtpSessions(db);
    const entry = awaiting.find((a) => a.id === sessionId);
    expect(entry).toBeTruthy();
    expect(entry!.connectionId).toBe(connId);
    expect(entry!.institutionId).toBe('b');
    expect(entry!.institutionName).toBe('B');
    expect(entry!.connectionName).toBe('Primary current');
    expect(entry!.otpSenderPattern).toBe('BANKCO');
    expect(entry!.otpRequestEpoch).toBe(4); // the companion echoes this back so its dedupe scopes to the episode
    // Once the request is disarmed it is excluded, even if the crawl remains active.
    await db.update(schema.sessions).set({ status: 'extracting', otpRequested: false }).where(eq(schema.sessions.id, sessionId));
    expect((await listAwaitingOtpSessions(db)).find((a) => a.id === sessionId)).toBeUndefined();
  });

  it('does not return OTP sessions through a device context after that stored device is revoked', async () => {
    await db.update(schema.sessions).set({ otpRequested: true }).where(eq(schema.sessions.id, sessionId));
    const [device] = await db
      .insert(schema.devices)
      .values({
        name: 'Pixel',
        hashedToken: 'device-token-hash',
        connectionGrants: [connId],
      })
      .returning({
        id: schema.devices.id,
        name: schema.devices.name,
        ownerSubject: schema.devices.ownerSubject,
        credentialHash: schema.devices.hashedToken,
        connectionGrants: schema.devices.connectionGrants,
      });
    expect(await listAwaitingOtpSessions(db, device.ownerSubject, device))
      .toHaveLength(1);
    await db
      .update(schema.devices)
      .set({ hashedToken: 'rotated-device-token-hash' })
      .where(eq(schema.devices.id, device.id));
    expect(await listAwaitingOtpSessions(db, device.ownerSubject, device))
      .toEqual([]);
    await db
      .update(schema.devices)
      .set({ hashedToken: device.credentialHash })
      .where(eq(schema.devices.id, device.id));
    expect(await listAwaitingOtpSessions(db, device.ownerSubject, device))
      .toHaveLength(1);
    await db
      .update(schema.devices)
      .set({ revokedAt: new Date() })
      .where(eq(schema.devices.id, device.id));
    expect(await listAwaitingOtpSessions(db, device.ownerSubject, device))
      .toEqual([]);
  });

  it('marks relay readiness only after an active granted device confirms SMS access', async () => {
    const [device] = await db.insert(schema.devices).values({
      name: 'Pixel',
      hashedToken: 'relay-device-token',
      connectionGrants: [connId],
    }).returning({
      id: schema.devices.id,
      name: schema.devices.name,
      ownerSubject: schema.devices.ownerSubject,
      credentialHash: schema.devices.hashedToken,
      connectionGrants: schema.devices.connectionGrants,
    });
    await db.update(schema.sessions).set({ otpRequested: true }).where(eq(schema.sessions.id, sessionId));

    expect(await markOtpRelayStatus(db, sessionId, device, false)).toBe(true);
    let [session] = await db.select().from(schema.sessions).where(eq(schema.sessions.id, sessionId));
    expect(session.otpRelayOnline).toBe(true);
    expect(session.otpRelayReady).toBe(false);

    expect(await markOtpRelayStatus(db, sessionId, device, true, false)).toBe(true);
    [session] = await db.select().from(schema.sessions).where(eq(schema.sessions.id, sessionId));
    expect(session.otpRelayOnline).toBe(true);
    expect(session.otpRelayReady).toBe(false); // queued behind another session

    expect(await markOtpRelayStatus(db, sessionId, device, true, true)).toBe(true);
    [session] = await db.select().from(schema.sessions).where(eq(schema.sessions.id, sessionId));
    expect(session.otpRelayReady).toBe(true);

    await db.update(schema.devices).set({ revokedAt: new Date() }).where(eq(schema.devices.id, device.id));
    expect(await markOtpRelayStatus(db, sessionId, device, true, true)).toBe(false);
  });

  it('rejects OTP authorization through a cached device context after revocation', async () => {
    const [device] = await db
      .insert(schema.devices)
      .values({
        name: 'Pixel',
        hashedToken: 'device-token-hash',
        connectionGrants: [connId],
      })
      .returning({
        id: schema.devices.id,
        name: schema.devices.name,
        ownerSubject: schema.devices.ownerSubject,
        credentialHash: schema.devices.hashedToken,
        connectionGrants: schema.devices.connectionGrants,
      });
    const request = { device } as FastifyRequest;
    expect(await actorCanAccessSession(db, request, sessionId)).toBe(true);
    await db
      .update(schema.devices)
      .set({ revokedAt: new Date() })
      .where(eq(schema.devices.id, device.id));
    expect(await actorCanAccessSession(db, request, sessionId)).toBe(false);
  });

  it('submitOtp rejects an ACTIVE-but-not-awaiting session (no premature/stale code)', async () => {
    // A session that is running but has not (yet) asked for a code must not accept one, or the engine would
    // later read a stale code and burn a 2FA attempt.
    for (const status of ['starting', 'logging_in', 'navigating', 'extracting'] as const) {
      await db.update(schema.sessions).set({ status, otp: null }).where(eq(schema.sessions.id, sessionId));
      expect(await submitOtp(db, sessionId, '424242')).toBe('not_active');
      const [s] = await db.select().from(schema.sessions).where(eq(schema.sessions.id, sessionId));
      expect(s.otp).toBeNull(); // nothing written
    }
    // back to waiting_for_otp -> accepted
    await db.update(schema.sessions).set({ status: 'waiting_for_otp' }).where(eq(schema.sessions.id, sessionId));
    expect(await submitOtp(db, sessionId, '424242')).toBe('accepted');
  });

  describe('submitOtpFromSms (LLM-first SMS relay)', () => {
    // The companion now relays the RAW body + sender + the request epoch it saw; the server validates the
    // sender against the institution's learned pattern (an EXACT case-insensitive match), checks the episode,
    // LLM-extracts, and submits. The sender must EQUAL the institution's otpSenderPattern ('BANKCO').
    const SENDER = 'BANKCO';
    beforeEach(async () => {
      await db.update(schema.institutions).set({ otpSenderPattern: 'BANKCO' }).where(eq(schema.institutions.id, 'b'));
      await db.update(schema.sessions).set({ status: 'waiting_for_otp', otpRequestEpoch: 1, otp: null }).where(eq(schema.sessions.id, sessionId));
    });

    it('extracts the code and submits it (sender matches, epoch current)', async () => {
      const calls = { n: 0 };
      const r = await submitOtpFromSms(
        db,
        { sessionId, smsBody: 'Your one-time code is 1234-5678. Do not share it.', sender: SENDER, otpRequestEpoch: 1 },
        mockModel('12345678', calls),
      );
      expect(r.status).toBe('accepted');
      expect(calls.n).toBe(1); // the LLM was consulted
      const [s] = await db.select().from(schema.sessions).where(eq(schema.sessions.id, sessionId));
      expect(s.otp).toBe('12345678'); // the LLM-extracted (grouped→joined) code reached the engine's poll field
    });

    it('does NOT submit when the LLM finds no code (session stays waiting for a manual code)', async () => {
      const r = await submitOtpFromSms(
        db,
        { sessionId, smsBody: 'Your statement is ready. Balance $1,234.56', sender: SENDER, otpRequestEpoch: 1 },
        mockModel(null),
      );
      expect(r.status).toBe('no_otp');
      const [s] = await db.select().from(schema.sessions).where(eq(schema.sessions.id, sessionId));
      expect(s.otp).toBeNull(); // nothing written → the operator can still type a code
    });

    it('rejects a sender that does not match the institution pattern — BEFORE spending an LLM call', async () => {
      const calls = { n: 0 };
      const r = await submitOtpFromSms(
        db,
        { sessionId, smsBody: 'Your code is 482910', sender: 'SCAMMER', otpRequestEpoch: 1 },
        mockModel('482910', calls),
      );
      expect(r.status).toBe('sender_mismatch');
      expect(calls.n).toBe(0); // never consulted the model — sender binding gates first
      const [s] = await db.select().from(schema.sessions).where(eq(schema.sessions.id, sessionId));
      expect(s.otp).toBeNull();
    });

    it('rejects a stale request episode (the engine re-armed since the companion last polled)', async () => {
      const calls = { n: 0 };
      // The session is on epoch 2 now, but the companion still believes it is on epoch 1.
      await db.update(schema.sessions).set({ otpRequestEpoch: 2 }).where(eq(schema.sessions.id, sessionId));
      const r = await submitOtpFromSms(
        db,
        { sessionId, smsBody: 'Your code is 482910', sender: SENDER, otpRequestEpoch: 1 },
        mockModel('482910', calls),
      );
      expect(r.status).toBe('stale_epoch');
      expect(calls.n).toBe(0); // gated before the LLM
    });

    it('not_found for an unknown session; not_active once the session leaves waiting_for_otp', async () => {
      expect((await submitOtpFromSms(db, { sessionId: '00000000-0000-0000-0000-000000000000', smsBody: 'code 1234', sender: SENDER, otpRequestEpoch: 1 }, mockModel('1234'))).status).toBe('not_found');
      await db.update(schema.sessions).set({ status: 'navigating' }).where(eq(schema.sessions.id, sessionId));
      expect((await submitOtpFromSms(db, { sessionId, smsBody: 'code 1234', sender: SENDER, otpRequestEpoch: 1 }, mockModel('1234'))).status).toBe('not_active');
    });

    it('idempotency: same body within one episode is a no-op; the SAME body in a NEW episode is accepted', async () => {
      const body = 'Your verification code: 246810';
      // First relay of this body in episode 1 → submitted.
      expect((await submitOtpFromSms(db, { sessionId, smsBody: body, sender: SENDER, otpRequestEpoch: 1 }, mockModel('246810'))).status).toBe('accepted');
      let [s] = await db.select().from(schema.sessions).where(eq(schema.sessions.id, sessionId));
      expect(s.otp).toBe('246810');
      expect(s.otpIdempotencyKey).toBe(otpSmsIdempotencyKey(sessionId, 1, body));

      // Engine consumed the code and advanced. A REDELIVERY of the same body in the SAME episode is a no-op —
      // recognised by the stored key, not re-submitted, never a second 2FA attempt (and no second LLM call).
      const calls = { n: 0 };
      await db.update(schema.sessions).set({ status: 'extracting' }).where(eq(schema.sessions.id, sessionId));
      expect((await submitOtpFromSms(db, { sessionId, smsBody: body, sender: SENDER, otpRequestEpoch: 1 }, mockModel('999999', calls))).status).toBe('accepted');
      [s] = await db.select().from(schema.sessions).where(eq(schema.sessions.id, sessionId));
      expect(s.otp).toBe('246810'); // unchanged — true no-op
      expect(calls.n).toBe(0); // the duplicate short-circuited BEFORE the LLM

      // The engine re-armed for a NEW request (epoch 2, back to waiting). The SAME body (a resend of the same
      // code) now carries a different episode-scoped key, so it is NOT mistaken for the previous duplicate — it
      // is accepted and submitted again. (The code is grounded in the body, so it's the same 246810 here.)
      await db.update(schema.sessions).set({ status: 'waiting_for_otp', otpRequestEpoch: 2, otp: null }).where(eq(schema.sessions.id, sessionId));
      expect((await submitOtpFromSms(db, { sessionId, smsBody: body, sender: SENDER, otpRequestEpoch: 2 }, mockModel('246810'))).status).toBe('accepted');
      [s] = await db.select().from(schema.sessions).where(eq(schema.sessions.id, sessionId));
      expect(s.otp).toBe('246810'); // the resend accepted for the new episode (different key)
    });

    it('GROUNDING: a model code that is NOT in the SMS body is refused (no_otp) — never submits an injected code', async () => {
      // A prompt-injected body could try to make the model emit an attacker-chosen value. Even if the model
      // returns it, the server only submits a code that physically appears in the body's digits.
      const calls = { n: 0 };
      const r = await submitOtpFromSms(
        db,
        { sessionId, smsBody: 'Your code is 482910.', sender: SENDER, otpRequestEpoch: 1 },
        mockModel('000000', calls),
      );
      expect(r.status).toBe('no_otp'); // grounding refused the absent code
      expect(calls.n).toBe(1); // the model WAS consulted; the guard caught the ungrounded result after
      const [s] = await db.select().from(schema.sessions).where(eq(schema.sessions.id, sessionId));
      expect(s.otp).toBeNull(); // nothing submitted
    });

    it('does not submit when the paired device is revoked while OTP extraction is in flight', async () => {
      const [device] = await db
        .insert(schema.devices)
        .values({
          name: 'Pixel',
          hashedToken: 'device-token-hash',
          connectionGrants: [connId],
        })
        .returning({
          id: schema.devices.id,
          name: schema.devices.name,
          ownerSubject: schema.devices.ownerSubject,
          credentialHash: schema.devices.hashedToken,
          connectionGrants: schema.devices.connectionGrants,
        });
      const revokeDuringExtraction: OtpModelCall = async () => {
        await db
          .update(schema.devices)
          .set({ revokedAt: new Date() })
          .where(eq(schema.devices.id, device.id));
        return { otp: '482910' };
      };
      const result = await submitOtpFromSms(
        db,
        {
          sessionId,
          smsBody: 'Your code is 482910.',
          sender: SENDER,
          otpRequestEpoch: 1,
        },
        revokeDuringExtraction,
        device,
      );
      expect(result.status).toBe('unauthorized');
      const [stored] = await db
        .select({ otp: schema.sessions.otp })
        .from(schema.sessions)
        .where(eq(schema.sessions.id, sessionId));
      expect(stored.otp).toBeNull();
    });

    it('FAIL-SAFE: a model that throws yields no_otp, never an error out of the relay (route stays non-5xx)', async () => {
      const throwing: OtpModelCall = async () => { throw new Error('gemini timeout'); };
      const r = await submitOtpFromSms(
        db,
        { sessionId, smsBody: 'Your code is 482910.', sender: SENDER, otpRequestEpoch: 1 },
        throwing,
      );
      expect(r.status).toBe('no_otp'); // the model error degraded to "no code", not a throw
      const [s] = await db.select().from(schema.sessions).where(eq(schema.sessions.id, sessionId));
      expect(s.otp).toBeNull();
    });

    it('senderMatches is a case-insensitive EXACT match with a length floor (mirrors the companion)', () => {
      expect(senderMatches('BANKCO', 'BANKCO')).toBe(true);
      expect(senderMatches('bankco', 'BANKCO')).toBe(true); // case-insensitive
      expect(senderMatches('  BANKCO  ', 'BANKCO')).toBe(true); // trimmed
      // The whole point of the fix: a SUBSTRING is no longer a match — a spoofed sender can't piggyback.
      expect(senderMatches('FAKE-BANKCO', 'BANKCO')).toBe(false); // spoofed prefix → rejected
      expect(senderMatches('BANKCO-SMS', 'BANKCO')).toBe(false);  // suffix → rejected (was true under contains)
      expect(senderMatches('SCAMMER', 'BANKCO')).toBe(false);
      expect(senderMatches('ANY', null)).toBe(false);     // no learned pattern → never matches
      expect(senderMatches('AB', 'AB')).toBe(false);      // below the 3-char floor → never matches even if equal
    });
  });

  it('listSessionEvents replays from a seq cursor in order', async () => {
    await db.insert(schema.sessionEvents).values([
      { sessionId, seq: 1, type: 'status', data: { status: 'starting' } },
      { sessionId, seq: 2, type: 'step', data: { stepNumber: 1 } },
      { sessionId, seq: 3, type: 'otp_requested', data: {} },
    ]);
    const all = await listSessionEvents(db, sessionId, 0);
    expect(all.map((e) => e.seq)).toEqual([1, 2, 3]);
    const since1 = await listSessionEvents(db, sessionId, 1);
    expect(since1.map((e) => e.type)).toEqual(['step', 'otp_requested']);
  });
});
