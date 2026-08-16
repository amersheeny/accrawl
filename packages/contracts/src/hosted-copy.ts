/**
 * Independently reviewed user-facing copy shared by the hosted control plane
 * and crawl engine. The web copy-review gate hashes every value in this table,
 * so changing a string requires a new content-strategist review record.
 */
export const HOSTED_COPY = {
  oauthInvalidRegistration: 'Some registration fields are invalid.',
  oauthRequestVerificationFailed:
    'We couldn’t verify this request. Reload the page and try again.',
  oauthRegistrationOutcomeUnknown:
    'We couldn’t confirm whether the app was registered. Refresh the page and check the registered apps list before trying again. If a confidential app appears and you did not receive its client secret, delete that app registration and register a replacement.',
  crawlRequestBodyMustBeEmpty:
    'Request body fields aren’t supported; a crawl or refresh retrieves all financial data supported for the connection.',
  refreshAlreadyRunning: 'A refresh is already running for this connection.',
  crawlAlreadyRunning: 'A crawl is already running for this connection.',
  apiKeyCannotAccessConnection: 'This API key cannot access this connection.',
  connectionNotFound: 'Connection not found.',
  scheduleInvalid: 'Choose a valid frequency, time, and time zone.',
  refreshSessionEnded:
    'This refresh can no longer start because its session has ended.',
  crawlSessionEnded:
    'This crawl expired before it could start. Start a new crawl.',
  refreshStartFailure: "We couldn't start this refresh. Try again later.",
  crawlStartFailure: "We couldn't start this crawl. Try again later.",
  refreshUnexpectedFailure:
    "We couldn't complete this refresh. Try again later.",
  crawlUnexpectedFailure:
    "We couldn't complete this crawl. Try again later.",
  crawlStopped: 'This crawl was stopped.',
  waitingForCompanion: 'Waiting for Accrawl Companion to connect…',
  enteringOneTimeCode: 'Entering the one-time code…',
  institutionUnavailable:
    'This institution is unavailable. Contact support before trying again.',
  connectionCredentialsUnavailable:
    'This connection’s sign-in details are unavailable. Contact support before trying again.',
  crawlConnectionNotReady:
    'This connection must be enabled and signed in before the crawl can start.',
  crawlLoginDomainUnverified:
    'This institution’s login domain hasn’t been verified, so the crawl can’t start.',
  crawlLoginAddressMismatch:
    'The saved login address doesn’t match this institution’s domain.',
  crawlSafetyCheckBlocked:
    'The crawl can’t start until its safety check passes.',
  crawlPhoneRoutingNotConfigured:
    'Accrawl isn’t configured to route crawls through a phone’s network.',
  crawlCompletionDeadline:
    'The crawl didn’t finish within the allowed time.',
} as const;

/** Compile-time boundary for text that may cross a hosted user-facing surface. */
export type ReviewedHostedCopy =
  (typeof HOSTED_COPY)[keyof typeof HOSTED_COPY];
