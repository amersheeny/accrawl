/**
 * Validate-then-store: promote a session's extracted records to the canonical tables.
 *
 * The engine writes RAW, unvalidated extraction to staged_records under a least-privilege role; the
 * control-plane (this module, full-access role) validates each record (reject-not-coerce — a record
 * with reasoning text in bookingDate or a NaN amount is dropped loudly, never coerced) and writes the
 * survivors transactionally:
 *   - accounts: upsert by deterministic id; a returned account resets its missing counter.
 *   - transactions: upsert by evidence-backed canonical id. Equal-looking rows are never collapsed.
 *     The CONNECTION watermark is advanced to
 *     the crawl day by the completion bookkeeping, not here.
 *   - positions: upsert by account-scoped deterministic id.
 *   - accounts NOT returned are retained unchanged: a partial crawl is not closure evidence.
 *   - positions NOT returned are retained: an incomplete crawl is not evidence that a holding was sold.
 *
 * Accrawl stores native values only (no FX conversion — that is a product concern, out of scope).
 */
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import {
  accounts,
  transactions,
  positions,
  sessionTransactionTargets,
  transactionOccurrences,
} from '../db/schema';
import type { NormalizedAccount, NormalizedTransaction, NormalizedPosition } from '@accrawl/contracts';
import {
  assignTransactionId,
  canonicalUpdateKey,
  deterministicAccountId,
  deterministicPositionId,
  deriveTransactionCutoffDate,
  isBankProvidedId,
  resolveAuthoritativeTransactionUpdateTargets,
  type TxIdentityInput,
} from './tx-identity';

const FiniteNumber = z.number().finite();
const IsoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'bookingDate must be YYYY-MM-DD')
  .refine((date) => {
    const parsed = new Date(`${date}T00:00:00.000Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
  }, 'bookingDate must be a real calendar date');
const Currency = z.string().regex(/^[A-Z]{3}$/, 'currency must be a 3-letter ISO-4217 code');
export const CRAWLED_ACCOUNT_TYPES = [
  'current',
  'savings',
  'credit',
  'investment',
  'broker_cash',
  'pension',
  'study_fund',
  'loan',
  'mortgage',
  'other',
] as const;

// Optional read-side overlays (spec §9/§10). Validated (reject-not-coerce) so a malformed overlay is
// dropped, not persisted. Absent from the schema, these would be silently stripped and never stored.
const CreditCardLiabilitySchema = z.object({
  aprs: z.array(z.object({
    percentage: FiniteNumber,
    type: z.enum(['purchase', 'cash', 'balance_transfer', 'penalty', 'other']).optional(),
  })).optional(),
  lastStatementDate: z.string().optional(),
  lastStatementBalance: FiniteNumber.optional(),
  minimumPaymentAmount: FiniteNumber.optional(),
  nextPaymentDueDate: z.string().optional(),
});
const PensionDetailSchema = z.object({
  scheme: z.enum(['defined_benefit', 'defined_contribution', 'provident_fund', 'study_fund', 'other']).optional(),
  employer: z.string().optional(),
  contributionsToDate: FiniteNumber.optional(),
  vestedValue: FiniteNumber.optional(),
});

export const CrawledAccountSchema = z.object({
  providerAccountId: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  currency: Currency,
  type: z.enum(CRAWLED_ACCOUNT_TYPES),
  balance: FiniteNumber,
  available: FiniteNumber.optional(),
  limit: FiniteNumber.optional(),
  creditCardLiability: CreditCardLiabilitySchema.optional(),
  pensionDetail: PensionDetailSchema.optional(),
});
export const CrawledTransactionSchema = z.object({
  providerAccountId: z.string().optional(),
  // Accrawl's occurrence-identity transport deliberately accepts id-less rows;
  // storage never derives identity from financial content.
  providerTransactionId: z.string().optional(),
  bookingDate: IsoDate,
  amount: FiniteNumber,
  currency: Currency,
  merchant: z.string().optional(),
  description: z.string(),
  providerCategory: z.string().optional(),
  isPending: z.boolean(),
  existingCanonicalId: z.string().optional(),
  extractionOccurrenceId: z.string().uuid().optional(),
});
export const CrawledPositionSchema = z.object({
  providerPositionId: z.string().min(1),
  providerAccountId: z.string().min(1),
  symbol: z.string().min(1).optional(),
  name: z.string().min(1),
  quantity: FiniteNumber,
  currency: Currency,
  valueNative: FiniteNumber,
  costBasisNative: FiniteNumber.optional(),
  isin: z.string().min(1).optional(),
  exchange: z.string().min(1).optional(),
  securityType: z.string().min(1).optional(),
});

export type CrawledAccount = z.infer<typeof CrawledAccountSchema>;
export type CrawledTransaction = z.infer<typeof CrawledTransactionSchema>;
export type CrawledPosition = z.infer<typeof CrawledPositionSchema>;

/** Merge only fields actually observed in this crawl. Optional properties that
 * are absent (or explicitly `undefined` in a trusted internal call) retain the
 * stored value; required/current fields present in the extraction replace it. */
export function mergePresentFields<T extends object>(
  previous: T | undefined,
  observed: T,
): T {
  const merged: Record<string, unknown> = { ...(previous ?? {}) };
  for (const [key, value] of Object.entries(observed)) {
    if (value !== undefined) merged[key] = value;
  }
  return merged as T;
}

export function mergeAccountData(
  previous: NormalizedAccount | undefined,
  observed: CrawledAccount,
): NormalizedAccount {
  const merged = mergePresentFields(
    previous,
    observed as unknown as NormalizedAccount,
  );

  // Description is emitted on every stored account record; an extraction that
  // has no description clears the old value to the contract's neutral string.
  merged.description = observed.description ?? '';
  return merged;
}

export function mergePositionData(
  previous: NormalizedPosition | undefined,
  observed: CrawledPosition,
): NormalizedPosition {
  // Current numeric/ticker fields replace the prior observation even when an
  // optional value is absent. The page-derived identity enrichments are
  // additive and survive a later view that does not expose them.
  return {
    ...(observed as unknown as NormalizedPosition),
    ...(observed.isin === undefined && previous?.isin !== undefined ? { isin: previous.isin } : {}),
    ...(observed.exchange === undefined && previous?.exchange !== undefined ? { exchange: previous.exchange } : {}),
    ...(observed.securityType === undefined && previous?.securityType !== undefined
      ? { securityType: previous.securityType }
      : {}),
  };
}

/** Validate raw records; return the survivors + a reject count. Invalid records are logged, not coerced. */
export function validateRecords<T>(
  schema: z.ZodType<T>,
  records: unknown[],
  kind: 'account' | 'transaction' | 'position',
): { valid: T[]; rejected: number } {
  const valid: T[] = [];
  let rejected = 0;
  for (const record of records) {
    const parsed = schema.safeParse(record);
    if (parsed.success) {
      valid.push(parsed.data);
    } else {
      rejected++;
      console.error(`[store] rejecting invalid ${kind} record`, {
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
  }
  return { valid, rejected };
}

export interface StoreCrawlInput {
  connectionId: string;
  /**
   * Session whose private stored-row target snapshot authorizes and resolves
   * `existingCanonicalId` values. Production promotion and recovery always
   * supply this; the stored mapping never crosses the crawler boundary.
   */
  sessionId?: string;
  accounts: unknown[];
  transactions: unknown[];
  positions: unknown[];
  /** Injectable authoritative targets for focused storage tests and trusted internal callers. */
  recentlySentUpdateTargets?: ReadonlyMap<string, ReadonlySet<string>>;
}

export interface StoreCrawlResult {
  accountsStored: number;
  transactionsStored: number;
  /** Newly inserted transactions this run (change cursor `added`). */
  transactionsAdded: number;
  /** Existing transactions whose `data` changed this run, e.g. pending→posted (change cursor `modified`). */
  transactionsModified: number;
  transactionsDropped: number;
  positionsStored: number;
  quarantinedAccounts: number;
  staleDeletedPositions: number;
  rejected: { accounts: number; transactions: number; positions: number };
  /** Newest booking date among the transactions stored this run (informational). */
  newestBookingDate?: string;
}

/**
 * Attach a durable private occurrence id to a staged transaction when it came
 * from an older engine that did not mint one. The staging row's UUID identifies
 * the observation without inspecting any financial fields.
 */
export function stagedTransactionForStore(record: { id: string; data: unknown }): unknown {
  if (!record.data || typeof record.data !== 'object' || Array.isArray(record.data)) {
    return record.data;
  }
  if ('extractionOccurrenceId' in record.data) return record.data;
  return { ...record.data, extractionOccurrenceId: record.id };
}

export async function storeCrawlResults(db: Db, input: StoreCrawlInput): Promise<StoreCrawlResult> {
  const { connectionId } = input;
  // Production promotions use the durable crawl session id. Trusted direct
  // stores receive a fresh invocation scope, so an occurrence UUID reused by
  // a later independent call can never resolve to the same transaction row.
  const occurrenceScopeId = input.sessionId ?? randomUUID();
  const va = validateRecords(CrawledAccountSchema, input.accounts, 'account');
  const vt = validateRecords(CrawledTransactionSchema, input.transactions, 'transaction');
  const vp = validateRecords(CrawledPositionSchema, input.positions, 'position');
  // The current engine supplies this id, and stagedTransactionForStore derives
  // it from the durable staging-row UUID for older engines. Keep the storage
  // boundary lossless for trusted direct callers too: every otherwise-valid
  // observation gets an identity before any ambiguity can demote its bank
  // reference or update relationship. A random UUID is deliberately unrelated
  // to date, amount, merchant, description, or any other financial content.
  const validTransactions = vt.valid.map((transaction) => (
    transaction.extractionOccurrenceId
      ? transaction
      : { ...transaction, extractionOccurrenceId: randomUUID() }
  ));

  return db.transaction(async (tx) => {
    const now = new Date();

    // Resolve update authority from the exact private snapshot persisted before
    // this session was dispatched. The crawler receives only canonical values;
    // immutable database row ids stay on the control-plane side. The injectable
    // map exists for focused storage callers, but a real session always wins.
    const authoritativeUpdateTargets = new Map<string, Set<string>>();
    const addUpdateTarget = (
      providerAccountId: string | undefined,
      canonicalId: string,
      transactionId: string,
    ): void => {
      const key = canonicalUpdateKey(providerAccountId, canonicalId);
      const targets = authoritativeUpdateTargets.get(key);
      if (targets) targets.add(transactionId);
      else authoritativeUpdateTargets.set(key, new Set([transactionId]));
    };
    if (input.sessionId) {
      const targetRows = await tx
        .select({
          providerAccountId: sessionTransactionTargets.providerAccountId,
          canonicalId: sessionTransactionTargets.canonicalId,
          transactionId: sessionTransactionTargets.transactionId,
        })
        .from(sessionTransactionTargets)
        .where(eq(sessionTransactionTargets.sessionId, input.sessionId));
      for (const target of targetRows) {
        addUpdateTarget(target.providerAccountId || undefined, target.canonicalId, target.transactionId);
      }
    } else {
      for (const [key, targetIds] of input.recentlySentUpdateTargets ?? []) {
        authoritativeUpdateTargets.set(key, new Set(targetIds));
      }
    }
    // ── accounts ──
    const storedAccountPayloads = await tx
      .select({ id: accounts.id, data: accounts.data })
      .from(accounts)
      .where(eq(accounts.connectionId, connectionId));
    const storedAccountsById = new Map(
      storedAccountPayloads.map(row => [row.id, row.data]),
    );
    for (const a of va.valid) {
      const id = deterministicAccountId(connectionId, a.providerAccountId);
      const data = mergeAccountData(storedAccountsById.get(id), a);
      await tx
        .insert(accounts)
        .values({ id, connectionId, data, missingSinceCrawlCount: 0, lastSeenAt: now, updatedAt: now })
        .onConflictDoUpdate({
          target: accounts.id,
          set: { data, missingSinceCrawlCount: 0, lastSeenAt: now, updatedAt: now },
        });
      storedAccountsById.set(id, data);
    }

    // ── transactions (evidence-backed identity) ──
    let transactionsStored = 0;
    let transactionsDropped = 0;
    let transactionsAdded = 0;
    let transactionsModified = 0;
    let newestBookingDate: string | undefined;
    // The canonical table is the authority for immutable row ids. A row's
    // providerTransactionId can change after pending→posted, so re-hashing its
    // current canonical value can fork a duplicate. Index every existing row
    // inside this same promotion transaction and keep the index current as
    // writes below change canonical values.
    const storedTransactionRows = await tx
      .select({ id: transactions.id, data: transactions.data })
      .from(transactions)
      .where(eq(transactions.connectionId, connectionId));
    const storedById = new Map<string, NormalizedTransaction>();
    const rowIdsByCanonical = new Map<string, Set<string>>();
    const addCanonicalOwner = (id: string, data: NormalizedTransaction): void => {
      const key = canonicalUpdateKey(data.providerAccountId, data.providerTransactionId);
      const owners = rowIdsByCanonical.get(key);
      if (owners) owners.add(id);
      else rowIdsByCanonical.set(key, new Set([id]));
    };
    const removeCanonicalOwner = (id: string, data: NormalizedTransaction): void => {
      const key = canonicalUpdateKey(data.providerAccountId, data.providerTransactionId);
      const owners = rowIdsByCanonical.get(key);
      if (!owners) return;
      owners.delete(id);
      if (owners.size === 0) rowIdsByCanonical.delete(key);
    };
    const replaceStoredIndex = (id: string, data: NormalizedTransaction): void => {
      const prior = storedById.get(id);
      if (prior) removeCanonicalOwner(id, prior);
      storedById.set(id, data);
      addCanonicalOwner(id, data);
    };
    for (const row of storedTransactionRows) replaceStoredIndex(row.id, row.data);
    const updateResolution = resolveAuthoritativeTransactionUpdateTargets(
      validTransactions,
      authoritativeUpdateTargets,
      storedById,
    );
    const { resolvedTargets: resolvedUpdateTargets, droppedClaimIndexes } = updateResolution;
    const approvedUpdateKeys = new Set(resolvedUpdateTargets.keys());
    // Immutable view of ownership at the start of this promotion. Collision
    // decisions must not depend on whether another row happened to be updated
    // earlier in this loop.
    const initialRowIdsByCanonical = new Map(
      [...rowIdsByCanonical].map(([key, ids]) => [key, new Set(ids)]),
    );
    const canonicalBelongsToAnotherRow = (key: string, transactionId: string): boolean => {
      const owners = new Set([
        ...(initialRowIdsByCanonical.get(key) ?? []),
        ...(rowIdsByCanonical.get(key) ?? []),
      ]);
      return [...owners].some((id) => id !== transactionId);
    };

    // An occurrence claim is the durable idempotency key for one exact engine
    // observation. It is intentionally unrelated to transaction content.
    const occurrenceIds = [...new Set(
      validTransactions
        .map((candidate) => candidate.extractionOccurrenceId)
        .filter((id): id is string => !!id),
    )];
    const claimedTransactionByOccurrence = new Map<string, string>();
    if (occurrenceIds.length > 0) {
      const claimRows = await tx
        .select({
          occurrenceId: transactionOccurrences.occurrenceId,
          transactionId: transactionOccurrences.transactionId,
        })
        .from(transactionOccurrences)
        .where(and(
          eq(transactionOccurrences.connectionId, connectionId),
          eq(transactionOccurrences.scopeId, occurrenceScopeId),
          inArray(transactionOccurrences.occurrenceId, occurrenceIds),
        ));
      for (const claim of claimRows) {
        claimedTransactionByOccurrence.set(claim.occurrenceId, claim.transactionId);
      }
    }

    // Repeated references in the same returned batch are non-unique regardless
    // of content. Precompute before writing so every occurrence is treated
    // symmetrically instead of whichever row happened to be processed second.
    const incomingProviderIdCounts = new Map<string, number>();
    for (const candidate of validTransactions) {
      if (!isBankProvidedId(candidate.providerTransactionId)) continue;
      const key = canonicalUpdateKey(candidate.providerAccountId, candidate.providerTransactionId!);
      incomingProviderIdCounts.set(key, (incomingProviderIdCounts.get(key) ?? 0) + 1);
    }

    const seenOccurrenceIdsThisBatch = new Set<string>();
    const transactionStorageFloorDate = deriveTransactionCutoffDate({ today: now });
    for (const [transactionIndex, t] of validTransactions.entries()) {
      if (t.extractionOccurrenceId) {
        if (seenOccurrenceIdsThisBatch.has(t.extractionOccurrenceId)) {
          throw new Error('the same transaction occurrence id appears more than once in one promotion');
        }
        seenOccurrenceIdsThisBatch.add(t.extractionOccurrenceId);
        const alreadyClaimedTransactionId = claimedTransactionByOccurrence.get(t.extractionOccurrenceId);
        if (alreadyClaimedTransactionId) {
          if (!storedById.has(alreadyClaimedTransactionId)) {
            throw new Error('transaction occurrence points to a missing or cross-connection transaction');
          }
          // Exact staged-payload replay. Do not reapply its possibly stale
          // fields; the first promotion and the occurrence claim committed
          // atomically.
          transactionsStored++;
          if (!newestBookingDate || t.bookingDate > newestBookingDate) newestBookingDate = t.bookingDate;
          continue;
        }
      }

      const rejectedUpdateReason = droppedClaimIndexes.get(transactionIndex);
      if (rejectedUpdateReason) {
        transactionsDropped++;
        console.error('[store] dropping invalid transaction update claim', {
          reason: rejectedUpdateReason,
        });
        continue;
      }

      if (
        !t.existingCanonicalId
        && !isBankProvidedId(t.providerTransactionId)
        && t.bookingDate < transactionStorageFloorDate
      ) {
        transactionsDropped++;
        console.warn('[store] dropping id-less transaction older than the 90-day storage floor', {
          bookingDate: t.bookingDate,
          transactionStorageFloorDate,
        });
        continue;
      }

      let identityInput: TxIdentityInput = t;
      let authoritativeExistingTxId: string | undefined;
      let preserveAsOccurrenceReason: string | undefined;
      if (t.existingCanonicalId) {
        const updateKey = canonicalUpdateKey(t.providerAccountId, t.existingCanonicalId);
        authoritativeExistingTxId = resolvedUpdateTargets.get(updateKey)!;

        // An update may introduce a replacement provider reference. If that
        // reference is repeated in this batch or belongs to any other row in
        // either the initial or current ownership view, it cannot become
        // canonical on this target. This deliberately remains conservative
        // when another update vacates the value: processing order must not
        // change the result.
        if (isBankProvidedId(t.providerTransactionId)) {
          const providerKey = canonicalUpdateKey(t.providerAccountId, t.providerTransactionId!);
          if (
            (incomingProviderIdCounts.get(providerKey) ?? 0) > 1
            || canonicalBelongsToAnotherRow(providerKey, authoritativeExistingTxId)
          ) {
            identityInput = { ...t, providerTransactionId: undefined };
          }
        }
      }

      if (!identityInput.existingCanonicalId && isBankProvidedId(identityInput.providerTransactionId)) {
        const providerKey = canonicalUpdateKey(
          identityInput.providerAccountId,
          identityInput.providerTransactionId!,
        );
        if ((incomingProviderIdCounts.get(providerKey) ?? 0) > 1) {
          preserveAsOccurrenceReason = 'the provider reference repeats within this extraction';
        } else if (
          (initialRowIdsByCanonical.get(providerKey)?.size ?? 0) > 0
          || (rowIdsByCanonical.get(providerKey)?.size ?? 0) > 0
        ) {
          // No explicit update relationship was supplied. The stored row and
          // observed row may be a reread or two genuine transactions sharing a
          // provider reference; content cannot decide. Never overwrite.
          preserveAsOccurrenceReason = 'the provider reference already belongs to a stored row';
        }
      }

      if (preserveAsOccurrenceReason) {
        identityInput = {
          ...t,
          providerTransactionId: undefined,
          existingCanonicalId: undefined,
        };
        console.warn('[store] preserving transaction as an independent occurrence', {
          reason: preserveAsOccurrenceReason,
        });
      }

      let idy = assignTransactionId(
        connectionId,
        identityInput,
        approvedUpdateKeys,
        { authoritativeExistingTxId, occurrenceScopeId },
      );
      // A canonical lookup can be absent while its deterministic target is
      // occupied by a legacy/migrated row carrying a different canonical
      // value. Treat that as ambiguity too; never let the upsert overwrite it.
      if (
        !('dropped' in idy)
        && !identityInput.existingCanonicalId
        && isBankProvidedId(identityInput.providerTransactionId)
        && storedById.has(idy.txId)
      ) {
        identityInput = {
          ...t,
          providerTransactionId: undefined,
          existingCanonicalId: undefined,
        };
        idy = assignTransactionId(
          connectionId,
          identityInput,
          approvedUpdateKeys,
          { occurrenceScopeId },
        );
        console.warn('[store] preserving transaction as an independent occurrence', {
          reason: 'the deterministic provider-reference target is already occupied',
        });
      }
      if ('dropped' in idy) {
        transactionsDropped++;
        console.error('[store] dropping transaction without a safe identity', {
          reason: idy.reason,
        });
        continue;
      }
      const {
        existingCanonicalId: _existingCanonicalId,
        extractionOccurrenceId: _extractionOccurrenceId,
        ...publicFields
      } = t;
      const observedData = {
        ...publicFields,
        providerTransactionId: idy.providerTransactionIdField,
      } as unknown as NormalizedTransaction;
      const data = mergePresentFields(storedById.get(idy.txId), observedData);
      // Every returned observation is written and advances updatedAt. The only
      // no-op is an exact occurrence replay handled above.
      const upserted = await tx
        .insert(transactions)
        // createdAt == updatedAt on insert (same `now`) is the invariant the change cursor relies on to
        // classify a row as `added` (never modified) vs `modified` (updatedAt advanced past createdAt).
        .values({ id: idy.txId, connectionId, data, createdAt: now, updatedAt: now })
        .onConflictDoUpdate({
          target: transactions.id,
          set: { data, updatedAt: now },
        })
        .returning({ inserted: sql<boolean>`(xmax = 0)` });
      transactionsStored++;
      if (upserted.length > 0) {
        if (upserted[0].inserted) transactionsAdded++;
        else transactionsModified++;
      }

      if (t.extractionOccurrenceId) {
        const insertedClaims = await tx
          .insert(transactionOccurrences)
          .values({
            connectionId,
            sessionId: input.sessionId,
            scopeId: occurrenceScopeId,
            occurrenceId: t.extractionOccurrenceId,
            transactionId: idy.txId,
          })
          .onConflictDoNothing({
            target: [
              transactionOccurrences.connectionId,
              transactionOccurrences.scopeId,
              transactionOccurrences.occurrenceId,
            ],
          })
          .returning({ transactionId: transactionOccurrences.transactionId });
        if (insertedClaims.length === 0) {
          const [existingClaim] = await tx
            .select({ transactionId: transactionOccurrences.transactionId })
            .from(transactionOccurrences)
            .where(and(
              eq(transactionOccurrences.connectionId, connectionId),
              eq(transactionOccurrences.scopeId, occurrenceScopeId),
              eq(transactionOccurrences.occurrenceId, t.extractionOccurrenceId),
            ))
            .limit(1);
          if (!existingClaim || existingClaim.transactionId !== idy.txId) {
            throw new Error('transaction occurrence was claimed by a different transaction');
          }
        }
        claimedTransactionByOccurrence.set(t.extractionOccurrenceId, idy.txId);
      }

      replaceStoredIndex(idy.txId, data);
      if (!newestBookingDate || t.bookingDate > newestBookingDate) newestBookingDate = t.bookingDate;
    }

    // ── positions ──
    const knownProviderAccountIds = new Set(
      [...storedAccountsById.values()]
        .map(row => row.providerAccountId)
        .filter(Boolean),
    );
    const validPositions = vp.valid.filter(position =>
      knownProviderAccountIds.has(position.providerAccountId),
    );
    const unknownAccountPositions = vp.valid.length - validPositions.length;
    if (unknownAccountPositions > 0) {
      console.error(
        `[store] rejecting ${unknownAccountPositions} position record(s) whose providerAccountId `
        + `does not match an account on this connection`,
      );
    }
    const storedPositionPayloads = await tx
      .select({ id: positions.id, data: positions.data })
      .from(positions)
      .where(eq(positions.connectionId, connectionId));
    const storedPositionsById = new Map(
      storedPositionPayloads.map(row => [row.id, row.data]),
    );
    for (const p of validPositions) {
      const id = deterministicPositionId(connectionId, p.providerAccountId, p.providerPositionId);
      const data = mergePositionData(storedPositionsById.get(id), p);
      await tx
        .insert(positions)
        .values({ id, connectionId, data, updatedAt: now })
        .onConflictDoUpdate({ target: positions.id, set: { data, updatedAt: now } });
      storedPositionsById.set(id, data);
    }

    // A missing account is a coverage gap, not proof of closure. Returned
    // accounts reset their counter above; unreturned accounts remain untouched.
    const quarantinedAccounts = 0;

    // Absence is not a sale signal. A crawl may cover one account's holdings and miss another account,
    // so deleting unreturned positions would turn a coverage gap into irreversible financial data loss.
    const staleDeletedPositions = 0;

    // The CONNECTION watermark (crawlStats.lastSuccessfulTxCrawlDay) is advanced to the crawl day by
    // the completion bookkeeping, not here — store-crawl only reports the newest booking date it stored.
    return {
      accountsStored: va.valid.length,
      transactionsStored,
      transactionsAdded,
      transactionsModified,
      transactionsDropped,
      positionsStored: validPositions.length,
      quarantinedAccounts,
      staleDeletedPositions,
      rejected: {
        accounts: va.rejected,
        transactions: vt.rejected,
        positions: vp.rejected + unknownAccountPositions,
      },
      newestBookingDate,
    };
  });
}
