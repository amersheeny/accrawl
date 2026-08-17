/**
 * The records a deployment keeps somewhere other than its own database.
 *
 * Five kinds of record predate the `UserDataStore` boundary and are still reached directly: credentials
 * and devices, OAuth clients and grants, webhooks, device pairing, and the device-facing view of
 * sessions. A deployment that keeps its records in this database needs none of this — every caller
 * already has PostgreSQL code for all five, and that is what runs.
 *
 * A deployment that keeps them elsewhere registers implementations here, and the callers ask this
 * registry rather than asking a configuration value what backend is in use. The difference matters: the
 * product cannot then name a particular backend, and a deployment cannot be configured for one it did
 * not supply.
 *
 * The interfaces are defined here, in the product. An implementation may map shapes and call its
 * provider; the moment it decides what is legal, that decision belongs on this side instead.
 */
import type { DeviceContext } from '../data/devices';
import type {
  AwaitingOtpSession,
  CompanionOtpWakeContext,
  RecentSessionView,
  SubmitOtpFromSmsInput,
  SubmitOtpFromSmsResult,
} from '../data/session-io';
import type { OtpRelayMode } from '../data/otp-readiness';
import type { ApiKeyContext } from '../auth/apiKeys';
import type {
  CompanionPushTarget,
  DeviceRevocation,
  DeviceView,
} from '../data/devices';
import type { AuditEntry } from '../auth/audit';
import type { OauthClientRecord } from '../auth/oauthClients';
import type { GrantView, RevokeGrantOutcome } from '../data/oauth-grants';
import type { PairingCompletion, PairingIntentView } from '../data/device-pairing';
import type { WebhookView } from '../data/webhooks';
import type { CompanionAccount, CompanionTransaction } from '../data/companion-data';

/** What `prepareSmsRelay` concluded: either a finished outcome, or a code ready to be committed. */
export type SmsRelayPreparation =
  | SubmitOtpFromSmsResult
  | { status: 'ready'; institutionName: string; idempotencyKey: string };

/**
 * The device-facing view of a crawl session: what a paired phone may see, and the two writes it may
 * make. Every method is scoped to the device that authenticated the request — a device is never shown,
 * and never able to answer for, a session it was not granted.
 */
export interface DeviceSessionStore {
  /** What a wake-up for this session needs to say, or null when the session is not awaiting a code. */
  getCompanionOtpWakeContext(sessionId: string): Promise<CompanionOtpWakeContext | null>;
  listAwaitingOtpSessions(device: DeviceContext): Promise<AwaitingOtpSession[]>;
  /**
   * Record who is expected to supply the code for one armed OTP episode. The worker clears the mode as
   * part of opening an episode, so a decision only ever describes the episode it was made for; the epoch
   * guard additionally discards a wake that was already in flight when the previous episode closed.
   */
  markOtpRelayMode(
    sessionId: string,
    otpRequestEpoch: number,
    mode: OtpRelayMode,
  ): Promise<boolean>;
  /** Explicit phone check-in for an armed OTP request. Polling the awaiting list never claims
   *  readiness; only this device-authenticated write may, after the phone has checked SMS access. */
  markOtpRelayStatus(
    device: DeviceContext,
    sessionId: string,
    smsPermission: boolean,
    ready?: boolean,
  ): Promise<boolean>;
  listRecentSessions(device: DeviceContext, limit?: number): Promise<RecentSessionView[]>;
  prepareSmsRelay(
    device: DeviceContext,
    input: SubmitOtpFromSmsInput,
  ): Promise<SmsRelayPreparation>;
  commitSmsRelay(
    device: DeviceContext,
    input: SubmitOtpFromSmsInput,
    code: string,
    idempotencyKey: string,
  ): Promise<SubmitOtpFromSmsResult>;
}


// ─── Records ────────────────────────────────────────────────────────
//
// Plain data, named here rather than inside any one implementation, because they describe what a record
// IS rather than how it is stored.

export interface CreateApiKeyRecord {
  name: string;
  ownerSubject: string;
  hashedKey: string;
  scopes: string[];
  connectionGrants: string[];
  grantId?: string | null;
  deviceId?: string | null;
  expiresAt?: Date | null;
}

export interface ApiKeyView {
  id: string;
  name: string;
  scopes: string[];
  connectionGrants: string[];
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

export interface CreateDeviceRecord {
  name: string;
  ownerSubject: string;
  hashedToken: string;
  connectionGrants: string[];
  pushTransport?: string | null;
  pushToken?: string | null;
}

export interface OauthClientView extends Omit<OauthClientRecord, 'hashedSecret'> {
  createdAt: Date;
}

export interface AuthorizationCodeRecord {
  codeHash: string;
  ownerSubject: string;
  clientId: string;
  redirectUri: string;
  scopes: string[];
  connectionGrants: string[];
  codeChallenge: string;
  codeChallengeMethod: 'S256';
  expiresAt: Date;
}

export interface OauthTokenMaterial {
  accessKeyId: string;
  accessKeyHash: string;
  refreshTokenHash: string;
  /**
   * When the ACCESS token stops working — deliberately much sooner than the grant.
   *
   * The access token is a bearer credential for somebody's financial data: whoever holds the string can
   * read it. It used to expire with the grant, so a copy taken from a log, a proxy, or a client's storage
   * stayed live for the whole ~90-day consent window, and the refresh machinery bought nothing because
   * there was never a moment the access token needed replacing. Bounding it is what makes rotation mean
   * something. The refresh token — held server-side as a hash, single-use, and rotated on every exchange —
   * remains the long-lived half.
   *
   * Never later than the grant: a token cannot outlive the consent it was issued under.
   */
  accessExpiresAt: Date;
}

export interface OauthIssuedGrant {
  id: string;
  ownerSubject: string;
  scopes: string[];
  connectionGrants: string[];
  expiresAt: Date;
}

export type OauthIssueResult =
  | { kind: 'issued'; grant: OauthIssuedGrant }
  | { kind: 'error'; description: string };

export interface OauthIntrospection {
  active: true;
  scopes: string[];
  tokenType: 'Bearer' | 'refresh_token';
  expiresAt: Date | null;
}

export interface PairingCredentialMaterial {
  deviceToken: string;
  hashedDeviceToken: string;
  financialToken: string;
  hashedFinancialToken: string;
}

// ─── The stores ─────────────────────────────────────────────────────

/**
 * API keys and paired devices — the two ways something other than a browser session proves it may act for
 * an owner. Every read is by credential digest, never by the credential itself.
 */
export interface CredentialStore {
  createApiKey(input: CreateApiKeyRecord): Promise<string>;
  verifyApiKey(hashedKey: string, now?: Date): Promise<ApiKeyContext | null>;
  refreshApiKey(context: ApiKeyContext, now?: Date): Promise<ApiKeyContext | null>;
  listApiKeys(ownerSubject: string): Promise<ApiKeyView[]>;
  revokeApiKey(id: string, ownerSubject: string): Promise<boolean>;
  createDevice(input: CreateDeviceRecord): Promise<string>;
  verifyDevice(hashedToken: string, now?: Date): Promise<DeviceContext | null>;
  refreshDevice(context: DeviceContext): Promise<DeviceContext | null>;
  listDevices(ownerSubject: string): Promise<DeviceView[]>;
  revokeDevice(id: string, ownerSubject: string, credentialHash?: string): Promise<DeviceRevocation>;
  updateDevicePush(
    context: DeviceContext,
    pushTransport: string,
    pushToken: string,
  ): Promise<boolean>;
  /** How many phones may relay a code for this connection — what decides whether a crawl waits for one. */
  countRelayAuthorizedDevices(ownerSubject: string, connectionId: string): Promise<number>;
  listCompanionPushTargets(
    ownerSubject: string,
    connectionId: string,
    deviceId?: string,
  ): Promise<CompanionPushTarget[]>;
  clearDevicePushToken(
    deviceId: string,
    ownerSubject: string,
    rejectedToken: string,
  ): Promise<boolean>;
  pickDevice(ownerSubject: string): Promise<{ id: string } | null>;
}

/** Third-party applications, the codes they exchange, and the grants an owner has given them. */
export interface OauthStore {
  createClient(record: OauthClientRecord, createdAt?: Date, audit?: AuditEntry): Promise<void>;
  createOrGetClient(
    record: OauthClientRecord,
    createdAt?: Date,
    audit?: AuditEntry,
  ): Promise<OauthClientRecord>;
  getClient(clientId: string): Promise<OauthClientRecord | null>;
  listClients(recipientTenantId?: string): Promise<OauthClientView[]>;
  deleteClient(
    id: string,
    recipientTenantId?: string,
    now?: Date,
    audit?: AuditEntry,
  ): Promise<boolean>;
  createAuthorizationCode(record: AuthorizationCodeRecord, createdAt?: Date): Promise<void>;
  /** One code, once. A second exchange of the same code must not issue a second grant. */
  exchangeAuthorizationCode(input: {
    codeHash: string;
    client: OauthClientRecord;
    redirectUri: string | undefined;
    codeVerifier: string | undefined;
    tokenMaterial: OauthTokenMaterial;
    grantExpiresAt: Date;
    now?: Date;
    sourceIp?: string | null;
  }): Promise<OauthIssueResult>;
  rotateRefreshToken(input: {
    presentedHash: string;
    client: OauthClientRecord;
    tokenMaterial: OauthTokenMaterial;
    now?: Date;
    sourceIp?: string | null;
  }): Promise<OauthIssueResult>;
  revokeToken(clientInternalId: string, tokenHash: string, now?: Date): Promise<void>;
  introspectToken(
    clientInternalId: string,
    tokenHash: string,
    now?: Date,
  ): Promise<OauthIntrospection | null>;
  listGrants(ownerSubject: string): Promise<GrantView[]>;
  getGrantClientPublicId(grantId: string, ownerSubject: string): Promise<string | null>;
  getGrantOwnerSubject(grantId: string): Promise<string | null>;
  revokeGrant(grantId: string, ownerSubject?: string, now?: Date): Promise<RevokeGrantOutcome>;
}

/**
 * Pairing a phone: the owner creates an intent, the phone claims it with the code, the owner compares the
 * verification code and approves, and only then are credentials issued.
 */
export interface DevicePairingStore {
  createIntent(input: {
    ownerSubject: string;
    name: string;
    connectionGrants: string[];
    codeHash: string;
    expiresAt: Date;
    now: Date;
  }): Promise<PairingIntentView>;
  getIntent(id: string, ownerSubject: string, now: Date): Promise<PairingIntentView | null>;
  claimIntent(input: {
    codeHash: string;
    claimHash: string;
    verificationCode: string;
    now: Date;
  }): Promise<{ status: PairingIntentView['status']; verificationCode?: string }>;
  approveIntent(
    id: string,
    ownerSubject: string,
    now: Date,
  ): Promise<PairingIntentView['status'] | null>;
  cancelIntent(id: string, ownerSubject: string, now: Date): Promise<boolean>;
  completeIntent(input: {
    codeHash: string;
    claimHash: string;
    credentials: PairingCredentialMaterial;
    now: Date;
  }): Promise<PairingCompletion>;
}

/** Where an owner's webhooks live, and the connection context a delivery is described by. */
export interface WebhookStore {
  createWebhook(input: {
    id: string;
    ownerSubject: string;
    url: string;
    secret: string;
    events: string[];
    createdAt: Date;
  }): Promise<WebhookView>;
  listWebhooks(ownerSubject: string): Promise<WebhookView[]>;
  deleteWebhook(id: string, ownerSubject: string): Promise<boolean>;
  activeWebhooksForEvent(
    event: string,
    ownerSubject: string,
  ): Promise<{ id: string; url: string; secret: string }[]>;
  getConnectionContext(connectionId: string): Promise<{
    ownerSubject: string;
    institutionId: string;
    status: string;
  } | null>;
}

/**
 * What a paired phone may read: the accounts and transactions its granted connections produced, in
 * pages. Scoped to the API key the phone presented, so a phone never sees a connection it was not
 * granted.
 */
export interface CompanionDataStore {
  listAccounts(
    key: ApiKeyContext,
    limit: number,
    cursor?: string,
  ): Promise<{ items: CompanionAccount[]; nextCursor: string | null }>;
  listTransactions(
    key: ApiKeyContext,
    limit: number,
    cursor?: string,
    accountId?: string,
  ): Promise<{ items: CompanionTransaction[]; nextCursor: string | null }>;
}

/**
 * Everything a deployment supplies when it keeps these records elsewhere. Each is resolved per request,
 * because which tenant's records these are is a property of the request being served.
 */
export interface HostedStores {
  companionData(): Promise<CompanionDataStore>;
  credentials(): Promise<CredentialStore>;
  deviceSessions(): Promise<DeviceSessionStore>;
  oauth(): Promise<OauthStore>;
  devicePairing(): Promise<DevicePairingStore>;
  webhooks(): Promise<WebhookStore>;
}

let registered: HostedStores | undefined;

/** Register the stores this deployment keeps elsewhere. Called once, before the server is built. */
export function registerHostedStores(stores: HostedStores): void {
  registered = stores;
}

/** The registered stores, or undefined when this deployment keeps its records in its own database. */
export function hostedStores(): HostedStores | undefined {
  return registered;
}

/** Test-only reset so a case can compose a different deployment. */
export function resetHostedStoresForTest(): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('resetHostedStoresForTest is available only under NODE_ENV=test');
  }
  registered = undefined;
}
