import { describe, it, expect, vi } from 'vitest';
import { routeEmailToAwaitingSession, type IncomingEmail } from './route-email';
import type { AwaitingOtpSession, SubmitOtpFromSmsResult } from '../data/session-io';
import type { Db } from '../db/client';

const db = {} as Db;
const email = (from: string, text = 'Your code is 123456'): IncomingEmail => ({ from, subject: 'Verification code', text });
const session = (id: string, otpSenderPattern: string | null, otpRequestEpoch = 1): AwaitingOtpSession =>
  ({
    id,
    connectionId: 'connection-1',
    institutionId: 'bank',
    institutionName: 'Bank',
    connectionName: null,
    otpSenderPattern,
    otpRequestEpoch,
    status: 'waiting_for_otp',
  });

function deps(awaiting: AwaitingOtpSession[], submitResult: SubmitOtpFromSmsResult = { status: 'accepted' }) {
  const submit = vi.fn(async () => submitResult);
  return { list: async () => awaiting, submit, _submit: submit };
}

describe('routeEmailToAwaitingSession', () => {
  it('submits to the single awaiting session whose sender exactly matches, passing the email body as the sms body', async () => {
    const d = deps([session('s1', 'noreply@northwind-bank.com', 7)]);
    const out = await routeEmailToAwaitingSession(db, email('noreply@northwind-bank.com'), d);
    expect(out).toEqual({ action: 'submitted', sessionId: 's1', result: { status: 'accepted' } });
    expect(d._submit).toHaveBeenCalledWith(db, { sessionId: 's1', smsBody: 'Your code is 123456', sender: 'noreply@northwind-bank.com', otpRequestEpoch: 7 });
  });

  it('matches case-insensitively + trimmed (exact, not substring)', async () => {
    const d = deps([session('s1', 'noreply@northwind-bank.com')]);
    const out = await routeEmailToAwaitingSession(db, email('  NOREPLY@Northwind-Bank.com '), d);
    expect(out.action).toBe('submitted');
  });

  it('does NOT match a spoofed lookalike sender (exact equality closes the substring bypass)', async () => {
    const d = deps([session('s1', 'noreply@northwind-bank.com')]);
    const out = await routeEmailToAwaitingSession(db, email('noreply@northwind-bank.com.attacker.io'), d);
    expect(out).toEqual({ action: 'skipped', reason: 'no awaiting session matches the email sender' });
    expect(d._submit).not.toHaveBeenCalled();
  });

  it('skips (no guess) when NO awaiting session matches', async () => {
    const d = deps([session('s1', 'someone-else@other-bank.com')]);
    const out = await routeEmailToAwaitingSession(db, email('noreply@northwind-bank.com'), d);
    expect(out.action).toBe('skipped');
    expect(d._submit).not.toHaveBeenCalled();
  });

  it('skips (no guess) when MULTIPLE awaiting sessions match the same sender — the concurrency guard', async () => {
    const d = deps([session('s1', 'noreply@northwind-bank.com'), session('s2', 'noreply@northwind-bank.com')]);
    const out = await routeEmailToAwaitingSession(db, email('noreply@northwind-bank.com'), d);
    expect(out.action).toBe('skipped');
    expect((out as { reason: string }).reason).toMatch(/not guessing/i);
    expect(d._submit).not.toHaveBeenCalled();
  });

  it('ignores sessions with a null OTP-sender pattern (never blindly relays a stray OTP email)', async () => {
    const d = deps([session('s1', null)]);
    const out = await routeEmailToAwaitingSession(db, email('noreply@northwind-bank.com'), d);
    expect(out.action).toBe('skipped');
    expect(d._submit).not.toHaveBeenCalled();
  });

  it('passes the server-side outcome through (e.g. no_otp — the LLM found no code)', async () => {
    const d = deps([session('s1', 'noreply@northwind-bank.com')], { status: 'no_otp' });
    const out = await routeEmailToAwaitingSession(db, email('noreply@northwind-bank.com', 'Your statement is ready'), d);
    expect(out).toEqual({ action: 'submitted', sessionId: 's1', result: { status: 'no_otp' } });
  });
});
