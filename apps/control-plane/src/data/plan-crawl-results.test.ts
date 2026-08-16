import { describe, expect, it } from 'vitest';
import {
  canonicalUpdateKey,
  deterministicAccountId,
  deterministicPositionId,
} from './tx-identity';
import { planCrawlResults } from './plan-crawl-results';

const connectionId = 'connection-1';
const account = {
  providerAccountId: 'account-1',
  name: 'Current',
  currency: 'GBP',
  type: 'current',
  balance: 100,
};
const transaction = {
  providerAccountId: 'account-1',
  bookingDate: '2026-07-30',
  amount: -12,
  currency: 'GBP',
  description: 'Lunch',
  isPending: false,
};
const position = {
  providerPositionId: 'position-1',
  providerAccountId: 'account-1',
  name: 'Fund',
  quantity: 2,
  currency: 'GBP',
  valueNative: 80,
};
const existingTransaction = {
  id: 'stored-transaction-1',
  data: {
    ...transaction,
    providerTransactionId: 'BANK-PENDING',
    description: 'Pending lunch',
    isPending: true,
  },
};

function deltaPlan(overrides: Partial<Parameters<typeof planCrawlResults>[0]> = {}) {
  return planCrawlResults({
    connectionId,
    occurrenceScopeId: '22222222-2222-4222-8222-222222222222',
    accounts: [account],
    transactions: [],
    positions: [],
    existingAccounts: [],
    existingTransactions: [existingTransaction],
    existingPositions: [],
    authoritativeUpdateTargets: new Map([
      [
        canonicalUpdateKey('account-1', 'BANK-PENDING'),
        new Set([existingTransaction.id]),
      ],
    ]),
    ...overrides,
  });
}

function plan() {
  return planCrawlResults({
    connectionId,
    occurrenceScopeId: '11111111-1111-4111-8111-111111111111',
    accounts: [account],
    transactions: [transaction],
    positions: [position],
    existingAccounts: [],
    existingTransactions: [],
    existingPositions: [],
    authoritativeUpdateTargets: new Map(),
  });
}

describe('planCrawlResults', () => {
  it('plans accounts, transactions, and positions in one promotion', () => {
    const result = plan();
    expect(result.result).toMatchObject({
      accountsStored: 1,
      transactionsStored: 1,
      transactionsAdded: 1,
      positionsStored: 1,
      rejected: { accounts: 0, transactions: 0, positions: 0 },
    });
    expect(result.accounts[0].id).toBe(
      deterministicAccountId(connectionId, account.providerAccountId),
    );
    expect(result.positions[0].id).toBe(
      deterministicPositionId(
        connectionId,
        position.providerAccountId,
        position.providerPositionId,
      ),
    );
  });

  it('is deterministic across promotion retries without an engine occurrence id', () => {
    const first = plan();
    const retry = plan();
    expect(retry.transactions).toEqual(first.transactions);
    expect(retry.occurrenceClaims).toEqual(first.occurrenceClaims);
  });

  it('updates one exact authoritative transaction target', () => {
    const result = deltaPlan({
      transactions: [{
        ...transaction,
        providerTransactionId: 'BANK-POSTED',
        description: 'Posted lunch',
        existingCanonicalId: 'BANK-PENDING',
      }],
    });

    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0]).toMatchObject({
      id: existingTransaction.id,
      data: {
        providerTransactionId: 'BANK-POSTED',
        description: 'Posted lunch',
        isPending: false,
      },
    });
    expect(result.result).toMatchObject({
      transactionsStored: 1,
      transactionsAdded: 0,
      transactionsModified: 1,
    });
  });

  it('drops an unknown target from the hosted generation plan', () => {
    const result = deltaPlan({
      transactions: [{
        ...transaction,
        providerTransactionId: 'BANK-POSTED',
        existingCanonicalId: 'UNKNOWN',
      }],
    });
    expect(result.result).toMatchObject({ transactionsStored: 0, transactionsDropped: 1 });
  });

  it('drops two observations that claim one authoritative target', () => {
    const result = deltaPlan({
      transactions: [
        {
          ...transaction,
          providerTransactionId: 'BANK-POSTED-A',
          existingCanonicalId: 'BANK-PENDING',
        },
        {
          ...transaction,
          providerTransactionId: 'BANK-POSTED-B',
          existingCanonicalId: 'BANK-PENDING',
        },
      ],
    });
    expect(result.result).toMatchObject({ transactionsStored: 0, transactionsDropped: 2 });
  });

  it('drops an ambiguous authoritative mapping', () => {
    const result = deltaPlan({
      transactions: [{
        ...transaction,
        providerTransactionId: 'BANK-POSTED',
        existingCanonicalId: 'BANK-PENDING',
      }],
      authoritativeUpdateTargets: new Map([
        [
          canonicalUpdateKey('account-1', 'BANK-PENDING'),
          new Set([existingTransaction.id, 'stored-transaction-2']),
        ],
      ]),
    });
    expect(result.result).toMatchObject({ transactionsStored: 0, transactionsDropped: 1 });
  });

  it('drops a cross-account target', () => {
    const result = deltaPlan({
      transactions: [{
        ...transaction,
        providerAccountId: 'account-2',
        providerTransactionId: 'BANK-POSTED',
        existingCanonicalId: 'BANK-PENDING',
      }],
    });
    expect(result.result).toMatchObject({ transactionsStored: 0, transactionsDropped: 1 });
  });

  it('drops a cross-connection target', () => {
    const result = deltaPlan({
      transactions: [{
        ...transaction,
        providerTransactionId: 'BANK-POSTED',
        existingCanonicalId: 'BANK-PENDING',
      }],
      authoritativeUpdateTargets: new Map([
        [
          canonicalUpdateKey('account-1', 'BANK-PENDING'),
          new Set(['foreign-connection-transaction']),
        ],
      ]),
    });
    expect(result.result).toMatchObject({ transactionsStored: 0, transactionsDropped: 1 });
  });

  it('rejects a mixed addition and invalid update without mutating the base generation', () => {
    const existingAccounts = [{
      id: deterministicAccountId(connectionId, account.providerAccountId),
      data: account,
    }];
    const existingTransactions = [existingTransaction];
    const existingPositions = [{
      id: deterministicPositionId(
        connectionId,
        position.providerAccountId,
        position.providerPositionId,
      ),
      data: position,
    }];
    const before = structuredClone({
      existingAccounts,
      existingTransactions,
      existingPositions,
    });

    const result = deltaPlan({
      accounts: [{ ...account, balance: 999 }],
      transactions: [
        { ...transaction, providerTransactionId: 'VALID-ADDITION' },
        {
          ...transaction,
          providerTransactionId: 'INVALID-UPDATE',
          existingCanonicalId: 'UNKNOWN',
        },
      ],
      positions: [{ ...position, valueNative: 999 }],
      existingAccounts,
      existingTransactions,
      existingPositions,
    });
    expect(result.result).toMatchObject({ transactionsStored: 1, transactionsDropped: 1 });

    expect({ existingAccounts, existingTransactions, existingPositions })
      .toEqual(before);
  });
});
