/**
 * Whether extracted data may become the account holder's canonical record.
 *
 * A crawl stages what it found; promotion is the moment that staged output replaces what the account
 * holder sees. Between those two moments a great deal can go wrong — the worker may have been superseded,
 * the connection may have been crawled again, the plan may have been computed from a generation that is no
 * longer current, or the staged rows may not be the ones the completion receipt described. Promoting in
 * any of those cases publishes the wrong balances, which is the worst thing this product can do quietly.
 *
 * So the rule is a conjunction and every clause is load-bearing: the output is the one the worker
 * reported, the job agrees, the session is still the connection's active crawl, the base generation has
 * not moved underneath it, and the plan was computed from the manifest that is still ready.
 *
 * Pure: plain values in, a verdict out.
 */

/** What the worker reported, as recorded on the session. */
export interface PromotionSessionFacts {
  status: string;
  workerOutcome?: string;
  workerOutputGeneration?: string;
  workerOutputDigest?: string;
  workerCompletionDigest?: string;
  workerOutputCounts?: {
    accounts?: number;
    transactions?: number;
    positions?: number;
  };
  targetDataGeneration?: string | null;
}

/** The durable job record for the same attempt. */
export interface PromotionJobFacts {
  status: string;
  workerOutputGeneration?: string;
  workerOutputDigest?: string;
  workerCompletionDigest?: string;
}

/** The connection as it stands right now, which may have moved since the crawl started. */
export interface PromotionConnectionFacts {
  activeSessionId?: string | null;
  activeDataGeneration?: string | null;
}

export interface PromotionExpectation {
  sessionId: string;
  outputGeneration: string;
  outputDigest: string;
  completionDigest: string;
  counts: {
    accounts: number | undefined;
    transactions: number | undefined;
    positions: number | undefined;
  };
  /** The generation the plan was computed against; promotion is only valid on top of it. */
  baseDataGeneration?: string | null;
  targetDataGeneration?: string | null;
  /** The staged manifest must still be complete and describe the plan that is about to be applied. */
  manifestStatus?: string;
  manifestPlanDigest?: string;
  expectedPlanDigest: string;
  activeSessionStatuses: ReadonlySet<string>;
}

export type PromotionReadiness =
  /** Already promoted; the caller returns the previous result rather than doing it twice. */
  | { state: 'already_promoted' }
  | { state: 'ready' }
  /** Something moved underneath this crawl; publishing now would show the wrong data. */
  | { state: 'not_ready'; reason: string };

export function decidePromotionReadiness(
  session: PromotionSessionFacts,
  job: PromotionJobFacts,
  connection: PromotionConnectionFacts,
  expected: PromotionExpectation,
): PromotionReadiness {
  if (session.status === 'completed') return { state: 'already_promoted' };

  const failures: Array<[boolean, string]> = [
    [session.workerOutcome !== 'success', 'the worker did not report success'],
    [
      session.workerOutputGeneration !== expected.outputGeneration
      || session.workerOutputDigest !== expected.outputDigest
      || session.workerCompletionDigest !== expected.completionDigest,
      'the session does not carry the output this promotion describes',
    ],
    [
      session.workerOutputCounts?.accounts !== expected.counts.accounts
      || session.workerOutputCounts?.transactions !== expected.counts.transactions
      || session.workerOutputCounts?.positions !== expected.counts.positions,
      'the staged row counts do not match what the worker reported',
    ],
    [
      job.status !== 'succeeded'
      || job.workerOutputGeneration !== expected.outputGeneration
      || job.workerOutputDigest !== expected.outputDigest
      || job.workerCompletionDigest !== expected.completionDigest,
      'the durable job record does not agree with the session',
    ],
    [
      !expected.activeSessionStatuses.has(session.status),
      'the session is no longer running',
    ],
    [
      connection.activeSessionId !== expected.sessionId,
      'another crawl has become the connection\'s active one',
    ],
    [
      (connection.activeDataGeneration ?? null) !== (expected.baseDataGeneration ?? null),
      'the connection moved to a different generation while this crawl ran',
    ],
    [
      session.targetDataGeneration !== expected.targetDataGeneration,
      'the session is aiming at a different generation than this promotion',
    ],
    [
      expected.manifestStatus !== 'ready',
      'the staged output is not complete',
    ],
    [
      expected.manifestPlanDigest !== expected.expectedPlanDigest,
      'the plan was computed from different staged output',
    ],
  ];

  const failed = failures.find(([tripped]) => tripped);
  return failed ? { state: 'not_ready', reason: failed[1] } : { state: 'ready' };
}
