import { spawnSync } from 'node:child_process';

export const GITLEAKS_VERSION = '8.30.1';

const MAX_OUTPUT_BYTES = 128 * 1024 * 1024;

export function runGitleaks(command, args, cwd, options = {}) {
  const version = spawnSync('gitleaks', ['version'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (version.status !== 0 || version.stdout.trim() !== GITLEAKS_VERSION) {
    throw new Error(
      `gitleaks ${GITLEAKS_VERSION} is required; found `
        + `${version.status === 0 ? version.stdout.trim() : 'no executable'}.`,
    );
  }

  const result = spawnSync('gitleaks', [
    command,
    '--no-banner',
    '--no-color',
    '--redact=100',
    '--timeout=300',
    '--report-format=json',
    '--report-path=-',
    ...args,
  ], {
    cwd,
    encoding: 'utf8',
    input: options.input,
    maxBuffer: MAX_OUTPUT_BYTES,
    stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  });
  if (result.status === 0) return [];

  try {
    const findings = JSON.parse(result.stdout);
    if (Array.isArray(findings) && findings.length > 0) return findings;
  } catch {
    // The generic scanner failure below deliberately excludes scanner output.
  }
  throw new Error('The gitleaks scan did not complete successfully.');
}
