/**
 * The normalized READ-SIDE contract (see `docs/spec-data-api.md`) and the pure projections that
 * derive it from the stored `Normalized*` records. This is the crawl-free shape Accrawl serves at
 * `/api/v1` — institutions, connections, accounts, balances, transactions, holdings, securities —
 * with retrieval never mentioned. Projections are deterministic and side-effect-free so the read
 * routes stay one-liners and the shapes can be unit-tested in isolation.
 */
import type {
  NormalizedAccount, NormalizedTransaction, NormalizedPosition, CreditCardLiability, PensionDetail,
} from './types';
import {
  mapAccountType, mapSecurityType, type AccountType, type SecurityType,
} from './taxonomy';

// ─── Contract resource shapes ───────────────────────────────────────

export interface ContractBalance {
  /** Booked/current signed balance.
   *
   * For a CREDIT account this is the amount OWED, positive — the convention the
   * published contract states and the one the industry's aggregators use, so a
   * consumer written against them reads Accrawl unchanged. A credit account in
   * credit (the issuer owes the customer) is negative. Every other type carries
   * the institution's own sign, so an overdrawn current account is negative.
   * Extraction normalises this at the source (the account schema states the
   * rule); nothing downstream re-signs a balance. */
  current: number;
  /** Spendable balance incl. pending & overdraft/credit, when known. */
  available?: number;
  /** Credit limit / arranged overdraft, when known. */
  limit?: number;
  /** ISO 8601 timestamp the balance was last observed. */
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
  accountId: string | null;
  providerTransactionId: string | null;
  bookingDate: string;
  amount: number; // signed, native currency; negative = outflow
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
  exchange?: string;
  securityType: SecurityType;
}

export interface ContractHolding {
  id: string;
  accountId: string | null;
  securityId: string;
  quantity: number;
  value: number; // market value, native currency
  costBasis?: number;
  currency: string;
}

/** One page of the change cursor (spec §12.2). `removed` carries ids only. */
export interface TransactionSyncPage {
  added: ContractTransaction[];
  modified: ContractTransaction[];
  removed: string[];
  nextCursor: string;
  hasMore: boolean;
}

/** The observable record of one refresh run (spec §12.3). */
export interface SyncView {
  id: string;
  connectionId: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  startedAt: string;
  completedAt?: string;
  counts?: { accounts?: number; transactionsAdded?: number; transactionsModified?: number };
  failureReason?: 'authentication_failed' | 'action_required' | 'institution_unavailable' | 'internal_error';
}

/** Retrieval-neutral webhook event vocabulary (spec §13). */
export const NORMALIZED_WEBHOOK_EVENTS = [
  'sync.succeeded', 'sync.failed', 'transactions.updated', 'connection.status_changed',
] as const;
export type NormalizedWebhookEvent = (typeof NORMALIZED_WEBHOOK_EVENTS)[number];

// ─── Projections (stored record → contract shape) ───────────────────

/** Compatibility threshold for older stored rows that already carry missing-crawl state.
 * New crawls do not infer inactivity from omission alone. */
export const ACCOUNT_INACTIVE_MISSING_THRESHOLD = 2;

export interface StoredAccountRow {
  id: string;
  connectionId: string;
  data: NormalizedAccount;
  missingSinceCrawlCount?: number;
  lastSeenAt?: Date | string | null;
}

export function toContractAccount(row: StoredAccountRow): ContractAccount {
  const d = row.data;
  const { type, subtype } = mapAccountType(d.type);
  const asOf = row.lastSeenAt instanceof Date ? row.lastSeenAt.toISOString()
    : (typeof row.lastSeenAt === 'string' ? row.lastSeenAt : undefined);
  const missing = row.missingSinceCrawlCount ?? 0;
  return {
    id: row.id,
    connectionId: row.connectionId,
    type,
    subtype,
    name: d.name,
    ...(d.description ? { description: d.description } : {}),
    currency: d.currency,
    balance: {
      current: d.balance,
      ...(d.available !== undefined ? { available: d.available } : {}),
      ...(d.limit !== undefined ? { limit: d.limit } : {}),
      ...(asOf ? { asOf } : {}),
    },
    status: missing >= ACCOUNT_INACTIVE_MISSING_THRESHOLD ? 'inactive' : 'active',
    ...(d.creditCardLiability ? { creditCardLiability: d.creditCardLiability } : {}),
    ...(d.pensionDetail ? { pensionDetail: d.pensionDetail } : {}),
  };
}

/**
 * Project a stored transaction. `accountId` is the CANONICAL account id (`ContractAccount.id`) the caller
 * resolved from the record's `providerAccountId`, or null if unlinked — NOT the raw provider id, so a
 * consumer can join transactions to the account resource (spec §11: provider ids are never keys).
 */
export function toContractTransaction(id: string, data: NormalizedTransaction, accountId: string | null): ContractTransaction {
  return {
    id,
    accountId,
    providerTransactionId: data.providerTransactionId ?? null,
    bookingDate: data.bookingDate,
    amount: data.amount,
    currency: data.currency,
    description: data.description,
    ...(data.merchant ? { merchant: data.merchant } : {}),
    status: data.isPending ? 'pending' : 'posted',
    ...(data.category ? { category: data.category } : {}),
    ...(data.providerCategory ? { providerCategory: data.providerCategory } : {}),
  };
}

/**
 * Stable security id shared across holdings of the same instrument. Identity precedence (spec §8):
 * ISIN › ticker+exchange › the provider position id (last resort, per-position). A bare ticker WITHOUT an
 * exchange is NOT an identity — two unrelated instruments can share a symbol across venues — so it falls
 * through to the per-position id rather than falsely merging them into one security.
 */
export function securityIdFor(data: NormalizedPosition): string {
  if (data.isin) return `isin:${data.isin.toUpperCase()}`;
  if (data.symbol && data.exchange) return `ticker:${data.exchange.toUpperCase()}:${data.symbol.toUpperCase()}`;
  return `pos:${data.providerPositionId}`;
}

/** Project a stored position into a holding. `accountId` is the caller-resolved canonical account id (or
 *  null if unlinked) — see {@link toContractTransaction}. */
export function toContractHolding(id: string, data: NormalizedPosition, accountId: string | null): ContractHolding {
  return {
    id,
    accountId,
    securityId: securityIdFor(data),
    quantity: data.quantity,
    value: data.valueNative,
    ...(data.costBasisNative !== undefined ? { costBasis: data.costBasisNative } : {}),
    currency: data.currency,
  };
}

export function toContractSecurity(data: NormalizedPosition): ContractSecurity {
  return {
    id: securityIdFor(data),
    name: data.name,
    ...(data.isin ? { isin: data.isin } : {}),
    ...(data.symbol ? { ticker: data.symbol } : {}),
    ...(data.exchange ? { exchange: data.exchange } : {}),
    securityType: mapSecurityType(data.securityType),
  };
}

/**
 * Project a set of position rows into holdings + a de-duplicated securities list. Multiple holdings
 * that resolve to the same `securityId` (e.g. same ISIN across sub-accounts) share one Security.
 * `resolveAccountId` maps a record's `providerAccountId` to the canonical `ContractAccount.id`, or
 * null when no such account exists in the connection (an orphan reference must not dangle) — so every
 * non-null `accountId` joins to the account resource (spec §11).
 */
export function toContractHoldingsAndSecurities(
  rows: Array<{ id: string; data: NormalizedPosition }>,
  resolveAccountId: (providerAccountId: string) => string | null,
): { holdings: ContractHolding[]; securities: ContractSecurity[] } {
  const holdings = rows.map((r) => toContractHolding(
    r.id, r.data, r.data.providerAccountId ? resolveAccountId(r.data.providerAccountId) : null,
  ));
  const securities = new Map<string, ContractSecurity>();
  for (const r of rows) {
    const sec = toContractSecurity(r.data);
    if (!securities.has(sec.id)) securities.set(sec.id, sec);
  }
  return { holdings, securities: [...securities.values()] };
}
