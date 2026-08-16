import {
  RecentTransactionHistoryChunkSchema,
  RecentTransactionHistoryManifestSchema,
  recentTransactionHistoryManifestsEqual,
  type RecentTransactionHistoryChunk,
  type RecentTransactionHistoryManifest,
} from '@accrawl/contracts';

const HISTORY_UPLOAD_TTL_MS = 5 * 60_000;
const MAX_PENDING_HISTORY_SESSIONS = 64;

interface PendingHistory {
  manifest: RecentTransactionHistoryManifest;
  chunks: RecentTransactionHistoryChunk[];
  invalidReason?: string;
  updatedAt: number;
}

/**
 * Short-lived assembly buffer for the self-host/private HTTP handoff. Chunks
 * must arrive in exact order; duplicate retries are accepted only byte-for-byte.
 */
export class TransactionHistoryUploadStore {
  private readonly pending = new Map<string, PendingHistory>();

  constructor(private readonly now: () => number = Date.now) {}

  private purgeExpired(): void {
    const cutoff = this.now() - HISTORY_UPLOAD_TTL_MS;
    for (const [sessionId, history] of this.pending) {
      if (history.updatedAt < cutoff) this.pending.delete(sessionId);
    }
  }

  private invalidate(history: PendingHistory, reason: string): never {
    history.invalidReason = reason;
    history.updatedAt = this.now();
    throw new Error(reason);
  }

  /** Whether this session has begun the external-history upload protocol. */
  hasUploadState(sessionId: string): boolean {
    this.purgeExpired();
    return this.pending.has(sessionId);
  }

  put(
    sessionId: string,
    rawManifest: RecentTransactionHistoryManifest,
    rawChunk: RecentTransactionHistoryChunk,
  ): void {
    this.purgeExpired();
    const manifest = RecentTransactionHistoryManifestSchema.parse(rawManifest);
    const chunk = RecentTransactionHistoryChunkSchema.parse(rawChunk);
    let history = this.pending.get(sessionId);
    if (!history) {
      if (this.pending.size >= MAX_PENDING_HISTORY_SESSIONS) {
        throw new Error('too many transaction histories are awaiting crawl dispatch');
      }
      history = { manifest, chunks: [], updatedAt: this.now() };
      this.pending.set(sessionId, history);
    } else if (history.invalidReason) {
      throw new Error(history.invalidReason);
    } else if (!recentTransactionHistoryManifestsEqual(history.manifest, manifest)) {
      this.invalidate(history, 'transaction history manifest changed during upload');
    }

    if (chunk.index < history.chunks.length) {
      if (JSON.stringify(history.chunks[chunk.index]) === JSON.stringify(chunk)) {
        history.updatedAt = this.now();
        return;
      }
      this.invalidate(history, 'transaction history chunk retry changed bytes');
    }
    if (chunk.index !== history.chunks.length) {
      this.invalidate(history, 'transaction history chunks arrived out of order');
    }
    if (chunk.index >= manifest.chunkCount) {
      this.invalidate(history, 'transaction history contains an unexpected extra chunk');
    }
    const uploadedBytes = history.chunks.reduce(
      (total, candidate) => total + candidate.byteLength,
      0,
    ) + chunk.byteLength;
    if (uploadedBytes > manifest.byteLength) {
      this.invalidate(history, 'transaction history chunks exceed the declared byte length');
    }
    history.chunks.push(chunk);
    history.updatedAt = this.now();
  }

  consume(
    sessionId: string,
    rawManifest: RecentTransactionHistoryManifest,
  ): RecentTransactionHistoryChunk[] {
    this.purgeExpired();
    const manifest = RecentTransactionHistoryManifestSchema.parse(rawManifest);
    const history = this.pending.get(sessionId);
    if (!history) throw new Error('transaction history chunks were not uploaded');
    if (history.invalidReason) throw new Error(history.invalidReason);
    if (!recentTransactionHistoryManifestsEqual(history.manifest, manifest)) {
      throw new Error('uploaded transaction history does not match the crawl request');
    }
    if (history.chunks.length !== manifest.chunkCount) {
      throw new Error('transaction history upload is incomplete');
    }
    return [...history.chunks];
  }

  discard(sessionId: string): void {
    this.pending.delete(sessionId);
  }
}
