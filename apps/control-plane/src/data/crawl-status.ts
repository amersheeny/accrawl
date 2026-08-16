/** Storage-neutral connection statuses that may start or continue a crawl. */
export const RECOVERABLE_CONNECTION_STATUSES = [
  'connected',
  'connecting',
  'error',
  'syncing',
] as const;

export function isRecoverableConnectionStatus(status: string): boolean {
  return (RECOVERABLE_CONNECTION_STATUSES as readonly string[]).includes(status);
}
