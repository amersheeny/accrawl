import { describe, expect, it } from 'vitest';
import { connectionUpdateSchema } from './connections';

describe('connection update payload', () => {
  it('rejects empty and unknown-only PATCH bodies', () => {
    expect(connectionUpdateSchema.safeParse({}).success).toBe(false);
    expect(connectionUpdateSchema.safeParse({ invented: true }).success).toBe(false);
  });

  it('accepts a supported schedule edit', () => {
    expect(connectionUpdateSchema.safeParse({
      crawlScheduleEnabled: true,
      crawlSchedule: '0 6 * * *',
      crawlTimezone: 'Europe/London',
    }).success).toBe(true);
  });
});
