import { describe, expect, it, vi } from 'vitest';
import { createSessionLogger } from './logger';
import {
  safeBrowserUrl,
  safeBrowserUrlsInText,
} from './safe-browser-url';

describe('safe browser URL boundary', () => {
  it('retains only HTTPS origin and path', () => {
    const credential = 'credential-value';
    const querySecret = 'query-value';
    const fragmentSecret = 'fragment-value';
    const safe = safeBrowserUrl(
      `https://user:${credential}@bank.example/callback?code=${querySecret}#access_token=${fragmentSecret}`,
    );

    expect(safe.startsWith('https://bank.example/callback')).toBe(true);
    expect(safe.includes(credential)).toBe(false);
    expect(safe.includes(querySecret)).toBe(false);
    expect(safe.includes(fragmentSecret)).toBe(false);
    expect(safe.includes('?')).toBe(false);
    expect(safe.includes('#')).toBe(false);
    expect(safe.includes('@')).toBe(false);
  });

  it('does not echo opaque or malformed URL payloads', () => {
    const opaqueSecret = 'opaque-value';
    const malformedSecret = 'malformed-value';
    const opaque = safeBrowserUrl(`data:text/html,${opaqueSecret}`);
    const malformed = safeBrowserUrl(`not a URL ${malformedSecret}`);

    expect(opaque.includes(opaqueSecret)).toBe(false);
    expect(opaque.length).toBe('data:'.length);
    expect(malformed.includes(malformedSecret)).toBe(false);
    expect(malformed.length).toBe(0);
  });

  it('scrubs absolute URLs embedded in free-form diagnostics', () => {
    const querySecret = 'embedded-query';
    const fragmentSecret = 'embedded-fragment';
    const safe = safeBrowserUrlsInText(
      `redirected through https://bank.example/authorize?code=${querySecret}#token=${fragmentSecret} before completion`,
    );

    expect(safe.includes(querySecret)).toBe(false);
    expect(safe.includes(fragmentSecret)).toBe(false);
    expect(safe.includes('?')).toBe(false);
    expect(safe.includes('#')).toBe(false);
    expect(safe.includes('https://bank.example/authorize')).toBe(true);
  });

  it('scrubs WebSocket and protocol-relative URLs in free-form diagnostics', () => {
    const socketSecret = 'socket-query';
    const protocolRelativeSecret = 'relative-fragment';
    const safe = safeBrowserUrlsInText(
      `socket wss://user:password@stream.bank.example/live?token=${socketSecret} `
      + `redirect //bank.example/return#token=${protocolRelativeSecret}`,
      'https://bank.example/current',
    );

    expect(safe.includes(socketSecret)).toBe(false);
    expect(safe.includes(protocolRelativeSecret)).toBe(false);
    expect(safe.includes('password')).toBe(false);
    expect(safe.includes('wss://stream.bank.example/live')).toBe(true);
    expect(safe.includes('https://bank.example/return')).toBe(true);
  });

  it('scrubs relative query and fragment payloads in free-form diagnostics', () => {
    const rootedSecret = 'rooted-query';
    const fragmentSecret = 'relative-fragment';
    const safe = safeBrowserUrlsInText(
      `redirect /callback?code=${rootedSecret} then ./complete#token=${fragmentSecret}`,
    );

    expect(safe.includes(rootedSecret)).toBe(false);
    expect(safe.includes(fragmentSecret)).toBe(false);
    expect(safe.includes('/callback')).toBe(true);
    expect(safe.includes('./complete')).toBe(true);
    expect(safe.includes('?')).toBe(false);
    expect(safe.includes('#')).toBe(false);
  });

  it('sanitizes session-log strings before buffering or console output', () => {
    const querySecret = 'logger-query';
    const fragmentSecret = 'logger-fragment';
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const logger = createSessionLogger('session-id');
      logger.log(
        `at https://bank.example/return?code=${querySecret}#token=${fragmentSecret}`,
      );
      const serialized = JSON.stringify(logger.getLines());
      const consoleSerialized = JSON.stringify(consoleSpy.mock.calls);

      expect(serialized.includes(querySecret)).toBe(false);
      expect(serialized.includes(fragmentSecret)).toBe(false);
      expect(consoleSerialized.includes(querySecret)).toBe(false);
      expect(consoleSerialized.includes(fragmentSecret)).toBe(false);
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('sanitizes WebSocket credentials before buffering or console output', () => {
    const socketSecret = 'logger-socket-query';
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const logger = createSessionLogger('session-id');
      logger.warn(
        `socket failed wss://user:password@stream.bank.example/live?token=${socketSecret}`,
      );
      const serialized = JSON.stringify(logger.getLines());
      const consoleSerialized = JSON.stringify(consoleSpy.mock.calls);

      expect(serialized.includes(socketSecret)).toBe(false);
      expect(serialized.includes('password')).toBe(false);
      expect(consoleSerialized.includes(socketSecret)).toBe(false);
      expect(consoleSerialized.includes('password')).toBe(false);
    } finally {
      consoleSpy.mockRestore();
    }
  });
});
