// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { disableWebRtcInPage, installEgressGuard } from './egress-guard';

type AnyWin = Record<string, unknown>;

describe('egress guard — WebRTC denial + install wiring', () => {
  it('removes the WebRTC constructors so ICE/STUN/data-channels cannot leave', () => {
    (window as unknown as AnyWin).RTCPeerConnection = function () {};
    (window as unknown as AnyWin).webkitRTCPeerConnection = function () {};
    disableWebRtcInPage();
    expect((window as unknown as AnyWin).RTCPeerConnection).toBeUndefined();
    expect((window as unknown as AnyWin).webkitRTCPeerConnection).toBeUndefined();
  });

  it('registers the WebRTC init script BEFORE the request route guard', async () => {
    const order: string[] = [];
    const initScripts: unknown[] = [];
    const ctx = {
      addInitScript: vi.fn(async (fn: unknown) => { initScripts.push(fn); order.push('init'); }),
      route: vi.fn(async () => { order.push('route'); }),
      // no routeWebSocket → exercises the optional-branch guard
    };
    const logger = { log: () => {}, warn: () => {} };
    await installEgressGuard(ctx as never, 'https://login.bank.com', [], logger as never);
    expect(initScripts).toContain(disableWebRtcInPage); // the WebRTC denial is wired in
    expect(order[0]).toBe('init');                       // applied before any navigation/route
    expect(ctx.route).toHaveBeenCalledWith('**/*', expect.any(Function));
  });

  it('redacts blocked HTTP and WebSocket URL secrets before logging', async () => {
    const querySecret = 'blocked-query';
    const fragmentSecret = 'blocked-fragment';
    let routeHandler: ((route: unknown, request: unknown) => void) | undefined;
    let socketHandler: ((socket: unknown) => void) | undefined;
    const warnings: string[] = [];
    const ctx = {
      addInitScript: vi.fn(async () => {}),
      route: vi.fn(async (_pattern: string, handler: typeof routeHandler) => {
        routeHandler = handler;
      }),
      routeWebSocket: vi.fn(async (_pattern: string, handler: typeof socketHandler) => {
        socketHandler = handler;
      }),
    };
    await installEgressGuard(
      ctx as never,
      'https://login.bank.example',
      [],
      { log: () => {}, warn: (message: string) => warnings.push(message) } as never,
    );
    routeHandler?.(
      { abort: vi.fn(), continue: vi.fn() },
      {
        method: () => 'GET',
        url: () =>
          `https://outside.example/collect?code=${querySecret}#token=${fragmentSecret}`,
      },
    );
    socketHandler?.({
      close: vi.fn(),
      connectToServer: vi.fn(),
      url: () =>
        `wss://outside.example/socket?code=${querySecret}#token=${fragmentSecret}`,
    });
    const serialized = JSON.stringify(warnings);

    expect(serialized.includes(querySecret)).toBe(false);
    expect(serialized.includes(fragmentSecret)).toBe(false);
    expect(serialized.includes('?')).toBe(false);
    expect(serialized.includes('#')).toBe(false);
  });
});
