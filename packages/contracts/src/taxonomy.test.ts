import { describe, it, expect } from 'vitest';
import {
  ACCOUNT_SUBTYPES, ACCOUNT_TYPES, SECURITY_TYPES, mapAccountType, mapSecurityType,
} from './taxonomy';

describe('mapAccountType', () => {
  // The eight legacy NormalizedAccount.type values, verified against docs/spec-data-api.md §5.2.
  const cases: Array<[string, string, string]> = [
    ['current', 'depository', 'current'],
    ['savings', 'depository', 'savings'],
    ['credit', 'credit', 'credit_card'],
    ['investment', 'investment', 'brokerage'],
    ['broker_cash', 'investment', 'brokerage_cash'],
    ['pension', 'pension', 'pension'],
    ['study_fund', 'pension', 'study_fund'],
    ['other', 'other', 'other'],
  ];

  it.each(cases)('maps legacy %s -> %s/%s', (legacy, type, subtype) => {
    expect(mapAccountType(legacy)).toEqual({ type, subtype });
  });

  it('degrades unknown input to other/other without throwing', () => {
    expect(mapAccountType('totally_unknown')).toEqual({ type: 'other', subtype: 'other' });
    expect(mapAccountType('')).toEqual({ type: 'other', subtype: 'other' });
  });

  it('every mapped (type, subtype) is a member of the declared taxonomy', () => {
    for (const legacy of ['current', 'savings', 'credit', 'investment', 'broker_cash', 'pension', 'study_fund', 'other', 'bogus']) {
      const { type, subtype } = mapAccountType(legacy);
      expect(ACCOUNT_TYPES).toContain(type);
      expect((ACCOUNT_SUBTYPES[type] as readonly string[])).toContain(subtype);
    }
  });
});

describe('mapSecurityType', () => {
  const cases: Array<[string | undefined, string]> = [
    ['ETF', 'etf'],
    ['Exchange Traded Fund', 'etf'],
    ['Money Market Fund', 'cash'],
    ['CASH', 'cash'],
    ['Bitcoin', 'crypto'],
    ['Digital Asset', 'crypto'],
    ['Call Option', 'derivative'],
    ['CFD', 'derivative'],
    ['Government Bond', 'bond'],
    ['Fixed Income', 'bond'],
    ['Mutual Fund', 'mutual_fund'],
    ['Domestic tracking fund', 'mutual_fund'],
    ['Common Stock', 'equity'],
    ['Ordinary Share', 'equity'],
    ['something weird', 'other'],
    [undefined, 'other'],
    ['', 'other'],
  ];

  it.each(cases)('maps %s -> %s', (raw, expected) => {
    expect(mapSecurityType(raw)).toBe(expected);
  });

  it('always returns a declared security type', () => {
    for (const [raw] of cases) {
      expect(SECURITY_TYPES).toContain(mapSecurityType(raw));
    }
  });
});
