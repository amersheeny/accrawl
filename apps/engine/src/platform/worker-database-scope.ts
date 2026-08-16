/**
 * PostgreSQL startup parameters that bind every connection in an ephemeral
 * worker to its one claimed crawl. PostgreSQL RLS validates these values
 * against the unguessable job capability and durable lease on every row.
 */
export function workerDatabaseConnectionParameters(
  applicationName: string,
  environment: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const jobId = environment.ENGINE_JOB_ID?.trim();
  const claimToken = environment.ENGINE_JOB_TOKEN?.trim();
  const workerName = environment.ACCRAWL_WORKER_NAME?.trim();
  const present = [jobId, claimToken, workerName].filter(Boolean).length;
  if (present === 0) return { application_name: applicationName };
  if (present !== 3) {
    throw new Error('worker database scope requires job id, claim token, and worker name');
  }
  return {
    application_name: applicationName,
    'accrawl.job_id': jobId!,
    'accrawl.claim_token': claimToken!,
    'accrawl.worker_name': workerName!,
  };
}
