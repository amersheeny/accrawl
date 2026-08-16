import { companionDataStore } from './companion-data-store';
import {
  and, asc, desc, eq, gt, inArray, lt, or, sql,
} from 'drizzle-orm';
import {
  toContractAccount, toContractTransaction,
  type ContractAccount, type ContractTransaction,
} from '@accrawl/contracts';
import { lockActiveApiKeyContext, type ApiKeyContext } from '../auth/apiKeys';
import type { Db } from '../db/client';
import {
  accounts, connections, institutions, transactions,
} from '../db/schema';
import {
  hostedCredentialStore,
  usesHostedCredentials,
} from '../auth/credential-store';
import {
  decodeCompanionCursor,
  encodeCompanionCursor,
  isCompanionTransactionCursor,
  type CompanionTransactionCursor,
} from './companion-pagination';

type CompanionReadDb = Pick<Db, 'select'>;

async function activeCompanionKey(
  db: CompanionReadDb,
  key: ApiKeyContext,
): Promise<ApiKeyContext> {
  const active = await lockActiveApiKeyContext(db, key);
  if (
    active
    && active.scopes.includes('read:companion')
    && active.deviceId
    && active.connectionGrants.length <= 100
    && !active.connectionGrants.includes('*')
  ) {
    return active;
  }
  throw new Error('invalid companion credential');
}

export interface CompanionAccount extends ContractAccount {
  institutionName: string;
  connectionNickname: string | null;
}

async function listCompanionAccountsLocked(
  db: CompanionReadDb,
  key: ApiKeyContext,
  limit: number,
  cursor?: string,
): Promise<{ items: CompanionAccount[]; nextCursor: string | null }> {
  const activeKey = await activeCompanionKey(db, key);
  const grants = activeKey.connectionGrants;
  if (grants.length === 0) return { items: [], nextCursor: null };
  const after = decodeCompanionCursor<string>(
    cursor,
    (value): value is string =>
      typeof value === 'string' && value.length > 0,
  );
  const filters = [
    eq(connections.ownerSubject, activeKey.ownerSubject),
    inArray(connections.id, grants),
  ];
  if (after) filters.push(gt(accounts.id, after));
  const rows = await db
    .select({
      id: accounts.id,
      connectionId: accounts.connectionId,
      data: accounts.data,
      missingSinceCrawlCount: accounts.missingSinceCrawlCount,
      lastSeenAt: accounts.lastSeenAt,
      institutionName: institutions.name,
      connectionNickname: connections.nickname,
    })
    .from(accounts)
    .innerJoin(connections, eq(accounts.connectionId, connections.id))
    .innerJoin(institutions, eq(connections.institutionId, institutions.id))
    .where(and(...filters))
    .orderBy(asc(accounts.id))
    .limit(limit + 1);
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  return {
    items: page.map((row) => ({
      ...toContractAccount(row),
      institutionName: row.institutionName,
      connectionNickname: row.connectionNickname,
    })),
    nextCursor: hasMore
      ? encodeCompanionCursor(page[page.length - 1].id)
      : null,
  };
}

export async function listCompanionAccounts(
  db: Db,
  key: ApiKeyContext,
  limit: number,
  cursor?: string,
): Promise<{ items: CompanionAccount[]; nextCursor: string | null }> {
  const hosted = companionDataStore();
  if (hosted) {
    return (await hosted()).listAccounts(key, limit, cursor);
  }
  return db.transaction(
    (tx) => listCompanionAccountsLocked(tx, key, limit, cursor),
  );
}

export interface CompanionTransaction extends ContractTransaction {
  connectionId: string;
  institutionName: string;
  connectionNickname: string | null;
  accountName: string | null;
}

async function listCompanionTransactionsLocked(
  db: CompanionReadDb,
  key: ApiKeyContext,
  limit: number,
  cursor?: string,
  accountId?: string,
): Promise<{ items: CompanionTransaction[]; nextCursor: string | null }> {
  const activeKey = await activeCompanionKey(db, key);
  const grants = activeKey.connectionGrants;
  if (grants.length === 0) return { items: [], nextCursor: null };
  const after = decodeCompanionCursor<CompanionTransactionCursor>(
    cursor,
    isCompanionTransactionCursor,
  );
  const filters = [
    eq(connections.ownerSubject, activeKey.ownerSubject),
    inArray(connections.id, grants),
  ];

  let selectedAccount: {
    id: string;
    connectionId: string;
    providerAccountId: string;
    name: string;
  } | null = null;
  if (accountId) {
    const [row] = await db
      .select({
        id: accounts.id,
        connectionId: accounts.connectionId,
        data: accounts.data,
      })
      .from(accounts)
      .innerJoin(connections, eq(accounts.connectionId, connections.id))
      .where(and(
        eq(accounts.id, accountId),
        eq(connections.ownerSubject, activeKey.ownerSubject),
        inArray(connections.id, grants),
      ))
      .limit(1);
    if (!row) throw new Error('account not found');
    selectedAccount = {
      id: row.id,
      connectionId: row.connectionId,
      providerAccountId: row.data.providerAccountId,
      name: row.data.name,
    };
    filters.push(eq(transactions.connectionId, row.connectionId));
    filters.push(sql`${transactions.data}->>'providerAccountId' = ${row.data.providerAccountId}`);
  }
  if (after) {
    filters.push(or(
      lt(sql`${transactions.data}->>'bookingDate'`, after.bookingDate),
      and(
        eq(sql`${transactions.data}->>'bookingDate'`, after.bookingDate),
        gt(transactions.id, after.id),
      ),
    )!);
  }

  const rows = await db
    .select({
      id: transactions.id,
      connectionId: transactions.connectionId,
      data: transactions.data,
      institutionName: institutions.name,
      connectionNickname: connections.nickname,
    })
    .from(transactions)
    .innerJoin(connections, eq(transactions.connectionId, connections.id))
    .innerJoin(institutions, eq(connections.institutionId, institutions.id))
    .where(and(...filters))
    .orderBy(desc(sql`${transactions.data}->>'bookingDate'`), asc(transactions.id))
    .limit(limit + 1);
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const connectionIds = [...new Set(page.map((row) => row.connectionId))];
  const accountRows = connectionIds.length === 0
    ? []
    : await db
      .select({ id: accounts.id, connectionId: accounts.connectionId, data: accounts.data })
      .from(accounts)
      .where(inArray(accounts.connectionId, connectionIds));
  const accountByProvider = new Map(
    accountRows.map((row) => [
      `${row.connectionId}\u0000${row.data.providerAccountId}`,
      { id: row.id, name: row.data.name },
    ]),
  );
  return {
    items: page.map((row) => {
      const linked: { id: string; name: string } | undefined = selectedAccount ?? (
        row.data.providerAccountId
          ? accountByProvider.get(`${row.connectionId}\u0000${row.data.providerAccountId}`)
          : undefined
      );
      return {
        ...toContractTransaction(row.id, row.data, linked?.id ?? null),
        connectionId: row.connectionId,
        institutionName: row.institutionName,
        connectionNickname: row.connectionNickname,
        accountName: linked?.name ?? null,
      };
    }),
    nextCursor: hasMore
      ? encodeCompanionCursor({
        bookingDate: page[page.length - 1].data.bookingDate,
        id: page[page.length - 1].id,
      })
      : null,
  };
}

export async function listCompanionTransactions(
  db: Db,
  key: ApiKeyContext,
  limit: number,
  cursor?: string,
  accountId?: string,
): Promise<{ items: CompanionTransaction[]; nextCursor: string | null }> {
  const hosted = companionDataStore();
  if (hosted) {
    return (await hosted()).listTransactions(key, limit, cursor, accountId);
  }
  return db.transaction(
    (tx) => listCompanionTransactionsLocked(
      tx,
      key,
      limit,
      cursor,
      accountId,
    ),
  );
}
