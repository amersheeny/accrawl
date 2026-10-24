/**
 * Device-proxy crawls end to end inside the engine: the real tunnel server, SOCKS5 relay, crawl executor, agent
 * loop, error recovery, navigate action and Chrome. A phone stand-in on the tunnel's WebSocket opens every connection
 * on a local bank and reports, in its {connected} frames, the address a real phone would have reached for each host.
 * Replaced: the platform's database-backed services and the model, whose steps are scripted and whose inputs are
 * recorded, so a test can see exactly what the model was shown.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import { WebSocket } from 'ws';
import { deriveTunnelKey, signTunnelToken } from '@accrawl/contracts';
import type { CrawlRequest, CrawlResponse, PageState } from '../types';
import type { StepResponse } from '../ai/schema';

const SECRET = 'tunnel-navigate-test-secret-aaaaaaaaaaaaaaa';

const model = vi.hoisted(() => {
  const state = {
    steps: [] as Array<Partial<import('../ai/schema').StepResponse>>,
    retries: [] as Array<Partial<import('../ai/schema').StepResponse>>,
    shown: [] as Array<{ via: 'step' | 'error'; message?: string; html: string }>,
    intranetServed: false,
    calls: [] as Array<{ to: string; afterIntranet: boolean; payload: string }>,
    note(to: string, payload: unknown): void {
      state.calls.push({ to, afterIntranet: state.intranetServed, payload: JSON.stringify(payload) ?? '' });
    },
  };
  return state;
});

vi.mock('../platform', () => ({
  getPlatform: () => ({
    tunnel: {
      loadTunnelContext: async (sessionId: string) => ({ sessionId, status: 'starting', tunnelRequested: true, claimed: true }),
      releaseTunnelClaim: async () => undefined,
    },
    sessionStore: {
      claimWorker: async () => true,
      assertActive: async () => undefined,
      updateStatus: async () => undefined,
      appendStep: async (_id: string, stepLog: unknown) => model.note('store.appendStep', stepLog),
      complete: async (_id: string, success: boolean, error: string | undefined, results: unknown) =>
        model.note('store.complete', { success, error, results }),
      startHeartbeat: () => () => undefined,
      flushLogs: async (_id: string, lines: unknown) => model.note('store.flushLogs', lines),
    },
    screenshots: {
      upload: async (_id: string, stepNumber: number, base64: string) => {
        model.note('screenshots.upload', { stepNumber, bytes: base64.length });
        return { path: 'unused' };
      },
    },
  }),
}));

vi.mock('../ai/request-vet', () => ({
  createRequestVet: () => async (request: unknown) => {
    model.note('request-vet', request);
    return 'read';
  },
}));

vi.mock('../ai/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ai/client')>();
  const step = (): { response: StepResponse; usage: import('../ai/client').StepResult['usage'] } => ({
    response: {
      action: 'complete', description: 'scripted', accounts: [], transactions: [], positions: [], memoryNotes: [],
      ...model.steps.shift(),
    } as StepResponse,
    usage: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
  });
  class ScriptedSession {
    getModelId(): string { return 'gemini-3-flash'; }
    getUsage() { return { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }; }
    setExtractionSummary(): void {}
    async sendStep(pageState: PageState) {
      model.shown.push({ via: 'step', html: pageState.fullHtml });
      return step();
    }
    async sendError(message: string, pageState: PageState) {
      model.shown.push({ via: 'error', message, html: pageState.fullHtml });
      model.steps = [model.retries.shift() ?? { action: 'error', message: 'scripted stop' }, ...model.steps];
      return step();
    }
  }
  return { ...actual, CrawlSession: ScriptedSession };
});

import { attachTunnelHandler, parkCrawlRequest } from './tunnel-server';
import { closeBrowser } from '../browser/browser-pool';

let bank: http.Server;
let bankPort = 0;
let engine: http.Server;
let enginePort = 0;
let sessions = 0;

/**
 * Crawl through a tunnel whose phone reports `reported[host]` for each host it opens, with the model scripted to take
 * `steps` and then complete, and to answer each action error with the next of `retries`.
 */
async function crawl(
  reported: Record<string, string>,
  steps: Array<Partial<StepResponse>>,
  declared = '',
  retries: Array<Partial<StepResponse>> = [],
): Promise<CrawlResponse> {
  const sessionId = `tunnel-navigate-${++sessions}`;
  process.env.ACCRAWL_ALLOW_PRIVATE_CRAWL_TARGETS = declared;
  model.steps = [...steps];
  model.retries = [...retries];
  model.shown = [];
  model.calls = [];
  model.intranetServed = false;
  const request: CrawlRequest = {
    sessionId,
    loginUrl: `http://bank.invalid:${bankPort}/login`,
    username: 'u',
    password: 'p',
    requires2fa: false,
    maxSteps: 5,
    timeoutSeconds: 300,
    useDeviceProxy: true,
    tunnelToken: 'unused',
  };
  const result = parkCrawlRequest(request);
  const phone = new WebSocket(`ws://127.0.0.1:${enginePort}/tunnel?sessionId=${sessionId}`, {
    headers: { Authorization: `Bearer ${signTunnelToken(deriveTunnelKey(SECRET), { sid: sessionId, did: 'device-1' })}` },
  });
  const sockets = new Map<number, net.Socket>();
  phone.on('message', (raw) => {
    const msg = JSON.parse(String(raw)) as { type: string; connId: number; host?: string; data?: string };
    if (msg.type === 'connect') {
      const socket = net.connect(bankPort, '127.0.0.1', () => {
        sockets.set(msg.connId, socket);
        phone.send(JSON.stringify({ type: 'connected', connId: msg.connId, address: reported[msg.host ?? ''] }));
      });
      socket.on('data', (chunk) => phone.send(JSON.stringify({ type: 'data', connId: msg.connId, data: chunk.toString('base64') })));
      socket.on('close', () => { if (phone.readyState === WebSocket.OPEN) phone.send(JSON.stringify({ type: 'close', connId: msg.connId })); });
      socket.on('error', () => socket.destroy());
    } else if (msg.type === 'data') {
      sockets.get(msg.connId)?.write(Buffer.from(msg.data ?? '', 'base64'));
    } else if (msg.type === 'close') {
      sockets.get(msg.connId)?.destroy();
    }
  });
  phone.on('error', () => undefined);
  try {
    return await result;
  } finally {
    for (const socket of sockets.values()) socket.destroy();
    phone.terminate();
  }
}

const navigate = (path: string, host = 'bank.invalid'): Partial<StepResponse> =>
  ({ action: 'navigate', url: `http://${host}:${bankPort}${path}`, description: `open ${path}` });
const reportAccount: Partial<StepResponse> = {
  action: 'reportData',
  description: 'report the account',
  accounts: [{ providerAccountId: 'acct-1', name: 'Everyday', description: 'Everyday', currency: 'GBP', type: 'current', balance: 1 }],
};

/**
 * The crawl ended on the refusal: once the intranet page was served nothing but the session's completion and its
 * logs went anywhere, the completion carries the refusal, and no recorded destination ever held the page.
 */
function expectRefusalEndedTheCrawl(result: CrawlResponse, refusal: RegExp): void {
  expect.soft(result).toMatchObject({ success: false, failureReason: 'internal_error' });
  expect.soft(result.error).toMatch(refusal);
  const after = model.calls.filter((call) => call.afterIntranet).map((call) => call.to);
  expect.soft(after.filter((to) => !['store.flushLogs', 'store.complete'].includes(to))).toEqual([]);
  const completion = model.calls.find((call) => call.to === 'store.complete');
  expect.soft(completion?.payload).toMatch(refusal);
  expect.soft(completion?.payload).toContain('"failureReason":"internal_error"');
  expect.soft(model.calls.filter((call) => call.payload.includes('INTRANET-ONLY')).map((call) => call.to)).toEqual([]);
  expect.soft(model.shown.some((shown) => shown.html.includes('INTRANET-ONLY'))).toBe(false);
}

describe('device-proxy crawls check the address the phone reported (real tunnel, executor, agent loop and browser)', () => {
  beforeAll(async () => {
    process.env.ENGINE_SHARED_SECRET = SECRET;
    bank = http.createServer((req, res) => {
      if (req.url === '/to-intranet') {
        res.writeHead(302, { location: `http://intranet.bank.invalid:${bankPort}/home` });
        res.end();
        return;
      }
      if (req.url === '/never.js') return;
      const intranet = (req.headers.host ?? '').startsWith('intranet.');
      if (req.method === 'POST') {
        model.note('bank.post', req.url);
        res.writeHead(204);
        res.end();
        return;
      }
      if (intranet) model.intranetServed = true;
      res.writeHead(200, { 'content-type': 'text/html' });
      if (intranet && req.url === '/stalled') {
        res.end('<h1>INTRANET-ONLY</h1><script src="/never.js"></script>');
      } else if (intranet && req.url === '/posting') {
        res.end('<h1>INTRANET-ONLY</h1><script>fetch("/transfer", { method: "POST", body: "account=INTRANET-ONLY-7" });</script>'
          + '<script src="/never.js"></script>');
      } else {
        res.end(intranet ? '<h1>INTRANET-ONLY</h1>' : `<h1>Northwind ${req.url}</h1>`);
      }
    });
    await new Promise<void>((resolve) => bank.listen(0, '127.0.0.1', resolve));
    bankPort = (bank.address() as net.AddressInfo).port;
    engine = http.createServer();
    attachTunnelHandler(engine);
    await new Promise<void>((resolve) => engine.listen(0, '127.0.0.1', resolve));
    enginePort = (engine.address() as net.AddressInfo).port;
  });

  afterAll(async () => {
    await closeBrowser();
    await new Promise<void>((resolve) => engine.close(() => resolve()));
    await new Promise<void>((resolve) => bank.close(() => resolve()));
    delete process.env.ACCRAWL_ALLOW_PRIVATE_CRAWL_TARGETS;
  });

  it('completes when the phone reached public addresses, through the first page and a navigate', async () => {
    const result = await crawl({ 'bank.invalid': '93.184.216.34' }, [navigate('/accounts'), reportAccount]);
    expect(result).toMatchObject({ success: true });
    expect(model.shown.map((s) => s.via)).toEqual(['step', 'step', 'step']);
    expect(model.shown[1].html).toContain('Northwind /accounts');
  }, 90_000);

  it('refuses the first page when the phone reached an internal address, before the model sees anything', async () => {
    const result = await crawl({ 'bank.invalid': '10.0.0.9' }, []);
    expect(result).toMatchObject({ success: false, failureReason: 'internal_error' });
    expect(result.error).toMatch(/bank\.invalid -> 10\.0\.0\.9/);
    expect(model.shown).toEqual([]);
  }, 90_000);

  it('ends the crawl on a navigate to a host the phone reached at an internal address, before the model sees it', async () => {
    const reported = { 'bank.invalid': '93.184.216.34', 'intranet.bank.invalid': '10.0.0.5' };
    const result = await crawl(reported, [navigate('/home', 'intranet.bank.invalid')]);
    expectRefusalEndedTheCrawl(result, /intranet\.bank\.invalid -> 10\.0\.0\.5/);
    expect(model.shown.map((s) => s.via)).toEqual(['step']);
  }, 90_000);

  it('ends the crawl on a recovery retry the phone reached at an internal address, before the model sees it', async () => {
    const reported = { 'bank.invalid': '93.184.216.34', 'intranet.bank.invalid': '10.0.0.5' };
    const result = await crawl(
      reported,
      [{ action: 'navigate', url: 'statements', description: 'open statements' }],
      '',
      [navigate('/home', 'intranet.bank.invalid')],
    );
    expectRefusalEndedTheCrawl(result, /intranet\.bank\.invalid -> 10\.0\.0\.5/);
    expect(model.shown.map((s) => s.via)).toEqual(['step', 'error']);
  }, 90_000);

  it('ends the crawl at the refusal on a page the phone reached internally that never finishes loading', async () => {
    const reported = { 'bank.invalid': '93.184.216.34', 'intranet.bank.invalid': '10.0.0.5' };
    const result = await crawl(reported, [navigate('/stalled', 'intranet.bank.invalid')]);
    expectRefusalEndedTheCrawl(result, /intranet\.bank\.invalid -> 10\.0\.0\.5/);
    expect(model.shown.map((s) => s.via)).toEqual(['step']);
  }, 90_000);

  it('never classifies or sends what a page the phone reached internally posts while loading, after login', async () => {
    const reported = { 'bank.invalid': '93.184.216.34', 'intranet.bank.invalid': '10.0.0.5' };
    const loginComplete: Partial<StepResponse> = { action: 'loginComplete', description: 'signed in' };
    const result = await crawl(reported, [loginComplete, navigate('/posting', 'intranet.bank.invalid')]);
    expectRefusalEndedTheCrawl(result, /intranet\.bank\.invalid -> 10\.0\.0\.5/);
    expect(model.calls.filter((call) => call.to === 'request-vet' || call.to === 'bank.post')).toEqual([]);
  }, 90_000);

  it('follows a navigate redirected to a declared host', async () => {
    const reported = { 'bank.invalid': '93.184.216.34', 'intranet.bank.invalid': '10.0.0.5' };
    const result = await crawl(reported, [navigate('/to-intranet'), reportAccount], 'intranet.bank.invalid');
    expect(result).toMatchObject({ success: true });
    expect(model.shown[1].html).toContain('INTRANET-ONLY');
  }, 90_000);

  it('ends the crawl on a navigate redirected from a declared host to an undeclared internal one, unseen', async () => {
    const reported = { 'bank.invalid': '10.0.0.4', 'intranet.bank.invalid': '10.0.0.5' };
    const result = await crawl(reported, [navigate('/to-intranet')], 'bank.invalid');
    expectRefusalEndedTheCrawl(result, /intranet\.bank\.invalid -> 10\.0\.0\.5/);
    expect(model.shown.map((s) => s.via)).toEqual(['step']);
  }, 90_000);
});
