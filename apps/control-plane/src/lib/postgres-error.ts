/**
 * Drizzle preserves the database error as `cause` on some drivers and exposes
 * it directly on others. Read the first PostgreSQL code in that chain without
 * depending on a driver-specific wrapper type.
 */
export function postgresErrorCode(error: unknown): string | undefined {
  const seen = new Set<object>();
  let current: unknown = error;

  while (typeof current === 'object' && current !== null && !seen.has(current)) {
    seen.add(current);
    const candidate = current as { code?: unknown; cause?: unknown };
    if (typeof candidate.code === 'string') return candidate.code;
    current = candidate.cause;
  }

  return undefined;
}
