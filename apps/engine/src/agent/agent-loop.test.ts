import { describe, expect, it } from 'vitest';
import {
  determineCrawlOutcome,
  isOtpResendAction,
  positionDedupKey,
  shouldHonorLoginFlowRestarted,
  shouldBlockWaitForOtp,
  shouldConsumeOtpAfterAction,
  shouldResetOtpAfterAction,
  classifyCrawlFailure,
  isRecoverableCaptureError,
  buildReportDataProgressFeedback,
  buildStepLogActionFields,
  sanitizeStepLogActionFeedback,
  buildDataContext,
  buildActionFeedback,
  buildPositionAccountFkFeedback,
  buildPositionReconciliationFeedback,
  accumulateStepTransactions,
  expandTransactionCounts,
  transactionDedupKey,
} from './agent-loop';
import type {
  NormalizedAccount,
  NormalizedPosition,
  NormalizedTransaction,
} from '@accrawl/contracts';
import { OTP_RECEIVED_LOG, OTP_RECEIVED_FROM_RECOVERY_LOG } from './otp-state';
import type { StepResponse } from '../ai/schema';
import { ApiContractError } from '../ai/providers/errors';

describe('classifyCrawlFailure', () => {
  it('classifies an ApiContractError as api_contract_drift', () => {
    expect(classifyCrawlFailure(new ApiContractError('Unknown parameter "mode"'))).toBe(
      'api_contract_drift',
    );
  });

  it('classifies an LLM 4xx contract-drift signature as api_contract_drift', () => {
    expect(classifyCrawlFailure(new Error('400 Unknown parameter: tool_choice.mode'))).toBe(
      'api_contract_drift',
    );
    expect(classifyCrawlFailure(new Error('invalid_request: bad field'))).toBe(
      'api_contract_drift',
    );
  });

  it('classifies OTP wait/timeout failures as otp_timeout', () => {
    expect(classifyCrawlFailure(new Error('OTP timeout after 180000ms for session abc'))).toBe(
      'otp_timeout',
    );
    expect(classifyCrawlFailure(new Error('OTP failed after 2 attempts. Aborting to prevent account lockout.'))).toBe(
      'otp_timeout',
    );
  });

  it('classifies an offline OTP relay as otp_relay_unreachable (not otp_timeout/internal_error)', () => {
    expect(classifyCrawlFailure(new Error(
      'OTP relay app did not come online within 120s for session test-123. Ensure the OTP relay APK is installed and the user is signed in.',
    ))).toBe('otp_relay_unreachable');
  });

  it('classifies operating-hours failures as outside_hours', () => {
    expect(classifyCrawlFailure(new Error('Agent error: This bank is outside operating hours right now'))).toBe(
      'outside_hours',
    );
  });

  it('classifies a page capture timeout as page_capture_timeout', () => {
    expect(classifyCrawlFailure(new Error('Operation "capturePageState" timed out after 45000ms'))).toBe(
      'page_capture_timeout',
    );
    expect(classifyCrawlFailure(new Error('Operation "takeScreenshot" timed out after 25000ms'))).toBe(
      'page_capture_timeout',
    );
    expect(classifyCrawlFailure(new Error('Operation "getPageContent.mainFrame" timed out after 20000ms'))).toBe(
      'page_capture_timeout',
    );
  });

  it('classifies a navigation timeout as navigation_timeout', () => {
    expect(classifyCrawlFailure(new Error('page.goto: Timeout 180000ms exceeded.'))).toBe(
      'navigation_timeout',
    );
    expect(classifyCrawlFailure(new Error('Timeout 30000ms exceeded waitForNavigation'))).toBe(
      'navigation_timeout',
    );
  });

  it('falls back to internal_error for unmatched errors', () => {
    expect(classifyCrawlFailure(new Error('Some random selector not found'))).toBe(
      'internal_error',
    );
    expect(classifyCrawlFailure('a plain string error')).toBe('internal_error');
  });

  it('does not over-classify a generic completion failure', () => {
    expect(
      classifyCrawlFailure(new Error('Agent completed without extracting any financial data.')),
    ).toBe('internal_error');
  });
});

describe('OTP-received log lines never leak code digits (DEFECT-3 regression)', () => {
  // The previous form logged `12****` — the first two digits of the live 2FA code — and the session logger
  // persists it. The fix logs only the fact a code arrived. Assert neither line contains ANY digit, so a
  // future edit can't reintroduce a masked-prefix leak without failing here.
  it('the main-loop OTP-received log contains no digit of the code', () => {
    expect(OTP_RECEIVED_LOG).not.toMatch(/\d/);
    expect(OTP_RECEIVED_LOG).not.toContain('*'); // not even a mask hinting at digit count
  });
  it('the error-recovery OTP-received log contains no digit of the code', () => {
    expect(OTP_RECEIVED_FROM_RECOVERY_LOG).not.toMatch(/\d/);
    expect(OTP_RECEIVED_FROM_RECOVERY_LOG).not.toContain('*');
  });
});

describe('shouldBlockWaitForOtp', () => {
  it('blocks waitForOtp when OTP is cached and not consumed', () => {
    expect(shouldBlockWaitForOtp('342962', false)).toBe(true);
  });

  it('does not block when no OTP is cached', () => {
    expect(shouldBlockWaitForOtp(null, false)).toBe(false);
  });

  it('does not block when cached OTP was already consumed', () => {
    expect(shouldBlockWaitForOtp('342962', true)).toBe(false);
  });
});

describe('positionDedupKey', () => {
  it('treats same-symbol lots as distinct when providerPositionId differs', () => {
    expect(positionDedupKey({
      providerPositionId: 'META-RSU-20220321',
      symbol: 'META',
      name: 'META RSU - Mar 21, 2022',
      quantity: 497,
      currency: 'USD',
      valueNative: 325465.42,
    })).not.toBe(positionDedupKey({
      providerPositionId: 'META-RSU-20230320',
      symbol: 'META',
      name: 'META RSU - Mar 20, 2023',
      quantity: 500,
      currency: 'USD',
      valueNative: 327430,
    }));
  });

  it('falls back to a stable composite key when providerPositionId is absent', () => {
    expect(positionDedupKey({
      symbol: 'META',
      name: 'META RSU - Mar 21, 2022',
      quantity: 497,
      currency: 'USD',
      valueNative: 325465.42,
    })).not.toBe(positionDedupKey({
      symbol: 'META',
      name: 'META RSU - Mar 20, 2023',
      quantity: 500,
      currency: 'USD',
      valueNative: 327430,
    }));
  });

  it('scopes an otherwise identical provider position id to its owning account', () => {
    const position: NormalizedPosition = {
      providerPositionId: 'security-42',
      providerAccountId: 'portfolio-a',
      symbol: 'ABC',
      name: 'ABC Fund',
      quantity: 10,
      currency: 'GBP',
      valueNative: 100,
    };
    expect(positionDedupKey(position)).not.toBe(positionDedupKey({
      ...position,
      providerAccountId: 'portfolio-b',
    }));
  });
});

describe('buildDataContext surfaces the providerAccountId the model must reuse for transactions', () => {
  const acct = (over: Partial<NormalizedAccount>): NormalizedAccount => ({
    providerAccountId: '4471-002', name: 'Cuenta Corriente', description: '', currency: 'EUR', type: 'current', balance: 100, ...over,
  });
  it('includes each account\'s providerAccountId, not just its name/currency', () => {
    // Root cause of the orphaned-transaction bug: the context showed only "name (currency)", so the model
    // tagged transactions with the display NAME while the account was stored under its NUMBER. The context
    // must now carry the exact providerAccountId so the model can reuse it.
    const ctx = buildDataContext([acct({})], [], []);
    expect(ctx).toContain('4471-002');
    expect(ctx).toContain('providerAccountId');
    // and it must still name the account so the model can recognize which is which
    expect(ctx).toContain('Cuenta Corriente');
  });
  it('lists the id for every account', () => {
    const ctx = buildDataContext([acct({ providerAccountId: '142-USD', name: 'FX USD', currency: 'USD' }), acct({})], [], []);
    expect(ctx).toContain('142-USD');
    expect(ctx).toContain('4471-002');
  });

  it('preserves exact position ownership and numeric state across a context reset', () => {
    const position: NormalizedPosition = {
      providerPositionId: 'lot-7',
      providerAccountId: '142-USD',
      symbol: 'ABC',
      name: 'ABC Fund',
      quantity: 3.5,
      currency: 'USD',
      valueNative: 420.75,
    };
    const ctx = buildDataContext(
      [acct({ providerAccountId: '142-USD', currency: 'USD', balance: 500 })],
      [],
      [position],
    );
    expect(ctx).toContain('providerPositionId "lot-7"');
    expect(ctx).toContain('providerAccountId "142-USD"');
    expect(ctx).toContain('qty=3.5');
    expect(ctx).toContain('value=420.75 USD');
  });

  it('keeps every position identity but omits repeated numeric detail above the context cap', () => {
    const positions: NormalizedPosition[] = Array.from({ length: 61 }, (_, index) => ({
      providerPositionId: `lot-${index}`,
      providerAccountId: '142-USD',
      symbol: `SYM${index}`,
      name: `Fund ${index}`,
      quantity: index + 0.5,
      currency: 'USD',
      valueNative: index + 100,
    }));

    const ctx = buildDataContext([], [], positions);

    expect(ctx).toContain('providerPositionId "lot-0"');
    expect(ctx).toContain('providerPositionId "lot-60"');
    expect(ctx).toContain('providerAccountId "142-USD"');
    expect(ctx).not.toContain('qty=');
    expect(ctx).not.toContain('value=');
  });

  it('carries trustworthy transaction references across a reset without content matching', () => {
    const ctx = buildDataContext([], [{
      providerAccountId: 'account-a',
      providerTransactionId: 'REF-9',
      bookingDate: '2026-07-20',
      amount: -10,
      currency: 'GBP',
      description: 'Potentially non-unique content',
      isPending: false,
    }], []);
    expect(ctx).toContain('account-a/REF-9');
    expect(ctx).not.toContain('Potentially non-unique content');
  });
});

describe('accumulateStepTransactions — identical multiples use count', () => {
  const tx = (over: Partial<NormalizedTransaction> = {}): NormalizedTransaction => ({
    providerAccountId: 'account-a',
    providerTransactionId: 'NONE',
    bookingDate: '2026-07-20',
    amount: -12.5,
    currency: 'GBP',
    merchant: 'Cafe',
    description: 'Cafe',
    isPending: false,
    ...over,
  });

  it('collapses an identical row listed twice in one batch as a model stutter', () => {
    const map = new Map<string, NormalizedTransaction>();
    const warnings: string[] = [];
    accumulateStepTransactions(map, [tx(), tx()], { log: message => warnings.push(message) });
    expect(map).toHaveLength(1);
    expect(warnings.some(message => message.includes('rule-26b'))).toBe(true);
  });

  it('expands one deliberate count claim into exact separate rows at hand-off', () => {
    const map = new Map<string, NormalizedTransaction>();
    accumulateStepTransactions(map, [tx({ count: 2 })]);
    const expanded = expandTransactionCounts([...map.values()]);
    expect(expanded).toHaveLength(2);
    expect(expanded.every(transaction => transaction.count === undefined)).toBe(true);
  });

  it('keeps the largest count when the model stutters the same count claim', () => {
    const map = new Map<string, NormalizedTransaction>();
    accumulateStepTransactions(map, [tx({ count: 2 }), tx({ count: 3 })]);
    expect(expandTransactionCounts([...map.values()])).toHaveLength(3);
  });

  it('collapses a full-page reread across steps instead of summing count claims', () => {
    const map = new Map<string, NormalizedTransaction>();
    accumulateStepTransactions(map, [tx({ count: 2 })]);
    accumulateStepTransactions(map, [tx({ count: 2 })]);
    expect(map).toHaveLength(1);
    expect(expandTransactionCounts([...map.values()])).toHaveLength(2);
  });

  it('collapses stutters that differ only in optional metadata', () => {
    const map = new Map<string, NormalizedTransaction>();
    accumulateStepTransactions(map, [
      tx({ merchant: 'CAFE' }),
      tx({ providerCategory: 'food' }),
    ]);
    expect(map).toHaveLength(1);
    expect(expandTransactionCounts([...map.values()])).toHaveLength(1);
  });

  it('caps a pathological count claim loudly', () => {
    const map = new Map<string, NormalizedTransaction>();
    const logs: string[] = [];
    accumulateStepTransactions(map, [tx({ count: 999 })]);
    const expanded = expandTransactionCounts([...map.values()], { log: message => logs.push(message) });
    expect(expanded).toHaveLength(10);
    expect(logs.some(message => message.includes('ERROR'))).toBe(true);
  });

  it('does not collapse a Rule-4 update with a new row of identical content', () => {
    const map = new Map<string, NormalizedTransaction>();
    accumulateStepTransactions(map, [tx({ existingCanonicalId: 'canonical-1' }), tx()]);
    expect(map).toHaveLength(2);
    expect(transactionDedupKey(tx({ existingCanonicalId: 'canonical-1' })))
      .not.toBe(transactionDedupKey(tx()));
  });

  it('deduplicates a repeated real bank id within and across steps', () => {
    const map = new Map<string, NormalizedTransaction>();
    accumulateStepTransactions(map, [
      tx({ providerTransactionId: 'REF-1' }),
      tx({ providerTransactionId: 'REF-1' }),
    ]);
    accumulateStepTransactions(map, [tx({ providerTransactionId: 'REF-1' })]);
    expect(map).toHaveLength(1);
  });

  it('demotes a recycled bank reference when different rows prove it is non-unique', () => {
    const map = new Map<string, NormalizedTransaction>();
    const demoted = new Set<string>();
    accumulateStepTransactions(map, [
      tx({ providerTransactionId: '99022330', bookingDate: '2026-07-16', amount: 2729.29 }),
      tx({ providerTransactionId: '99022330', bookingDate: '2026-06-22', amount: 2248.64 }),
    ], undefined, demoted);
    expect(map).toHaveLength(2);
    expect([...map.values()].map(row => row.amount).sort()).toEqual([2248.64, 2729.29]);
    expect([...map.values()].every(row => row.providerTransactionId === 'NONE')).toBe(true);
    accumulateStepTransactions(map, [
      tx({ providerTransactionId: '99022330', bookingDate: '2026-07-16', amount: 2729.29 }),
    ], undefined, demoted);
    expect(map).toHaveLength(2);
  });

  it('keeps an account-scoped bank reference distinct across accounts', () => {
    const map = new Map<string, NormalizedTransaction>();
    accumulateStepTransactions(map, [
      tx({ providerTransactionId: 'REF-7', providerAccountId: 'account-a' }),
      tx({ providerTransactionId: 'REF-7', providerAccountId: 'account-b' }),
    ]);
    expect(map).toHaveLength(2);
  });

  it('keeps rows that differ in a money field', () => {
    const map = new Map<string, NormalizedTransaction>();
    accumulateStepTransactions(map, [tx({ amount: -10 }), tx({ amount: -12 })]);
    expect(map).toHaveLength(2);
  });
});

describe('evidence feedback', () => {
  it('reports an unknown position account id without guessing a replacement', () => {
    const feedback = buildPositionAccountFkFeedback(
      [{
        providerPositionId: 'p-1',
        providerAccountId: 'unknown',
        name: 'Fund',
        quantity: 1,
        currency: 'GBP',
        valueNative: 10,
      }],
      [{
        providerAccountId: 'observed',
        name: 'Portfolio',
        currency: 'GBP',
        type: 'investment',
        balance: 10,
      }],
    );
    expect(feedback).toContain('unknown');
    expect(feedback).toContain('observed');
    expect(feedback).toContain('cannot be stored');
  });

  it('records that a successful normal click was enabled at click time', () => {
    const feedback = buildActionFeedback(
      {
        action: 'click',
        description: 'Submit',
        selector: '#submit',
        accounts: [],
        transactions: [],
        positions: [],
        memoryNotes: [],
      },
      'https://example.test/login',
      100,
      'https://example.test/login',
      120,
      { status: 'success', matchCount: 1 },
    );
    expect(feedback).toContain('target passed actionability checks (visible and ENABLED at click time)');
  });

  it('restores the signed position/account reconciliation warning', () => {
    const account: NormalizedAccount = {
      providerAccountId: 'portfolio-a',
      name: 'Study Fund',
      description: '',
      currency: 'EUR',
      type: 'study_fund',
      balance: 100,
    };
    const position = (
      providerPositionId: string,
      valueNative: number,
    ): NormalizedPosition => ({
      providerPositionId,
      providerAccountId: 'portfolio-a',
      name: providerPositionId,
      quantity: 1,
      currency: 'EUR',
      valueNative,
    });

    expect(buildPositionReconciliationFeedback([
      position('month-1', 100),
      position('month-2', 95),
      position('month-3', 90),
    ], [account])).toContain('RECONCILIATION_CHECK');
    expect(buildPositionReconciliationFeedback([
      position('long', 60),
      position('cash', 40),
      position('short', -30),
    ], [{ ...account, balance: 70 }])).toBeNull();
  });
});

describe('determineCrawlOutcome', () => {
  it('requires explicit completion before a crawl is considered successful', () => {
    expect(determineCrawlOutcome({
      finishReason: 'timeout',
      accountsCount: 1,
      transactionsCount: 6,
      positionsCount: 2,
      maxSteps: 100,
      timeoutSeconds: 900,
    })).toEqual({
      success: false,
      error: 'Crawl timed out after 900s before explicit completion.',
    });
  });

  it('accepts explicit completion once data was extracted', () => {
    expect(determineCrawlOutcome({
      finishReason: 'complete',
      accountsCount: 1,
      transactionsCount: 6,
      positionsCount: 2,
      maxSteps: 100,
      timeoutSeconds: 900,
    })).toEqual({
      success: true,
    });
  });
});

describe('shouldConsumeOtpAfterAction', () => {
  it('does not consume the OTP immediately after the fill step', () => {
    expect(shouldConsumeOtpAfterAction({
      action: 'fill',
      description: 'Filling OTP field with OTP_CODE placeholder.',
      usedOtpPlaceholder: true,
      otpFillAttempted: false,
    })).toBe(false);
  });

  it('does not consume the OTP on submit unless the model explicitly confirms the field was filled', () => {
    expect(shouldConsumeOtpAfterAction({
      action: 'click',
      description: 'Clicking the Verify button to submit the OTP.',
      usedOtpPlaceholder: false,
      otpFillAttempted: true,
    })).toBe(false);
  });

  it('consumes the OTP only after a confirmed submit action', () => {
    expect(shouldConsumeOtpAfterAction({
      action: 'click',
      description: 'Clicking Verify after confirming the OTP field is populated. OTP_CONFIRMED_FILLED',
      usedOtpPlaceholder: false,
      otpFillAttempted: true,
    })).toBe(true);
  });
});

describe('shouldResetOtpAfterAction', () => {
  it('clears the cached OTP only when the model explicitly signals a resend request', () => {
    expect(shouldResetOtpAfterAction({
      action: 'click',
      description: 'Clicking the resend link to request a new code. OTP_RESEND_REQUESTED',
    })).toBe(true);
  });

  it('does not clear the cached OTP for ordinary clicks', () => {
    expect(shouldResetOtpAfterAction({
      action: 'click',
      description: 'Clicking the Verify button to submit the OTP.',
    })).toBe(false);
  });
});

describe('isOtpResendAction', () => {
  it('detects explicit resend intents from the model description token', () => {
    expect(isOtpResendAction({
      action: 'click',
      description: 'Clicking resend to request a fresh OTP. OTP_RESEND_REQUESTED',
    })).toBe(true);
  });

  it('does not treat ordinary OTP submit clicks as resend requests', () => {
    expect(isOtpResendAction({
      action: 'click',
      description: 'Clicking Verify after confirming the OTP field is populated. OTP_CONFIRMED_FILLED',
    })).toBe(false);
  });
});

describe('shouldHonorLoginFlowRestarted', () => {
  it('honors loginFlowRestarted only after earlier successful login', () => {
    expect(shouldHonorLoginFlowRestarted('extract')).toBe(true);
  });

  it('ignores loginFlowRestarted during the initial login phase', () => {
    expect(shouldHonorLoginFlowRestarted('login')).toBe(false);
  });
});

describe('isRecoverableCaptureError', () => {
  it('treats a mid-navigation execution-context teardown as recoverable', () => {
    expect(isRecoverableCaptureError('Execution context was destroyed, most likely because of a navigation')).toBe(true);
    expect(isRecoverableCaptureError('frame was detached during navigation')).toBe(true);
  });

  it('treats a capture/evaluate timeout as recoverable (the heavy-DOM hang)', () => {
    expect(isRecoverableCaptureError('Operation "capturePageState" timed out after 45000ms')).toBe(true);
    expect(isRecoverableCaptureError('Operation "getPageContent.mainFrame" timed out after 20000ms')).toBe(true);
  });

  it('does not treat an unrelated error as recoverable', () => {
    expect(isRecoverableCaptureError('Selector not found: #login')).toBe(false);
  });
});

// ─── Regression: INFRA-1 — completion nudge must not unconditionally push "complete" ───

describe('buildReportDataProgressFeedback', () => {
  const progress = { accounts: 1, transactions: 0, positions: 0 };

  it('includes the progress JSON for the model', () => {
    expect(buildReportDataProgressFeedback(progress)).toContain(
      `DATA_PROGRESS_JSON: ${JSON.stringify(progress)}`,
    );
  });

  it('does not contain the old unconditional "use complete now" directive', () => {
    const feedback = buildReportDataProgressFeedback(progress);
    expect(feedback).not.toContain('use "complete" now');
  });

  it('conditions completion on the rule-37a sanity checks instead of pushing it', () => {
    const feedback = buildReportDataProgressFeedback(progress);
    // Empty report after a failed export must not be nudged into completion:
    // the text restates the prompt's own completion conditions at the decision point.
    expect(feedback).toContain('completion sanity checks');
    expect(feedback).toContain('every investment account with a non-zero balance has positions');
    expect(feedback).toContain('transaction views checked for each account');
    expect(feedback).toContain('no planned extraction such as a file export failed without a successful retry');
    expect(feedback).toContain('If a planned extraction failed, diagnose and re-attempt it before completing.');
  });
});

// ─── Regression: accuracy INFRA — step logs must record the executed (substituted) action ───

describe('buildStepLogActionFields', () => {
  const emptyData = { accounts: [], transactions: [], positions: [], memoryNotes: [] };

  const originalClick: StepResponse = {
    ...emptyData,
    action: 'click',
    description: 'Clicking the Excel export option.',
    selector: 'li.export.excel[ng-click="vm.exportToExcel()"]',
  };

  const substituteWait: StepResponse = {
    ...emptyData,
    action: 'wait',
    description: 'Waiting for 2 seconds for the Excel file to download.',
    ms: 2000,
  };

  it('records the substituted action as the executed action, not the original', () => {
    const fields = buildStepLogActionFields(originalClick, substituteWait);
    expect(fields.action).toBe('wait');
    expect(fields.ms).toBe(2000);
    expect(fields.description).toBe('Waiting for 2 seconds for the Excel file to download.');
    // The original click's selector must NOT masquerade as the executed step's selector
    expect(fields.selector).toBeUndefined();
  });

  it('preserves the original failed action so the log shows that a substitution happened', () => {
    const fields = buildStepLogActionFields(originalClick, substituteWait);
    expect(fields.originalStep).toEqual({
      action: 'click',
      description: 'Clicking the Excel export option.',
      selector: 'li.export.excel[ng-click="vm.exportToExcel()"]',
    });
  });

  it('derives extraction counts from the executed step, so retry-reported data is visible', () => {
    const retryReport: StepResponse = {
      ...emptyData,
      action: 'reportData',
      description: 'Extracting positions found during recovery.',
      positions: [
        { providerPositionId: 'p1', symbol: 'AAPL', name: 'Apple', quantity: 10, currency: 'USD', valueNative: 2000 },
      ],
    };
    const fields = buildStepLogActionFields(originalClick, retryReport);
    expect(fields.positionsExtracted).toBe(1);
    expect(fields.accountsExtracted).toBe(0);
    expect(fields.originalStep?.action).toBe('click');
  });

  it('omits originalStep for a normal (non-substituted) step', () => {
    const fields = buildStepLogActionFields(originalClick);
    expect(fields.action).toBe('click');
    expect(fields.selector).toBe('li.export.excel[ng-click="vm.exportToExcel()"]');
    expect(fields.originalStep).toBeUndefined();
  });

  it('records memory notes and navigate URL from the executed step', () => {
    const retryNavigate: StepResponse = {
      ...emptyData,
      action: 'navigate',
      description: 'Navigating back to the holdings page.',
      url: 'https://example.com/holdings',
      memoryNotes: [{ key: 'holdings_url', value: 'https://example.com/holdings' }],
    };
    const fields = buildStepLogActionFields(originalClick, retryNavigate);
    expect(fields.navigateUrl).toBe('https://example.com/holdings');
    expect(fields.memoryNotes).toEqual([{ key: 'holdings_url', value: 'https://example.com/holdings' }]);
  });

  it('redacts navigation and memory-note URL secrets before step persistence', () => {
    const querySecret = 'step-query';
    const fragmentSecret = 'step-fragment';
    const retryNavigate: StepResponse = {
      ...emptyData,
      action: 'navigate',
      description: 'Continue.',
      url:
        `https://bank.example/callback?code=${querySecret}#token=${fragmentSecret}`,
      memoryNotes: [{
        key: 'callback',
        value:
          `Return to https://bank.example/callback?code=${querySecret}#token=${fragmentSecret}`,
      }],
    };
    const serialized = JSON.stringify(
      buildStepLogActionFields(originalClick, retryNavigate),
    );

    expect(serialized.includes(querySecret)).toBe(false);
    expect(serialized.includes(fragmentSecret)).toBe(false);
    expect(serialized.includes('?')).toBe(false);
    expect(serialized.includes('#')).toBe(false);
  });

  it('redacts embedded browser URLs from every free-text action field', () => {
    const descriptionSecret = 'description-query';
    const selectorSecret = 'selector-fragment';
    const valueSecret = 'value-query';
    const originalSecret = 'original-query';
    const original: StepResponse = {
      ...emptyData,
      action: 'click',
      description:
        `Failed at https://bank.example/original?code=${originalSecret}`,
      selector:
        `[href="https://bank.example/original?code=${originalSecret}"]`,
    };
    const executed: StepResponse = {
      ...emptyData,
      action: 'fill',
      description:
        `Fill after wss://stream.bank.example/live?token=${descriptionSecret}`,
      selector:
        `[data-return="https://bank.example/callback#token=${selectorSecret}"]`,
      value:
        `Continue at https://bank.example/value?token=${valueSecret}`,
    };

    const serialized = JSON.stringify(
      buildStepLogActionFields(original, executed),
    );

    for (const secret of [
      descriptionSecret,
      selectorSecret,
      valueSecret,
      originalSecret,
    ]) {
      expect(serialized.includes(secret)).toBe(false);
    }
    expect(serialized.includes('?')).toBe(false);
    expect(serialized.includes('#')).toBe(false);
  });

  it('redacts browser URLs embedded in persisted action feedback', () => {
    const feedbackSecret = 'feedback-query';
    const safe = sanitizeStepLogActionFeedback(
      `Navigation failed at https://bank.example/callback?code=${feedbackSecret}`,
    );

    expect(safe.includes(feedbackSecret)).toBe(false);
    expect(safe.includes('https://bank.example/callback')).toBe(true);
    expect(safe.includes('?')).toBe(false);
  });
});
