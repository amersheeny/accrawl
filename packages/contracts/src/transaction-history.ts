import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type {
  CrawlRecentTransaction,
  RecentTransactionHistoryChunk,
  RecentTransactionHistoryManifest,
} from './types';

export const RECENT_TRANSACTION_HISTORY_VERSION = 'v1' as const;

/**
 * Raw bytes per transport fragment. After JSON and base64/AEAD overhead this
 * remains comfortably below the engine and document-store single-message limits.
 */
export const RECENT_TRANSACTION_HISTORY_CHUNK_BYTES = 128 * 1024;

const SHA256_HEX = /^[a-f0-9]{64}$/;
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export const CrawlRecentTransactionSchema = z.strictObject({
  providerAccountId: z.string(),
  providerTransactionId: z.string(),
  bookingDate: z.string(),
  amount: z.number().finite(),
  currency: z.string(),
  description: z.string(),
  isPending: z.boolean(),
});

export const RecentTransactionHistoryManifestSchema = z.strictObject({
  version: z.literal(RECENT_TRANSACTION_HISTORY_VERSION),
  itemCount: z.number().int().nonnegative(),
  byteLength: z.number().int().positive(),
  chunkCount: z.number().int().positive(),
  sha256: z.string().regex(SHA256_HEX),
});

export const RecentTransactionHistoryChunkSchema = z.strictObject({
  index: z.number().int().nonnegative(),
  byteLength: z.number().int().positive()
    .max(RECENT_TRANSACTION_HISTORY_CHUNK_BYTES),
  sha256: z.string().regex(SHA256_HEX),
  data: z.string().min(1).regex(CANONICAL_BASE64),
});

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function safeHexEqual(left: string, right: string): boolean {
  if (!SHA256_HEX.test(left) || !SHA256_HEX.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

/**
 * Validate every record while preserving the caller's received array order.
 * The exported name remains stable for existing contract consumers.
 */
export function orderRecentTransactions(
  transactions: ReadonlyArray<CrawlRecentTransaction>,
): CrawlRecentTransaction[] {
  return transactions.map((transaction) =>
    CrawlRecentTransactionSchema.parse(transaction));
}

export interface BuiltRecentTransactionHistory {
  transactions: CrawlRecentTransaction[];
  manifest: RecentTransactionHistoryManifest;
  chunks: RecentTransactionHistoryChunk[];
}

/** Validate, serialize, hash and fragment one complete received-order history. */
export function buildRecentTransactionHistory(
  transactions: ReadonlyArray<CrawlRecentTransaction>,
): BuiltRecentTransactionHistory {
  const received = orderRecentTransactions(transactions);
  const payload = Buffer.from(JSON.stringify(received), 'utf8');
  const chunks: RecentTransactionHistoryChunk[] = [];
  for (let offset = 0; offset < payload.length; offset += RECENT_TRANSACTION_HISTORY_CHUNK_BYTES) {
    const bytes = payload.subarray(
      offset,
      Math.min(offset + RECENT_TRANSACTION_HISTORY_CHUNK_BYTES, payload.length),
    );
    chunks.push({
      index: chunks.length,
      byteLength: bytes.length,
      sha256: sha256(bytes),
      data: bytes.toString('base64'),
    });
  }
  // JSON.stringify([]) is two bytes, so every valid history has at least one
  // chunk. Keep the assertion explicit because chunkCount is a transport fence.
  if (chunks.length === 0) throw new Error('transaction history serialization is empty');
  return {
    transactions: received,
    manifest: {
      version: RECENT_TRANSACTION_HISTORY_VERSION,
      itemCount: received.length,
      byteLength: payload.length,
      chunkCount: chunks.length,
      sha256: sha256(payload),
    },
    chunks,
  };
}

function sameManifest(
  left: RecentTransactionHistoryManifest,
  right: RecentTransactionHistoryManifest,
): boolean {
  return left.version === right.version
    && left.itemCount === right.itemCount
    && left.byteLength === right.byteLength
    && left.chunkCount === right.chunkCount
    && safeHexEqual(left.sha256, right.sha256);
}

/**
 * Assert that an inline logical request carries the exact received-order
 * count/byte/digest fence for the bytes that will be transported.
 */
export function assertRecentTransactionHistory(
  transactions: ReadonlyArray<CrawlRecentTransaction>,
  manifest: RecentTransactionHistoryManifest,
): BuiltRecentTransactionHistory {
  const parsedManifest = RecentTransactionHistoryManifestSchema.parse(manifest);
  const built = buildRecentTransactionHistory(transactions);
  if (!sameManifest(built.manifest, parsedManifest)) {
    throw new Error('transaction history manifest does not match its records');
  }
  return built;
}

/**
 * Reassemble fragments in their supplied order and reject missing, reordered,
 * duplicated or corrupted bytes before parsing any transaction record.
 */
export function reassembleRecentTransactionHistory(
  manifest: RecentTransactionHistoryManifest,
  chunks: ReadonlyArray<RecentTransactionHistoryChunk>,
): CrawlRecentTransaction[] {
  const expected = RecentTransactionHistoryManifestSchema.parse(manifest);
  if (chunks.length !== expected.chunkCount) {
    throw new Error('transaction history chunk count does not match its manifest');
  }
  const decoded: Buffer[] = [];
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = RecentTransactionHistoryChunkSchema.parse(chunks[index]);
    if (chunk.index !== index) {
      throw new Error('transaction history chunks are missing, duplicated, or reordered');
    }
    const bytes = Buffer.from(chunk.data, 'base64');
    if (
      bytes.length !== chunk.byteLength
      || bytes.toString('base64') !== chunk.data
      || !safeHexEqual(sha256(bytes), chunk.sha256)
    ) {
      throw new Error('transaction history chunk failed its integrity fence');
    }
    decoded.push(bytes);
  }
  const payload = Buffer.concat(decoded);
  if (
    payload.length !== expected.byteLength
    || !safeHexEqual(sha256(payload), expected.sha256)
  ) {
    throw new Error('transaction history payload failed its integrity fence');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload.toString('utf8')) as unknown;
  } catch {
    throw new Error('transaction history payload is not valid JSON');
  }
  const transactions = z.array(CrawlRecentTransactionSchema).parse(parsed);
  if (transactions.length !== expected.itemCount) {
    throw new Error('transaction history item count does not match its manifest');
  }
  return transactions;
}

export function recentTransactionHistoryManifestsEqual(
  left: RecentTransactionHistoryManifest,
  right: RecentTransactionHistoryManifest,
): boolean {
  return sameManifest(
    RecentTransactionHistoryManifestSchema.parse(left),
    RecentTransactionHistoryManifestSchema.parse(right),
  );
}
