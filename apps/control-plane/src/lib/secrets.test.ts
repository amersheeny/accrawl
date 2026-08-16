import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readSecret } from './secrets';

describe('readSecret (_FILE / Docker-secrets convention)', () => {
  afterEach(() => {
    delete process.env.TESTSEC;
    delete process.env.TESTSEC_FILE;
    delete process.env.ACCRAWL_RUNTIME_SECRET_BUNDLE_FILE;
  });

  it('reads a raw env var when no _FILE is set', () => {
    process.env.TESTSEC = 'from-env';
    expect(readSecret('TESTSEC')).toBe('from-env');
  });

  it('prefers _FILE over the raw env var, trimming a trailing newline', () => {
    const p = path.join(os.tmpdir(), `accrawl-secret-${process.pid}`);
    fs.writeFileSync(p, 'from-file\n');
    process.env.TESTSEC = 'from-env';
    process.env.TESTSEC_FILE = p;
    try {
      expect(readSecret('TESTSEC')).toBe('from-file');
    } finally {
      fs.unlinkSync(p);
    }
  });

  it('throws a clear error when _FILE points at a missing file', () => {
    process.env.TESTSEC_FILE = '/no/such/secret/file';
    expect(() => readSecret('TESTSEC')).toThrow(/could not be read/);
  });

  it('treats a present-but-empty _FILE as the inline-secret default — falls through to the raw env var', () => {
    // A compose `NAME_FILE: ${NAME_FILE:-}` line passes an EMPTY string whenever the operator uses the
    // inline NAME secret instead. That is the normal default, NOT a mount failure, so it must fall through
    // to NAME — otherwise the default `docker compose up` crash-loops. A genuine mount failure is a
    // NON-empty path that cannot be read (the test above), which still throws.
    process.env.TESTSEC = 'raw-secret';
    process.env.TESTSEC_FILE = '';
    expect(readSecret('TESTSEC')).toBe('raw-secret');
  });

  it('returns undefined when neither is set', () => {
    expect(readSecret('TESTSEC')).toBeUndefined();
  });

  it('reads an allowlisted secret from the mounted runtime bundle', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'accrawl-secret-test-'));
    try {
      const filename = path.join(directory, 'runtime.json');
      fs.writeFileSync(filename, JSON.stringify({
        GEMINI_API_KEY: 'bundle-secret',
        JOB_ENCRYPTION_KEY: 'job-envelope-secret',
      }));
      process.env.ACCRAWL_RUNTIME_SECRET_BUNDLE_FILE = filename;
      expect(readSecret('GEMINI_API_KEY')).toBe('bundle-secret');
      expect(readSecret('JOB_ENCRYPTION_KEY')).toBe('job-envelope-secret');
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects unknown or cross-service keys in the runtime bundle', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'accrawl-secret-test-'));
    try {
      const filename = path.join(directory, 'runtime.json');
      fs.writeFileSync(filename, JSON.stringify({
        SOME_OTHER_SERVICE_API_KEY: 'wrong-service',
        GEMINI_API_KEY: 'bundle-secret',
      }));
      process.env.ACCRAWL_RUNTIME_SECRET_BUNDLE_FILE = filename;
      expect(() => readSecret('GEMINI_API_KEY')).toThrow(
        /invalid control-plane secret bundle/,
      );
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('fails closed for malformed or unreadable runtime bundles', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'accrawl-secret-test-'));
    try {
      const malformed = path.join(directory, 'runtime.json');
      fs.writeFileSync(malformed, '{"GEMINI_API_KEY":');
      process.env.ACCRAWL_RUNTIME_SECRET_BUNDLE_FILE = malformed;
      expect(() => readSecret('GEMINI_API_KEY')).toThrow(/invalid JSON/);

      process.env.ACCRAWL_RUNTIME_SECRET_BUNDLE_FILE = path.join(directory, 'missing.json');
      expect(() => readSecret('GEMINI_API_KEY')).toThrow(/could not be read/);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects duplicate keys instead of accepting parser-dependent precedence', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'accrawl-secret-test-'));
    try {
      const filename = path.join(directory, 'runtime.json');
      fs.writeFileSync(
        filename,
        '{"GEMINI_API_KEY":"first","GEMINI_API_KEY":"second"}',
      );
      process.env.ACCRAWL_RUNTIME_SECRET_BUNDLE_FILE = filename;
      expect(() => readSecret('GEMINI_API_KEY')).toThrow(/duplicate key/);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
