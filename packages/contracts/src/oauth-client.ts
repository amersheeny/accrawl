import { z } from 'zod';

/**
 * Every scope the public API can carry.
 *
 * The public API serves data Accrawl has ALREADY retrieved. It has no crawl
 * vocabulary: no run triggers, no session status, no one-time-passcode relay.
 * Retrieval is the deployment's own concern — connections refresh on their
 * schedule, and an operator or a paired device drives an ad-hoc run from the
 * console. A consumer reads what is there and learns freshness from the data
 * itself (`lastSyncedAt` on a connection, `asOf` on a balance).
 */
export const PUBLIC_API_SCOPES = [
  'read:data',
] as const;

export type PublicApiScope = (typeof PUBLIC_API_SCOPES)[number];

export function isAllowedOauthRedirectUri(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.hash || url.username || url.password) return false;
  const isLoopback = url.hostname === 'localhost'
    || url.hostname === '127.0.0.1'
    || url.hostname === '[::1]';
  return url.protocol === 'https:'
    || (url.protocol === 'http:' && isLoopback);
}

/** OAuth 2.1 permits the port of a native app's loopback redirect URI to vary.
 * Every other component, and every non-loopback redirect URI, must match the
 * registered value exactly. */
export function oauthRedirectUriMatches(
  registered: string,
  presented: string,
): boolean {
  if (registered === presented) return true;
  let expected: URL;
  let actual: URL;
  try {
    expected = new URL(registered);
    actual = new URL(presented);
  } catch {
    return false;
  }
  const loopback = expected.hostname === 'localhost'
    || expected.hostname === '127.0.0.1'
    || expected.hostname === '[::1]';
  return loopback
    && isAllowedOauthRedirectUri(registered)
    && isAllowedOauthRedirectUri(presented)
    && expected.protocol === actual.protocol
    && expected.hostname === actual.hostname
    && expected.pathname === actual.pathname
    && expected.search === actual.search;
}

export const oauthClientRegistrationSchema = z.object({
  name: z.string().trim().min(1, 'app_name_required').max(120),
  redirectUris: z
    .array(z.string())
    .min(1, 'redirect_uri_required')
    .max(10, 'too_many_redirect_uris')
    .refine((uris) => new Set(uris).size === uris.length, {
      message: 'duplicate_redirect_uris',
    })
    .refine((uris) => uris.every(isAllowedOauthRedirectUri), {
      message: 'invalid_redirect_uri',
    }),
  allowedScopes: z
    .array(z.enum(PUBLIC_API_SCOPES))
    .min(1, 'permission_required')
    .refine((scopes) => new Set(scopes).size === scopes.length, {
      message: 'duplicate_permissions',
    }),
  isPublic: z.boolean().default(false),
}).strict();

export type OauthClientRegistrationInput = z.infer<
  typeof oauthClientRegistrationSchema
>;

/** Active client metadata returned by either OAuth client-list endpoint. */
export interface OauthClientApiView {
  id: string;
  clientId: string;
  name: string;
  isPublic: boolean;
  redirectUris: string[];
  allowedScopes: string[];
  createdAt: string;
}

/** One-time credential result returned when an OAuth client is registered. */
export interface CreatedOauthClientApiView {
  id: string;
  clientId: string;
  clientSecret: string | null;
}
