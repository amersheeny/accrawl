// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { disableWebRtcInPage, installEgressGuard } from './egress-guard';
import { WriteGate } from './write-gate';
import { sealContext } from './context-seal';

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

  it('does not log the URL of a request whose routing fails after its page was refused', async () => {
    let routeHandler: ((route: unknown, request: unknown) => void) | undefined;
    const warnings: string[] = [];
    const ctx = {
      addInitScript: vi.fn(async () => {}),
      route: vi.fn(async (_pattern: string, handler: typeof routeHandler) => {
        routeHandler = handler;
      }),
    };
    const quiet = { log: () => {}, warn: () => {}, error: () => {}, getLines: () => [] };
    const gate = new WriteGate({ vet: async () => 'read', logger: quiet as never });
    gate.setPhase('extract');
    await installEgressGuard(
      ctx as never,
      'https://login.bank.example',
      [],
      { log: () => {}, warn: (message: string) => warnings.push(message) } as never,
      gate,
    );
    const abort = vi.fn(async () => undefined);
    await new Promise<void>((continued) => {
      routeHandler?.(
        {
          abort,
          continue: async () => {
            sealContext(ctx as never);
            continued();
            throw new Error('route.continue: Target page, context or browser has been closed');
          },
        },
        {
          method: () => 'POST',
          url: () => 'https://login.bank.example/transfer-SEALED-ONLY',
          postData: () => 'account=SEALED-ONLY',
          headers: () => ({ 'content-type': 'application/x-www-form-urlencoded' }),
        },
      );
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(JSON.stringify(warnings)).not.toContain('SEALED-ONLY');
    expect(abort).toHaveBeenCalledWith('blockedbyclient');
  });
});
