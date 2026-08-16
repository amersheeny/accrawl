import { describe, expect, it } from 'vitest';
import { isFencedCrawlJobData } from './pgboss';

describe('pg-boss scheduled crawl payload fence', () => {
  const fenced = {
    connectionId: '11111111-1111-4111-8111-111111111111',
    scheduleRevision: 3,
    scheduleClaim: '22222222-2222-4222-8222-222222222222',
    priorStatus: 'connected',
  };

  it('accepts only complete version-fenced automatic crawl jobs', () => {
    expect(isFencedCrawlJobData(fenced)).toBe(true);
    expect(isFencedCrawlJobData({ connectionId: fenced.connectionId })).toBe(false);
    expect(isFencedCrawlJobData({ ...fenced, scheduleClaim: undefined })).toBe(false);
    expect(isFencedCrawlJobData({ ...fenced, scheduleRevision: -1 })).toBe(false);
    expect(isFencedCrawlJobData({ ...fenced, priorStatus: 'invented' })).toBe(false);
  });
});
