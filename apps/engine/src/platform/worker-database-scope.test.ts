import { describe, expect, it } from 'vitest';
import { workerDatabaseConnectionParameters } from './worker-database-scope';

describe('worker database connection scope', () => {
  it('binds every hosted connection to the exact job capability and owner', () => {
    expect(workerDatabaseConnectionParameters('worker', {
      ENGINE_JOB_ID: 'job-id',
      ENGINE_JOB_TOKEN: 'claim-token',
      ACCRAWL_WORKER_NAME: 'pod:owner',
    })).toEqual({
      application_name: 'worker',
      'accrawl.job_id': 'job-id',
      'accrawl.claim_token': 'claim-token',
      'accrawl.worker_name': 'pod:owner',
    });
  });

  it('keeps the self-host owner connection unscoped and rejects partial worker scope', () => {
    expect(workerDatabaseConnectionParameters('engine', {})).toEqual({
      application_name: 'engine',
    });
    expect(() => workerDatabaseConnectionParameters('engine', {
      ENGINE_JOB_ID: 'job-id',
    })).toThrow(/requires job id, claim token, and worker name/);
  });
});
