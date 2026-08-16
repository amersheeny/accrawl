import { readFileSync } from 'node:fs';
import { z } from 'zod';

const RuntimeSecretBundleSchema = z.strictObject({
  ENGINE_DATABASE_URL: z.string().trim().min(1).optional(),
  ENGINE_SHARED_SECRET: z.string().trim().min(1).optional(),
  GEMINI_API_KEY: z.string().trim().min(1).optional(),
  JOB_ENCRYPTION_KEY: z.string().trim().min(1).optional(),
});

type RuntimeSecretName = keyof z.infer<typeof RuntimeSecretBundleSchema>;
let cachedBundle:
  | { filename: string; values: z.infer<typeof RuntimeSecretBundleSchema> }
  | undefined;

function rejectDuplicateKeys(raw: string): void {
  const keys: string[] = [];
  raw.replace(/"((?:\\.|[^"\\])*)"\s*:/g, (_match, encoded: string) => {
    keys.push(JSON.parse(`"${encoded}"`) as string);
    return '';
  });
  const duplicate = keys.find((key, index) => keys.indexOf(key) !== index);
  if (duplicate) {
    throw new Error(
      `ACCRAWL_RUNTIME_SECRET_BUNDLE_FILE contains duplicate key ${JSON.stringify(duplicate)}`,
    );
  }
}

function runtimeBundle(filename: string): z.infer<typeof RuntimeSecretBundleSchema> {
  if (cachedBundle?.filename === filename) return cachedBundle.values;
  let raw: string;
  try {
    raw = readFileSync(filename, 'utf8').trim();
  } catch (error) {
    throw new Error(
      `ACCRAWL_RUNTIME_SECRET_BUNDLE_FILE could not be read: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!raw) throw new Error('ACCRAWL_RUNTIME_SECRET_BUNDLE_FILE is empty');
  rejectDuplicateKeys(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(
      `ACCRAWL_RUNTIME_SECRET_BUNDLE_FILE contains invalid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const values = RuntimeSecretBundleSchema.parse(parsed);
  cachedBundle = { filename, values };
  return values;
}

export function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function loadSecretEnvironment(name: string): string {
  const file = process.env[`${name}_FILE`]?.trim();
  let value = file
    ? readFileSync(file, 'utf8').trim()
    : process.env[name]?.trim();
  if (!value) {
    const bundleFile = process.env.ACCRAWL_RUNTIME_SECRET_BUNDLE_FILE?.trim();
    if (bundleFile) {
      if (!(name in RuntimeSecretBundleSchema.shape)) {
        throw new Error(`${name} is not permitted in the engine runtime secret bundle`);
      }
      value = runtimeBundle(bundleFile)[name as RuntimeSecretName];
    }
  }
  if (!value) throw new Error(`${name} or ${name}_FILE is required`);
  process.env[name] = value;
  return value;
}

export function resetSecretEnvironmentForTests(): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('secret-environment reset is available only under NODE_ENV=test');
  }
  cachedBundle = undefined;
}
