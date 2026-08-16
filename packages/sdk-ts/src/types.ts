/**
 * Types mirroring the Accrawl Data API schemas (apps/control-plane/src/openapi/spec.ts). Optional fields
 * (`?`) match the spec's non-required properties. A drift test (in the control-plane) cross-checks the
 * endpoint surface against the spec so this SDK can't silently fall out of sync with the API it targets.
 *
 * There is no session or run type here, by design: the API serves data Accrawl already retrieved, and how it
 * was retrieved is not part of the contract.
 */

/** A connection directory entry (GET /api/v1/connections) — the crawl-free projection a consumer sees. */
export interface ConnectionSummary {
  id: string;
  /** Stable slug — a lookup key, never a label to show a person; use `institutionName` for that. */
  institutionId: string;
  institutionName: string;
  institutionType: 'bank' | 'broker' | 'retirement';
  /** Institution logo URL, or null. Untrusted display content: render it, never fetch-and-trust it. */
  institutionLogoUrl: string | null;
  status: 'connecting' | 'connected' | 'syncing' | 'needs_reauth' | 'error' | 'disabled';
  nickname: string | null;
  /** YYYY-MM-DD of the last successful transaction sync, or null. The connection's freshness signal. */
  lastSyncedAt: string | null;
}

export interface CrawlWebhookPayload {
  event: 'crawl.completed' | 'crawl.failed';
  connectionId: string;
  institutionId?: string;
  sessionId: string;
  status: 'completed' | 'failed';
  error?: string;
  /** ISO-8601. */
  occurredAt: string;
}

// ─── Normalized data contract (v1) ──────────────────────────────────────────
// Mirrors the /api/v1 response schemas (apps/control-plane/src/openapi/spec.ts). Each projected record
// carries its `id` inline, so a list page (ContractPage) holds the records themselves.

/** Two-level account taxonomy: `type` is the closed top-level enum, `subtype` refines it within that type. */
export type AccountType = 'depository' | 'credit' | 'investment' | 'pension' | 'loan' | 'other';

export type SecurityType = 'equity' | 'etf' | 'mutual_fund' | 'bond' | 'cash' | 'crypto' | 'derivative' | 'other';

/** Optional overlay on credit accounts, when the institution exposes it. */
export interface CreditCardLiability {
  aprs?: Array<{ percentage: number; type?: 'purchase' | 'cash' | 'balance_transfer' | 'penalty' | 'other' }>;
  /** YYYY-MM-DD. */
  lastStatementDate?: string;
  lastStatementBalance?: number;
  minimumPaymentAmount?: number;
  /** YYYY-MM-DD. */
  nextPaymentDueDate?: string;
}

/** Optional overlay on pension accounts, when known. */
export interface PensionDetail {
  scheme?: 'defined_benefit' | 'defined_contribution' | 'provident_fund' | 'study_fund' | 'other';
  employer?: string;
  contributionsToDate?: number;
  vestedValue?: number;
}

/** Native-currency balance triple. For credit accounts `current` is the amount owed (positive = debt). */
export interface ContractBalance {
  current: number;
  available?: number;
  limit?: number;
  /** ISO-8601 timestamp the balance was last observed. */
  asOf?: string;
}

export interface ContractAccount {
  id: string;
  connectionId: string;
  type: AccountType;
  subtype: string;
  name: string;
  description?: string;
  currency: string;
  balance: ContractBalance;
  status: 'active' | 'inactive';
  creditCardLiability?: CreditCardLiability;
  pensionDetail?: PensionDetail;
}

export interface ContractTransaction {
  id: string;
  /** Owning account (providerAccountId) or null if unlinked. */
  accountId: string | null;
  /** Institution-supplied id, passthrough only — never used as a key. */
  providerTransactionId: string | null;
  /** YYYY-MM-DD. */
  bookingDate: string;
  /** Signed, native currency; negative = outflow (bank-statement convention). */
  amount: number;
  currency: string;
  description: string;
  merchant?: string;
  status: 'posted' | 'pending';
  category?: { primary: string; detailed?: string };
  providerCategory?: string;
}

export interface ContractSecurity {
  id: string;
  name: string;
  isin?: string;
  ticker?: string;
  /** MIC or market code. */
  exchange?: string;
  securityType: SecurityType;
}

export interface ContractHolding {
  id: string;
  /** Owning account (providerAccountId) or null. */
  accountId: string | null;
  /** References a ContractSecurity.id. */
  securityId: string;
  quantity: number;
  /** Market value, native currency. */
  value: number;
  costBasis?: number;
  currency: string;
}

/** A page of contract records — each record carries its `id` inline. */
export interface ContractPage<T> {
  items: T[];
  hasMore: boolean;
  limit: number;
  offset: number;
}

/** The holdings endpoint returns holdings + the de-duplicated securities they reference, in one page. */
export interface HoldingsPage {
  holdings: ContractHolding[];
  securities: ContractSecurity[];
  hasMore: boolean;
  limit: number;
  offset: number;
}

/** One page of the transaction change cursor. `removed` carries ids only (transactions are never
 *  hard-deleted, so in practice it is always empty). */
export interface TransactionSyncPage {
  added: ContractTransaction[];
  modified: ContractTransaction[];
  removed: string[];
  nextCursor: string;
  hasMore: boolean;
}

// ─── Outbound webhook bodies ────────────────────────────────────────────────
// Webhooks are an OWNER feature: only the deployment owner can register an endpoint, and they choose where
// deliveries go. These types (and the verify helpers) are here for whoever writes that receiver. They are
// not part of the read API surface.

/** sync.succeeded / sync.failed webhook body. */
export interface SyncWebhookPayload {
  event: 'sync.succeeded' | 'sync.failed';
  connectionId: string;
  syncId: string;
  status: 'succeeded' | 'failed';
  error?: string;
  /** ISO-8601. */
  occurredAt: string;
}

/** transactions.updated webhook body — change counts only (removed is always 0). */
export interface TransactionsUpdatedPayload {
  event: 'transactions.updated';
  connectionId: string;
  syncId: string;
  added: number;
  modified: number;
  removed: number;
  /** ISO-8601. */
  occurredAt: string;
}

/** connection.status_changed webhook body. */
export interface ConnectionStatusChangedPayload {
  event: 'connection.status_changed';
  connectionId: string;
  syncId: string;
  from: string;
  to: string;
  /** ISO-8601. */
  occurredAt: string;
}

/** The retrieval-neutral webhook family (spec §13), as a discriminated union on `event`. */
export type NormalizedWebhookPayload =
  | SyncWebhookPayload
  | TransactionsUpdatedPayload
  | ConnectionStatusChangedPayload;
