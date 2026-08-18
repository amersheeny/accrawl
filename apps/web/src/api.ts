/** Typed control-plane API client. Self-hosted deployments store their operator
 * token in localStorage. Hosted deployments use only the edge's HttpOnly
 * session cookie. */
const TOKEN_KEY = 'accrawl.token';
const LEGACY_HOSTED_TOKEN = 'hosted-session';
let hostedSessionActive = false;
let hostedSessionProbe: Promise<boolean> | null = null;

function storedToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function removeStoredToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Hosted authentication remains authoritative in its HttpOnly cookie even
    // when browser storage is unavailable.
  }
}

export function getToken(): string | null {
  const token = storedToken();
  return token === LEGACY_HOSTED_TOKEN ? null : token;
}

export function setToken(token: string): void {
  if (token === LEGACY_HOSTED_TOKEN) {
    hostedSessionActive = true;
    removeStoredToken();
    return;
  }
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  hostedSessionActive = false;
  hostedSessionProbe = null;
  removeStoredToken();
}

export function hasAuthentication(): boolean {
  return hostedSessionActive || getToken() !== null;
}

export function restoreHostedSession(): Promise<boolean> {
  if (hostedSessionActive) return Promise.resolve(true);
  hostedSessionProbe ??= fetch('/__auth/session', {
    method: 'GET',
    headers: { accept: 'application/json' },
  }).then((response) => {
    const active = response.status === 204;
    hostedSessionActive = active;
    // Remove the marker written by older hosted releases. The verified
    // HttpOnly cookie is now the single source of authentication truth.
    if (storedToken() === LEGACY_HOSTED_TOKEN) removeStoredToken();
    return active;
  }).catch(() => false).finally(() => {
    hostedSessionProbe = null;
  });
  return hostedSessionProbe;
}
export function hostedLoginUrl(
  pathname: string,
  search = '',
  hash = '',
): string {
  const requestedReturnTo = `${pathname}${search}${hash}`;
  const returnTo = requestedReturnTo.startsWith('/')
    && !requestedReturnTo.startsWith('//')
    ? requestedReturnTo
    : '/accounts';
  return `/login?returnTo=${encodeURIComponent(returnTo)}`;
}
export async function signOut(): Promise<void> {
  if (hostedSessionActive) {
    const response = await fetch('/__auth/session', { method: 'DELETE' });
    if (!response.ok) {
      throw new Error(`Hosted session deletion failed with status ${response.status}`);
    }
  }
  clearToken();
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) { super(message); }
}

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const token = getToken();
  const res = await fetch(url, {
    method,
    headers: {
      // Only declare a JSON content-type when we actually send a body. A bodyless request (every DELETE, and
      // POSTs like cancel/otp that carry no payload) with `content-type: application/json` and an empty body
      // makes Fastify reject it with 400 "Body cannot be empty…" before the handler runs.
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) {
    // A 401 WITH a token means it expired/was revoked: clear it and hard-redirect to login (RequireAuth
    // alone won't re-render the mounted page). A 401 WITHOUT a token is a login failure — surface the
    // server's actual error (e.g. "invalid password"), never a misleading "session expired".
    const wasAuthed = hasAuthentication();
    if (wasAuthed) {
      clearToken();
      window.location.assign('/login');
      throw new ApiError(401, 'Your session expired — please sign in again.');
    }
    let msg = 'Sign in to continue.';
    try { msg = ((await res.json()) as { error?: string }).error ?? msg; } catch { /* non-JSON body */ }
    throw new ApiError(401, msg);
  }
  if (!res.ok) {
    let msg = res.statusText;
    let code: string | undefined;
    try {
      const body = (await res.json()) as { error?: string; code?: string };
      msg = body.error ?? msg;
      code = body.code;
    } catch { /* non-JSON body */ }
    throw new ApiError(res.status, msg, code);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export type ThinkingLevel = 'minimal' | 'low' | 'medium' | 'high';
export interface Institution {
  id: string; name: string; loginUrl: string; canonicalDomain: string; type: string;
  country?: string | null; requires2fa: boolean; otpSenderPattern?: string | null; allowedDomains: string[];
  model: string | null; thinkingLevel: ThinkingLevel | null; playbook: string | null;
  maxSteps: number; timeoutSeconds: number; transactionLookbackDays: number;
  source: string; scanStatus: string;
  visibility: 'published' | 'private'; ownedByViewer: boolean;
  canManage: boolean; canPublish: boolean;
}
export interface NewInstitution {
  id: string; name: string; loginUrl: string; type: string;
  country?: string; requires2fa?: boolean; otpSenderPattern?: string; allowedDomains?: string[]; playbook?: string;
  model?: string; thinkingLevel?: ThinkingLevel;
  maxSteps?: number; timeoutSeconds?: number; transactionLookbackDays?: number;
}
/** PATCH body for an institution. null on model/thinkingLevel clears the override back to the engine default. */
export type InstitutionPatch = Partial<Omit<NewInstitution, 'id' | 'model' | 'thinkingLevel'>> & {
  model?: string | null; thinkingLevel?: ThinkingLevel | null;
};
export interface CrawlStats {
  totalCount: number; completedCount: number; failedCount: number; consecutiveFailures: number;
  lastFailureReason?: string; avgCostUsd: number; recentCosts: number[]; lastSuccessfulTxCrawlDay?: string;
}
export interface Connection {
  id: string; institutionId: string; status: string; loginDomainVerified: boolean;
  nickname: string | null; crawlScheduleEnabled: boolean; crawlSchedule: string; crawlTimezone: string;
  nextCrawlAt: string | null; consecutiveFailures: number;
  safeErrorMessage: string | null; crawlStats: CrawlStats; updatedAt: string;
}
export interface NewConnection {
  institutionId: string; username: string; password: string;
  dob?: string; phone?: string; nickname?: string; crawlScheduleEnabled?: boolean;
  crawlSchedule?: string; crawlTimezone?: string;
}
export type ConnectionPatch = Partial<Omit<NewConnection, 'institutionId'>>;
export interface CrawlResult { outcome?: 'completed' | 'failed' | 'locked'; sessionId?: string; error?: string }
export interface CrawlCost {
  modelId: string; inputTokens: number; outputTokens: number;
  cacheCreationInputTokens: number; cacheReadInputTokens: number;
  inputCostUsd: number; outputCostUsd: number; cacheCreationCostUsd: number; cacheReadCostUsd: number;
  totalCostUsd: number;
}
export interface SessionView {
  id: string; connectionId: string; status: string; currentStep: string | null; stepCount: number;
  otpRequested: boolean; error: string | null;
  startedAt: string | null; completedAt: string | null; heartbeatAt: string | null; cost: CrawlCost | null;
}
export interface SessionStep {
  stepNumber: number; action: string; description: string | null; url: string | null;
  durationMs: number | null; error: string | null; hasScreenshot: boolean;
  accountsExtracted: number; transactionsExtracted: number; positionsExtracted: number; createdAt: string | null;
}
export interface SessionSummary {
  id: string; connectionId: string; status: string; stepCount: number; error: string | null;
  startedAt: string | null; completedAt: string | null; cost: CrawlCost | null;
  institutionName?: string | null; nickname?: string | null;
}
export interface NormalizedAccount {
  providerAccountId: string; name: string; description: string; currency: string; type: string; balance: number;
}
export interface NormalizedTransaction {
  providerAccountId?: string; providerTransactionId: string; bookingDate: string; amount: number;
  currency: string; merchant?: string; description: string; providerCategory?: string; isPending: boolean;
}
export interface NormalizedPosition {
  providerPositionId: string; symbol?: string; name: string; quantity: number; currency: string;
  valueNative: number; costBasisNative?: number; isin?: string; exchange?: string; securityType?: string;
}
// Normalized data API (v1): holdings + the de-duplicated securities they reference.
export interface ContractHolding {
  id: string; accountId: string | null; securityId: string; quantity: number; value: number;
  costBasis?: number; currency: string;
}
export interface ContractSecurity {
  id: string; name: string; isin?: string; ticker?: string; exchange?: string; securityType: string;
}
export interface HoldingsPage {
  holdings: ContractHolding[]; securities: ContractSecurity[]; hasMore: boolean; limit: number; offset: number;
}
export interface SessionRecords {
  counts: { accounts: number; transactions: number; positions: number };
  accounts: NormalizedAccount[]; transactions: NormalizedTransaction[]; positions: NormalizedPosition[];
}
export interface AccountView {
  id: string; connectionId: string; institutionName: string | null; nickname: string | null;
  data: NormalizedAccount; missingSinceCrawlCount: number; lastSeenAt: string | null; updatedAt: string | null;
}
export interface Device {
  id: string; name: string; pushTransport: string | null;
  connectionGrants: string[];
  pairedAt: string; lastSeenAt: string | null; revokedAt: string | null;
}
export interface DevicePairingIntent {
  id: string;
  name: string;
  connectionGrants: string[];
  expiresAt: string;
  verificationCode: string | null;
  status: 'waiting_for_phone' | 'waiting_for_approval' | 'approved' | 'expired' | 'used' | 'cancelled';
}
export interface CreatedDevicePairingIntent extends DevicePairingIntent {
  pairingCode: string;
}
export interface OAuthGrant {
  id: string;
  clientId: string | null;
  clientName: string | null;
  scopes: string[];
  connectionGrants: string[];
  status: 'active' | 'expired' | 'revoked';
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
}
export interface Page<T> { items: T[]; hasMore: boolean; limit: number; offset: number }

export const api = {
  setupStatus: () => req<{ initialized: boolean }>('GET', '/api/setup/status'),
  setup: (password: string, setupCode: string) =>
    req<{ token: string }>('POST', '/api/setup', { password, setupCode }),
  login: (password: string) => req<{ token: string }>('POST', '/api/auth/login', { password }),
  listInstitutions: () => req<{ institutions: Institution[] }>('GET', '/api/institutions'),
  createInstitution: (b: NewInstitution) => req<Institution>('POST', '/api/institutions', b),
  updateInstitution: (id: string, b: InstitutionPatch) => req<Institution>('PATCH', `/api/institutions/${encodeURIComponent(id)}`, b),
  deleteInstitution: (id: string) => req<void>('DELETE', `/api/institutions/${encodeURIComponent(id)}`),
  publishInstitution: (id: string) => req<Institution>('POST', `/api/institutions/${encodeURIComponent(id)}/publish`),
  listConnections: () => req<{ connections: Connection[] }>('GET', '/api/connections'),
  createConnection: (b: NewConnection) => req<Connection>('POST', '/api/connections', b),
  updateConnection: (id: string, b: ConnectionPatch) => req<Connection>('PATCH', `/api/connections/${id}`, b),
  deleteConnection: (id: string) => req<void>('DELETE', `/api/connections/${id}`),
  verifyDomain: (id: string, canonicalDomain: string) => req<Connection>('POST', `/api/connections/${id}/verify-domain`, { canonicalDomain }),
  crawlNow: (id: string) => req<CrawlResult>('POST', `/api/connections/${id}/crawl`),
  getSession: (id: string) => req<SessionView>('GET', `/api/sessions/${id}`),
  listSessions: () => req<{ sessions: SessionSummary[] }>('GET', '/api/sessions'),
  listConnectionSessions: (id: string) => req<{ sessions: SessionSummary[] }>('GET', `/api/connections/${id}/sessions`),
  getSessionSteps: (id: string) => req<{ steps: SessionStep[] }>('GET', `/api/sessions/${id}/steps`),
  getSessionRecords: (id: string) => req<SessionRecords>('GET', `/api/sessions/${id}/records`),
  cancelSession: (id: string) => req<{ status: string }>('POST', `/api/sessions/${id}/cancel`),
  submitOtp: (id: string, code: string, idempotencyKey: string) =>
    req<{ status: string }>('POST', `/api/sessions/${id}/otp`, { code, idempotencyKey }),
  awaitingOtp: () => req<{ sessions: Array<{ id: string; institutionName: string | null }> }>('GET', '/api/sessions/awaiting-otp'),
  listAccounts: () => req<{ accounts: AccountView[] }>('GET', '/api/accounts'),
  accountTransactions: (id: string, limit = 50, offset = 0) =>
    req<Page<{ id: string; data: NormalizedTransaction }>>('GET', `/api/accounts/${encodeURIComponent(id)}/transactions?limit=${limit}&offset=${offset}`),
  unassignedTransactions: (connectionId: string, limit = 50, offset = 0) =>
    req<Page<{ id: string; data: NormalizedTransaction }>>('GET', `/api/connections/${connectionId}/unassigned-transactions?limit=${limit}&offset=${offset}`),
  connectionHoldings: (connectionId: string, limit = 200, offset = 0) =>
    req<HoldingsPage>('GET', `/api/v1/connections/${connectionId}/holdings?limit=${limit}&offset=${offset}`),
  listDevices: () => req<{ devices: Device[] }>('GET', '/api/devices'),
  createDevicePairingIntent: (name: string, connectionGrants: string[]) =>
    req<CreatedDevicePairingIntent>('POST', '/api/devices/pairing-intents', { name, connectionGrants }),
  getDevicePairingIntent: (id: string) =>
    req<DevicePairingIntent>('GET', `/api/devices/pairing-intents/${encodeURIComponent(id)}`),
  approveDevicePairingIntent: (id: string) =>
    req<{ status: DevicePairingIntent['status'] }>(
      'POST',
      `/api/devices/pairing-intents/${encodeURIComponent(id)}/approve`,
    ),
  cancelDevicePairingIntent: (id: string) =>
    req<void>('DELETE', `/api/devices/pairing-intents/${encodeURIComponent(id)}`),
  revokeDevice: (id: string) => req<void>('DELETE', `/api/devices/${id}`),
  listOAuthGrants: () =>
    req<{ grants: OAuthGrant[] }>('GET', '/api/grants'),
  revokeOAuthGrant: (id: string) =>
    req<void>('DELETE', `/api/grants/${encodeURIComponent(id)}`),
};

/** Fetch a step screenshot as an object URL (an <img> can't send the bearer header). Returns null on 404
 *  (no screenshot / not yet written). Callers must URL.revokeObjectURL when done. */
export async function fetchScreenshot(sessionId: string, stepNumber: number): Promise<string | null> {
  const token = getToken();
  const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/steps/${stepNumber}/screenshot`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  // Only a 404 means "there is no screenshot". Reporting an auth failure or a storage error as the
  // same thing hides a broken deployment behind a tile that merely looks empty.
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`screenshot request failed: HTTP ${res.status}`);
  return URL.createObjectURL(await res.blob());
}

export interface SseEvent { type: string; data: unknown; id: string }

function safeParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return s; }
}

/**
 * Consume the operator-only SSE session stream. EventSource cannot send an Authorization header (the
 * endpoint is behind requireOperator, so a bare EventSource just 401s), so we stream via fetch with the
 * bearer and parse the SSE frames ourselves. A 401 routes through the shared auth-expiry handling.
 *
 * `sinceId` resumes after a dropped stream: the server replays every event past it (it honours both the
 * `Last-Event-ID` header and a `since` query), so a reconnect never loses events.
 *
 * Resolves when the stream ends or `signal` aborts. NOTE for callers: a clean end WITHOUT a terminal
 * event is a disconnect like any other — reconnect unless you saw `end` (the monitor handles this).
 */
export async function streamSessionEvents(id: string, onEvent: (e: SseEvent) => void, signal: AbortSignal, sinceId?: number): Promise<void> {
  const token = getToken();
  const res = await fetch(`/api/sessions/${encodeURIComponent(id)}/events`, {
    headers: {
      accept: 'text/event-stream',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(sinceId ? { 'last-event-id': String(sinceId) } : {}),
    },
    signal,
  });
  if (res.status === 401) {
    const wasAuthed = hasAuthentication();
    clearToken();
    if (wasAuthed) window.location.assign('/login');
    throw new ApiError(401, 'Your session expired — please sign in again.');
  }
  if (!res.ok || !res.body) throw new ApiError(res.status, `event stream failed (${res.status})`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buf += decoder.decode(value, { stream: true });
    buf = buf.replace(/\r\n/g, '\n'); // SSE permits CRLF; normalize so frame/line splitting works either way
    let sep: number;
    // SSE frames are separated by a blank line.
    while ((sep = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      let type = 'message';
      let data = '';
      let evId = '';
      let hasField = false; // a comment-only keepalive frame (": keepalive") carries NO fields — emit nothing
      for (const line of frame.split('\n')) {
        if (line.startsWith(':')) continue; // keepalive comment
        if (line.startsWith('event:')) { type = line.slice(6).trim(); hasField = true; }
        else if (line.startsWith('data:')) { data += (data ? '\n' : '') + line.slice(5).replace(/^ /, ''); hasField = true; }
        else if (line.startsWith('id:')) { evId = line.slice(3).trim(); hasField = true; }
      }
      if (hasField) onEvent({ type, data: safeParse(data), id: evId });
    }
  }
}
