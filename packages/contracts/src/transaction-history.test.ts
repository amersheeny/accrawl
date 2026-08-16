import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CrawlRequestSchema } from './schemas';
import {
  buildRecentTransactionHistory,
  reassembleRecentTransactionHistory,
} from './transaction-history';
import type { CrawlRecentTransaction, CrawlRequest } from './types';

function transaction(
  providerTransactionId: string,
  description: string,
): CrawlRecentTransaction {
  return {
    providerAccountId: 'account-a',
    providerTransactionId,
    bookingDate: '2026-07-25',
    amount: -10,
    currency: 'GBP',
    description,
    isPending: false,
  };
}

function largeHistory(): CrawlRecentTransaction[] {
  return [
    transaction('999-received-first', `received-first-${'z'.repeat(110_000)}`),
    ...Array.from({ length: 4 }, (_, index) =>
      transaction(
        `700-before-${String(index).padStart(3, '0')}`,
        `before-middle-${index}-${String(index).repeat(110_000)}`,
      )),
    transaction('500-received-middle', `received-middle-${'m'.repeat(110_000)}`),
    ...Array.from({ length: 4 }, (_, index) =>
      transaction(
        `300-after-${String(index).padStart(3, '0')}`,
        `after-middle-${index}-${String(index + 4).repeat(110_000)}`,
      )),
    transaction('000-received-final', `received-final-${'a'.repeat(110_000)}`),
  ];
}

describe('recent transaction history transport', () => {
  it('preserves received first, middle and final records across more than 1 MiB', () => {
    const received = largeHistory();
    const payload = Buffer.from(JSON.stringify(received), 'utf8');
    const built = buildRecentTransactionHistory(received);
    expect(built.manifest.byteLength).toBeGreaterThan(1024 * 1024);
    expect(built.manifest).toEqual({
      version: 'v1',
      itemCount: received.length,
      byteLength: payload.length,
      chunkCount: built.chunks.length,
      sha256: createHash('sha256').update(payload).digest('hex'),
    });
    expect(built.chunks.length).toBeGreaterThan(1);
    const rejoined = Buffer.concat(built.chunks.map((chunk) =>
      Buffer.from(chunk.data, 'base64')));
    // Compared as bytes. Structural equality walks all 1.2 million of them one at a time and takes
    // ~2.6s — thirty times longer than the chunking this test is actually about — which left the
    // test inside the default five-second budget only on an idle machine.
    expect(rejoined.length).toBe(payload.length);
    expect(rejoined.equals(payload)).toBe(true);
    expect(built.transactions).toEqual(received);
    const reassembled = reassembleRecentTransactionHistory(
      built.manifest,
      built.chunks,
    );
    expect(reassembled).toEqual(received);
    expect(reassembled[0].providerTransactionId).toBe('999-received-first');
    expect(reassembled[Math.floor(reassembled.length / 2)].providerTransactionId)
      .toBe('500-received-middle');
    expect(reassembled.at(-1)?.providerTransactionId).toBe('000-received-final');
  });

  it('rejects missing, reordered, duplicated and corrupted chunks', () => {
    const built = buildRecentTransactionHistory(largeHistory());
    expect(() => reassembleRecentTransactionHistory(
      built.manifest,
      built.chunks.slice(0, -1),
    )).toThrow(/chunk count/);
    expect(() => reassembleRecentTransactionHistory(
      built.manifest,
      [built.chunks[1], built.chunks[0], ...built.chunks.slice(2)],
    )).toThrow(/reordered/);
    expect(() => reassembleRecentTransactionHistory(
      built.manifest,
      [built.chunks[0], built.chunks[0], ...built.chunks.slice(2)],
    )).toThrow(/reordered/);
    const corrupted = built.chunks.map((chunk) => ({ ...chunk }));
    const bytes = Buffer.from(corrupted[1].data, 'base64');
    bytes[Math.floor(bytes.length / 2)] ^= 0x01;
    corrupted[1].data = bytes.toString('base64');
    expect(() => reassembleRecentTransactionHistory(
      built.manifest,
      corrupted,
    )).toThrow(/integrity fence/);
    expect(() => reassembleRecentTransactionHistory(
      built.manifest,
      built.chunks.map((chunk, index) => index === 1
        ? { ...chunk, byteLength: chunk.byteLength - 1 }
        : chunk),
    )).toThrow(/integrity fence/);
    expect(() => reassembleRecentTransactionHistory(
      built.manifest,
      built.chunks.map((chunk, index) => index === 1
        ? { ...chunk, sha256: '0'.repeat(64) }
        : chunk),
    )).toThrow(/integrity fence/);
  });

  it('rejects overall digest and exact item-count mismatches', () => {
    const built = buildRecentTransactionHistory(largeHistory());
    expect(() => reassembleRecentTransactionHistory(
      { ...built.manifest, sha256: '0'.repeat(64) },
      built.chunks,
    )).toThrow(/payload failed its integrity fence/);
    expect(() => reassembleRecentTransactionHistory(
      { ...built.manifest, byteLength: built.manifest.byteLength + 1 },
      built.chunks,
    )).toThrow(/payload failed its integrity fence/);
    expect(() => reassembleRecentTransactionHistory(
      { ...built.manifest, itemCount: built.manifest.itemCount + 1 },
      built.chunks,
    )).toThrow(/item count/);
  });

  it('accepts arbitrary received order and fences later record reordering', () => {
    const received = [
      transaction('b', 'second'),
      transaction('a', 'first'),
    ];
    const built = buildRecentTransactionHistory(received);
    const base: CrawlRequest = {
      sessionId: 'session-a',
      loginUrl: 'https://bank.example/login',
      username: 'alice',
      password: 'secret',
      requires2fa: false,
      maxSteps: 100,
      timeoutSeconds: 900,
    };
    expect(CrawlRequestSchema.safeParse({
      ...base,
      recentTransactions: built.transactions,
      recentTransactionsManifest: built.manifest,
    }).success).toBe(true);
    expect(built.transactions.map(({ providerTransactionId }) =>
      providerTransactionId)).toEqual(['b', 'a']);
    expect(CrawlRequestSchema.safeParse({
      ...base,
      recentTransactions: built.transactions,
    }).success).toBe(false);
    const reordered = [...built.transactions].reverse();
    expect(CrawlRequestSchema.safeParse({
      ...base,
      recentTransactions: reordered,
      recentTransactionsManifest: built.manifest,
    }).success).toBe(false);
    const reorderedHistory = buildRecentTransactionHistory(reordered);
    expect(CrawlRequestSchema.safeParse({
      ...base,
      recentTransactions: reorderedHistory.transactions,
      recentTransactionsManifest: reorderedHistory.manifest,
    }).success).toBe(true);
  });
});
