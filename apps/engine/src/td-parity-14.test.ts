import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Page } from 'playwright';
import {
  buildRecentTransactionHistory,
  reassembleRecentTransactionHistory,
  type NormalizedAccount,
  type NormalizedPosition,
  type NormalizedTransaction,
} from '@accrawl/contracts';
import { describe, expect, it } from 'vitest';
import {
  accumulateStepTransactions,
  buildDataContext,
  buildPositionReconciliationFeedback,
  expandTransactionCounts,
  positionDedupKey,
  transactionDedupKey,
} from './agent/agent-loop';
import {
  recoverFromActionError,
  type LoopState,
  type RecoveryContext,
} from './agent/error-recovery';
import { buildSystemPrompt } from './ai/prompts';
import {
  getInteractionsGenerationConfig,
  getModelConfig,
} from './ai/providers/gemini';
import {
  GEMINI_STEP_FUNCTION_DECLARATIONS,
  type StepResponse,
} from './ai/schema';
import { safeBrowserUrlsInText } from './utils/safe-browser-url';
import {
  deriveTransactionCutoffDate,
  MAX_TRANSACTION_WINDOW_DAYS,
  RECENT_TRANSACTION_WINDOW_DAYS,
} from './utils/transaction-window';

interface ParityManifest {
  allowedDivergences: {
    transactionHistoryWindow: {
      laterCrawlUtcCalendarDays: number;
      comparisonInputUtcCalendarDays: number;
      firstCrawlComparisonInput: 'empty';
    };
    syntheticTransactionIdentity: { additionalAcceptedPrefix: string };
    modelContext: {
      exactProviderAccountIdContext: boolean;
      accountScopedPositionIdentity: boolean;
    };
    securityAdaptations: {
      serverSideRawSmsExtraction: boolean;
      senderActiveSessionAndRequestEpochBinding: boolean;
      ambiguousSmsSessionRefusal: boolean;
      symmetricCrossSourceRawMessageDedupe: boolean;
      genericActiveCountNotificationCopy: boolean;
      permissionSourceRegistrationAfterMidSessionGrant: boolean;
      deviceApiReauthorizationBeforeServiceStart: boolean;
      urlAndSecretRedactionBeforeTelemetryOrMemory: boolean;
    };
    modelControls: {
      gemini3Temperature: number;
      optionalPerCrawlThinkingOverride: boolean;
    };
    normalizedAccountExtensions: string[];
  };
  generatedArtifactDigests: {
    completeFirstCrawlPrompt: string;
    completeLaterCrawlPrompt: string;
    completeStepFunctionSchema: string;
    accumulatorResults: string;
    modelSampling: string;
    sharedSemanticResults: string;
  };
}

interface AccumulatorSummaryRow {
  account: string;
  id: string;
  date: string;
  amount: number;
  existingCanonicalId: string | null;
  count: number | null;
}

interface AccumulatorExpected {
  stored: AccumulatorSummaryRow[];
  expandedCount: number;
  expandedRowsWithoutCount: number;
  signals: string[];
}

interface RecoveryAccumulatorExpected {
  resultType: 'continue';
  stored: AccumulatorSummaryRow[];
  demotedIdentityKeys: string[];
  signals: string[];
}

interface EngineVectors {
  fixedClock: string;
  expectedWindows: {
    firstCrawlCutoff: string;
    laterCrawlCutoff: string;
  };
  sharedSemanticVectors: {
    receivedHistoryOrder: string[];
    positionBalanceReconciliation: {
      account: NormalizedAccount;
      historyLikeValues: number[];
      signedHoldingValues: number[];
      signedHoldingBalance: number;
      expectedSignal: string;
    };
    tickerInferenceDescription: string;
    positionValueDescription: {
      pinned: string;
      allowedTransformations: [];
    };
    recoveryAccumulation: {
      allowedTransformations: [];
      initial: NormalizedTransaction;
      retry: NormalizedTransaction;
      expected: RecoveryAccumulatorExpected;
    };
    defaultThinking: {
      interactionsGemini2: string;
      interactionsGemini3: string;
      generateContentGemini2Budget: number;
      generateContentGemini3Level: string;
    };
  };
  accumulatorScenarios: Array<{
    id: string;
    steps: NormalizedTransaction[][];
    expected: AccumulatorExpected;
  }>;
}

const MANIFEST = JSON.parse(readFileSync(
  new URL('../../../parity/td-parity-14/manifest.json', import.meta.url),
  'utf8',
)) as ParityManifest;
const VECTORS = JSON.parse(readFileSync(
  new URL('../../../parity/td-parity-14/engine-vectors.json', import.meta.url),
  'utf8',
)) as EngineVectors;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

function semanticDigest(value: unknown): string {
  return sha256(JSON.stringify(canonicalize(value)));
}

const commonPromptOptions: Parameters<typeof buildSystemPrompt>[0] = {
  playbook: 'Open each account view and exhaust its complete transaction history.',
  customInstructions: 'Do not infer records that are not visible in current evidence.',
  loginHints: {
    usernameField: '#username',
    passwordField: '#password',
    submitButton: 'button[type="submit"]',
  },
  extractionHints: {
    dateFormat: 'YYYY-MM-DD',
    currency: 'GBP',
    accountsSelector: '#accounts',
    transactionsSelector: '#transactions',
    positionsSelector: '#positions',
  },
  existingAccounts: [
    {
      providerAccountId: 'account-gbp',
      name: 'Current account',
      description: 'Ending 0012',
      currency: 'GBP',
      type: 'current',
      balance: 1250.25,
    },
    {
      providerAccountId: 'account-usd',
      name: 'USD account',
      description: 'Ending 0042',
      currency: 'USD',
      type: 'current',
      balance: 400.5,
    },
  ],
  existingPositions: [
    {
      providerPositionId: 'lot-7',
      providerAccountId: 'account-usd',
      symbol: 'ACME',
      name: 'ACME Holdings',
      currency: 'USD',
      quantity: 3,
    },
  ],
  crawlMemory: 'transactions_selector: #transactions\naccount_switcher: #account-menu',
  useUnifiedLoop: true,
};

function renderPinnedPrompts(): { first: string; later: string } {
  const today = new Date(VECTORS.fixedClock);
  const firstCutoff = deriveTransactionCutoffDate({ today });
  const laterCutoff = deriveTransactionCutoffDate({
    lastSuccessfulCrawlDay: '2026-08-02',
    today,
  });
  return {
    first: buildSystemPrompt({
      ...commonPromptOptions,
      cutoffDate: firstCutoff,
      recentTransactions: [],
    }),
    later: buildSystemPrompt({
      ...commonPromptOptions,
      cutoffDate: laterCutoff,
      recentTransactions: [
        {
          providerAccountId: 'account-gbp',
          providerTransactionId: 'canonical-posted-1',
          bookingDate: '2026-07-27',
          amount: -18.75,
          currency: 'GBP',
          description: 'Corner Shop',
          isPending: false,
        },
        {
          providerAccountId: 'account-gbp',
          providerTransactionId: 'occurrence:scope:pending-2',
          bookingDate: '2026-08-01',
          amount: -7.5,
          currency: 'GBP',
          description: 'City Transit',
          isPending: true,
        },
      ],
    }),
  };
}

function summarizeTransaction(tx: NormalizedTransaction): AccumulatorSummaryRow {
  return {
    account: tx.providerAccountId,
    id: tx.providerTransactionId,
    date: tx.bookingDate,
    amount: tx.amount,
    existingCanonicalId: tx.existingCanonicalId ?? null,
    count: tx.count ?? null,
  };
}

function rowSortKey(row: AccumulatorSummaryRow): string {
  return [
    row.account,
    row.date,
    row.amount.toString(),
    row.id,
    row.existingCanonicalId ?? '',
    row.count?.toString() ?? '',
  ].join('\u0000');
}

function runAccumulatorScenario(
  scenario: EngineVectors['accumulatorScenarios'][number],
): AccumulatorExpected {
  const map = new Map<string, NormalizedTransaction>();
  const demoted = new Set<string>();
  const logs: string[] = [];
  for (const step of scenario.steps) {
    accumulateStepTransactions(map, step, { log: message => logs.push(message) }, demoted);
  }
  const storedTransactions = [...map.values()];
  const expanded = expandTransactionCounts(
    storedTransactions,
    { log: message => logs.push(message) },
  );
  const signals = [
    ...(logs.some(message => message.includes('rule-26b violation')) ? ['stutter'] : []),
    ...(logs.some(message => message.includes('non-unique bank reference')) ? ['recycled-bank-id'] : []),
    ...(logs.some(message => message.includes('exceeds the identical-multiplicity bound')) ? ['multiplicity-cap'] : []),
  ];
  return {
    stored: storedTransactions.map(summarizeTransaction)
      .sort((left, right) => rowSortKey(left).localeCompare(rowSortKey(right))),
    expandedCount: expanded.length,
    expandedRowsWithoutCount: expanded.filter(transaction => transaction.count === undefined).length,
    signals,
  };
}

function reportDataProperties(): Record<string, unknown> {
  const declaration = GEMINI_STEP_FUNCTION_DECLARATIONS.find(
    (candidate) => candidate.name === 'step_report_data',
  );
  return (declaration?.parameters as {
    properties?: Record<string, unknown>;
  } | undefined)?.properties ?? {};
}

function tickerDescription(): string | undefined {
  const positions = reportDataProperties().positions as {
    items?: { properties?: { ticker?: { description?: string } } };
  } | undefined;
  return positions?.items?.properties?.ticker?.description;
}

function positionValueDescription(): string | undefined {
  const positions = reportDataProperties().positions as {
    items?: { properties?: { valueNative?: { description?: string } } };
  } | undefined;
  return positions?.items?.properties?.valueNative?.description;
}

async function runRecoveryAccumulationVector(): Promise<RecoveryAccumulatorExpected> {
  const vector = VECTORS.sharedSemanticVectors.recoveryAccumulation;
  const transactionMap = new Map<string, NormalizedTransaction>([[
    transactionDedupKey(vector.initial),
    vector.initial,
  ]]);
  const demotedIdentityKeys = new Set<string>();
  const logs: string[] = [];
  const retryStep: StepResponse = {
    action: 'reportData',
    description: 'Report the row found while recovering.',
    accounts: [],
    transactions: [vector.retry],
    positions: [],
    memoryNotes: [],
  };
  const page = {
    evaluate: async () => [],
    frames: () => [],
    mainFrame: () => page,
    url: () => 'https://institution.invalid/recovery',
  } as unknown as Page;
  const state = {
    goal: 'extract',
    otp: {},
    consecutiveErrors: 1,
    consecutiveSelectorNotFoundErrors: 0,
    ambiguousSelectorRetries: 0,
    pendingRecoveryWarning: null,
    pendingActionFeedback: null,
    pendingDataIntegrityFeedback: null,
    pendingSpreadsheetText: null,
    lastReportDataProgress: null,
    consecutiveStaleReports: 0,
  } as unknown as LoopState;
  const ctx = {
    sessionId: 'td-parity-14-recovery',
    request: { requires2fa: false },
    credentials: { username: '', password: '' },
    session: {
      sendError: async () => ({ response: retryStep }),
    },
    log: {
      log: (message: string) => logs.push(message),
      warn: (message: string) => logs.push(message),
    },
    downloadTracker: {},
    accountMap: new Map(),
    transactionMap,
    // Deliberately retained as an external observation. The pinned recovery
    // path does not receive or mutate crawl-wide demotion state.
    demotedTransactionIdKeys: demotedIdentityKeys,
    positionMap: new Map(),
    allMemoryNotes: [],
    capturePageState: async () => ({
      screenshotBase64: '',
      fullHtml: '',
      htmlLength: 0,
    }),
    captureLogState: async (
      url: string,
      screenshotBase64: string,
      htmlLength: number,
    ) => ({ url, screenshotBase64, htmlLength }),
    persistStepLog: async () => undefined,
  } as unknown as RecoveryContext;

  const result = await recoverFromActionError(
    new Error('bounded parity recovery'),
    page,
    state,
    ctx,
  );
  return {
    resultType: result.type as 'continue',
    stored: [...transactionMap.values()].map(summarizeTransaction)
      .sort((left, right) => rowSortKey(left).localeCompare(rowSortKey(right))),
    demotedIdentityKeys: [...demotedIdentityKeys].sort(),
    signals: logs.some(message => message.includes('non-unique bank reference'))
      ? ['recycled-bank-id']
      : [],
  };
}

async function runSharedSemanticVectors(): Promise<Record<string, unknown>> {
  const history = buildRecentTransactionHistory(
    VECTORS.sharedSemanticVectors.receivedHistoryOrder.map(
      (providerTransactionId, index) => ({
        providerAccountId: 'account-a',
        providerTransactionId,
        bookingDate: `2026-08-0${index + 1}`,
        amount: -(index + 1),
        currency: 'GBP',
        description: providerTransactionId,
        isPending: false,
      }),
    ),
  );
  const reconciliation = VECTORS.sharedSemanticVectors
    .positionBalanceReconciliation;
  const positions = (
    values: number[],
  ): NormalizedPosition[] => values.map((valueNative, index) => ({
    providerPositionId: `position-${index}`,
    providerAccountId: reconciliation.account.providerAccountId,
    name: `Position ${index}`,
    quantity: 1,
    currency: reconciliation.account.currency,
    valueNative,
  }));
  const defaultInteractions2 = getInteractionsGenerationConfig(
    'gemini-2.5-flash',
    8192,
  );
  const defaultInteractions3 = getInteractionsGenerationConfig(
    'gemini-3.1-flash-lite-preview',
    8192,
  );
  const defaultGenerate2 = getModelConfig('gemini-2.5-flash');
  const defaultGenerate3 = getModelConfig('gemini-3.1-flash-lite-preview');
  return {
    receivedHistoryOrder: reassembleRecentTransactionHistory(
      history.manifest,
      history.chunks,
    ).map((transaction) => transaction.providerTransactionId),
    positionReconciliationSignal: buildPositionReconciliationFeedback(
      positions(reconciliation.historyLikeValues),
      [reconciliation.account],
    )?.includes(reconciliation.expectedSignal) ?? false,
    signedPositionControl: buildPositionReconciliationFeedback(
      positions(reconciliation.signedHoldingValues),
      [{ ...reconciliation.account, balance: reconciliation.signedHoldingBalance }],
    ),
    tickerInferenceDescription: tickerDescription(),
    positionValueDescription: positionValueDescription(),
    recoveryAccumulation: await runRecoveryAccumulationVector(),
    defaultThinking: {
      interactionsGemini2: defaultInteractions2.thinking_level,
      interactionsGemini3: defaultInteractions3.thinking_level,
      generateContentGemini2Budget:
        defaultGenerate2.thinkingConfig.thinkingBudget,
      generateContentGemini3Level:
        defaultGenerate3.thinkingConfig.thinkingLevel,
    },
  };
}

describe('TD-PARITY-14 engine source-pin contract', () => {
  it('pins the permitted 90-day and seven-day UTC windows', () => {
    const today = new Date(VECTORS.fixedClock);
    // Ninety days is shared behavior, not an allowed divergence.
    expect(MAX_TRANSACTION_WINDOW_DAYS).toBe(90);
    expect(RECENT_TRANSACTION_WINDOW_DAYS)
      .toBe(MANIFEST.allowedDivergences.transactionHistoryWindow.laterCrawlUtcCalendarDays);
    expect(MANIFEST.allowedDivergences.transactionHistoryWindow)
      .toMatchObject({
        comparisonInputUtcCalendarDays: 7,
        firstCrawlComparisonInput: 'empty',
      });
    expect(deriveTransactionCutoffDate({ today }))
      .toBe(VECTORS.expectedWindows.firstCrawlCutoff);
    expect(deriveTransactionCutoffDate({ lastSuccessfulCrawlDay: '2020-01-01', today }))
      .toBe(VECTORS.expectedWindows.laterCrawlCutoff);
  });

  it('pins both complete rendered prompts and their ordered transaction procedure', () => {
    const prompts = renderPinnedPrompts();
    expect(sha256(prompts.first))
      .toBe(MANIFEST.generatedArtifactDigests.completeFirstCrawlPrompt);
    expect(sha256(prompts.later))
      .toBe(MANIFEST.generatedArtifactDigests.completeLaterCrawlPrompt);
    expect(prompts.later).toContain('### Decision procedure for each HTML row');
    expect(prompts.later).toContain(
      MANIFEST.allowedDivergences.syntheticTransactionIdentity
        .additionalAcceptedPrefix,
    );
    expect(prompts.later).toContain('content:');
    expect(prompts.later).toContain('same owning account');
    expect(prompts.later).toContain('Memory notes must ONLY contain structural information');
  });

  it('pins every step-function schema field, requirement, and description', () => {
    expect(semanticDigest(GEMINI_STEP_FUNCTION_DECLARATIONS))
      .toBe(MANIFEST.generatedArtifactDigests.completeStepFunctionSchema);
    const schemaText = JSON.stringify(GEMINI_STEP_FUNCTION_DECLARATIONS);
    expect(schemaText).toContain('existingCanonicalId');
    expect(schemaText).toContain('Number of IDENTICAL occurrences');
    expect(schemaText).toContain('providerAccountId');
    expect(schemaText).toContain('NEVER include user financial data');
  });

  it('runs every frozen accumulator and exact-count expansion vector', () => {
    const results = VECTORS.accumulatorScenarios.map(scenario => ({
      id: scenario.id,
      result: runAccumulatorScenario(scenario),
    }));
    for (const [index, scenario] of VECTORS.accumulatorScenarios.entries()) {
      expect(results[index].result, scenario.id).toEqual(scenario.expected);
    }
    expect(semanticDigest(results)).toBe(MANIFEST.generatedArtifactDigests.accumulatorResults);
  });

  it('pins zero-temperature sampling on every supported Gemini path', () => {
    const sampling = {
      interactionsGemini2: getInteractionsGenerationConfig(
        'gemini-2.5-flash',
        8192,
        undefined,
        'low',
      ),
      interactionsGemini3: getInteractionsGenerationConfig(
        'gemini-3.1-flash-lite-preview',
        8192,
        undefined,
        'low',
      ),
      generateContentGemini2: getModelConfig('gemini-2.5-flash', 'low'),
      generateContentGemini3: getModelConfig('gemini-3.1-flash-lite-preview', 'low'),
    };
    expect(Object.values(sampling).every(config => config.temperature === 0)).toBe(true);
    expect(MANIFEST.allowedDivergences.modelControls.gemini3Temperature).toBe(0);
    expect(semanticDigest(sampling)).toBe(MANIFEST.generatedArtifactDigests.modelSampling);
  });

  it('compares restored shared semantics against neutral behavior vectors', async () => {
    const results = await runSharedSemanticVectors();
    expect(results.receivedHistoryOrder)
      .toEqual(VECTORS.sharedSemanticVectors.receivedHistoryOrder);
    expect(results.positionReconciliationSignal).toBe(true);
    expect(results.signedPositionControl).toBeNull();
    expect(results.tickerInferenceDescription)
      .toBe(VECTORS.sharedSemanticVectors.tickerInferenceDescription);
    expect(results.positionValueDescription)
      .toBe(VECTORS.sharedSemanticVectors.positionValueDescription.pinned);
    expect(VECTORS.sharedSemanticVectors.positionValueDescription.allowedTransformations)
      .toEqual([]);
    expect(results.recoveryAccumulation)
      .toEqual(VECTORS.sharedSemanticVectors.recoveryAccumulation.expected);
    expect(VECTORS.sharedSemanticVectors.recoveryAccumulation.allowedTransformations)
      .toEqual([]);
    expect(results.defaultThinking)
      .toEqual(VECTORS.sharedSemanticVectors.defaultThinking);
    expect(semanticDigest(results))
      .toBe(MANIFEST.generatedArtifactDigests.sharedSemanticResults);
  });

  it('exercises every transaction/schema/model divergence recorded in the catalog', () => {
    const divergences = MANIFEST.allowedDivergences;
    const prompt = renderPinnedPrompts().later;
    expect(prompt).toContain(
      divergences.syntheticTransactionIdentity.additionalAcceptedPrefix,
    );
    expect(buildDataContext([commonPromptOptions.existingAccounts![0]], [], []))
      .toContain('providerAccountId "account-gbp"');
    expect(divergences.modelContext.exactProviderAccountIdContext).toBe(true);

    const position: NormalizedPosition = {
      providerPositionId: 'shared-position-id',
      providerAccountId: 'account-a',
      name: 'ACME',
      quantity: 1,
      currency: 'GBP',
      valueNative: 1,
    };
    expect(positionDedupKey(position)).not.toBe(positionDedupKey({
      ...position,
      providerAccountId: 'account-b',
    }));
    expect(divergences.modelContext.accountScopedPositionIdentity).toBe(true);

    const accountItems = reportDataProperties().accounts as {
      items?: { properties?: Record<string, unknown> };
    } | undefined;
    expect(Object.keys(accountItems?.items?.properties ?? {}))
      .toEqual(expect.arrayContaining(divergences.normalizedAccountExtensions));

    expect(safeBrowserUrlsInText(
      'redirected to https://bank.example/callback?code=secret#token',
    )).toBe('redirected to https://bank.example/callback');
    expect(divergences.securityAdaptations
      .urlAndSecretRedactionBeforeTelemetryOrMemory).toBe(true);

    expect(getInteractionsGenerationConfig(
      'gemini-3.1-flash-lite-preview',
      8192,
      undefined,
      'high',
    )).toMatchObject({ temperature: 0, thinking_level: 'high' });
    expect(divergences.modelControls)
      .toMatchObject({ gemini3Temperature: 0, optionalPerCrawlThinkingOverride: true });
  });
});
