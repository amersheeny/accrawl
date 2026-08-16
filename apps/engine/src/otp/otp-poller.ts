/**
 * OTP Poller
 *
 * Two-phase OTP handling, delegated to the active platform (see ../platform):
 * 1. prepareOtpRelay() — arm the OTP source before browser navigation starts.
 * 2. pollForOtp()      — block until a 2FA code is available, then return it.
 *
 * A hosted adapter implements these via the Android OTP-relay handshake over
 * the session doc; the local adapter reads the code from a watched file / env var.
 */

import type { SessionLogger } from '../utils/logger';
import { getPlatform } from '../platform';

/**
 * Phase 1: signal that this crawl needs OTP and wait for the code source to be
 * ready. MUST be called before the browser navigates to the login page.
 */
export async function prepareOtpRelay(
  sessionId: string,
  offlineTimeoutMs = 120_000,
  busyTimeoutMs = 300_000,
  pollIntervalMs = 2_000,
  logger?: SessionLogger,
): Promise<void> {
  return getPlatform().otp.prepare(sessionId, offlineTimeoutMs, busyTimeoutMs, pollIntervalMs, logger);
}

/**
 * Phase 2: poll for the OTP code. Called when the agent signals waitForOtp
 * (after the browser has triggered the SMS send).
 */
export async function pollForOtp(
  sessionId: string,
  timeoutMs = 180_000,
  pollIntervalMs = 2_000,
  logger?: SessionLogger,
): Promise<string> {
  return getPlatform().otp.waitForOtp(sessionId, timeoutMs, pollIntervalMs, logger);
}
