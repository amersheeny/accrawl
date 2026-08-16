import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@accrawl/contracts': fileURLToPath(
        new URL('../../packages/contracts/src/index.ts', import.meta.url),
      ),
      '@accrawl/sdk': fileURLToPath(
        new URL('../../packages/sdk-ts/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    include: ['src/email-otp/watcher.greenmail.test.ts'],
    hookTimeout: 60_000,
    testTimeout: 30_000,
  },
});
