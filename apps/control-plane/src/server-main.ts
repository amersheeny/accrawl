/**
 * Run the control-plane as this process's whole job.
 *
 * `index.ts` is a module: importing it starts nothing, so a deployment that has providers to register
 * before the server exists — where it keeps records, where screenshots go, who its workers are — can do
 * that first and then call `startControlPlane()` itself. Importing a module that had already begun
 * listening would leave such a deployment binding the port twice.
 */
import { startControlPlane } from './index';

startControlPlane().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('[control-plane] fatal:', error);
  process.exit(1);
});
