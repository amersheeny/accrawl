/**
 * Zod schemas for the Accrawl contract. The engine validates `/crawl` request
 * bodies against `CrawlRequestSchema`; the control-plane API and web UI reuse the
 * same schema so request validation never drifts from the wire type.
 */
import { z } from 'zod';
import {
  assertRecentTransactionHistory,
  CrawlRecentTransactionSchema,
  reassembleRecentTransactionHistory,
  RecentTransactionHistoryChunkSchema,
  RecentTransactionHistoryManifestSchema,
} from './transaction-history';
import type {
  CrawlRequest,
  RecentTransactionHistoryChunk,
} from './types';

/**
 * The worker routing context, under whichever name the sender used.
 *
 * A release updates workers before the control plane, so for one release a new reader is fed by a
 * sender that still uses the old name. Every reader goes through this rather than picking a field, so
 * dropping the old name is one deletion here instead of a hunt.
 */
export function workerContextOf(
  request: Pick<CrawlRequest, 'workerContext' | 'firestoreWorker'>,
): CrawlRequest['workerContext'] {
  return request.workerContext ?? request.firestoreWorker;
}

/** Where a worker running elsewhere finds its session, and the one attempt it may claim. */
const WorkerContextSchema = z.object({
  namespace: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
  runtimePartitionId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
  attemptId: z.string().uuid(),
}).strict();

const CrawlRequestObjectSchema = z.object({
  sessionId: z.string().min(1),
  workerContext: WorkerContextSchema.optional(),
  // Accepted for one release while a control plane that predates the rename is still emitting it.
  firestoreWorker: WorkerContextSchema.optional(),
  loginUrl: z.string().url(),
  allowedDomains: z.array(z.string()).optional(),
  username: z.string().min(1),
  password: z.string().min(1),
  dob: z.string().optional(),
  phone: z.string().optional(),
  playbook: z.string().optional(),
  customInstructions: z.string().optional(),
  extractionHints: z.object({
    dateFormat: z.string().optional(),
    currency: z.string().optional(),
    accountsSelector: z.string().optional(),
    transactionsSelector: z.string().optional(),
    positionsSelector: z.string().optional(),
  }).optional(),
  loginHints: z.object({
    usernameField: z.string().optional(),
    passwordField: z.string().optional(),
    dobField: z.string().optional(),
    phoneField: z.string().optional(),
    submitButton: z.string().optional(),
  }).optional(),
  requires2fa: z.boolean(),
  otpSenderPattern: z.string().optional(),
  country: z.string().length(2).optional(),
  maxSteps: z.number().int().min(5).max(1000),
  timeoutSeconds: z.number().int().min(60).max(3600),
  // Route the browser's traffic through the user's device over a SOCKS5 tunnel. Present in the wire
  // type; without it here the field was silently stripped at the engine boundary.
  useDeviceProxy: z.boolean().optional(),
  // Short-lived, session+device-bound HMAC token the engine presents to open the device-proxy WS. The
  // schema is .strict(), so this must be declared or it's rejected at the engine boundary.
  tunnelToken: z.string().optional(),
  existingAccounts: z.array(z.object({
    providerAccountId: z.string(),
    name: z.string(),
    description: z.string().nullish().transform(v => v ?? undefined),
    currency: z.string(),
    type: z.string(),
    balance: z.number().nullish().transform(v => v ?? undefined),
  })).optional(),
  existingPositions: z.array(z.object({
    providerPositionId: z.string(),
    providerAccountId: z.string().optional(),
    symbol: z.string(),
    name: z.string(),
    currency: z.string(),
    quantity: z.number(),
  })).optional(),
  recentTransactions: z.array(CrawlRecentTransactionSchema).optional(),
  recentTransactionsManifest: RecentTransactionHistoryManifestSchema.optional(),
  // Hard floor for the LLM extractor: must NOT return any tx older than this
  // date (YYYY-MM-DD). The caller already has every tx older than this.
  cutoffDate: z.string().optional(),
  // Floor for an account we hold no transactions for, which cutoffDate must not
  // govern: nothing is stored for it, so "the caller already has it" is false.
  historyFloorDate: z.string().optional(),
  // Known accounts with no stored transactions at all (from every stored row,
  // not the windowed list). They reach back to historyFloorDate.
  accountsWithoutStoredHistory: z.array(z.string()).optional(),
  model: z.string().optional(),
  thinkingLevel: z.enum(['minimal', 'low', 'medium', 'high']).optional(),
  crawlMemory: z.string().optional(),
}).strict(); // reject unknown keys so a future wire-type/schema field-name drift surfaces as a 400, not a silent drop

function addHistoryFenceIssue(
  value: z.infer<typeof CrawlRequestObjectSchema>,
  context: z.RefinementCtx,
  requireInlineHistory: boolean,
): void {
  if (value.recentTransactions !== undefined) {
    if (!value.recentTransactionsManifest) {
      context.addIssue({
        code: 'custom',
        path: ['recentTransactionsManifest'],
        message: 'recentTransactions requires an exact count and SHA-256 manifest',
      });
      return;
    }
    try {
      assertRecentTransactionHistory(
        value.recentTransactions,
        value.recentTransactionsManifest,
      );
    } catch (error) {
      context.addIssue({
        code: 'custom',
        path: ['recentTransactions'],
        message: error instanceof Error
          ? error.message
          : 'transaction history integrity validation failed',
      });
    }
    return;
  }
  if (requireInlineHistory && value.recentTransactionsManifest) {
    context.addIssue({
      code: 'custom',
      path: ['recentTransactions'],
      message: 'transaction history chunks must be reassembled before crawl execution',
    });
  }
}

/**
 * Wire schema used before external transaction-history chunks have been loaded.
 * A manifest without an inline list is valid only at this transport boundary.
 */
export const CrawlRequestTransportSchema = CrawlRequestObjectSchema.superRefine(
  (value, context) => addHistoryFenceIssue(value, context, false),
);

/** Logical request schema: any declared history is present, preserved in received order and fenced. */
export const CrawlRequestSchema = CrawlRequestObjectSchema.superRefine(
  (value, context) => addHistoryFenceIssue(value, context, true),
);

export const RecentTransactionHistoryChunkUploadSchema = z.strictObject({
  sessionId: z.string().min(1),
  manifest: RecentTransactionHistoryManifestSchema,
  chunk: RecentTransactionHistoryChunkSchema,
});

/** Convert a validated wire request plus its ordered fragments into a logical request. */
export function hydrateCrawlRequestTransactionHistory(
  input: unknown,
  chunks: ReadonlyArray<RecentTransactionHistoryChunk>,
): CrawlRequest {
  const transport = CrawlRequestTransportSchema.parse(input);
  if (!transport.recentTransactionsManifest) {
    return CrawlRequestSchema.parse(transport) as CrawlRequest;
  }
  if (transport.recentTransactions !== undefined) {
    if (chunks.length !== 0) {
      throw new Error('inline transaction history cannot also supply external chunks');
    }
    return CrawlRequestSchema.parse(transport) as CrawlRequest;
  }
  const recentTransactions = reassembleRecentTransactionHistory(
    transport.recentTransactionsManifest,
    chunks,
  );
  return CrawlRequestSchema.parse({
    ...transport,
    recentTransactions,
  }) as CrawlRequest;
}

/** The validated, parsed crawl request (output type of `CrawlRequestSchema`). */
export type CrawlRequestInput = z.infer<typeof CrawlRequestSchema>;
