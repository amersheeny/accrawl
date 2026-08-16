/**
 * Email-OTP routing core (tier-b of the tiered 2FA ingress). A per-deployment IMAP watcher fetches OTP
 * emails from the operator's inbox; this routes ONE fetched email to the single awaiting session whose
 * institution OTP-sender matches, reusing the SMS relay's server-side path (submitOtpFromSms does the
 * sender-binding + LLM extraction + episode/idempotency checks — the email body IS the "sms body").
 *
 * CONCURRENCY GUARD (the plan's non-negotiable): if ZERO or MULTIPLE awaiting sessions match the email's
 * sender, we DO NOT guess. A wrong code burns a bank 2FA attempt and can lock the login, so an ambiguous
 * email is skipped (logged) — crawls sharing an OTP source must be serialized/disambiguated, never guessed.
 * The IMAP connection layer + config are separate; this pure function is the routing brain, fully testable.
 */
import type { Db } from '../db/client';
import {
  listAwaitingOtpSessions,
  submitOtpFromSms,
  senderMatches,
  type AwaitingOtpSession,
  type SubmitOtpFromSmsResult,
} from '../data/session-io';

export interface IncomingEmail {
  /** The From header (display name + address, or bare address) — matched against otpSenderPattern. */
  from: string;
  subject: string;
  /** The plaintext body — handed to submitOtpFromSms exactly as an SMS body is (the LLM extracts the code). */
  text: string;
}

export type EmailRouteOutcome =
  | { action: 'submitted'; sessionId: string; result: SubmitOtpFromSmsResult }
  | { action: 'skipped'; reason: string };

export interface RouteEmailDeps {
  list?: (db: Db) => Promise<AwaitingOtpSession[]>;
  submit?: typeof submitOtpFromSms;
}

/**
 * Route one email to an awaiting session. Returns 'submitted' (the server-side path ran — its result says
 * whether the code was accepted, or e.g. no_otp / sender_mismatch / stale_epoch) or 'skipped' with a reason
 * (no match, or an ambiguous multi-match we refuse to guess on).
 */
export async function routeEmailToAwaitingSession(db: Db, email: IncomingEmail, deps: RouteEmailDeps = {}): Promise<EmailRouteOutcome> {
  const list = deps.list ?? listAwaitingOtpSessions;
  const submit = deps.submit ?? submitOtpFromSms;

  const awaiting = await list(db);
  // Only sessions whose institution has a learned OTP-sender pattern can be matched; a null pattern never
  // matches (senderMatches returns false), so those are ignored — never blindly relayed a stray OTP email.
  const matches = awaiting.filter((s) => senderMatches(email.from, s.otpSenderPattern));

  if (matches.length === 0) return { action: 'skipped', reason: 'no awaiting session matches the email sender' };
  if (matches.length > 1) {
    return { action: 'skipped', reason: `${matches.length} awaiting sessions match this sender — not guessing (serialize per OTP source)` };
  }

  const s = matches[0];
  const result = await submit(db, { sessionId: s.id, smsBody: email.text, sender: email.from, otpRequestEpoch: s.otpRequestEpoch });
  return { action: 'submitted', sessionId: s.id, result };
}
