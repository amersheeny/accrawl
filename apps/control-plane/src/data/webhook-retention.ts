const DAY_MS = 24 * 60 * 60 * 1_000;

/** Delivery receipts remain queryable long enough for bounded retry attempts. */
export const WEBHOOK_DELIVERY_RETENTION_MS = 7 * DAY_MS;

/**
 * A disabled hook is retained slightly longer than any delivery receipt so a
 * terminal event that predates deletion can still materialize with the exact
 * endpoint and signing secret that were active when it occurred.
 */
export const WEBHOOK_TOMBSTONE_RETENTION_MS =
  WEBHOOK_DELIVERY_RETENTION_MS + DAY_MS;
