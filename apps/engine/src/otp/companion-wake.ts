import type { SessionLogger } from '../utils/logger';

const WAKE_PATH = '/internal/engine/companion/otp-wake';
const WAKE_REQUEST_TIMEOUT_MS = 5_000;

type WakeLogger = Pick<SessionLogger, 'warn'>;

interface WakeClientDependencies {
  fetchImpl?: typeof fetch;
}

/**
 * Ask the control plane to wake the companion for an OTP episode that has just
 * been armed. The session id is the only caller-supplied context: the control
 * plane re-reads the live session and derives the owner, connection, device,
 * institution, and request epoch before it sends anything.
 *
 * Delivery is deliberately best-effort. The durable otpRequested session state
 * remains the source of truth and companion recovery can discover it after a
 * transient wake failure.
 */
export async function notifyCompanionOtpWake(
  sessionId: string,
  logger: WakeLogger = console,
  dependencies: WakeClientDependencies = {},
): Promise<boolean> {
  const origin = process.env.CONTROL_PLANE_INTERNAL_ORIGIN?.trim();
  if (!origin) {
    logger.warn(
      `[OTP] Companion wake request skipped for session ${sessionId}: `
      + 'CONTROL_PLANE_INTERNAL_ORIGIN is not set',
    );
    return false;
  }

  const sharedSecret = process.env.ENGINE_SHARED_SECRET?.trim();
  if (!sharedSecret) {
    logger.warn(
      `[OTP] Companion wake request skipped for session ${sessionId}: `
      + 'ENGINE_SHARED_SECRET is not set',
    );
    return false;
  }

  let endpoint: string;
  try {
    endpoint = new URL(WAKE_PATH, origin).toString();
  } catch {
    logger.warn(
      `[OTP] Companion wake request skipped for session ${sessionId}: `
      + 'CONTROL_PLANE_INTERNAL_ORIGIN is invalid',
    );
    return false;
  }

  try {
    const response = await (dependencies.fetchImpl ?? fetch)(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${sharedSecret}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ sessionId }),
      signal: AbortSignal.timeout(WAKE_REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      logger.warn(
        `[OTP] Companion wake request failed for session ${sessionId}: `
        + `control plane returned HTTP ${response.status}`,
      );
      return false;
    }
    return true;
  } catch (error) {
    // Do not include the error message: fetch implementations can echo request
    // headers in an exception, which would put ENGINE_SHARED_SECRET in logs.
    const failureKind = error instanceof Error ? error.name : 'UnknownError';
    logger.warn(
      `[OTP] Companion wake request failed for session ${sessionId}: ${failureKind}`,
    );
    return false;
  }
}
