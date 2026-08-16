import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { CrawlRecentTransaction, CrawlRequest } from './types';
import {
  decryptCrawlJobHistoryChunk,
  decryptCrawlJobPayload,
  encryptCrawlJobHistoryChunk,
  encryptCrawlJobPayload,
} from './job-payload';
import {
  buildRecentTransactionHistory,
  reassembleRecentTransactionHistory,
} from './transaction-history';

const key = randomBytes(32).toString('base64');
const request: CrawlRequest = {
  sessionId: '3fb8d048-835a-4cab-9492-aafcf1082676',
  loginUrl: 'https://bank.example/login',
  username: 'alice',
  password: 'correct horse battery staple',
  requires2fa: false,
  maxSteps: 100,
  timeoutSeconds: 900,
};

function largeReceivedHistory(): CrawlRecentTransaction[] {
  return Array.from({ length: 11 }, (_, index) => ({
    providerAccountId: 'account-a',
    providerTransactionId: index === 0
      ? '999-received-first'
      : index === 5
        ? '500-received-middle'
        : index === 10
          ? '000-received-final'
          : `${900 - index}-received-${index}`,
    bookingDate: '2026-07-25',
    amount: -(index + 1),
    currency: 'GBP',
    description: `received-${index}-${String(index).repeat(100_000)}`,
    isPending: false,
  }));
}

describe('crawl-job payload envelope', () => {
  it('round-trips a request without exposing credentials in the envelope', () => {
    const envelope = encryptCrawlJobPayload(key, 'tenant-a', request.sessionId, request);
    expect(envelope).not.toContain(request.username);
    expect(envelope).not.toContain(request.password);
    expect(decryptCrawlJobPayload(key, 'tenant-a', request.sessionId, envelope)).toEqual(request);
  });

  it('is bound to both tenant and job id', () => {
    const envelope = encryptCrawlJobPayload(key, 'tenant-a', request.sessionId, request);
    expect(() => decryptCrawlJobPayload(key, 'tenant-b', request.sessionId, envelope)).toThrow();
    expect(() => decryptCrawlJobPayload(key, 'tenant-a', 'different-job', envelope)).toThrow();
  });

  it('rejects a modified ciphertext', () => {
    const envelope = encryptCrawlJobPayload(key, 'tenant-a', request.sessionId, request);
    const parts = envelope.split('.');
    const ciphertext = Buffer.from(parts[3], 'base64url');
    ciphertext[Math.floor(ciphertext.length / 2)] ^= 0x01;
    parts[3] = ciphertext.toString('base64url');
    const tampered = parts.join('.');
    expect(() => decryptCrawlJobPayload(key, 'tenant-a', request.sessionId, tampered)).toThrow();
  });

  it('rejects keys that are not exactly 32 bytes', () => {
    expect(() => encryptCrawlJobPayload(Buffer.alloc(16).toString('base64'), 'tenant-a', request.sessionId, request)).toThrow(
      /32-byte/,
    );
  });

  it('round-trips a history chunk only under its tenant, job and index', () => {
    const history = buildRecentTransactionHistory([{
      providerAccountId: 'account-a',
      providerTransactionId: 'tx-a',
      bookingDate: '2026-07-25',
      amount: -1,
      currency: 'GBP',
      description: 'Coffee',
      isPending: false,
    }]);
    const chunk = history.chunks[0];
    const envelope = encryptCrawlJobHistoryChunk(
      key,
      'tenant-a',
      request.sessionId,
      chunk,
    );
    expect(decryptCrawlJobHistoryChunk(
      key,
      'tenant-a',
      request.sessionId,
      chunk.index,
      envelope,
    )).toEqual(chunk);
    expect(() => decryptCrawlJobHistoryChunk(
      key,
      'tenant-a',
      request.sessionId,
      chunk.index + 1,
      envelope,
    )).toThrow();
    expect(() => decryptCrawlJobHistoryChunk(
      key,
      'tenant-b',
      request.sessionId,
      chunk.index,
      envelope,
    )).toThrow();
    expect(() => decryptCrawlJobHistoryChunk(
      key,
      'tenant-a',
      'different-job',
      chunk.index,
      envelope,
    )).toThrow();
  });

  it('preserves received first, middle and final records through every encrypted chunk', () => {
    const received = largeReceivedHistory();
    const history = buildRecentTransactionHistory(received);
    expect(history.manifest.byteLength).toBeGreaterThan(1024 * 1024);
    const decryptedChunks = history.chunks.map((chunk) =>
      decryptCrawlJobHistoryChunk(
        key,
        'tenant-a',
        request.sessionId,
        chunk.index,
        encryptCrawlJobHistoryChunk(
          key,
          'tenant-a',
          request.sessionId,
          chunk,
        ),
      ));
    const reassembled = reassembleRecentTransactionHistory(
      history.manifest,
      decryptedChunks,
    );
    expect(reassembled).toEqual(received);
    expect(reassembled[0].providerTransactionId).toBe('999-received-first');
    expect(reassembled[Math.floor(reassembled.length / 2)].providerTransactionId)
      .toBe('500-received-middle');
    expect(reassembled.at(-1)?.providerTransactionId).toBe('000-received-final');
  });
});
