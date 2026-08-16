/**
 * Versioned AEAD envelope for durable crawl jobs.
 *
 * Crawl requests contain plaintext credentials. Cell mode therefore stores only an
 * AES-256-GCM envelope in the tenant database; the ephemeral worker receives the
 * tenant-scoped key through its own Kubernetes Secret and decrypts exactly one job.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { CrawlRequestTransportSchema } from './schemas';
import { RecentTransactionHistoryChunkSchema } from './transaction-history';
import type {
  CrawlRequest,
  RecentTransactionHistoryChunk,
} from './types';

const VERSION = 'v1';

function decodeKey(encoded: string): Buffer {
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32 || key.toString('base64').replace(/=+$/, '') !== encoded.trim().replace(/=+$/, '')) {
    throw new Error('JOB_ENCRYPTION_KEY must be a canonical base64-encoded 32-byte key');
  }
  return key;
}

function aad(tenantId: string, jobId: string): Buffer {
  return Buffer.from(`accrawl:crawl-job:${tenantId}:${jobId}`, 'utf8');
}

function historyChunkAad(
  tenantId: string,
  jobId: string,
  chunkIndex: number,
): Buffer {
  return Buffer.from(
    `accrawl:crawl-job-history:${tenantId}:${jobId}:${chunkIndex}`,
    'utf8',
  );
}

function encryptJson(
  encodedKey: string,
  associatedData: Buffer,
  value: unknown,
): string {
  const key = decodeKey(encodedKey);
  const nonce = randomBytes(12);
  try {
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(associatedData);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(value), 'utf8'),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return [
      VERSION,
      nonce.toString('base64url'),
      tag.toString('base64url'),
      ciphertext.toString('base64url'),
    ].join('.');
  } finally {
    key.fill(0);
  }
}

function decryptJson(
  encodedKey: string,
  associatedData: Buffer,
  envelope: string,
): unknown {
  const parts = envelope.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error('Unsupported crawl-job payload envelope');
  }
  const [, noncePart, tagPart, ciphertextPart] = parts;
  const nonce = Buffer.from(noncePart, 'base64url');
  const tag = Buffer.from(tagPart, 'base64url');
  if (nonce.length !== 12 || tag.length !== 16) {
    throw new Error('Malformed crawl-job payload envelope');
  }
  const key = decodeKey(encodedKey);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAAD(associatedData);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(ciphertextPart, 'base64url')),
      decipher.final(),
    ]);
    return JSON.parse(plaintext.toString('utf8')) as unknown;
  } finally {
    key.fill(0);
  }
}

export function encryptCrawlJobPayload(
  encodedKey: string,
  tenantId: string,
  jobId: string,
  request: CrawlRequest,
): string {
  return encryptJson(encodedKey, aad(tenantId, jobId), request);
}

export function decryptCrawlJobPayload(
  encodedKey: string,
  tenantId: string,
  jobId: string,
  envelope: string,
): CrawlRequest {
  return CrawlRequestTransportSchema.parse(
    decryptJson(encodedKey, aad(tenantId, jobId), envelope),
  ) as CrawlRequest;
}

/** Encrypt one history fragment under a chunk-index-bound AEAD context. */
export function encryptCrawlJobHistoryChunk(
  encodedKey: string,
  tenantId: string,
  jobId: string,
  chunk: RecentTransactionHistoryChunk,
): string {
  const parsed = RecentTransactionHistoryChunkSchema.parse(chunk);
  return encryptJson(
    encodedKey,
    historyChunkAad(tenantId, jobId, parsed.index),
    parsed,
  );
}

/** Decrypt and schema-check one history fragment before list reassembly. */
export function decryptCrawlJobHistoryChunk(
  encodedKey: string,
  tenantId: string,
  jobId: string,
  chunkIndex: number,
  envelope: string,
): RecentTransactionHistoryChunk {
  const chunk = RecentTransactionHistoryChunkSchema.parse(decryptJson(
    encodedKey,
    historyChunkAad(tenantId, jobId, chunkIndex),
    envelope,
  ));
  if (chunk.index !== chunkIndex) {
    throw new Error('crawl-job history chunk index does not match its envelope');
  }
  return chunk;
}
