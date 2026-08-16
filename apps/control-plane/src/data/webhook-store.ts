/**
 * Webhook registrations, for a deployment that keeps them elsewhere.
 *
 * The interface lives in storage/hosted-stores.ts with the other records of its kind; this module is
 * where callers reach it, next to the PostgreSQL code they use otherwise.
 */
import { hostedStores, type WebhookStore } from '../storage/hosted-stores';

export type { WebhookStore } from '../storage/hosted-stores';

/** The registered store, or undefined when this deployment keeps webhooks in its own database. */
export function webhookStore(): (() => Promise<WebhookStore>) | undefined {
  const stores = hostedStores();
  return stores ? () => stores.webhooks() : undefined;
}

/** Whether this deployment keeps these records elsewhere. */
export function usesHostedWebhooks(): boolean {
  return webhookStore() !== undefined;
}

/** The registered store. Callers check {@link usesHostedWebhooks} first; this throws rather than
 *  silently answering for a deployment that never registered one. */
export async function hostedWebhookStore(): Promise<WebhookStore> {
  const store = webhookStore();
  if (!store) throw new Error('this deployment keeps its webhook records in its own database');
  return store();
}
export { usesHostedWebhooks as usesHostedWebhookStore };
