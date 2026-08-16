import { HOSTED_COPY, type CrawlRequest } from '@accrawl/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RemoteBrokerClient } from './remote-broker-client';
import {
  configureRemotePlatform,
  createRemotePlatform,
  resetRemotePlatformForTests,
} from './remote';

const SESSION_ID = '313fce73-a320-4b34-bd4b-a554f41acb35';
const ATTEMPT_ID = 'fd60f6e9-6d8f-4491-9b93-85f3e602501e';

function configuredPlatform(complete: ReturnType<typeof vi.fn>) {
  const client = {
    environment: {
      sessionId: SESSION_ID,
      attemptId: ATTEMPT_ID,
    },
    complete,
  } as unknown as RemoteBrokerClient;
  const request = {
    sessionId: SESSION_ID,
    workerContext: { attemptId: ATTEMPT_ID },
  } as CrawlRequest;
  configureRemotePlatform({ client, request });
  return createRemotePlatform();
}

afterEach(() => {
  resetRemotePlatformForTests();
  vi.restoreAllMocks();
});

describe('remote session completion', () => {
  it('logs the protected diagnostic but sends only reviewed failure copy', async () => {
    const complete = vi.fn().mockResolvedValue(undefined);
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const platform = configuredPlatform(complete);

    await platform.sessionStore.complete(
      SESSION_ID,
      false,
      'customer-secret-bank-response',
      { failureReason: 'internal_error' },
    );

    expect(errorLog).toHaveBeenCalledWith(
      `[Session] Hosted crawl ${SESSION_ID} reported a failure:`,
      'customer-secret-bank-response',
    );
    expect(complete).toHaveBeenCalledWith({
      success: false,
      error: HOSTED_COPY.refreshUnexpectedFailure,
      results: { failureReason: 'internal_error' },
    });
  });

  it('does not attach an error to a successful completion', async () => {
    const complete = vi.fn().mockResolvedValue(undefined);
    const platform = configuredPlatform(complete);

    await platform.sessionStore.complete(SESSION_ID, true, undefined, {});

    expect(complete).toHaveBeenCalledWith({
      success: true,
      error: undefined,
      results: {},
    });
  });
});
