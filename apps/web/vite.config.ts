import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In dev, the SPA proxies the API + SSE to the control-plane; in prod, Caddy serves both behind one origin.
// ACCRAWL_API_TARGET points the dev proxy elsewhere (e.g. http://localhost:8088 to develop against a
// running docker-compose stack instead of a bare control-plane on :3000).
const target = process.env.ACCRAWL_API_TARGET ?? 'http://localhost:3000';

// Deployed build stamp (git short SHA) baked in at image build time (Caddy.Dockerfile passes ACCRAWL_VERSION);
// 'dev' for a bare `vite dev`/`vite build`. Surfaced in the console footer so the running build is visible.
const version = (process.env.ACCRAWL_VERSION ?? 'dev').slice(0, 12);

// AGPL-3.0 §13: anyone interacting with this program over a network must be offered its Corresponding
// Source. The console is that network interface, so it carries the offer as a link. A deployment running
// MODIFIED code must point this at ITS OWN source — that is the whole obligation — hence the override.
const repositoryUrl = (
  JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8')) as {
    repository?: { url?: string };
  }
).repository?.url;
const sourceUrl = process.env.ACCRAWL_SOURCE_URL ?? repositoryUrl ?? '';

export default defineConfig({
  plugins: [react()],
  define: {
    __ACCRAWL_VERSION__: JSON.stringify(version),
    __ACCRAWL_SOURCE_URL__: JSON.stringify(sourceUrl),
  },
  resolve: {
    alias: {
      // Compile the shared model list from TS source: the package's published entry is CommonJS
      // (rollup can't statically resolve its re-exports) and its barrel pulls in node:crypto, which
      // has no browser build. The models module is browser-safe by construction.
      '@accrawl/contracts/models': path.resolve(
        import.meta.dirname,
        '../../packages/contracts/src/models.ts',
      ),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target, changeOrigin: true },
      // Where a built Companion is published is a property of the deployment, not of the product, so
      // the dev server only forwards this when it has been told where to look. Set
      // COMPANION_APK_UPSTREAM to the origin and COMPANION_APK_PATH to the object.
      ...(process.env.COMPANION_APK_UPSTREAM
        ? {
          '/downloads/companion.apk': {
            target: process.env.COMPANION_APK_UPSTREAM,
            changeOrigin: true,
            rewrite: () => process.env.COMPANION_APK_PATH ?? '/accrawl-companion.apk',
          },
        }
        : {}),
      '/health': { target, changeOrigin: true },
      '/version': { target, changeOrigin: true },
    },
  },
  build: { outDir: 'dist' },
});
