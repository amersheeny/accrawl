const CURSOR_VERSION = 1;

export function encodeCompanionCursor(value: unknown): string {
  return Buffer.from(
    JSON.stringify({ v: CURSOR_VERSION, value }),
    'utf8',
  ).toString('base64url');
}

export function decodeCompanionCursor<T>(
  cursor: string | undefined,
  validate: (value: unknown) => value is T,
): T | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    ) as {
      v?: unknown;
      value?: unknown;
    };
    if (
      parsed.v !== CURSOR_VERSION
      || !validate(parsed.value)
    ) throw new Error('invalid cursor');
    return parsed.value;
  } catch {
    throw new Error('invalid cursor');
  }
}

export interface CompanionTransactionCursor {
  bookingDate: string;
  id: string;
}

export function isCompanionTransactionCursor(
  value: unknown,
): value is CompanionTransactionCursor {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record.bookingDate === 'string'
    && /^\d{4}-\d{2}-\d{2}$/.test(record.bookingDate)
    && typeof record.id === 'string'
    && record.id.length > 0;
}
