/**
 * Sending a silent wake-up to the Companion app.
 *
 * The Companion is an Android app, so the wake travels over Firebase Cloud Messaging — that is the
 * transport Android gives us, and it is part of the product rather than a detail of where the server
 * runs. What differs between deployments is only how the server proves it is the sender this project
 * authorized. A self-hoster points COMPANION_PUSH_CREDENTIALS_FILE at the sender key they downloaded;
 * a deployment whose runtime already carries an identity registers a supplier that hands out tokens
 * from wherever it gets them.
 *
 * Nothing here needs a vendor SDK: the token exchange is a signed JWT, and the send is one HTTPS POST.
 */
import { createSign } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const MESSAGING_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token';
const SEND_ENDPOINT = 'https://fcm.googleapis.com/v1/projects';
/** Refresh a little before the token actually expires, so a send never races the boundary. */
const REFRESH_MARGIN_MS = 60_000;

export interface FcmDataMessage {
  token: string;
  data: Record<string, string>;
  android: { priority: 'high' };
}

/** How this deployment proves it is the authorized sender. */
export interface FcmCredentials {
  /** The FCM project the wake is sent through. */
  projectId(): Promise<string>;
  /** A bearer token for the messaging scope, and when it stops being usable (epoch millis). */
  accessToken(): Promise<{ token: string; expiresAt: number }>;
}

/**
 * Why a send failed, in terms the caller can act on. `unregistered` and `invalid-token` mean the
 * registration is dead and should be cleared; anything else is a fault to report, not a token to drop.
 */
export type FcmFailure = 'unregistered' | 'invalid-token' | 'unauthorized' | 'unavailable' | 'unknown';

export class FcmSendError extends Error {
  constructor(
    readonly failure: FcmFailure,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'FcmSendError';
  }
}

let registered: FcmCredentials | undefined;

/** Supply the credentials for a deployment whose runtime identity is not a key file. */
export function registerFcmCredentials(credentials: FcmCredentials): void {
  registered = credentials;
}

/**
 * What this deployment supplied, if anything. A deployment that composes the product can assert on
 * this at startup rather than discovering at the first wake — which is one crawl, in front of a
 * person waiting on their phone — that nothing was ever registered.
 */
export function fcmCredentials(): FcmCredentials | undefined {
  return registered;
}

/** Test-only reset so a case can compose a different deployment. */
export function resetFcmCredentialsForTest(): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('resetFcmCredentialsForTest is available only under NODE_ENV=test');
  }
  registered = undefined;
  cachedToken = undefined;
  serviceAccountPromise = undefined;
}

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  project_id: string;
  token_uri?: string;
}

let serviceAccountPromise: Promise<ServiceAccountKey> | undefined;

async function serviceAccount(): Promise<ServiceAccountKey> {
  serviceAccountPromise ??= (async () => {
    const file = process.env.COMPANION_PUSH_CREDENTIALS_FILE?.trim()
      // The name this setting had before the product stopped naming the transport in its own
      // configuration. Still answered to, so an existing install keeps working across the rename.
      || process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
    if (!file) {
      throw new Error(
        'Companion wake-ups need sender credentials. Point COMPANION_PUSH_CREDENTIALS_FILE at the '
        + 'sender key for your push project, or register credentials of your own with '
        + 'registerFcmCredentials().',
      );
    }
    const parsed = JSON.parse(await readFile(file, 'utf8')) as Partial<ServiceAccountKey>;
    if (!parsed.client_email || !parsed.private_key || !parsed.project_id) {
      throw new Error(`${file} is not a service-account key (client_email, private_key, project_id)`);
    }
    return parsed as ServiceAccountKey;
  })();
  return serviceAccountPromise;
}

function base64url(value: Buffer | string): string {
  return Buffer.from(value).toString('base64url');
}

/** The JWT-bearer exchange: sign an assertion with the key, swap it for an access token. */
async function exchangeServiceAccountKey(
  key: ServiceAccountKey,
  fetchImpl: typeof fetch,
): Promise<{ token: string; expiresAt: number }> {
  const tokenUri = key.token_uri ?? DEFAULT_TOKEN_URI;
  const issuedAt = Math.floor(Date.now() / 1000);
  const claims = {
    iss: key.client_email,
    scope: MESSAGING_SCOPE,
    aud: tokenUri,
    iat: issuedAt,
    exp: issuedAt + 3600,
  };
  const signingInput = `${base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}`
    + `.${base64url(JSON.stringify(claims))}`;
  const signature = createSign('RSA-SHA256').update(signingInput).sign(key.private_key);
  const assertion = `${signingInput}.${signature.toString('base64url')}`;

  const response = await fetchImpl(tokenUri, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }).toString(),
  });
  if (!response.ok) {
    throw new FcmSendError(
      'unauthorized',
      `FCM token exchange returned HTTP ${response.status}`,
      response.status,
    );
  }
  const body = await response.json() as { access_token?: unknown; expires_in?: unknown };
  if (typeof body.access_token !== 'string') {
    throw new FcmSendError('unauthorized', 'FCM token exchange returned no access token');
  }
  const lifetimeSeconds = typeof body.expires_in === 'number' ? body.expires_in : 3600;
  return { token: body.access_token, expiresAt: Date.now() + lifetimeSeconds * 1000 };
}

/** The key-file credentials every deployment gets unless it registers something else. */
export function serviceAccountFileCredentials(
  fetchImpl: typeof fetch = fetch,
): FcmCredentials {
  return {
    async projectId() {
      // What this deployment was told to send as, then the names that setting used to have, then the
      // project the sender key itself belongs to.
      return process.env.COMPANION_PUSH_PROJECT_ID?.trim()
        || process.env.FCM_PROJECT_ID?.trim()
        || process.env.GOOGLE_CLOUD_PROJECT?.trim()
        || (await serviceAccount()).project_id;
    },
    async accessToken() {
      return exchangeServiceAccountKey(await serviceAccount(), fetchImpl);
    },
  };
}

let cachedToken: { token: string; expiresAt: number } | undefined;

async function bearer(credentials: FcmCredentials): Promise<string> {
  if (cachedToken && cachedToken.expiresAt - REFRESH_MARGIN_MS > Date.now()) {
    return cachedToken.token;
  }
  cachedToken = await credentials.accessToken();
  return cachedToken.token;
}

/**
 * Read FCM's answer for what it says about the registration itself. A dead registration is reported
 * as an error status plus an `errorCode`, and only those two codes mean the token should be cleared —
 * treating anything else as "dead token" would silently unregister devices during an outage.
 */
function classify(status: number, body: unknown): FcmFailure {
  const error = (body as { error?: { status?: unknown; details?: unknown } } | undefined)?.error;
  const details = Array.isArray(error?.details) ? error.details : [];
  const errorCode = details
    .map((detail) => (detail as { errorCode?: unknown })?.errorCode)
    .find((code): code is string => typeof code === 'string');
  if (errorCode === 'UNREGISTERED') return 'unregistered';
  if (errorCode === 'INVALID_ARGUMENT') return 'invalid-token';
  if (status === 404) return 'unregistered';
  if (status === 400) return 'invalid-token';
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 429 || status >= 500) return 'unavailable';
  return 'unknown';
}

/**
 * Send one data message. Resolves with the message name FCM assigned; throws an {@link FcmSendError}
 * naming what went wrong so the caller can tell a dead registration from a fault.
 */
export async function sendFcmDataMessage(
  message: FcmDataMessage,
  options: { credentials?: FcmCredentials; fetchImpl?: typeof fetch } = {},
): Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const credentials = options.credentials ?? registered ?? serviceAccountFileCredentials(fetchImpl);
  const projectId = await credentials.projectId();
  const response = await fetchImpl(
    `${SEND_ENDPOINT}/${encodeURIComponent(projectId)}/messages:send`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await bearer(credentials)}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        message: {
          token: message.token,
          data: message.data,
          android: { priority: message.android.priority.toUpperCase() },
        },
      }),
    },
  );
  const body = await response.json().catch(() => undefined);
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) cachedToken = undefined;
    throw new FcmSendError(
      classify(response.status, body),
      `FCM send returned HTTP ${response.status}`,
      response.status,
    );
  }
  const name = (body as { name?: unknown } | undefined)?.name;
  return typeof name === 'string' ? name : '';
}
