/**
 * Platform factory.
 *
 * Selects the active platform implementation from the PLATFORM env var:
 *   - 'local'    (default) — filesystem run artifacts, file-based OTP, plaintext
 *                            credentials. Requires no cloud services.
 *   - 'postgres'           — telemetry + staged extraction to Postgres, behind the
 *                            control-plane (the self-host worker mode).
 *   - 'remote'             — private hosted broker; the worker has no direct
 *                            persistence, storage, or decryption-key access.
 *
 * The non-local adapters are imported lazily, so a `local` deployment never loads the postgres
 * driver (an optionalDependency) or anything a registered platform brings with it.
 */

import type { Platform } from './types';
// The local adapter has zero external dependencies, so it is safe to import statically (the default
// path needs no runtime module resolution). Every other adapter is imported lazily below, so a
// local-only install — one that ran `npm install --omit=optional` — never loads it.
import { createLocalPlatform } from './local';

let cached: Platform | undefined;
const registered = new Map<string, () => Platform>();

/**
 * Register how this deployment's worker records a crawl. The three built in below need nothing from
 * anyone: writing files locally, writing to a database we run, and reporting over HTTP to our own
 * control-plane. Anything else is supplied by whoever composes the deployment.
 */
export function registerPlatform(name: string, factory: () => Platform): void {
  registered.set(name, factory);
}

/** Test helper: forget registrations so a case can compose a different deployment. */
export function resetRegisteredPlatformsForTests(): void {
  registered.clear();
  cached = undefined;
}

function resolvePlatformName(): string {
  const raw = (process.env.PLATFORM || 'local').toLowerCase();
  if (
    raw === 'local'
    || raw === 'postgres'
    || raw === 'remote'
  ) return raw;
  // A deployment may register its own, so an unknown name is only invalid once nothing has supplied it.
  return raw;
}

export function getPlatform(): Platform {
  if (cached) return cached;
  const name = resolvePlatformName();
  const supplied = registered.get(name);
  if (supplied) {
    cached = supplied();
    console.log(`[platform] Using '${name}' platform`);
    return cached;
  }
  if (name === 'postgres') {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('./postgres') as { createPostgresPlatform: () => Platform };
    cached = mod.createPostgresPlatform();
  } else if (name === 'remote') {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('./remote') as { createRemotePlatform: () => Platform };
    cached = mod.createRemotePlatform();
  } else {
    cached = createLocalPlatform();
  }
  console.log(`[platform] Using '${name}' platform`);
  return cached;
}

/** Test helper: reset the cached platform so a different PLATFORM can be selected. */
export function resetPlatformForTests(): void {
  cached = undefined;
}
