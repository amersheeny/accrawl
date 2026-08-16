/**
 * Pairing intents, for a deployment that keeps them elsewhere.
 *
 * The interface lives in storage/hosted-stores.ts with the other records of its kind; this module is
 * where callers reach it, next to the PostgreSQL code they use otherwise.
 */
import { hostedStores, type DevicePairingStore } from '../storage/hosted-stores';

export type {
  DevicePairingStore,
  PairingCredentialMaterial,
} from '../storage/hosted-stores';

/** The registered store, or undefined when this deployment keeps pairing in its own database. */
export function devicePairingStore(): (() => Promise<DevicePairingStore>) | undefined {
  const stores = hostedStores();
  return stores ? () => stores.devicePairing() : undefined;
}

/** Whether this deployment keeps these records elsewhere. */
export function usesHostedDevicePairing(): boolean {
  return devicePairingStore() !== undefined;
}

/** The registered store. Callers check {@link usesHostedDevicePairing} first; this throws rather than
 *  silently answering for a deployment that never registered one. */
export async function hostedDevicePairingStore(): Promise<DevicePairingStore> {
  const store = devicePairingStore();
  if (!store) throw new Error('this deployment keeps its device pairing records in its own database');
  return store();
}
export { usesHostedDevicePairing as usesHostedPairingStore };
export { hostedDevicePairingStore as hostedPairingStore };
