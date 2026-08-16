import { describe, expect, it } from 'vitest';
import { classifyCrawlFailure } from './agent-loop';

/**
 * classifyCrawlFailure identifies a relay outage by matching the error message,
 * and the message is built in three other files. Nothing tied the two together,
 * so they drifted: every alternative in the pattern required the literal word
 * "app", but only a hosted platform says "OTP relay app". platform/remote.ts
 * — the hosted platform production runs — and platform/postgres.ts both say
 * "OTP relay did not come online within Nms".
 *
 * The result was that a user's phone being asleep at 06:00 was recorded as
 * internal_error. That happened for real on 2026-08-11T09:56Z: a scheduled
 * crawl of a live bank connection failed with "OTP relay did not come online
 * within 120000ms" and was filed as an internal defect rather than the
 * environmental outage it was. It matters beyond tidiness — retry and alerting
 * policy keys off this reason, so a misclassified outage is treated as a bug in
 * our own code and an actual bug would hide among them.
 *
 * These are the literal strings the three platforms throw. If a throw site is
 * reworded, this fails here rather than silently in production a month later.
 */
const THROWN_BY_PLATFORMS: ReadonlyArray<readonly [string, string]> = [
  // apps/engine/src/platform/remote.ts — hosted (production)
  ['remote/offline', 'OTP relay did not come online within 120000ms'],
  ['remote/not-ready', 'OTP relay did not become ready within 60000ms'],
  // apps/engine/src/platform/postgres.ts — self-host
  ['postgres/offline', 'OTP relay did not come online within 120000ms'],
  ['postgres/not-ready', 'OTP relay did not become ready within 60000ms'],
  // a hosted platform
  [
    'hosted/offline',
    'OTP relay app did not come online within 120s for session '
      + 'f95ea3e7-1f3d-40ae-a5d6-c02728d54331. Ensure the OTP relay APK is '
      + 'installed and the user is signed in.',
  ],
];

describe('OTP relay outage classification', () => {
  it.each(THROWN_BY_PLATFORMS)(
    'classifies the %s message as otp_relay_unreachable',
    (_label, message) => {
      expect(classifyCrawlFailure(new Error(message))).toBe('otp_relay_unreachable');
    },
  );

  it('still separates a late verification code from an unreachable relay', () => {
    // otp_timeout means the relay was there and the code never arrived; that is
    // a different situation with a different remedy, and collapsing the two
    // would make the reason useless for deciding what to do next.
    expect(classifyCrawlFailure(new Error('OTP timeout after 300s')))
      .toBe('otp_timeout');
    expect(classifyCrawlFailure(new Error('OTP failed after 3 attempts')))
      .toBe('otp_timeout');
  });

  it('does not label an unrelated failure as a relay outage', () => {
    // The signature branch is deliberately narrow: anything it cannot identify
    // confidently stays internal_error. A pattern loose enough to swallow
    // unrelated errors would be worse than the bug it replaced.
    expect(classifyCrawlFailure(new Error('Something else broke entirely')))
      .toBe('internal_error');
    expect(classifyCrawlFailure(new Error('relay race in the scheduler')))
      .toBe('internal_error');
  });
});
