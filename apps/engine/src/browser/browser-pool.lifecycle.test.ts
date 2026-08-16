import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  launch: vi.fn(),
}));

vi.mock('playwright', () => ({
  chromium: { launch: mocks.launch },
}));

import { closeBrowser, createContext, getBrowser } from './browser-pool';
import { buildChromiumEnvironment } from './chromium-environment';

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('browser lifecycle fence', () => {
  beforeEach(async () => {
    await closeBrowser();
    mocks.launch.mockReset();
  });

  it('passes only the allowlisted process environment to Chromium', async () => {
    const previousCanary = process.env.ACCRAWL_BROWSER_ENV_TEST_SECRET;
    process.env.ACCRAWL_BROWSER_ENV_TEST_SECRET = 'must-not-reach-chromium';
    const launchedBrowser = {
      close: vi.fn(async () => undefined),
      isConnected: () => true,
      version: () => '150.0.7871.186',
      newContext: vi.fn(),
    };
    mocks.launch.mockResolvedValueOnce(launchedBrowser);

    try {
      await getBrowser();

      expect(mocks.launch).toHaveBeenCalledWith(expect.objectContaining({
        env: buildChromiumEnvironment(process.env),
      }));
      const launchOptions = mocks.launch.mock.calls[0][0] as {
        env: Record<string, string>;
      };
      expect(launchOptions.env).not.toHaveProperty('ACCRAWL_BROWSER_ENV_TEST_SECRET');
    } finally {
      if (previousCanary === undefined) {
        delete process.env.ACCRAWL_BROWSER_ENV_TEST_SECRET;
      } else {
        process.env.ACCRAWL_BROWSER_ENV_TEST_SECRET = previousCanary;
      }
      await closeBrowser();
    }
  });

  it('closes a browser that finishes launching after a fence before any context can be created', async () => {
    const pending = deferred<{
      close: () => Promise<void>;
      isConnected: () => boolean;
      version: () => string;
      newContext: ReturnType<typeof vi.fn>;
    }>();
    const lateBrowser = {
      close: vi.fn(async () => undefined),
      isConnected: () => true,
      version: () => '150.0.7871.186',
      newContext: vi.fn(),
    };
    mocks.launch.mockReturnValueOnce(pending.promise);

    const context = createContext();
    await vi.waitFor(() => expect(mocks.launch).toHaveBeenCalledOnce());
    const fenced = closeBrowser();
    pending.resolve(lateBrowser);

    await expect(context).rejects.toThrow('Browser launch was fenced during startup');
    await fenced;
    expect(lateBrowser.close).toHaveBeenCalledOnce();
    expect(lateBrowser.newContext).not.toHaveBeenCalled();
  });

  it('rejects the positive fence when a late browser cannot be closed', async () => {
    const pending = deferred<{
      close: () => Promise<void>;
      isConnected: () => boolean;
      version: () => string;
      newContext: ReturnType<typeof vi.fn>;
    }>();
    const lateBrowser = {
      close: vi.fn(async () => {
        throw new Error('chrome process remained alive');
      }),
      isConnected: () => true,
      version: () => '150.0.7871.186',
      newContext: vi.fn(),
    };
    mocks.launch.mockReturnValueOnce(pending.promise);

    const context = createContext();
    await vi.waitFor(() => expect(mocks.launch).toHaveBeenCalledOnce());
    const fenced = closeBrowser();
    pending.resolve(lateBrowser);

    await expect(context).rejects.toMatchObject({ name: 'BrowserFenceError' });
    await expect(fenced).rejects.toMatchObject({ name: 'BrowserFenceError' });
    expect(lateBrowser.close).toHaveBeenCalledOnce();
  });

  it('allows a new launch after the prior in-flight launch has been fenced', async () => {
    const pending = deferred<{
      close: () => Promise<void>;
      isConnected: () => boolean;
      version: () => string;
      newContext: ReturnType<typeof vi.fn>;
    }>();
    const fencedBrowser = {
      close: vi.fn(async () => undefined),
      isConnected: () => true,
      version: () => '150.0.7871.186',
      newContext: vi.fn(),
    };
    const nextContext = { addInitScript: vi.fn(async () => undefined) };
    const nextBrowser = {
      close: vi.fn(async () => undefined),
      isConnected: () => true,
      version: () => '150.0.7871.186',
      newContext: vi.fn(async () => nextContext),
    };
    mocks.launch
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(nextBrowser);

    const firstContext = createContext();
    await vi.waitFor(() => expect(mocks.launch).toHaveBeenCalledOnce());
    const fenced = closeBrowser();
    pending.resolve(fencedBrowser);
    await expect(firstContext).rejects.toThrow('Browser launch was fenced during startup');
    await fenced;

    await expect(createContext()).resolves.toBe(nextContext);
    expect(nextBrowser.newContext).toHaveBeenCalledOnce();
    await closeBrowser();
  });

  it('closes a context that resolves while its browser is being fenced', async () => {
    const pendingContext = deferred<{
      addInitScript: ReturnType<typeof vi.fn>;
      close: ReturnType<typeof vi.fn>;
    }>();
    const pendingBrowserClose = deferred<void>();
    const lateContext = {
      addInitScript: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    };
    const activeBrowser = {
      close: vi.fn(() => pendingBrowserClose.promise),
      isConnected: () => true,
      version: () => '150.0.7871.186',
      newContext: vi.fn(() => pendingContext.promise),
    };
    mocks.launch.mockResolvedValueOnce(activeBrowser);

    const creating = createContext();
    await vi.waitFor(() => expect(activeBrowser.newContext).toHaveBeenCalledOnce());
    const fenced = closeBrowser();
    pendingContext.resolve(lateContext);

    await expect(creating).rejects.toThrow('Browser context creation was fenced during startup');
    expect(lateContext.close).toHaveBeenCalledOnce();
    expect(lateContext.addInitScript).not.toHaveBeenCalled();
    pendingBrowserClose.resolve();
    await fenced;
  });
});
