import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  loadSecretEnvironment,
  resetSecretEnvironmentForTests,
} from './secret-environment';

const original = { ...process.env };

afterEach(() => {
  process.env = { ...original, NODE_ENV: 'test' };
  resetSecretEnvironmentForTests();
});

describe('engine runtime secret bundle', () => {
  it('loads only approved keys from a strict mounted JSON bundle', () => {
    const directory = mkdtempSync(join(tmpdir(), 'accrawl-engine-secrets-'));
    const filename = join(directory, 'runtime.json');
    writeFileSync(filename, JSON.stringify({ GEMINI_API_KEY: 'model-key' }));
    delete process.env.GEMINI_API_KEY;
    process.env.ACCRAWL_RUNTIME_SECRET_BUNDLE_FILE = filename;

    expect(loadSecretEnvironment('GEMINI_API_KEY')).toBe('model-key');
    expect(process.env.GEMINI_API_KEY).toBe('model-key');
  });

  it('rejects unknown and duplicate bundle keys', () => {
    const directory = mkdtempSync(join(tmpdir(), 'accrawl-engine-secrets-'));
    const filename = join(directory, 'runtime.json');
    process.env.ACCRAWL_RUNTIME_SECRET_BUNDLE_FILE = filename;
    delete process.env.GEMINI_API_KEY;

    writeFileSync(filename, '{"GEMINI_API_KEY":"one","GEMINI_API_KEY":"two"}');
    expect(() => loadSecretEnvironment('GEMINI_API_KEY')).toThrow(/duplicate key/);

    resetSecretEnvironmentForTests();
    writeFileSync(filename, '{"GEMINI_API_KEY":"one","UNSAFE":"two"}');
    expect(() => loadSecretEnvironment('GEMINI_API_KEY')).toThrow();
  });
});
