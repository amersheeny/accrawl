/**
 * The Accrawl Data API client. Authenticate with a scoped API key (`acck_…`) or an OAuth access token. The
 * credential carries the `read:data` SCOPE and CONNECTION GRANTS; a call fails with AccrawlApiError (403) if
 * it lacks either. Typical flow: listConnections → listAccounts / listTransactions or syncTransactions /
 * listHoldings.
 *
 * READ-ONLY. This client reads the data Accrawl has already retrieved and offers nothing else — no way to
 * start a retrieval, follow one, or relay a one-time passcode. Those belong to the person whose accounts
 * these are, in their own Accrawl console, and no API credential reaches them. Connections refresh on their
 * own schedule; read `lastSyncedAt` on a connection and `asOf` on a balance to see how current the data is.
 *
 * Zero runtime dependencies: uses the global fetch (Node 18+ / browsers). Pass a custom `fetch` to inject one.
 */
import { AccrawlApiError } from './errors';
import type {
  ConnectionSummary,
  ContractAccount, ContractPage, ContractTransaction, HoldingsPage, TransactionSyncPage,
} from './types';

/** The consumer endpoints this client implements — cross-checked against the OpenAPI spec by a drift test so
 *  the SDK cannot silently diverge from the API surface. All GET: the API only reads. */
export const ACCRAWL_ENDPOINTS = [
  { method: 'get', path: '/api/v1/connections' },
  { method: 'get', path: '/api/v1/connections/{id}/accounts' },
  { method: 'get', path: '/api/v1/connections/{id}/transactions' },
  { method: 'get', path: '/api/v1/connections/{id}/transactions/sync' },
  { method: 'get', path: '/api/v1/connections/{id}/holdings' },
] as const;

type FetchLike = (input: string, init?: {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}) => Promise<{ status: number; text: () => Promise<string> }>;

export interface AccrawlClientOptions {
  /** The deployment's front-door base URL, e.g. https://accrawl.example.com. */
  baseUrl: string;
  /** A scoped API key (`acck_…`). */
  apiKey: string;
  /** Inject a fetch implementation (defaults to the global fetch). */
  fetch?: FetchLike;
}

export interface Page {
  limit?: number;
  offset?: number;
}

/** Offset page + an optional booking-date window (YYYY-MM-DD) for the transactions endpoint. */
export interface TransactionQuery extends Page {
  from?: string;
  to?: string;
}

/** The transaction change-cursor query: omit `cursor` for the first page, then pass back `nextCursor`. */
export interface SyncCursor {
  cursor?: string;
  limit?: number;
}

export class AccrawlClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: FetchLike;

  constructor(opts: AccrawlClientOptions) {
    if (!opts.baseUrl) throw new Error('AccrawlClient: baseUrl is required');
    if (!opts.apiKey) throw new Error('AccrawlClient: apiKey is required');
    this.baseUrl = opts.baseUrl.replace(/\/+$/, ''); // no trailing slash
    this.apiKey = opts.apiKey;
    const f = opts.fetch ?? (globalThis.fetch as unknown as FetchLike | undefined);
    if (!f) throw new Error('AccrawlClient: no fetch available — pass opts.fetch');
    this.fetchImpl = f;
  }

  // ── Normalized data contract (v1) — the read surface (needs read:data + a grant) ──

  /** List the connections this credential may read (grant-scoped; all for the operator) — the entry point
   *  for discovering what you can read. A crawl-free projection: id, institution name/type/logo, status,
   *  nickname, last sync. */
  async listConnections(): Promise<{ items: ConnectionSummary[] }> {
    return this.request('GET', '/api/v1/connections');
  }

  /** List a connection's accounts: two-level `type`+`subtype`, a balance triple
   *  (current/available/limit), and optional credit-card / pension overlays. */
  async listAccounts(connectionId: string, page: Page = {}): Promise<ContractPage<ContractAccount>> {
    return this.request('GET', `/api/v1/connections/${enc(connectionId)}/accounts${query(page)}`);
  }

  /** List a connection's transactions, optionally windowed by booking date (`from`/`to`, inclusive,
   *  YYYY-MM-DD). */
  async listTransactions(connectionId: string, q: TransactionQuery = {}): Promise<ContractPage<ContractTransaction>> {
    return this.request('GET', `/api/v1/connections/${enc(connectionId)}/transactions${qs({ limit: q.limit, offset: q.offset, from: q.from, to: q.to })}`);
  }

  /** Fetch a page of the transaction change cursor (added/modified/removed). Omit `cursor` for the first
   *  call; pass the returned `nextCursor` back until `hasMore` is false. */
  async syncTransactions(connectionId: string, c: SyncCursor = {}): Promise<TransactionSyncPage> {
    return this.request('GET', `/api/v1/connections/${enc(connectionId)}/transactions/sync${qs({ cursor: c.cursor, limit: c.limit })}`);
  }

  /** List a connection's investment holdings plus the de-duplicated securities they reference. */
  async listHoldings(connectionId: string, page: Page = {}): Promise<HoldingsPage> {
    return this.request('GET', `/api/v1/connections/${enc(connectionId)}/holdings${query(page)}`);
  }

  private async request<T>(method: 'GET', path: string): Promise<T> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.apiKey}`, accept: 'application/json' };
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, { method, headers });
    const text = await res.text();
    const parsed = text ? safeJson(text) : undefined;
    if (res.status < 200 || res.status >= 300) {
      const message = (parsed && typeof parsed === 'object' && typeof (parsed as { error?: unknown }).error === 'string')
        ? (parsed as { error: string }).error
        : `Accrawl API error (HTTP ${res.status})`;
      throw new AccrawlApiError(res.status, message, parsed);
    }
    return parsed as T;
  }
}

function enc(segment: string): string {
  return encodeURIComponent(segment);
}

function query(page: Page): string {
  return qs({ limit: page.limit, offset: page.offset });
}

/** Build a `?a=1&b=2` query string, skipping undefined values and URL-encoding each. */
function qs(params: Record<string, string | number | undefined>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) parts.push(`${k}=${encodeURIComponent(String(v))}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text; // non-JSON body — surface as-is in the error path
  }
}
