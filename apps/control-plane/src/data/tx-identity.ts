/**
 * Deterministic transaction & account identity + the crawl cutoff window.
 *
 * Transactions have no universal id, so identity is evidence-driven and fail-safe:
 * Three layers, in order of trust:
 *   - Rule 4 (existingCanonicalId): the crawler flagged a row as an update to one we sent it last run.
 *     Honoured ONLY when storage resolves it through the exact private session snapshot to the immutable
 *     row id actually sent. A mutable/synthetic canonical value is never re-hashed into row identity.
 *   - Layer 1 (bank id): a real provider transaction id → hash(accountId:id).
 *   - Layer 2 (observed occurrence): no trustworthy unique bank id →
 *     hash(accountId:promotionScopeId:occurrenceId). The promotion scope prevents an accidental UUID reuse
 *     in another crawl from merging independent rows. Content fields never collapse transactions: two
 *     purchases may legitimately share account, date, amount, and description.
 *
 * The cutoff window is branch-based and anchored to the current UTC date: a connection with no successful
 * crawl fetches 90 calendar days; every later crawl fetches the preceding seven calendar days. Stored rows,
 * the date of the prior success, and legacy per-institution lookback configuration never move that window.
 */
import { createHash } from 'node:crypto';

export const CONTENT_ID_PREFIX = 'content:';
export const OCCURRENCE_ID_PREFIX = 'occurrence:';
export const MAX_TRANSACTION_WINDOW_DAYS = 90;
export const RECENT_TRANSACTION_WINDOW_DAYS = 7;

/**
 * Stable namespace for a transaction the crawler could NOT attribute to an account. It MUST be a fixed
 * constant, never a positional or order-dependent account: identity depending on "the first account in the
 * batch" would re-key the same unattributed transaction whenever the bank reorders its dashboard (or an
 * account drops out), duplicating it every crawl. The leading NUL makes it impossible to collide with a
 * real provider account id (which is always a trimmed, non-empty string).
 */
export const UNATTRIBUTED_ACCOUNT_KEY = '\u0000accrawl:unattributed';

export function hashValue(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Stable RFC 4122 v5-shaped identifier for a durable extraction occurrence.
 * The value is used only as a private identity token; deriving it from the
 * immutable crawl session and staging ordinal makes promotion retries exact.
 */
export function deterministicOccurrenceId(
  occurrenceScopeId: string,
  ordinal: string | number,
): string {
  const bytes = createHash('sha256')
    .update(idPreimage([occurrenceScopeId, ordinal]))
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}

/**
 * Injective preimage for a multi-part id. A bare `${a}:${b}` join is ambiguous — ("a:b","c") and
 * ("a","b:c") collide — which on a financial dedup key would silently merge two distinct records. JSON
 * array encoding is unambiguous regardless of what characters the parts contain.
 */
function idPreimage(parts: Array<string | number>): string {
  return JSON.stringify(parts);
}

export function deterministicAccountId(connectionId: string, providerAccountId: string): string {
  return hashValue(idPreimage([connectionId, providerAccountId])).slice(0, 20);
}

export function deterministicTransactionId(accountId: string, providerTransactionId: string): string {
  return hashValue(idPreimage([accountId, providerTransactionId])).slice(0, 20);
}

export function deterministicPositionId(
  connectionId: string,
  providerAccountId: string,
  providerPositionId: string,
): string {
  return hashValue(idPreimage([connectionId, providerAccountId, providerPositionId])).slice(0, 20);
}

/** A real bank-provided id — not "NONE"/empty, and not one of our synthetic canonical ids. */
export function isBankProvidedId(id: string | undefined): boolean {
  if (!id) return false;
  const normalized = id.trim().toUpperCase();
  return normalized !== 'NONE'
    && normalized !== ''
    && !normalized.startsWith(CONTENT_ID_PREFIX.toUpperCase())
    && !normalized.startsWith(OCCURRENCE_ID_PREFIX.toUpperCase());
}

export interface TxIdentityInput {
  providerAccountId?: string;
  providerTransactionId?: string;
  bookingDate: string;
  amount: number;
  description: string;
  /** Set by the crawler to flag this row as an update to a tx we sent it last run (Rule 4). */
  existingCanonicalId?: string;
  /** Engine-minted identity for one newly observed row with no trustworthy unique bank id. */
  extractionOccurrenceId?: string;
}

export interface TxIdentity {
  txId: string;
  /** Stored on the row; a bank id verbatim, an existing canonical id verbatim, or `occurrence:<txId>`. */
  providerTransactionIdField: string;
  isExistingUpdate: boolean;
}

export type TxIdentityResult = TxIdentity | { dropped: true; reason: string };

export interface TxIdentityResolution {
  /**
   * Actual immutable database row id for an approved existingCanonicalId.
   * Canonical provider references are mutable data and must never be re-hashed
   * when storage already knows the real row they name.
   */
  authoritativeExistingTxId?: string;
  /** Unique namespace for one promotion, normally the crawl session id. */
  occurrenceScopeId?: string;
}

/**
 * Account-scope an update target. A bare canonical-id allowlist is unsafe because two accounts may
 * legitimately expose the same provider reference.
 */
export function canonicalUpdateKey(providerAccountId: string | undefined, canonicalId: string): string {
  return idPreimage([providerAccountId || UNATTRIBUTED_ACCOUNT_KEY, canonicalId]);
}

export interface AuthoritativeTransactionUpdateClaim {
  providerAccountId?: string;
  existingCanonicalId?: string;
}

export interface ExistingTransactionUpdateTarget {
  providerAccountId?: string;
}

export interface AuthoritativeTransactionUpdateResolution {
  resolvedTargets: Map<string, string>;
  droppedClaimIndexes: Map<number, string>;
}

/**
 * Resolve every model-declared update before promotion writes can take effect.
 *
 * An `existingCanonicalId` is a declaration to mutate one exact stored row,
 * never a hint that storage may reinterpret as a new observation. Invalid,
 * repeated, ambiguous, or cross-account declarations are rejected row by row;
 * unrelated valid observations in the same crawl remain promotable.
 */
export function resolveAuthoritativeTransactionUpdateTargets(
  claims: ReadonlyArray<AuthoritativeTransactionUpdateClaim>,
  authoritativeTargets: ReadonlyMap<string, ReadonlySet<string>>,
  existingTargetsById: ReadonlyMap<string, ExistingTransactionUpdateTarget>,
): AuthoritativeTransactionUpdateResolution {
  const claimIndexesByKey = new Map<string, number[]>();
  for (const [index, claim] of claims.entries()) {
    if (!claim.existingCanonicalId) continue;
    const key = canonicalUpdateKey(
      claim.providerAccountId,
      claim.existingCanonicalId,
    );
    const existing = claimIndexesByKey.get(key);
    if (existing) existing.push(index);
    else claimIndexesByKey.set(key, [index]);
  }

  const resolvedTargets = new Map<string, string>();
  const droppedClaimIndexes = new Map<number, string>();
  const claimIndexByKey = new Map<string, number>();
  for (const [key, matchingIndexes] of claimIndexesByKey) {
    if (matchingIndexes.length !== 1) {
      for (const index of matchingIndexes) {
        droppedClaimIndexes.set(
          index,
          'transaction update target is claimed more than once in one promotion',
        );
      }
      continue;
    }
    const claimIndex = matchingIndexes[0];
    const claim = claims[claimIndex];
    const approvedTargets = authoritativeTargets.get(key);
    if (!approvedTargets) {
      droppedClaimIndexes.set(
        claimIndex,
        'transaction update target is not in the authoritative crawl snapshot',
      );
      continue;
    }
    if (approvedTargets.size !== 1) {
      droppedClaimIndexes.set(claimIndex, 'transaction update target is ambiguous');
      continue;
    }

    const targetId = approvedTargets.values().next().value as string;
    const existingTarget = existingTargetsById.get(targetId);
    if (!existingTarget) {
      droppedClaimIndexes.set(
        claimIndex,
        'transaction update target is missing or belongs to another connection',
      );
      continue;
    }
    if (
      canonicalUpdateKey(
        existingTarget.providerAccountId,
        claim.existingCanonicalId!,
      ) !== key
    ) {
      droppedClaimIndexes.set(
        claimIndex,
        'transaction update target belongs to another account',
      );
      continue;
    }
    claimIndexByKey.set(key, claimIndex);
    resolvedTargets.set(key, targetId);
  }

  const keysByTarget = new Map<string, string[]>();
  for (const [key, targetId] of resolvedTargets) {
    const keys = keysByTarget.get(targetId);
    if (keys) keys.push(key);
    else keysByTarget.set(targetId, [key]);
  }
  for (const keys of keysByTarget.values()) {
    if (keys.length === 1) continue;
    for (const key of keys) {
      droppedClaimIndexes.set(
        claimIndexByKey.get(key)!,
        'stored transaction is targeted by more than one update in one promotion',
      );
      resolvedTargets.delete(key);
    }
  }
  return { resolvedTargets, droppedClaimIndexes };
}

/**
 * Assign a canonical transaction id. `approvedUpdateKeys` is the account-scoped set whose exact stored
 * targets were supplied to storage for this crawl session.
 *
 * A transaction with no `providerAccountId` is namespaced under the stable `UNATTRIBUTED_ACCOUNT_KEY`
 * constant — deliberately NOT any real account. Deriving identity from "the first account returned" made
 * the same unattributed transaction re-key (and duplicate) whenever the bank reordered its dashboard, so
 * there is intentionally no way to pass an account-derived fallback here.
 */
export function assignTransactionId(
  connectionId: string,
  tx: TxIdentityInput,
  approvedUpdateKeys?: Set<string>,
  resolution?: TxIdentityResolution,
): TxIdentityResult {
  const providerAccId = tx.providerAccountId || UNATTRIBUTED_ACCOUNT_KEY;
  const accountId = deterministicAccountId(connectionId, providerAccId);

  let txId: string;
  let isExistingUpdate = false;

  if (tx.existingCanonicalId) {
    const updateKey = canonicalUpdateKey(tx.providerAccountId, tx.existingCanonicalId);
    if (!approvedUpdateKeys || !approvedUpdateKeys.has(updateKey)) {
      return { dropped: true, reason: 'existingCanonicalId not in the recent allowlist — dropped to protect against LLM hallucination' };
    }
    if (!resolution?.authoritativeExistingTxId) {
      return {
        dropped: true,
        reason: 'approved existingCanonicalId has no authoritative stored-row resolution',
      };
    }
    txId = resolution.authoritativeExistingTxId;
    isExistingUpdate = true;
  } else if (isBankProvidedId(tx.providerTransactionId)) {
    txId = deterministicTransactionId(accountId, tx.providerTransactionId as string);
  } else if (tx.extractionOccurrenceId && resolution?.occurrenceScopeId) {
    txId = deterministicTransactionId(
      accountId,
      `occurrence:${resolution.occurrenceScopeId}:${tx.extractionOccurrenceId}`,
    );
  } else {
    return {
      dropped: true,
      reason: 'transaction has neither a trustworthy bank id, an authoritative update target, nor a promotion-scoped extraction occurrence id',
    };
  }

  let providerTransactionIdField: string;
  if (isExistingUpdate) {
    providerTransactionIdField = isBankProvidedId(tx.providerTransactionId)
      ? (tx.providerTransactionId as string)
      : (tx.existingCanonicalId as string);
  } else if (isBankProvidedId(tx.providerTransactionId)) {
    providerTransactionIdField = tx.providerTransactionId as string;
  } else {
    providerTransactionIdField = `${OCCURRENCE_ID_PREFIX}${txId}`;
  }

  return { txId, providerTransactionIdField, isExistingUpdate };
}

/** Subtract whole days from a YYYY-MM-DD date in UTC, returning YYYY-MM-DD. */
export function subtractDaysUtc(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().split('T')[0];
}

/**
 * The inclusive booking-date floor for the next crawl. The prior-success field is a branch marker only:
 * absent means current UTC date minus 90 calendar days; present means current UTC date minus seven calendar
 * days. Its stored date value is deliberately not an anchor. The legacy stored-row and institution-lookback
 * inputs remain accepted for mirror compatibility but deliberately cannot influence the result.
 */
export function deriveTransactionCutoffDate(opts: {
  lastSuccessfulCrawlDay?: string;
  newestStoredBookingDate?: string;
  lookbackDays?: number;
  today?: Date;
}): string {
  const todayBase = opts.today ? new Date(opts.today.getTime()) : new Date();
  const todayUtc = todayBase.toISOString().split('T')[0];
  return subtractDaysUtc(
    todayUtc,
    opts.lastSuccessfulCrawlDay
      ? RECENT_TRANSACTION_WINDOW_DAYS
      : MAX_TRANSACTION_WINDOW_DAYS,
  );
}
