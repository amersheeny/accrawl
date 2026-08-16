/**
 * The device-facing view of a session, for a deployment that keeps its sessions elsewhere.
 *
 * The interface lives in storage/hosted-stores.ts with the other records of its kind; this module is
 * where callers reach it, next to the PostgreSQL code they use otherwise.
 */
import {
  hostedStores,
  type DeviceSessionStore,
} from '../storage/hosted-stores';

export type { DeviceSessionStore };

/** The registered store, or undefined when this deployment keeps sessions in its own database. */
export function deviceSessionStore(): (() => Promise<DeviceSessionStore>) | undefined {
  const stores = hostedStores();
  return stores ? () => stores.deviceSessions() : undefined;
}
