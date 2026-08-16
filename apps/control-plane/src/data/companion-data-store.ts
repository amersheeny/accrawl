/**
 * The phone-facing accounts and transactions view, for a deployment that keeps its records elsewhere.
 *
 * The interface lives in storage/hosted-stores.ts with the other records of its kind; this module is
 * where callers reach it, next to the PostgreSQL code they use otherwise.
 */
import { hostedStores, type CompanionDataStore } from '../storage/hosted-stores';

export type { CompanionDataStore } from '../storage/hosted-stores';

/** The registered store, or undefined when this deployment reads these from its own database. */
export function companionDataStore(): (() => Promise<CompanionDataStore>) | undefined {
  const stores = hostedStores();
  return stores ? () => stores.companionData() : undefined;
}
