/**
 * Who is expected to supply the 2FA code for one OTP-request episode.
 *
 * A crawl that needs 2FA arms an OTP episode BEFORE it navigates to the login page, and then waits: a
 * configured Companion must first confirm it is alive and currently holds SMS access, so a phone that is
 * merely paired-on-paper can never be mistaken for one that will catch the bank's code. That wait is the
 * right behaviour whenever a phone might answer — and a guaranteed timeout when none can, because nothing
 * exists to send the confirmation. An account with no paired phone at all would spend its entire readiness
 * window waiting for a device that cannot exist, then fail; meanwhile the console's own "enter the code"
 * box sits there, fully working, unreachable because the crawl never got as far as asking.
 *
 * So the mode is decided once, when the episode is armed, by the only side that can see the paired devices.
 * The bar for 'manual' is deliberately the unambiguous case — not one authorized device exists — rather
 * than a guess about whether a phone is reachable right now. Any authorized phone, even one with no push
 * registration, keeps the strict Companion handshake: it may already be running and polling, and a code
 * relayed from the phone is always better than asking a human to read one off a screen.
 */

/** 'companion' — wait for a phone to prove live SMS access. 'manual' — no phone can, so let the operator type it. */
export type OtpRelayMode = 'companion' | 'manual';

export interface OtpRelayModeInput {
  /**
   * Devices authorized to relay THIS connection's codes: active (not revoked), owned by the connection's
   * owner, and holding a grant for the connection — exactly the devices whose relay-status report the
   * control-plane would accept for this session.
   */
  authorizedDeviceCount: number;
}

export function otpRelayModeFor({ authorizedDeviceCount }: OtpRelayModeInput): OtpRelayMode {
  return authorizedDeviceCount > 0 ? 'companion' : 'manual';
}

/**
 * Whether an armed episode still has to wait. The engine keeps polling while a Companion is expected and
 * has not confirmed yet; in manual mode there is nothing to confirm, so the crawl proceeds immediately and
 * parks in waiting_for_otp for the operator instead.
 */
export function otpRelaySatisfied(
  input: { relayReady: boolean; mode: OtpRelayMode | null | undefined },
): boolean {
  return input.relayReady || input.mode === 'manual';
}
