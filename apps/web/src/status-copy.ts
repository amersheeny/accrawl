/**
 * User-visible copy introduced for session lifecycle states.
 *
 * Keep reviewed copy in this table: scripts/check-reviewed-copy.ts hashes every
 * value against the content-strategist manifest before tests or pushes pass.
 */
export const REVIEWED_STATUS_COPY = {
  cancelling: 'Stopping',
} as const;
