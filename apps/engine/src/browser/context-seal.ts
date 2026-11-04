/**
 * Browser contexts whose page has been refused for the address it reached, and the address checks still pending.
 *
 * Closing a context is asynchronous, and until it completes the refused page can still raise requests, downloads
 * and popups. A seal is set synchronously at the refusal, and the engine's own handlers for those events check it,
 * so nothing the refused page does from then on reaches the request classifier, a log, or the network.
 *
 * The address is checked when a navigation's document commits, and its scripts can run before that check settles.
 * The write gate waits for the pending check before it classifies a request, so a page is never classified before
 * it is known not to be refused.
 */
import type { BrowserContext } from 'playwright';

const sealed = new WeakSet<BrowserContext>();
const addressChecks = new WeakMap<BrowserContext, Promise<void>>();

export function sealContext(context: BrowserContext): void {
  sealed.add(context);
}

export function isContextSealed(context: BrowserContext): boolean {
  return sealed.has(context);
}

/** Records `check` as the pending check of the address the context's page is navigating to. */
export function checkingAddress(context: BrowserContext, check: Promise<unknown>): void {
  addressChecks.set(context, check.then(() => undefined, () => undefined));
}

/** Settles once the latest address check recorded for the context has settled, whatever its outcome. */
export async function addressChecked(context: BrowserContext): Promise<void> {
  await addressChecks.get(context);
}
