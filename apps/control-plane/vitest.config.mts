import { configDefaults, defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@accrawl/contracts': fileURLToPath(new URL('../../packages/contracts/src/index.ts', import.meta.url)),
      '@accrawl/sdk': fileURLToPath(new URL('../../packages/sdk-ts/src/index.ts', import.meta.url)),
    },
  },
  test: {
    // One real PostgreSQL for the run, shared by the suites that need a genuine server. See the file
    // itself for why two clusters was the wrong number.
    globalSetup: ['./test/embedded-postgres.global.ts'],
    exclude: [
      ...configDefaults.exclude,
      'src/email-otp/watcher.greenmail.test.ts',
      'src/{data,storage}/*.emulator.test.ts',
    ],
    hookTimeout: 30_000,
    testTimeout: 30_000,
  },
});
