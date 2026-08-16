import { z } from 'zod';
import { createHash } from 'node:crypto';
import { CrawlRequestSchema } from './schemas';

const UUID = z.string().uuid();
const EXECUTION_NAME = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/);
const SHA256_HEX = z.string().regex(/^[a-f0-9]{64}$/);

export const WorkerClaimRequestSchema = z.strictObject({
  execution: EXECUTION_NAME,
  taskIndex: z.literal(0),
  taskAttempt: z.literal(0),
  taskCount: z.literal(1),
  sessionBearerDigest: SHA256_HEX,
});

export const WorkerClaimResponseSchema = z.strictObject({
  request: CrawlRequestSchema,
});

export const WorkerBrokerContextSchema = z.strictObject({
  execution: EXECUTION_NAME,
  sessionId: UUID,
  attemptId: UUID,
});

export const WorkerStatusRequestSchema = WorkerBrokerContextSchema.extend({
  status: z.enum([
    'starting',
    'logging_in',
    'navigating',
    'waiting_for_otp',
    'extracting',
  ]),
  currentStep: z.string().max(2_000),
  stepCount: z.number().int().min(0).max(1_000).optional(),
});

export const WorkerHeartbeatResponseSchema = z.strictObject({
  status: z.enum([
    'running',
    'cancel_requested',
    'cancelled',
    'failed',
    'succeeded',
  ]),
});

export const WorkerStepRequestSchema = WorkerBrokerContextSchema.extend({
  step: z.record(z.string(), z.unknown()),
});

export const WorkerLogsRequestSchema = WorkerBrokerContextSchema.extend({
  lines: z.array(z.strictObject({
    ts: z.iso.datetime(),
    level: z.enum(['log', 'warn', 'error']),
    msg: z.string().max(8_000),
  })).max(2_000),
});

export const WorkerCompletionResultsSchema = z.strictObject({
  accounts: z.array(z.unknown()).optional(),
  transactions: z.array(z.unknown()).optional(),
  positions: z.array(z.unknown()).optional(),
  stepsExecuted: z.number().int().min(0).max(1_000).optional(),
  stepLogs: z.array(z.unknown()).max(1_000).optional(),
  crawlMemory: z.string().max(100_000).optional(),
  failureReason: z.enum([
    'api_contract_drift',
    'bank_login_failed',
    'otp_timeout',
    'otp_relay_unreachable',
    'waf_block',
    'outside_hours',
    'site_unavailable',
    'instance_died',
    'page_capture_timeout',
    'navigation_timeout',
    'crawl_watchdog',
    'internal_error',
  ]).optional(),
  cost: z.record(z.string(), z.unknown()).optional(),
});

export const WorkerCompleteRequestSchema = WorkerBrokerContextSchema.extend({
  success: z.boolean(),
  error: z.string().max(2_000).optional(),
  results: WorkerCompletionResultsSchema.optional(),
});

export const WorkerScreenshotRequestSchema = WorkerBrokerContextSchema.extend({
  stepNumber: z.number().int().min(0).max(1_000),
  jpegBase64: z.string().max(10_000_000),
});

export const WorkerScreenshotResponseSchema = z.strictObject({
  path: z.string().min(1).max(1_024),
});

export const WorkerOtpPrepareRequestSchema = WorkerBrokerContextSchema.extend({
  mode: z.enum(['begin', 'poll']),
});

/**
 * 'offline'/'online' — a Companion is expected and has not confirmed live SMS access yet; 'ready' — it has;
 * 'manual' — no phone is authorized for this connection at all, so nothing can confirm and the worker stops
 * waiting: the code will be entered in the console instead.
 */
export const WorkerOtpPrepareResponseSchema = z.strictObject({
  state: z.enum(['offline', 'online', 'ready', 'manual']),
});

export const WorkerOtpConsumeResponseSchema = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('pending') }),
  z.strictObject({ state: z.literal('received'), code: z.string().min(1).max(32) }),
]);

export type WorkerClaimRequest = z.infer<typeof WorkerClaimRequestSchema>;
export type WorkerBrokerContext = z.infer<typeof WorkerBrokerContextSchema>;
export type WorkerStatusRequest = z.infer<typeof WorkerStatusRequestSchema>;
export type WorkerStepRequest = z.infer<typeof WorkerStepRequestSchema>;
export type WorkerLogsRequest = z.infer<typeof WorkerLogsRequestSchema>;
export type WorkerCompleteRequest = z.infer<typeof WorkerCompleteRequestSchema>;

function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) {
        throw new Error('worker output contains a non-finite number');
      }
      return Object.is(value, -0) ? '0' : String(value);
    case 'string':
      return JSON.stringify(value);
    case 'object':
      return `{${Object.keys(value as Record<string, unknown>)
        .filter(
          (key) => (value as Record<string, unknown>)[key] !== undefined,
        )
        .sort()
        .map((key) =>
          `${JSON.stringify(key)}:${canonicalJson(
            (value as Record<string, unknown>)[key],
          )}`)
        .join(',')}}`;
    default:
      throw new Error('worker output contains a non-JSON value');
  }
}

export function workerOutputDigest(
  results: Pick<
    z.infer<typeof WorkerCompletionResultsSchema>,
    'accounts' | 'transactions' | 'positions'
  > | undefined,
): string {
  return createHash('sha256').update(canonicalJson({
    accounts: results?.accounts ?? [],
    transactions: results?.transactions ?? [],
    positions: results?.positions ?? [],
  })).digest('hex');
}
