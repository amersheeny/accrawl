/**
 * Secret resolution with the Docker-secrets / `_FILE` convention (the pattern the official postgres and
 * mysql images use): for any secret NAME, prefer `NAME_FILE` — a path to a mounted file, e.g.
 * `/run/secrets/credential_enc_key` — over a raw `NAME` env var.
 *
 * Why: file-mounted secrets stay out of `docker inspect`, out of `/proc/<pid>/environ`, out of child
 * processes' env, and — when the file lives outside the repo (e.g. `~/.accrawl/secrets/`) — out of git.
 * A raw env var leaks through all of those. A trailing newline (from `echo "x" > file`) is trimmed.
 */
import { readFileSync } from 'node:fs';
import { z } from 'zod';

const RuntimeSecretBundleSchema = z.strictObject({
  CREDENTIAL_ENC_KEY: z.string().trim().min(1).optional(),
  DATABASE_URL: z.string().trim().min(1).optional(),
  ENGINE_SHARED_SECRET: z.string().trim().min(1).optional(),
  GEMINI_API_KEY: z.string().trim().min(1).optional(),
  JOB_ENCRYPTION_KEY: z.string().trim().min(1).optional(),
  // Named here so a deployment that keeps its secrets in a mounted bundle can hold this one too. A name
  // absent from this list is refused when the bundle is in use, and refused at import — so the server
  // does not start rather than starting without it. Reading it from the environment never reaches that
  // check, which is why a deployment configured the ordinary way cannot tell whether this line exists.
  SETUP_CLAIM_TOKEN: z.string().trim().min(1).optional(),
});

type RuntimeSecretName = keyof z.infer<typeof RuntimeSecretBundleSchema>;

function rejectDuplicateTopLevelKeys(raw: string): void {
  const keys = new Set<string>();
  let depth = 0;
  let inString = false;
  let escaped = false;
  let keyStart = -1;
  let expectingKey = false;

  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index]!;
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        inString = false;
        if (keyStart >= 0) {
          const key = JSON.parse(raw.slice(keyStart, index + 1)) as string;
          if (keys.has(key)) {
            throw new Error(
              `ACCRAWL_RUNTIME_SECRET_BUNDLE_FILE contains duplicate key ${JSON.stringify(key)}`,
            );
          }
          keys.add(key);
          keyStart = -1;
          expectingKey = false;
        }
      }
      continue;
    }
    if (character === '"') {
      inString = true;
      if (depth === 1 && expectingKey) keyStart = index;
    } else if (character === '{') {
      depth += 1;
      if (depth === 1) expectingKey = true;
    } else if (character === '}') {
      depth -= 1;
    } else if (character === ',' && depth === 1) {
      expectingKey = true;
    }
  }
}

function readRuntimeSecretBundle(filename: string): z.infer<typeof RuntimeSecretBundleSchema> {
  let raw: string;
  try {
    raw = readFileSync(filename, 'utf8').trim();
  } catch (error) {
    throw new Error(
      `ACCRAWL_RUNTIME_SECRET_BUNDLE_FILE is set (${filename}) but the file could not be read: ${(error as Error).message}`,
    );
  }
  if (!raw) throw new Error('ACCRAWL_RUNTIME_SECRET_BUNDLE_FILE is empty');
  rejectDuplicateTopLevelKeys(raw);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(
      `ACCRAWL_RUNTIME_SECRET_BUNDLE_FILE contains invalid JSON: ${(error as Error).message}`,
    );
  }

  const result = RuntimeSecretBundleSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `ACCRAWL_RUNTIME_SECRET_BUNDLE_FILE has an invalid control-plane secret bundle: ${z.prettifyError(result.error)}`,
    );
  }
  return result.data;
}

export function readSecret(name: string): string | undefined {
  const filePath = process.env[`${name}_FILE`];
  // Truthiness (non-empty): a compose `NAME_FILE: ${NAME_FILE:-}` line passes an EMPTY string whenever the
  // operator uses the inline NAME secret instead — that is the normal default, not a mount failure, so it
  // must fall through to NAME below (otherwise the default `docker compose up` crash-loops). A genuine mount
  // failure is a NON-empty path that cannot be read, and that still fails loud in the catch below.
  if (filePath) {
    try {
      return readFileSync(filePath, 'utf8').replace(/\r?\n$/, '');
    } catch (err) {
      throw new Error(`${name}_FILE is set (${filePath}) but the file could not be read: ${(err as Error).message}`);
    }
  }
  const direct = process.env[name];
  if (direct !== undefined) return direct;

  const bundleFilename = process.env.ACCRAWL_RUNTIME_SECRET_BUNDLE_FILE?.trim();
  if (!bundleFilename) return undefined;
  if (!(name in RuntimeSecretBundleSchema.shape)) {
    throw new Error(`${name} is not permitted in the control-plane runtime secret bundle`);
  }
  return readRuntimeSecretBundle(bundleFilename)[name as RuntimeSecretName];
}
