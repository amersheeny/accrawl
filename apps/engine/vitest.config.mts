import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Resolve @accrawl/contracts to its TS source so engine tests run without a
// prior `contracts` build (production build/typecheck use the built package).
export default defineConfig({
  resolve: {
    alias: {
      '@accrawl/contracts': fileURLToPath(new URL('../../packages/contracts/src/index.ts', import.meta.url)),
    },
  },
  test: {
    // The real-browser tests (*.browser.test.ts) launch Chromium in `beforeAll`. Under `turbo run test`
    // (all workspaces in parallel) on a loaded host, that launch can exceed vitest's default 10s hook
    // timeout — the hook then times out BEFORE the graceful-skip catch can run, failing the whole file
    // (a flaky suite is not production-ready). A generous hook timeout absorbs a slow cold launch; a
    // well-behaved hook still returns in milliseconds, so this only raises the ceiling.
    hookTimeout: 60_000,
  },
});
