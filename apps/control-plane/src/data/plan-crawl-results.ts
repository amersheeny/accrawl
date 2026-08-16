import type {
  NormalizedAccount,
  NormalizedPosition,
  NormalizedTransaction,
} from '@accrawl/contracts';
import {
  CrawledAccountSchema,
  CrawledPositionSchema,
  CrawledTransactionSchema,
  mergeAccountData,
  mergePositionData,
  mergePresentFields,
  stagedTransactionForStore,
  validateRecords,
  type StoreCrawlResult,
} from './store-crawl';
import {
  assignTransactionId,
  canonicalUpdateKey,
  deterministicAccountId,
  deterministicOccurrenceId,
  deterministicPositionId,
  deriveTransactionCutoffDate,
  isBankProvidedId,
  resolveAuthoritativeTransactionUpdateTargets,
  type TxIdentityInput,
} from './tx-identity';

export interface ExistingCanonicalRecord<T, TTimestamp = unknown> {
  id: string;
  data: T;
  missingSinceCrawlCount?: number;
  lastSeenAt?: TTimestamp;
  createdAt?: TTimestamp;
  updatedAt?: TTimestamp;
}

export interface PlannedCanonicalRecord<T, TTimestamp = unknown> {
  id: string;
  data: T;
  previous?: ExistingCanonicalRecord<T, TTimestamp>;
  observed?: boolean;
}

export interface PlannedOccurrenceClaim {
  occurrenceId: string;
  transactionId: string;
}

export interface CrawlPromotionPlan<TTimestamp = unknown> {
  accounts: Array<PlannedCanonicalRecord<NormalizedAccount, TTimestamp>>;
  transactions: Array<PlannedCanonicalRecord<NormalizedTransaction, TTimestamp>>;
  positions: Array<PlannedCanonicalRecord<NormalizedPosition, TTimestamp>>;
  occurrenceClaims: PlannedOccurrenceClaim[];
  result: StoreCrawlResult;
}

export interface PlanCrawlResultsInput<TTimestamp = unknown> {
  connectionId: string;
  occurrenceScopeId: string;
  accounts: unknown[];
  transactions: unknown[];
  positions: unknown[];
  existingAccounts: Array<ExistingCanonicalRecord<NormalizedAccount, TTimestamp>>;
  existingTransactions: Array<ExistingCanonicalRecord<NormalizedTransaction, TTimestamp>>;
  existingPositions: Array<ExistingCanonicalRecord<NormalizedPosition, TTimestamp>>;
  authoritativeUpdateTargets: ReadonlyMap<string, ReadonlySet<string>>;
  occurrenceClaims?: ReadonlyMap<string, string>;
}

/**
 * Pure, deterministic canonical-promotion planner for the hosted
 * copy-on-write path. It mirrors the evidence-backed transaction identity
 * rules enforced by storeCrawlResults without mutating the active generation.
 */
export function planCrawlResults<TTimestamp = unknown>(
  input: PlanCrawlResultsInput<TTimestamp>,
): CrawlPromotionPlan<TTimestamp> {
  const va = validateRecords(CrawledAccountSchema, input.accounts, 'account');
  const vt = validateRecords(
    CrawledTransactionSchema,
    input.transactions.map((transaction, index) =>
      stagedTransactionForStore({
        id: deterministicOccurrenceId(input.occurrenceScopeId, index),
        data: transaction,
      })),
    'transaction',
  );
  const vp = validateRecords(CrawledPositionSchema, input.positions, 'position');
  const validTransactions = vt.valid;

  const existingAccountsById = new Map(
    input.existingAccounts.map((record) => [record.id, record]),
  );
  const accountsById = new Map<string, PlannedCanonicalRecord<
    NormalizedAccount,
    TTimestamp
  >>(
    input.existingAccounts.map((record) => [
      record.id,
      { id: record.id, data: record.data, previous: record },
    ]),
  );
  for (const observed of va.valid) {
    const id = deterministicAccountId(
      input.connectionId,
      observed.providerAccountId,
    );
    const previous = existingAccountsById.get(id);
    accountsById.set(id, {
      id,
      data: mergeAccountData(previous?.data, observed),
      previous,
      observed: true,
    });
  }

  const storedById = new Map(
    input.existingTransactions.map((record) => [record.id, record.data]),
  );
  const originalTransactions = new Map(
    input.existingTransactions.map((record) => [record.id, record]),
  );
  const rowIdsByCanonical = new Map<string, Set<string>>();
  const addCanonicalOwner = (
    id: string,
    data: NormalizedTransaction,
  ): void => {
    const key = canonicalUpdateKey(
      data.providerAccountId,
      data.providerTransactionId,
    );
    const owners = rowIdsByCanonical.get(key);
    if (owners) owners.add(id);
    else rowIdsByCanonical.set(key, new Set([id]));
  };
  const removeCanonicalOwner = (
    id: string,
    data: NormalizedTransaction,
  ): void => {
    const key = canonicalUpdateKey(
      data.providerAccountId,
      data.providerTransactionId,
    );
    const owners = rowIdsByCanonical.get(key);
    if (!owners) return;
    owners.delete(id);
    if (owners.size === 0) rowIdsByCanonical.delete(key);
  };
  const replaceStoredIndex = (
    id: string,
    data: NormalizedTransaction,
  ): void => {
    const previous = storedById.get(id);
    if (previous) removeCanonicalOwner(id, previous);
    storedById.set(id, data);
    addCanonicalOwner(id, data);
  };
  for (const record of input.existingTransactions) {
    addCanonicalOwner(record.id, record.data);
  }
  const updateResolution = resolveAuthoritativeTransactionUpdateTargets(
    validTransactions,
    input.authoritativeUpdateTargets,
    storedById,
  );
  const { resolvedTargets: resolvedUpdateTargets, droppedClaimIndexes } = updateResolution;
  const approvedUpdateKeys = new Set(resolvedUpdateTargets.keys());
  const initialRowIdsByCanonical = new Map(
    [...rowIdsByCanonical].map(([key, ids]) => [key, new Set(ids)]),
  );
  const canonicalBelongsToAnotherRow = (
    key: string,
    transactionId: string,
  ): boolean => {
    const owners = new Set([
      ...(initialRowIdsByCanonical.get(key) ?? []),
      ...(rowIdsByCanonical.get(key) ?? []),
    ]);
    return [...owners].some((id) => id !== transactionId);
  };

  const incomingProviderIdCounts = new Map<string, number>();
  for (const candidate of validTransactions) {
    if (!isBankProvidedId(candidate.providerTransactionId)) continue;
    const key = canonicalUpdateKey(
      candidate.providerAccountId,
      candidate.providerTransactionId!,
    );
    incomingProviderIdCounts.set(
      key,
      (incomingProviderIdCounts.get(key) ?? 0) + 1,
    );
  }

  let transactionsStored = 0;
  let transactionsDropped = 0;
  let transactionsAdded = 0;
  let transactionsModified = 0;
  let newestBookingDate: string | undefined;
  const seenOccurrenceIds = new Set<string>();
  const occurrenceClaims = new Map(input.occurrenceClaims ?? []);
  const observedTransactionIds = new Set<string>();
  const transactionStorageFloorDate = deriveTransactionCutoffDate({});

  for (const [transactionIndex, transaction] of validTransactions.entries()) {
    const occurrenceId = transaction.extractionOccurrenceId!;
    if (seenOccurrenceIds.has(occurrenceId)) {
      throw new Error(
        'the same transaction occurrence id appears more than once in one promotion',
      );
    }
    seenOccurrenceIds.add(occurrenceId);
    const existingClaim = occurrenceClaims.get(occurrenceId);
    if (existingClaim) {
      if (!storedById.has(existingClaim)) {
        throw new Error(
          'transaction occurrence points to a missing or cross-connection transaction',
        );
      }
      transactionsStored++;
      if (
        !newestBookingDate
        || transaction.bookingDate > newestBookingDate
      ) {
        newestBookingDate = transaction.bookingDate;
      }
      continue;
    }

    if (droppedClaimIndexes.has(transactionIndex)) {
      transactionsDropped++;
      continue;
    }
    if (
      !transaction.existingCanonicalId
      && !isBankProvidedId(transaction.providerTransactionId)
      && transaction.bookingDate < transactionStorageFloorDate
    ) {
      transactionsDropped++;
      continue;
    }

    let identityInput: TxIdentityInput = transaction;
    let authoritativeExistingTxId: string | undefined;
    if (transaction.existingCanonicalId) {
      const updateKey = canonicalUpdateKey(
        transaction.providerAccountId,
        transaction.existingCanonicalId,
      );
      authoritativeExistingTxId = resolvedUpdateTargets.get(updateKey)!;
      if (isBankProvidedId(transaction.providerTransactionId)) {
        const providerKey = canonicalUpdateKey(
          transaction.providerAccountId,
          transaction.providerTransactionId!,
        );
        if (
          (incomingProviderIdCounts.get(providerKey) ?? 0) > 1
          || canonicalBelongsToAnotherRow(
            providerKey,
            authoritativeExistingTxId,
          )
        ) {
          identityInput = {
            ...transaction,
            providerTransactionId: undefined,
          };
        }
      }
    }

    if (
      !identityInput.existingCanonicalId
      && isBankProvidedId(identityInput.providerTransactionId)
    ) {
      const providerKey = canonicalUpdateKey(
        identityInput.providerAccountId,
        identityInput.providerTransactionId!,
      );
      if (
        (incomingProviderIdCounts.get(providerKey) ?? 0) > 1
        || (initialRowIdsByCanonical.get(providerKey)?.size ?? 0) > 0
        || (rowIdsByCanonical.get(providerKey)?.size ?? 0) > 0
      ) {
        identityInput = {
          ...transaction,
          providerTransactionId: undefined,
          existingCanonicalId: undefined,
        };
      }
    }

    let identity = assignTransactionId(
      input.connectionId,
      identityInput,
      approvedUpdateKeys,
      {
        authoritativeExistingTxId,
        occurrenceScopeId: input.occurrenceScopeId,
      },
    );
    if (
      !('dropped' in identity)
      && !identityInput.existingCanonicalId
      && isBankProvidedId(identityInput.providerTransactionId)
      && storedById.has(identity.txId)
    ) {
      identityInput = {
        ...transaction,
        providerTransactionId: undefined,
        existingCanonicalId: undefined,
      };
      identity = assignTransactionId(
        input.connectionId,
        identityInput,
        approvedUpdateKeys,
        { occurrenceScopeId: input.occurrenceScopeId },
      );
    }
    if ('dropped' in identity) {
      transactionsDropped++;
      continue;
    }

    const {
      existingCanonicalId: _existingCanonicalId,
      extractionOccurrenceId: _extractionOccurrenceId,
      ...publicFields
    } = transaction;
    const observedData = {
      ...publicFields,
      providerTransactionId: identity.providerTransactionIdField,
    } as NormalizedTransaction;
    const previousData = storedById.get(identity.txId);
    const data = mergePresentFields(previousData, observedData);
    transactionsStored++;
    if (!previousData) transactionsAdded++;
    else transactionsModified++;
    replaceStoredIndex(identity.txId, data);
    observedTransactionIds.add(identity.txId);
    occurrenceClaims.set(occurrenceId, identity.txId);
    if (
      !newestBookingDate
      || transaction.bookingDate > newestBookingDate
    ) {
      newestBookingDate = transaction.bookingDate;
    }
  }

  const existingPositionsById = new Map(
    input.existingPositions.map((record) => [record.id, record]),
  );
  const positionsById = new Map<string, PlannedCanonicalRecord<
    NormalizedPosition,
    TTimestamp
  >>(
    input.existingPositions.map((record) => [
      record.id,
      { id: record.id, data: record.data, previous: record },
    ]),
  );
  const knownProviderAccountIds = new Set(
    [...accountsById.values()].map((record) => record.data.providerAccountId),
  );
  const validPositions = vp.valid.filter((position) =>
    knownProviderAccountIds.has(position.providerAccountId)
  );
  const unknownAccountPositions = vp.valid.length - validPositions.length;
  for (const observed of validPositions) {
    const id = deterministicPositionId(
      input.connectionId,
      observed.providerAccountId,
      observed.providerPositionId,
    );
    const previous = existingPositionsById.get(id);
    positionsById.set(id, {
      id,
      data: mergePositionData(previous?.data, observed),
      previous,
      observed: true,
    });
  }

  const transactions = [...storedById].map(([id, data]) => ({
    id,
    data,
    previous: originalTransactions.get(id),
    observed: observedTransactionIds.has(id),
  }));
  return {
    accounts: [...accountsById.values()],
    transactions,
    positions: [...positionsById.values()],
    occurrenceClaims: [...occurrenceClaims].map(
      ([occurrenceId, transactionId]) => ({
        occurrenceId,
        transactionId,
      }),
    ),
    result: {
      accountsStored: va.valid.length,
      transactionsStored,
      transactionsAdded,
      transactionsModified,
      transactionsDropped,
      positionsStored: validPositions.length,
      quarantinedAccounts: 0,
      staleDeletedPositions: 0,
      rejected: {
        accounts: va.rejected,
        transactions: vt.rejected,
        positions: vp.rejected + unknownAccountPositions,
      },
      newestBookingDate,
    },
  };
}
