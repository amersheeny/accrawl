import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { readSecret } from './secrets';

it('a mounted bundle may carry the setup claim token', () => {
  const dir = mkdtempSync(join(tmpdir(), 'accrawl-bundle-'));
  const file = join(dir, 'runtime.json');
  writeFileSync(file, JSON.stringify({ SETUP_CLAIM_TOKEN: 'from-the-bundle' }));
  process.env.ACCRAWL_RUNTIME_SECRET_BUNDLE_FILE = file;
  delete process.env.SETUP_CLAIM_TOKEN;
  // Before this name was permitted, reading it here threw and the server never started.
  expect(readSecret('SETUP_CLAIM_TOKEN')).toBe('from-the-bundle');
  delete process.env.ACCRAWL_RUNTIME_SECRET_BUNDLE_FILE;
});
