import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  api,
  ApiError,
  clearToken,
  getToken,
  hasAuthentication,
  hostedLoginUrl,
  restoreHostedSession,
  setToken,
  signOut,
} from './api';

const values = new Map<string, string>();
const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  values.clear();
  fetchMock.mockReset();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
  vi.stubGlobal('fetch', fetchMock);
  clearToken();
});

describe('hostedLoginUrl', () => {
  it('preserves the console return path and rejects a protocol-relative target', () => {
    expect(hostedLoginUrl('/accounts', '?connection=one', '#balance'))
      .toBe('/login?returnTo=%2Faccounts%3Fconnection%3Done%23balance');
    expect(hostedLoginUrl('//attacker.example/path'))
      .toBe('/login?returnTo=%2Faccounts');
  });
});

describe('signOut', () => {
  it('clears a self-hosted token without calling the hosted session endpoint', async () => {
    setToken('self-hosted-token');

    await signOut();

    expect(getToken()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('clears a hosted token only after the edge confirms session deletion', async () => {
    setToken('hosted-session');
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

    await signOut();

    expect(fetchMock).toHaveBeenCalledWith('/__auth/session', { method: 'DELETE' });
    expect(getToken()).toBeNull();
    expect(hasAuthentication()).toBe(false);
  });

  it('retains hosted state when the edge refuses session deletion', async () => {
    setToken('hosted-session');
    fetchMock.mockResolvedValue(new Response(null, { status: 503 }));

    await expect(signOut()).rejects.toThrow('status 503');
    expect(hasAuthentication()).toBe(true);
  });

  it('retains hosted state when session deletion cannot reach the edge', async () => {
    setToken('hosted-session');
    fetchMock.mockRejectedValue(new Error('network unavailable'));

    await expect(signOut()).rejects.toThrow('network unavailable');
    expect(hasAuthentication()).toBe(true);
  });
});

describe('restoreHostedSession', () => {
  it('restores a valid HttpOnly session without persisting duplicate auth state', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

    await expect(restoreHostedSession()).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledWith('/__auth/session', {
      method: 'GET',
      headers: { accept: 'application/json' },
    });
    expect(hasAuthentication()).toBe(true);
    expect(getToken()).toBeNull();
    expect(values.has('accrawl.token')).toBe(false);
  });

  it('does not mistake a self-hosted SPA fallback for a hosted session', async () => {
    fetchMock.mockResolvedValue(new Response('<!doctype html>', { status: 200 }));

    await expect(restoreHostedSession()).resolves.toBe(false);

    expect(hasAuthentication()).toBe(false);
  });

  it('removes the legacy hosted marker after checking the authoritative cookie', async () => {
    values.set('accrawl.token', 'hosted-session');
    fetchMock.mockResolvedValue(new Response(null, { status: 401 }));

    await expect(restoreHostedSession()).resolves.toBe(false);

    expect(values.has('accrawl.token')).toBe(false);
    expect(hasAuthentication()).toBe(false);
  });
});

describe('institution publication', () => {
  it('preserves the server error code so the screen can select reviewed copy', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      code: 'institution_publish_copy_exists',
      error: 'server fallback',
    }), {
      status: 409,
      headers: { 'content-type': 'application/json' },
    }));

    const error = await api.publishInstitution('private/id').catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 409,
      code: 'institution_publish_copy_exists',
      message: 'server fallback',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/institutions/private%2Fid/publish',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});
