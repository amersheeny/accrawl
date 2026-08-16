/**
 * Account-centric console views over the canonical data — the Accounts page's backend.
 *
 * STRUCTURAL MODEL (kept honest — no fabricated joins):
 *  - An account row's identity is (connectionId, data.providerAccountId).
 *  - A transaction belongs to an account IFF its data.providerAccountId EXACTLY equals the account's —
 *    the linkage NormalizedTransaction declares. Every transaction that matches NO account of the
 *    connection (unattributed OR carrying an id no account has) is surfaced as the connection's
 *    UNASSIGNED bucket — the exact complement of the per-account view, so no transaction is ever
 *    invisible — never guessed onto an account.
 *  - Holdings often lack a per-account link (the bank rarely ties a position to one account), so the
 *    console presents them at the CONNECTION level via the /api/v1 holdings route — where a position
 *    does carry an account link, the contract's `accountId` exposes it, but the console view stays
 *    per-connection rather than inventing a per-account grouping.
 */
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { NormalizedAccount, NormalizedTransaction } from '@accrawl/contracts';
import type { Db } from '../db/client';
import { accounts, transactions, connections, institutions } from '../db/schema';
import { SELF_HOSTED_OPERATOR_SUBJECT } from '../auth/subjects';

export interface AccountView {
  id: string;
  connectionId: string;
  institutionName: string | null;
  nickname: string | null;
  data: NormalizedAccount;
  /** Crawls this account has been missing from (0 = seen on the latest crawl). */
  missingSinceCrawlCount: number;
  lastSeenAt: Date | null;
  updatedAt: Date | null;
}

/** Every stored account, labeled with its institution/connection — ordered for stable grouping. */
export async function listAllAccounts(
  db: Db,
  ownerSubject: string = SELF_HOSTED_OPERATOR_SUBJECT,
): Promise<AccountView[]> {
  return db
    .select({
      id: accounts.id, connectionId: accounts.connectionId,
      institutionName: institutions.name, nickname: connections.nickname,
      data: accounts.data, missingSinceCrawlCount: accounts.missingSinceCrawlCount,
      lastSeenAt: accounts.lastSeenAt, updatedAt: accounts.updatedAt,
    })
    .from(accounts)
    .innerJoin(connections, eq(accounts.connectionId, connections.id))
    .innerJoin(institutions, eq(connections.institutionId, institutions.id))
    .where(eq(connections.ownerSubject, ownerSubject))
    .orderBy(asc(institutions.name), asc(accounts.id));
}

export interface AccountTransactionsPage {
  items: Array<{ id: string; data: NormalizedTransaction }>;
  hasMore: boolean;
}

/** The connectionId an account belongs to, or null — the route's authorization anchor for API keys. */
export async function getAccountConnectionId(db: Db, accountId: string): Promise<string | null> {
  const [row] = await db.select({ connectionId: accounts.connectionId }).from(accounts).where(eq(accounts.id, accountId)).limit(1);
  return row?.connectionId ?? null;
}

/**
 * One page of an account's transactions: exact (connectionId, providerAccountId) match, newest booking
 * date first (id tiebreak keeps offset paging deterministic when dates collide).
 */
export async function listAccountTransactions(
  db: Db, accountId: string, limit: number, offset: number,
): Promise<AccountTransactionsPage | null> {
  const [acct] = await db
    .select({ connectionId: accounts.connectionId, data: accounts.data })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1);
  if (!acct) return null;
  const pid = acct.data.providerAccountId;
  const rows = await db
    .select({ id: transactions.id, data: transactions.data })
    .from(transactions)
    .where(and(
      eq(transactions.connectionId, acct.connectionId),
      sql`${transactions.data}->>'providerAccountId' = ${pid}`,
    ))
    .orderBy(desc(sql`${transactions.data}->>'bookingDate'`), asc(transactions.id))
    .limit(limit + 1)
    .offset(offset);
  return { items: rows.slice(0, limit), hasMore: rows.length > limit };
}

/**
 * A connection's transactions that link to NONE of its known accounts — the complement of the
 * per-account view, so the two together cover EVERY transaction and nothing is ever invisible. This
 * catches both (a) transactions the bank didn't attribute (providerAccountId absent/empty) AND (b)
 * transactions carrying a providerAccountId that matches no account row (e.g. the crawler tagged the
 * transaction with the account's display NAME while the account was stored under its NUMBER). Case (b)
 * must not silently disappear — a finance console showing a transaction under no account and in no
 * bucket is a data-integrity failure. Attributing them to a specific account would still be fabrication,
 * so they surface here as "not linked to an account".
 */
export async function listUnassignedTransactions(
  db: Db, connectionId: string, limit: number, offset: number,
): Promise<AccountTransactionsPage> {
  const rows = await db
    .select({ id: transactions.id, data: transactions.data })
    .from(transactions)
    .where(and(
      eq(transactions.connectionId, connectionId),
      // No account for THIS connection shares the transaction's providerAccountId. An empty/absent id
      // matches no account either (accounts always carry a non-empty id), so it's included too.
      sql`NOT EXISTS (
        SELECT 1 FROM ${accounts} a
        WHERE a.connection_id = ${transactions.connectionId}
          AND a.data->>'providerAccountId' = coalesce(${transactions.data}->>'providerAccountId', '')
      )`,
    ))
    .orderBy(desc(sql`${transactions.data}->>'bookingDate'`), asc(transactions.id))
    .limit(limit + 1)
    .offset(offset);
  return { items: rows.slice(0, limit), hasMore: rows.length > limit };
}
