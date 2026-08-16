import { describe, expect, it } from 'vitest';
import {
  getCompletionMetadata,
  sanitizeDocumentArrayItems,
  buildFailureReasonUpdate,
} from './session-updater';

describe('buildFailureReasonUpdate', () => {
  it('persists the failureReason on a failed session', () => {
    expect(buildFailureReasonUpdate(false, 'api_contract_drift')).toEqual({
      failureReason: 'api_contract_drift',
    });
  });

  it('writes no failureReason field for a successful session', () => {
    expect(buildFailureReasonUpdate(true, 'api_contract_drift')).toEqual({});
  });

  it('writes no failureReason field when none was classified', () => {
    expect(buildFailureReasonUpdate(false, undefined)).toEqual({});
  });
});

describe('getCompletionMetadata', () => {
  it('clears stale errors on success', () => {
    expect(getCompletionMetadata(true, 'Crawl timed out after 840s')).toEqual({
      status: 'completed',
      clearLastError: true,
    });
  });

  it('preserves the failure error on unsuccessful completion', () => {
    expect(getCompletionMetadata(false, 'Invalid credentials')).toEqual({
      status: 'failed',
      clearLastError: false,
      lastError: 'Invalid credentials',
    });
  });
});

describe('sanitizeDocumentArrayItems', () => {
  it('strips undefined optional fields from extracted result items', () => {
    expect(sanitizeDocumentArrayItems([
      {
        symbol: 'META',
        providerPositionId: undefined,
        valueNative: 100,
      },
      {
        providerTransactionId: 'tx-1',
        merchant: undefined,
        amount: 20,
      },
    ])).toEqual([
      {
        symbol: 'META',
        valueNative: 100,
      },
      {
        providerTransactionId: 'tx-1',
        amount: 20,
      },
    ]);
  });
});
