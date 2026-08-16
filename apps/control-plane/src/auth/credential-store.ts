/**
 * API keys and paired devices, for a deployment that keeps them elsewhere.
 *
 * The interface lives in storage/hosted-stores.ts with the other records of its kind; this module is
 * where callers reach it, next to the PostgreSQL code they use otherwise.
 */
import { hostedStores, type CredentialStore } from '../storage/hosted-stores';

export type {
  ApiKeyView,
  CreateApiKeyRecord,
  CreateDeviceRecord,
  CredentialStore,
} from '../storage/hosted-stores';

/** The registered store, or undefined when this deployment keeps credentials in its own database. */
export function credentialStore(): (() => Promise<CredentialStore>) | undefined {
  const stores = hostedStores();
  return stores ? () => stores.credentials() : undefined;
}

/** Whether this deployment keeps these records elsewhere. */
export function usesHostedCredentials(): boolean {
  return credentialStore() !== undefined;
}

/** The registered store. Callers check {@link usesHostedCredentials} first; this throws rather than
 *  silently answering for a deployment that never registered one. */
export async function hostedCredentialStore(): Promise<CredentialStore> {
  const store = credentialStore();
  if (!store) throw new Error('this deployment keeps its credential records in its own database');
  return store();
}
