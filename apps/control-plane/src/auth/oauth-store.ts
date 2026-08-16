/**
 * OAuth clients, codes and grants, for a deployment that keeps them elsewhere.
 *
 * The interface lives in storage/hosted-stores.ts with the other records of its kind; this module is
 * where callers reach it, next to the PostgreSQL code they use otherwise.
 */
import { hostedStores, type OauthStore } from '../storage/hosted-stores';

export type {
  AuthorizationCodeRecord,
  OauthClientView,
  OauthIntrospection,
  OauthIssueResult,
  OauthStore,
  OauthTokenMaterial,
} from '../storage/hosted-stores';

/** The registered store, or undefined when this deployment keeps OAuth records in its own database. */
export function oauthStore(): (() => Promise<OauthStore>) | undefined {
  const stores = hostedStores();
  return stores ? () => stores.oauth() : undefined;
}

/** Whether this deployment keeps these records elsewhere. */
export function usesHostedOauth(): boolean {
  return oauthStore() !== undefined;
}

/** The registered store. Callers check {@link usesHostedOauth} first; this throws rather than
 *  silently answering for a deployment that never registered one. */
export async function hostedOauthStore(): Promise<OauthStore> {
  const store = oauthStore();
  if (!store) throw new Error('this deployment keeps its OAuth records in its own database');
  return store();
}
export { usesHostedOauth as usesHostedOauthStore };
