/**
 * OTP State Management
 *
 * Encapsulates all OTP-related mutable state for a crawl session.
 * Replaces 6 scattered `let` variables with named reset methods.
 */

/**
 * The log line emitted when a 2FA code arrives from the relay.
 *
 * SECURITY: this MUST contain NO digit of the actual code — not even a masked prefix. The previous form
 * (`12****`, the first two digits of the OTP) leaked real code material into the session logger, which
 * persists it; two known digits meaningfully shrink the brute-force space of a short code and are needless
 * exposure of a live 2FA secret. We log only the fact that a code was received — never any of its content.
 *
 * Exported as a constant (not a digit-bearing template) so a regression test can assert it carries no digit,
 * and so both the main loop and the error-recovery path emit the identical, content-free line.
 */
export const OTP_RECEIVED_LOG = '[Agent] OTP received (two-factor code received from relay)';
/** Same fact, on the error-recovery path — kept distinct only to preserve the existing breadcrumb that the
 *  code arrived during error recovery. Still carries no digit of the code (the regression test asserts the
 *  line contains no digit at all, so even an incidental numeral like "2FA" is disallowed). */
export const OTP_RECEIVED_FROM_RECOVERY_LOG = '[Agent] OTP received (two-factor code received from relay, during error recovery)';

export class OtpState {
  cachedOtp: string | null = null;
  consumed = false;
  fillAttempted = false;
  attempts = 0;
  relayPrepared = false;
  pendingForNextStep: string | null = null;

  /** Reset after a successful action that used OTP (e.g., shouldResetOtpAfterAction) */
  resetAfterAction(): void {
    this.cachedOtp = null;
    this.consumed = false;
    this.fillAttempted = false;
  }

  /** Reset for a new login flow (e.g., loginFlowRestarted) */
  resetForNewLogin(): void {
    this.cachedOtp = null;
    this.consumed = false;
    this.fillAttempted = false;
    this.attempts = 0;
    this.pendingForNextStep = null;
  }

  /** Reset after OTP code is received from relay */
  resetAfterOtpReceived(): void {
    this.relayPrepared = false;
    this.consumed = false;
    this.fillAttempted = false;
  }

  /** Reset when requesting a fresh OTP (resend flow) */
  resetForResend(): void {
    this.cachedOtp = null;
    this.consumed = false;
    this.fillAttempted = false;
    this.pendingForNextStep = null;
  }

  /** Mark OTP as consumed after submit action */
  markConsumed(): void {
    this.consumed = true;
    this.fillAttempted = false;
  }
}
