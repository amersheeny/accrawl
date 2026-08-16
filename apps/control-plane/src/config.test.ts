import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('which implementations this deployment selected', () => {
  it('keeps its own records and runs its own engine unless told otherwise', async () => {
    vi.stubEnv('PERSISTENCE_BACKEND', '');
    vi.stubEnv('ENGINE_DISPATCH_MODE', '');

    await expect(import('./config')).resolves.toMatchObject({
      config: { persistenceBackend: 'postgres', engineDispatchMode: 'http' },
    });
  });

  it('carries a name it has never heard of through to the registry', async () => {
    // Configuration does not hold a list of what exists — the registries do, and a deployment may add
    // to them. Deciding here would mean rejecting an implementation this repository does not contain.
    vi.stubEnv('PERSISTENCE_BACKEND', 'somewhere-else');
    vi.stubEnv('ENGINE_DISPATCH_MODE', 'some-other-way');

    await expect(import('./config')).resolves.toMatchObject({
      config: { persistenceBackend: 'somewhere-else', engineDispatchMode: 'some-other-way' },
    });
  });

  it('treats a set but blank selection as unset', async () => {
    vi.stubEnv('PERSISTENCE_BACKEND', '   ');

    await expect(import('./config')).resolves.toMatchObject({
      config: { persistenceBackend: 'postgres' },
    });
  });
});

describe('what a Companion is told to register with', () => {
  const CLIENT = {
    COMPANION_PUSH_CLIENT_APP_ID: '1:2:android:3',
    COMPANION_PUSH_CLIENT_API_KEY: 'a-key',
    COMPANION_PUSH_PROJECT_ID: 'a-project',
    COMPANION_PUSH_CLIENT_SENDER_ID: '4',
  };

  it('hands over all four values when a deployment sends wake-ups', async () => {
    for (const [name, value] of Object.entries(CLIENT)) vi.stubEnv(name, value);

    await expect(import('./config')).resolves.toMatchObject({
      config: {
        companionPushClient: {
          applicationId: '1:2:android:3',
          apiKey: 'a-key',
          projectId: 'a-project',
          senderId: '4',
        },
      },
    });
  });

  it('offers nothing at all when one of them is missing', async () => {
    // A partial answer would let the app register with something the sender cannot reach, which shows
    // up as a phone that never wakes rather than as an error anybody sees.
    for (const [name, value] of Object.entries(CLIENT)) vi.stubEnv(name, value);
    vi.stubEnv('COMPANION_PUSH_CLIENT_SENDER_ID', '');

    await expect(import('./config')).resolves.toMatchObject({
      config: { companionPushClient: undefined },
    });
  });

  it('offers nothing when a deployment sends no wake-ups', async () => {
    for (const name of Object.keys(CLIENT)) vi.stubEnv(name, '');

    await expect(import('./config')).resolves.toMatchObject({
      config: { companionPushClient: undefined },
    });
  });
});

describe('refusing to start on a selection nothing answers', () => {
  it('names what is registered when the records backend is not', async () => {
    vi.stubEnv('PERSISTENCE_BACKEND', 'somewhere-else');
    const { assertPersistenceBackendRegistered } = await import('./storage');

    expect(() => assertPersistenceBackendRegistered())
      .toThrow(/PERSISTENCE_BACKEND="somewhere-else".*Registered: postgres/s);
  });

  it('names what is registered when the dispatch transport is not', async () => {
    vi.stubEnv('ENGINE_DISPATCH_MODE', 'some-other-way');
    const { assertEngineDispatcherRegistered } = await import('./orchestration/dispatch-engine');

    expect(() => assertEngineDispatcherRegistered())
      .toThrow(/ENGINE_DISPATCH_MODE="some-other-way".*Registered: http/s);
  });

  it('accepts what this repository ships on its own', async () => {
    const [{ assertPersistenceBackendRegistered }, { assertEngineDispatcherRegistered }] =
      await Promise.all([import('./storage'), import('./orchestration/dispatch-engine')]);

    expect(() => assertPersistenceBackendRegistered()).not.toThrow();
    expect(() => assertEngineDispatcherRegistered()).not.toThrow();
  });
});
