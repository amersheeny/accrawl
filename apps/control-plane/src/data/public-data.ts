/**
 * Read-only data access for the external consumer API (scoped API keys). Returns the NORMALIZED records
 * from the canonical tables for one connection, paginated. These are the validated rows the control-plane
 * wrote after a crawl — never the raw staged extraction. Every query is connection-scoped and bounded by a
 * limit, so a key can only read its own connections' data and never trigger an unbounded scan.
 *
 * The route is responsible for authorization (the key's scope + connection grant); these helpers assume the
 * caller is already entitled to `connectionId`.
 */
import { and, asc, eq, gte, lte, sql } from 'drizzle-orm';
import {
  toContractAccount, toContractTransaction, toContractHoldingsAndSecurities,
  type ContractAccount, type ContractTransaction, type ContractHolding, type ContractSecurity,
  type TransactionSyncPage,
} from '@accrawl/contracts';
import type { Db } from '../db/client';
import { accounts, positions, transactions } from '../db/schema';
import { deterministicAccountId } from './tx-identity';

/** Default and hard-cap page sizes for the list endpoints — keep them bounded (no unbounded queries). */
export const DEFAULT_PAGE_LIMIT = 100;
export const MAX_PAGE_LIMIT = 500;
/** Hard cap on `offset` for the offset-paged endpoints. A huge offset forces Postgres to scan-and-discard
 *  that many rows per request (a resource-amplification DoS), so we reject beyond this and point deep
 *  iterators at the keyset cursor (GET …/transactions/sync). No per-connection dataset is legitimately
 *  this deep. */
export const MAX_OFFSET = 100_000;

/** Clamp a requested page size into [1, MAX_PAGE_LIMIT], falling back to the default when absent/invalid. */
export function clampLimit(requested: number | undefined): number {
  if (requested == null || !Number.isFinite(requested) || requested <= 0) return DEFAULT_PAGE_LIMIT;
  return Math.min(Math.floor(requested), MAX_PAGE_LIMIT);
}

function paginate<T>(rows: T[], limit: number): { items: T[]; hasMore: boolean } {
  const hasMore = rows.length > limit;
  return { items: hasMore ? rows.slice(0, limit) : rows, hasMore };
}

// ─── Normalized read contract (/api/v2) — projections of the stored records ───
//
// These return the crawl-free contract shapes (docs/spec-data-api.md): two-level account type,
// balance triple, holdings + securities, and a change cursor. The projections are pure
// (@accrawl/contracts); this module supplies the connection-scoped, bounded queries AND resolves a
// record's providerAccountId to the canonical account id so transactions/holdings join to accounts.

/**
 * Build a resolver from a record's providerAccountId to the canonical ContractAccount.id (accounts.id
 * is `deterministicAccountId(connectionId, providerAccountId)`). Returns null when NO such account row
 * exists in the connection, so an orphan reference (a transaction/holding pointing at an account the
 * crawl never produced) yields `accountId: null` rather than a dangling id that joins to nothing.
 */
async function loadAccountIdResolver(db: Db, connectionId: string): Promise<(providerAccountId: string) => string | null> {
  const rows = await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.connectionId, connectionId));
  const known = new Set(rows.map((r) => r.id));
  return (providerAccountId) => {
    const id = deterministicAccountId(connectionId, providerAccountId);
    return known.has(id) ? id : null;
  };
}

/** One page of a connection's accounts as ContractAccount (two-level type, balance triple, overlays). */
export async function listConnectionAccountsContract(
  db: Db, connectionId: string, limit: number, offset: number,
): Promise<{ items: ContractAccount[]; hasMore: boolean }> {
  const rows = await db
    .select({ id: accounts.id, connectionId: accounts.connectionId, data: accounts.data, missingSinceCrawlCount: accounts.missingSinceCrawlCount, lastSeenAt: accounts.lastSeenAt })
    .from(accounts)
    .where(eq(accounts.connectionId, connectionId))
    .orderBy(asc(accounts.id))
    .limit(limit + 1)
    .offset(offset);
  const { items, hasMore } = paginate(rows, limit);
  return { items: items.map(toContractAccount), hasMore };
}

/** One page of a connection's transactions as ContractTransaction, optionally windowed by [from, to]
 *  on bookingDate (inclusive, YYYY-MM-DD). Ordered by the stable primary key for deterministic paging. */
export async function listConnectionTransactionsContract(
  db: Db, connectionId: string, limit: number, offset: number, from?: string, to?: string,
): Promise<{ items: ContractTransaction[]; hasMore: boolean }> {
  const filters = [eq(transactions.connectionId, connectionId)];
  // bookingDate lives inside the JSONB payload; compare it as text (ISO dates sort lexically).
  if (from) filters.push(gte(sql`${transactions.data}->>'bookingDate'`, from));
  if (to) filters.push(lte(sql`${transactions.data}->>'bookingDate'`, to));
  const rows = await db
    .select({ id: transactions.id, data: transactions.data })
    .from(transactions)
    .where(and(...filters))
    .orderBy(asc(transactions.id))
    .limit(limit + 1)
    .offset(offset);
  const { items, hasMore } = paginate(rows, limit);
  const resolve = await loadAccountIdResolver(db, connectionId);
  return {
    items: items.map((r) => toContractTransaction(r.id, r.data, r.data.providerAccountId ? resolve(r.data.providerAccountId) : null)),
    hasMore,
  };
}

/** One page of a connection's holdings + the de-duplicated securities they reference. */
export async function listConnectionHoldings(
  db: Db, connectionId: string, limit: number, offset: number,
): Promise<{ holdings: ContractHolding[]; securities: ContractSecurity[]; hasMore: boolean }> {
  const rows = await db
    .select({ id: positions.id, data: positions.data })
    .from(positions)
    .where(eq(positions.connectionId, connectionId))
    .orderBy(asc(positions.id))
    .limit(limit + 1)
    .offset(offset);
  const { items, hasMore } = paginate(rows, limit);
  const { holdings, securities } = toContractHoldingsAndSecurities(items, await loadAccountIdResolver(db, connectionId));
  return { holdings, securities, hasMore };
}

// ── Change cursor (spec §12.2) ──
// The cursor is an opaque (updatedAt, id) watermark. A page returns every transaction whose (updatedAt,
// id) sorts after it, split into `added` (createdAt == updatedAt — never modified since insert) vs
// `modified` (updatedAt advanced past createdAt). `removed` is always empty: transactions are upsert-only
// and never hard-deleted in this model. An absent cursor starts from the beginning (full history).

const CURSOR_SEP = '\u0000';

export function encodeCursor(updatedAt: Date, id: string): string {
  return Buffer.from(`${updatedAt.toISOString()}${CURSOR_SEP}${id}`, 'utf8').toString('base64url');
}

/** Decode a cursor to its (updatedAt, id) watermark. A missing/malformed cursor → the epoch start. */
export function decodeCursor(cursor: string | undefined): { updatedAt: Date; id: string } {
  if (!cursor) return { updatedAt: new Date(0), id: '' };
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const sep = raw.indexOf(CURSOR_SEP);
    if (sep === -1) return { updatedAt: new Date(0), id: '' };
    const updatedAt = new Date(raw.slice(0, sep));
    if (Number.isNaN(updatedAt.getTime())) return { updatedAt: new Date(0), id: '' };
    return { updatedAt, id: raw.slice(sep + 1) };
  } catch {
    return { updatedAt: new Date(0), id: '' };
  }
}

export async function transactionSyncPage(
  db: Db, connectionId: string, cursor: string | undefined, limit: number,
): Promise<TransactionSyncPage> {
  const { updatedAt, id } = decodeCursor(cursor);
  const rows = await db
    .select({ id: transactions.id, data: transactions.data, createdAt: transactions.createdAt, updatedAt: transactions.updatedAt })
    .from(transactions)
    .where(and(
      eq(transactions.connectionId, connectionId),
      // Row-value comparison: strictly after the (updatedAt, id) watermark. Stable tiebreak on id.
      sql`(${transactions.updatedAt}, ${transactions.id}) > (${updatedAt.toISOString()}::timestamptz, ${id})`,
    ))
    .orderBy(asc(transactions.updatedAt), asc(transactions.id))
    .limit(limit + 1);
  const { items, hasMore } = paginate(rows, limit);

  const resolve = await loadAccountIdResolver(db, connectionId);
  const added: ContractTransaction[] = [];
  const modified: ContractTransaction[] = [];
  for (const r of items) {
    const c = toContractTransaction(r.id, r.data, r.data.providerAccountId ? resolve(r.data.providerAccountId) : null);
    if (r.createdAt.getTime() === r.updatedAt.getTime()) added.push(c);
    else modified.push(c);
  }
  const last = items[items.length - 1];
  const nextCursor = last ? encodeCursor(last.updatedAt, last.id) : (cursor ?? encodeCursor(new Date(0), ''));
  return { added, modified, removed: [], nextCursor, hasMore };
}
