/**
 * Run the one-shot worker as this process's whole job.
 *
 * `job-worker.ts` is a module: importing it starts nothing, so a deployment that has something to
 * register before the worker claims — how it proves which execution it is, where its screenshots go —
 * can do that first and then call `runJobWorker()` itself. This file is the entry for a deployment
 * that has nothing to register.
 */
import { runJobWorker } from './job-worker';

void runJobWorker().catch((error) => {
  console.error('[job-worker] fatal:', error);
  process.exit(1);
});
