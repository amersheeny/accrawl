import { describe, it, expect } from 'vitest';
import type { NormalizedAccount, NormalizedPosition, NormalizedTransaction } from './types';
import {
  toContractAccount, toContractTransaction, toContractHoldingsAndSecurities, securityIdFor,
} from './contract';

const baseAccount = (over: Partial<NormalizedAccount> = {}): NormalizedAccount => ({
  providerAccountId: 'acc-1', name: 'Main', description: 'desc', currency: 'USD', type: 'current', balance: 100, ...over,
});

describe('toContractAccount', () => {
  it('projects the two-level type and the balance triple', () => {
    const a = toContractAccount({ id: 'ID1', connectionId: 'C1', data: baseAccount({ type: 'credit', balance: -250, available: 750, limit: 1000 }) });
    expect(a.type).toBe('credit');
    expect(a.subtype).toBe('credit_card');
    expect(a.balance).toMatchObject({ current: -250, available: 750, limit: 1000 });
  });

  it('omits available/limit when absent', () => {
    const a = toContractAccount({ id: 'ID1', connectionId: 'C1', data: baseAccount() });
    expect(a.balance.current).toBe(100);
    expect(a.balance.available).toBeUndefined();
    expect(a.balance.limit).toBeUndefined();
  });

  it('marks accounts inactive past the missing threshold', () => {
    expect(toContractAccount({ id: 'x', connectionId: 'C', data: baseAccount(), missingSinceCrawlCount: 0 }).status).toBe('active');
    expect(toContractAccount({ id: 'x', connectionId: 'C', data: baseAccount(), missingSinceCrawlCount: 2 }).status).toBe('inactive');
  });

  it('carries the overlays through when present', () => {
    const a = toContractAccount({ id: 'x', connectionId: 'C', data: baseAccount({
      type: 'pension', pensionDetail: { scheme: 'defined_contribution', employer: 'Acme' },
    }) });
    expect(a.type).toBe('pension');
    expect(a.pensionDetail).toEqual({ scheme: 'defined_contribution', employer: 'Acme' });
  });

  it('projects lastSeenAt to balance.asOf', () => {
    const when = new Date('2026-07-01T12:00:00.000Z');
    const a = toContractAccount({ id: 'x', connectionId: 'C', data: baseAccount(), lastSeenAt: when });
    expect(a.balance.asOf).toBe('2026-07-01T12:00:00.000Z');
  });
});

describe('toContractTransaction', () => {
  const tx = (over: Partial<NormalizedTransaction> = {}): NormalizedTransaction => ({
    providerTransactionId: 'T1', bookingDate: '2026-06-01', amount: -42.5, currency: 'USD', description: 'Coffee', isPending: false, ...over,
  });

  it('maps isPending to status and carries the caller-resolved canonical accountId', () => {
    // The caller resolves providerAccountId → the canonical ContractAccount.id; the projection just carries it.
    const c = toContractTransaction('ID', tx({ providerAccountId: 'acc-1', isPending: true }), 'CANON:acc-1');
    expect(c.status).toBe('pending');
    expect(c.accountId).toBe('CANON:acc-1');
  });

  it('nulls accountId when unlinked and preserves both category fields', () => {
    const c = toContractTransaction('ID', tx({ providerCategory: 'GROCERIES', category: { primary: 'food', detailed: 'food.groceries' } }), null);
    expect(c.accountId).toBeNull();
    expect(c.providerTransactionId).toBe('T1');
    expect(c.category).toEqual({ primary: 'food', detailed: 'food.groceries' });
    expect(c.providerCategory).toBe('GROCERIES');
  });
});

describe('securityIdFor / holdings projection', () => {
  const pos = (over: Partial<NormalizedPosition> = {}): NormalizedPosition => ({
    providerPositionId: 'P1', name: 'Apple', quantity: 10, currency: 'USD', valueNative: 1500, ...over,
  });

  it('prefers ISIN, then ticker+exchange, then position id', () => {
    expect(securityIdFor(pos({ isin: 'US0378331005', symbol: 'AAPL', exchange: 'XNAS' }))).toBe('isin:US0378331005');
    expect(securityIdFor(pos({ symbol: 'AAPL', exchange: 'XNAS' }))).toBe('ticker:XNAS:AAPL');
    expect(securityIdFor(pos({}))).toBe('pos:P1');
  });

  it('does NOT treat a bare ticker (no exchange) as identity — falls back to the per-position id', () => {
    // Two DIFFERENT instruments with the same symbol and no exchange must not collapse into one security.
    expect(securityIdFor(pos({ providerPositionId: 'P1', symbol: 'ABC' }))).toBe('pos:P1');
    expect(securityIdFor(pos({ providerPositionId: 'P2', symbol: 'ABC' }))).toBe('pos:P2');
  });

  it('links holdings to the canonical account id and de-duplicates shared securities', () => {
    const resolve = (pid: string) => `CANON:${pid}`;
    const rows = [
      { id: 'H1', data: pos({ providerPositionId: 'P1', isin: 'US0378331005', symbol: 'AAPL', providerAccountId: 'acc-1' }) },
      { id: 'H2', data: pos({ providerPositionId: 'P2', isin: 'US0378331005', symbol: 'AAPL', providerAccountId: 'acc-2', valueNative: 300 }) },
      { id: 'H3', data: pos({ providerPositionId: 'P3', name: 'Fund', securityType: 'tracking fund' }) },
    ];
    const { holdings, securities } = toContractHoldingsAndSecurities(rows, resolve);
    expect(holdings).toHaveLength(3);
    expect(holdings[0]).toMatchObject({ id: 'H1', accountId: 'CANON:acc-1', securityId: 'isin:US0378331005', value: 1500 });
    expect(holdings[2].accountId).toBeNull();
    // Two AAPL holdings share ONE security; the fund is a second, distinct one.
    expect(securities).toHaveLength(2);
    const fund = securities.find((s) => s.id === 'pos:P3');
    expect(fund?.securityType).toBe('mutual_fund');
  });
});
