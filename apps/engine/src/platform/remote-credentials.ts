/**
 * What a remote worker needs from the deployment that started it.
 *
 * `PLATFORM=remote` is the engine as a one-shot worker: something started this process to run exactly
 * one crawl, and it must now prove to the control-plane that it is that worker — nothing else may
 * claim the crawl, and a second copy of the same worker must be refused. Three things are needed for
 * that, and all three depend on how the worker was started:
 *
 *   - which execution this process is, as the control-plane recorded it when it started the worker;
 *   - a way to call the control-plane carrying proof of who this worker is;
 *   - the one-time factor the control-plane left for this worker to present when it claims its crawl.
 *
 * The protocol built on top of them — how the claim is made, what it fences, what the worker does
 * next — is the product's, and lives in `remote-broker-client.ts`. Only the mechanics are supplied.
 */

/** Which single execution of the worker this process is. */
export interface RemoteWorkerExecution {
  /** The identifier the control-plane recorded when it started this worker. The broker admits one
   *  claim per execution, so an implementation that cannot establish it must throw rather than
   *  invent one — a guessed identifier would race the real execution for the same crawl. */
  execution: string;
  /** Where the control-plane left this worker's one-time claim factor. Opaque to the engine: only
   *  `readClaimFactor` interprets it. */
  claimSecretReference: string;
}

export interface RemoteWorkerCredentials {
  /**
   * Establish which execution this process is, and refuse if it is not the single one the
   * control-plane started — a duplicate or retried copy must throw here rather than claim.
   */
  workerExecution(environment: NodeJS.ProcessEnv): Promise<RemoteWorkerExecution>;

  /**
   * `fetch`, carrying proof of this worker's identity to `audience`. Every broker call goes through
   * it, so an implementation should mint the proof once and reuse it until it expires.
   */
  authorizedFetch(audience: string): Promise<typeof fetch>;

  /**
   * Read the one-time claim factor from wherever the control-plane left it, verifying it arrived
   * intact. Returned as raw bytes; the caller zeroes them as soon as the claim is made.
   */
  readClaimFactor(reference: string): Promise<Buffer>;
}

let registered: RemoteWorkerCredentials | undefined;

/** Supply the credentials for this deployment. Must be called before a remote worker claims. */
export function registerRemoteWorkerCredentials(credentials: RemoteWorkerCredentials): void {
  registered = credentials;
}

/** Test-only: forget the registered credentials so a case can assert the unregistered behaviour. */
export function resetRemoteWorkerCredentialsForTest(): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('resetRemoteWorkerCredentialsForTest is available only under NODE_ENV=test');
  }
  registered = undefined;
}

/**
 * The registered credentials. A remote worker cannot proceed without them: with no way to prove which
 * execution it is, any claim it made would be indistinguishable from a second copy claiming the same
 * crawl, so this fails loudly rather than degrading to an unfenced claim.
 */
export function remoteWorkerCredentials(): RemoteWorkerCredentials {
  if (!registered) {
    throw new Error(
      'PLATFORM=remote requires worker credentials, and none are registered. The deployment that '
      + 'starts the worker registers them with registerRemoteWorkerCredentials() before it claims.',
    );
  }
  return registered;
}
