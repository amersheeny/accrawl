import { describe, it, expect } from 'vitest';
import {
  assignTransactionId, deterministicAccountId, deterministicTransactionId, deterministicPositionId,
  canonicalUpdateKey, isBankProvidedId, deriveTransactionCutoffDate, subtractDaysUtc,
  CONTENT_ID_PREFIX, OCCURRENCE_ID_PREFIX, type TxIdentity,
} from './tx-identity';

describe('deterministic ids are injective (no delimiter collision)', () => {
  it('distinct tuples never collide, even when a part contains the join delimiter', () => {
    // ("a:b","c") vs ("a","b:c") would collide under a bare `${a}:${b}` join — a silent merge of two
    // distinct records on a money dedup key.
    expect(deterministicAccountId('a:b', 'c')).not.toBe(deterministicAccountId('a', 'b:c'));
    expect(deterministicTransactionId('a:b', 'c')).not.toBe(deterministicTransactionId('a', 'b:c'));
    expect(deterministicPositionId('a:b', 'c', 'd')).not.toBe(deterministicPositionId('a', 'b:c', 'd'));
  });
  it('is stable: identical inputs map to the same id', () => {
    expect(deterministicAccountId('conn', 'acct')).toBe(deterministicAccountId('conn', 'acct'));
    expect(deterministicTransactionId('acct', 'BANK1')).toBe(deterministicTransactionId('acct', 'BANK1'));
  });
});

const CONN = 'conn-1';
const OCCURRENCE_SCOPE = 'session-1';
const ok = (r: ReturnType<typeof assignTransactionId>): TxIdentity => {
  if ('dropped' in r) throw new Error(`unexpectedly dropped: ${r.reason}`);
  return r;
};

describe('transaction identity', () => {
  it('hashes accounts/transactions deterministically (20 hex chars)', () => {
    expect(deterministicAccountId(CONN, 'acc-1')).toMatch(/^[0-9a-f]{20}$/);
    expect(deterministicAccountId(CONN, 'acc-1')).toBe(deterministicAccountId(CONN, 'acc-1'));
    expect(deterministicAccountId(CONN, 'acc-1')).not.toBe(deterministicAccountId(CONN, 'acc-2'));
    const a = deterministicAccountId(CONN, 'acc-1');
    expect(deterministicTransactionId(a, 'TX9')).toBe(deterministicTransactionId(a, 'TX9'));
  });

  it('Layer 1: a bank id maps to a stable id; the field stores the bank id verbatim', () => {
    const base = { bookingDate: '2026-06-01', amount: -50, description: 'Coffee', providerAccountId: 'acc-1' };
    const r1 = ok(assignTransactionId(CONN, { ...base, providerTransactionId: 'BANK123' }));
    const r2 = ok(assignTransactionId(CONN, { ...base, providerTransactionId: 'BANK123' }));
    expect(r1.txId).toBe(r2.txId); // stable across runs
    expect(r1.providerTransactionIdField).toBe('BANK123');
    expect(r1.isExistingUpdate).toBe(false);
  });

  it('Layer 2: no bank id uses an engine-minted occurrence id, never content fields', () => {
    const tx = { bookingDate: '2026-06-01', amount: -10, description: 'Bus fare', providerAccountId: 'acc-1', providerTransactionId: 'NONE' };
    const a = ok(assignTransactionId(CONN, {
      ...tx,
      extractionOccurrenceId: '00000000-0000-4000-8000-000000000001',
    }, undefined, { occurrenceScopeId: OCCURRENCE_SCOPE }));
    const b = ok(assignTransactionId(CONN, {
      ...tx,
      extractionOccurrenceId: '00000000-0000-4000-8000-000000000002',
    }, undefined, { occurrenceScopeId: OCCURRENCE_SCOPE }));
    expect(a.txId).not.toBe(b.txId);
    expect(a.providerTransactionIdField).toBe(`${OCCURRENCE_ID_PREFIX}${a.txId}`);
    const c = ok(assignTransactionId(CONN, {
      ...tx,
      extractionOccurrenceId: '00000000-0000-4000-8000-000000000001',
    }, undefined, { occurrenceScopeId: OCCURRENCE_SCOPE }));
    expect(c.txId).toBe(a.txId);
    const laterSession = ok(assignTransactionId(CONN, {
      ...tx,
      extractionOccurrenceId: '00000000-0000-4000-8000-000000000001',
    }, undefined, { occurrenceScopeId: 'session-2' }));
    expect(laterSession.txId).not.toBe(a.txId);
  });

  it('Rule 4: the authoritative stored row id preserves identity on pending→posted', () => {
    const first = ok(assignTransactionId(CONN, {
      bookingDate: '2026-06-01', amount: -10, description: 'Pending coffee', providerAccountId: 'acc-1',
      extractionOccurrenceId: '00000000-0000-4000-8000-000000000001',
    }, undefined, { occurrenceScopeId: OCCURRENCE_SCOPE }));
    const canonical = first.providerTransactionIdField;
    // next run: crawler flags it as an update via existingCanonicalId
    const update = ok(assignTransactionId(CONN, {
      bookingDate: '2026-06-01', amount: -10, description: 'Coffee', providerAccountId: 'acc-1',
      existingCanonicalId: canonical,
    }, new Set([canonicalUpdateKey('acc-1', canonical)]), {
      authoritativeExistingTxId: first.txId,
    }));
    expect(update.txId).toBe(first.txId); // SAME row — no duplicate
    expect(update.isExistingUpdate).toBe(true);
    expect(update.providerTransactionIdField).toBe(canonical); // canonical preserved verbatim
  });

  it('Rule 4: an authoritative stored row id wins over re-hashing a mutable bank canonical', () => {
    const canonical = 'BANK-ASSIGNED-LATER';
    const authoritativeId = 'original-occurrence-row';
    const update = ok(assignTransactionId(CONN, {
      bookingDate: '2026-06-01',
      amount: -10,
      description: 'Posted coffee',
      providerAccountId: 'acc-1',
      providerTransactionId: canonical,
      existingCanonicalId: canonical,
    }, new Set([canonicalUpdateKey('acc-1', canonical)]), {
      authoritativeExistingTxId: authoritativeId,
    }));
    expect(update.txId).toBe(authoritativeId);
    expect(update.providerTransactionIdField).toBe(canonical);
    expect(update.isExistingUpdate).toBe(true);
  });

  it('Rule 4: an existingCanonicalId NOT in the allowlist is dropped (anti-hallucination)', () => {
    const r = assignTransactionId(CONN, {
      bookingDate: '2026-06-01', amount: -10, description: 'x', providerAccountId: 'acc-1',
      existingCanonicalId: 'content:deadbeef',
    }, new Set([canonicalUpdateKey('acc-1', 'content:other')]));
    expect('dropped' in r && r.dropped).toBe(true);
  });

  it('does not reconstruct a stored row id from an approved canonical value', () => {
    const canonicalId = 'content:legacy-synthetic-id';
    const result = assignTransactionId(CONN, {
      bookingDate: '2026-06-01',
      amount: -10,
      description: 'x',
      providerAccountId: 'account-a',
      existingCanonicalId: canonicalId,
    }, new Set([canonicalUpdateKey('account-a', canonicalId)]));
    expect(result).toMatchObject({
      dropped: true,
      reason: expect.stringContaining('no authoritative stored-row resolution'),
    });
  });

  it('scopes update allowlists by account', () => {
    const canonicalId = 'content:abc';
    const result = assignTransactionId(CONN, {
      bookingDate: '2026-06-01',
      amount: -10,
      description: 'x',
      providerAccountId: 'account-b',
      existingCanonicalId: canonicalId,
    }, new Set([canonicalUpdateKey('account-a', canonicalId)]));
    expect('dropped' in result && result.dropped).toBe(true);
  });

  it('drops an id-less transaction only when the engine omitted its occurrence evidence', () => {
    const result = assignTransactionId(CONN, {
      bookingDate: '2026-06-01',
      amount: -10,
      description: 'Bus fare',
      providerAccountId: 'acc-1',
      providerTransactionId: 'NONE',
    });
    expect('dropped' in result && result.dropped).toBe(true);
  });

  it('scopes the same position id to its owning account', () => {
    expect(deterministicPositionId(CONN, 'account-a', 'position-1'))
      .not.toBe(deterministicPositionId(CONN, 'account-b', 'position-1'));
  });

  it('isBankProvidedId rejects NONE/empty and legacy/current synthetic ids', () => {
    expect(isBankProvidedId('BANK123')).toBe(true);
    expect(isBankProvidedId('NONE')).toBe(false);
    expect(isBankProvidedId('none')).toBe(false);
    expect(isBankProvidedId('')).toBe(false);
    expect(isBankProvidedId(undefined)).toBe(false);
    expect(isBankProvidedId('content:abc')).toBe(false);
    expect(isBankProvidedId('occurrence:abc')).toBe(false);
  });

  it('cutoff: first crawl uses 90 UTC days and every later crawl uses seven', () => {
    const today = new Date('2026-06-28T12:00:00Z');
    expect(subtractDaysUtc('2026-06-28', 90)).toBe('2026-03-30');
    expect(deriveTransactionCutoffDate({ today })).toBe('2026-03-30');
    expect(deriveTransactionCutoffDate({
      lastSuccessfulCrawlDay: '2026-06-20',
      today,
    })).toBe('2026-06-21');
  });

  it('cutoff: prior success alone selects an exact UTC-today-anchored seven-day window', () => {
    const today = new Date('2026-06-28T23:59:59.999Z');
    expect(deriveTransactionCutoffDate({
      newestStoredBookingDate: '2026-06-27',
      lookbackDays: 1,
      today,
    })).toBe('2026-03-30');
    expect(deriveTransactionCutoffDate({
      lastSuccessfulCrawlDay: '2026-06-27',
      newestStoredBookingDate: '2026-06-28',
      lookbackDays: 0,
      today,
    })).toBe('2026-06-21');
    expect(deriveTransactionCutoffDate({
      lastSuccessfulCrawlDay: '2020-01-01',
      newestStoredBookingDate: '2026-03-01',
      lookbackDays: 89,
      today,
    })).toBe('2026-06-21');
  });
});
