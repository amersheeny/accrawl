/**
 * A navigation refused for the address it reached ends the crawl, and nothing the refused page holds or does reaches
 * anywhere after the refusal: the real crawl executor, agent loop, error recovery, navigate action, egress guard,
 * write gate, request classifier, download tracker and Chrome. Chrome resolves both hosts to the local server and only
 * the bank's host is declared, so the check refuses the intranet host. Replaced, and recorded with whether the refused
 * page had been served or the context sealed yet: the platform's database-backed services, the model, the classifier's
 * Gemini client, and every POST, WebSocket and WebSocket message the server receives.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import { WebSocketServer } from 'ws';
import type { BrowserContext } from 'playwright';
import type { CrawlRequest, CrawlResponse, PageState } from '../types';
import type { StepResponse } from '../ai/schema';
import { sealContext } from '../browser/context-seal';

// Read once when the agent loop loads, so it has to be set before the imports below run.
vi.hoisted(() => { process.env.INITIAL_NAV_TIMEOUT_MS = '3000'; });

const rec = vi.hoisted(() => {
  const state = {
    steps: [] as Array<Partial<import('../ai/schema').StepResponse>>,
    retries: [] as Array<Partial<import('../ai/schema').StepResponse>>,
    context: undefined as import('playwright').BrowserContext | undefined,
    seal: (() => undefined) as () => void,
    vet: 'read' as 'read' | 'seal-then-read' | 'seal-then-fail',
    refusedPageServed: false,
    sealed: false,
    contextClosed: false,
    calls: [] as Array<{
      to: string; afterRefusedPage: boolean; afterSeal: boolean; contextClosed: boolean; payload: string;
    }>,
    note(to: string, payload: unknown): void {
      state.calls.push({
        to,
        afterRefusedPage: state.refusedPageServed,
        afterSeal: state.sealed,
        contextClosed: state.contextClosed,
        payload: JSON.stringify(payload) ?? '',
      });
    },
  };
  return state;
});

vi.mock('../platform', () => ({
  getPlatform: () => ({
    sessionStore: {
      claimWorker: async () => true,
      assertActive: async () => undefined,
      updateStatus: async (_id: string, status: string, currentStep: string) =>
        rec.note('store.updateStatus', { status, currentStep }),
      appendStep: async (_id: string, stepLog: unknown) => rec.note('store.appendStep', stepLog),
      complete: async (_id: string, success: boolean, error: string | undefined, results: unknown) =>
        rec.note('store.complete', { success, error, results }),
      startHeartbeat: () => () => undefined,
      flushLogs: async (_id: string, lines: unknown) => {
        rec.note('store.flushLogs', lines);
        // A store write takes real time; the refused page has to be gone while it runs, not only once it returns.
        await new Promise((resolve) => setTimeout(resolve, 2_500));
      },
    },
    screenshots: {
      upload: async (_id: string, stepNumber: number, base64: string) => {
        rec.note('screenshots.upload', { stepNumber, bytes: base64.length });
        return { path: 'unused' };
      },
    },
  }),
}));

vi.mock('../browser/browser-pool', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../browser/browser-pool')>();
  return {
    ...actual,
    createContext: async (...args: Parameters<typeof actual.createContext>) => {
      rec.context = await actual.createContext(...args);
      rec.contextClosed = false;
      rec.context.on('close', () => { rec.contextClosed = true; });
      return rec.context;
    },
  };
});

vi.mock('../ai/providers/gemini', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ai/providers/gemini')>();
  return {
    ...actual,
    getClient: () => ({
      models: {
        generateContent: async (params: { contents: unknown }) => {
          rec.note('request-vet', params.contents);
          if (rec.vet !== 'read') rec.seal();
          if (rec.vet === 'seal-then-fail') throw new Error('classifier unavailable');
          return { text: '"read"' };
        },
      },
    }),
  };
});

vi.mock('../ai/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ai/client')>();
  const reply = (next: Partial<StepResponse> | undefined) => ({
    response: {
      action: 'error', message: 'script exhausted', description: 'scripted', accounts: [], transactions: [],
      positions: [], memoryNotes: [], ...next,
    } as StepResponse,
    usage: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
  });
  class ScriptedSession {
    getModelId(): string { return 'gemini-3-flash'; }
    getUsage() { return { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }; }
    setExtractionSummary(): void {}
    async sendStep(pageState: PageState) {
      rec.note('model.step', { url: pageState.url, html: pageState.fullHtml });
      return reply(rec.steps.shift());
    }
    async sendError(message: string, pageState: PageState) {
      rec.note('model.error', { message, url: pageState.url, html: pageState.fullHtml });
      return reply(rec.retries.shift());
    }
  }
  return { ...actual, CrawlSession: ScriptedSession };
});

import { executeCrawl } from '../crawl-executor';
import { closeBrowser } from '../browser/browser-pool';

let bank: http.Server;
let sockets: WebSocketServer;
let port = 0;
let sessions = 0;

const REFUSED_PAGE = `<!doctype html><title>INTRANET-ONLY</title><h1>INTRANET-ONLY payroll</h1>
<script>
  setTimeout(() => fetch('/transfer', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'account=INTRANET-ONLY-7&amount=5',
  }), 1000);
</script>`;

// A script the server never answers keeps DOMContentLoaded from ever firing.
const STALLED = '<script src="/never.js"></script>';
const INTRANET_PAGES: Record<string, string> = {
  '/payroll-stalled': `<!doctype html><title>INTRANET-ONLY</title><h1>INTRANET-ONLY payroll</h1>${STALLED}`,
  '/payroll-posting': `<!doctype html><title>INTRANET-ONLY</title><script>
  fetch('/transfer', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'account=INTRANET-ONLY-7&amount=5',
  });
</script>${STALLED}`,
};
const stalled: http.ServerResponse[] = [];

// The marker is assembled in the page, so the page's own source never contains it.
const SEALED = 'SEALED-ONLY';
const MARK = `const m = ['SEALED', 'ONLY'].join('-');`;
const post = `fetch('/transfer-' + m, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'account=' + m,
  })`;
const SEAL_PAGES: Record<string, string> = {
  '/post-after-seal': `<script>${MARK} fetch('/seal').then(() => ${post});</script>`,
  '/post-during-vet': `<script>${MARK} ${post};</script>`,
  '/download-after-seal': `<script>location.href = '/sealing-download';</script>`,
  '/popup-after-seal': `<script>${MARK} window.open('/popup-' + m);</script>`,
  [`/popup-${SEALED}`]: `<script src="/sealing-script.js"></script><p>popup</p>`,
  '/websocket-after-seal': `<script>${MARK} fetch('/seal').then(() => new WebSocket('ws://' + location.host + '/ws-' + m));</script>`,
  '/websocket-before-seal': `<script>${MARK} const ws = new WebSocket('ws://' + location.host + '/ws-open');
  ws.onopen = () => { ws.send('before-seal'); fetch('/seal').then(() => ws.send('after-' + m)); };</script>`,
};

async function crawl(
  startHost: string,
  steps: Array<Partial<StepResponse>>,
  retries: Array<Partial<StepResponse>> = [],
  vet: typeof rec.vet = 'read',
  loginPath = '/login',
): Promise<CrawlResponse> {
  rec.steps = [...steps];
  rec.retries = [...retries];
  rec.calls = [];
  rec.refusedPageServed = false;
  rec.sealed = false;
  rec.vet = vet;
  const request: CrawlRequest = {
    sessionId: `refused-navigation-${++sessions}`,
    loginUrl: `http://${startHost}:${port}${loginPath}`,
    username: 'u',
    password: 'p',
    requires2fa: false,
    maxSteps: 6,
    timeoutSeconds: 300,
  };
  const result = await executeCrawl(request);
  // Anything the refused page scheduled has had time to fire by now if it still could.
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  return result;
}

const navigateTo = (url: string): Partial<StepResponse> => ({ action: 'navigate', url, description: `open ${url}` });
const navigateToIntranet = (): Partial<StepResponse> => navigateTo(`http://intranet.bank.invalid:${port}/payroll`);
const onBank = (path: string): Partial<StepResponse> => navigateTo(`http://bank.invalid:${port}${path}`);
const loginComplete: Partial<StepResponse> = { action: 'loginComplete', description: 'signed in' };
const complete: Partial<StepResponse> = { action: 'complete', description: 'done' };
const reportAccount: Partial<StepResponse> = {
  action: 'reportData',
  description: 'report the account',
  accounts: [{ providerAccountId: 'acct-1', name: 'Everyday', description: 'Everyday', currency: 'GBP', type: 'current', balance: 1 }],
};

function expectRefusalWasTheEnd(result: CrawlResponse): void {
  expect.soft(result).toMatchObject({ success: false, failureReason: 'internal_error' });
  expect.soft(result.error).toMatch(/intranet\.bank\.invalid -> 127\.0\.0\.1/);
  const after = rec.calls.filter((call) => call.afterRefusedPage);
  expect.soft(after.map((call) => call.to).filter((to) => !['store.flushLogs', 'store.complete'].includes(to)))
    .toEqual([]);
  const failureWrite = rec.calls.find((call) => call.to === 'store.flushLogs' && call.payload.includes('Crawl failed at step'));
  expect.soft(failureWrite?.contextClosed, 'browser closed before the failure was written').toBe(true);
  const completion = after.find((call) => call.to === 'store.complete');
  expect.soft(completion?.payload).toMatch(/intranet\.bank\.invalid -> 127\.0\.0\.1/);
  expect.soft(completion?.payload).toContain('"failureReason":"internal_error"');
  expect.soft(rec.calls.filter((call) => call.payload.includes('INTRANET-ONLY')).map((call) => call.to)).toEqual([]);
}

function expectNothingAfterTheSeal(): void {
  expect.soft(rec.sealed).toBe(true);
  expect.soft(rec.calls.filter((call) => call.afterSeal && call.payload.includes(SEALED)).map((call) => call.to))
    .toEqual([]);
  expect.soft(rec.calls.filter((call) => call.afterSeal
    && ['bank.post', 'bank.websocket', 'bank.websocket.message', 'request-vet'].includes(call.to))
    .map((call) => call.to)).toEqual([]);
}

beforeAll(async () => {
  bank = http.createServer((req, res) => {
    const intranet = (req.headers.host ?? '').startsWith('intranet.');
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', () => {
        rec.note('bank.post', { host: req.headers.host, path: req.url, body });
        res.writeHead(204);
        res.end();
      });
      return;
    }
    if (intranet) rec.refusedPageServed = true;
    const path = req.url ?? '';
    if (path === '/never.js') {
      stalled.push(res);
      return;
    }
    if (path === '/payroll-late') {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(INTRANET_PAGES['/payroll-posting']);
      }, 4_500);
      return;
    }
    if (path === '/seal' || path === '/sealing-download' || path === '/sealing-script.js') rec.seal();
    if (path === '/seal') {
      res.writeHead(204);
      res.end();
    } else if (path === '/sealing-download') {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename="${SEALED}.xlsx"` });
      res.end('not a workbook');
    } else if (path === '/sealing-script.js') {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'text/javascript' });
        res.end('');
      }, 300);
    } else {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(intranet
        ? INTRANET_PAGES[path] ?? REFUSED_PAGE
        : `<!doctype html><title>Northwind</title><h1>Northwind ${path}</h1>${SEAL_PAGES[path] ?? ''}`);
    }
  });
  sockets = new WebSocketServer({ noServer: true });
  bank.on('upgrade', (req, socket: net.Socket, head: Buffer) => {
    rec.note('bank.websocket', { path: req.url });
    if (req.url !== '/ws-open') {
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(req, socket, head, (ws) => {
      ws.on('message', (data) => rec.note('bank.websocket.message', String(data)));
    });
  });
  await new Promise<void>((resolve) => bank.listen(0, '127.0.0.1', resolve));
  port = (bank.address() as net.AddressInfo).port;
  process.env.EXTRA_CHROMIUM_ARGS = '--host-resolver-rules=MAP bank.invalid 127.0.0.1, MAP intranet.bank.invalid 127.0.0.1';
  process.env.ACCRAWL_ALLOW_PRIVATE_CRAWL_TARGETS = 'bank.invalid';
  rec.seal = () => {
    rec.sealed = true;
    if (rec.context) sealContext(rec.context as BrowserContext);
  };
});

afterAll(async () => {
  await closeBrowser();
  for (const res of stalled) res.destroy();
  await new Promise<void>((resolve) => sockets.close(() => resolve()));
  bank.closeAllConnections();
  await new Promise<void>((resolve) => bank.close(() => resolve()));
  delete process.env.ACCRAWL_ALLOW_PRIVATE_CRAWL_TARGETS;
  delete process.env.EXTRA_CHROMIUM_ARGS;
  delete process.env.INITIAL_NAV_TIMEOUT_MS;
});

describe('a navigation refused for the address it reached ends the crawl there (real executor, loop and browser)', () => {
  it('a refused first page is closed before its scripts can send anything', async () => {
    expectRefusalWasTheEnd(await crawl('intranet.bank.invalid', []));
  }, 120_000);

  it('a refused navigate during login ends the crawl and the page never reaches the model, a step log or the bank', async () => {
    const result = await crawl('bank.invalid', [navigateToIntranet()]);
    expectRefusalWasTheEnd(result);
    expect(rec.calls.some((call) => call.to === 'model.step' && call.payload.includes('Northwind /login'))).toBe(true);
  }, 120_000);

  it('a refused navigate after login is closed before its delayed POST reaches the request classifier', async () => {
    const result = await crawl('bank.invalid', [loginComplete, navigateToIntranet()]);
    expectRefusalWasTheEnd(result);
  }, 120_000);

  it('a refused first page that never finishes loading ends the crawl at the refusal, not at a timeout', async () => {
    expectRefusalWasTheEnd(await crawl('intranet.bank.invalid', [], [], 'read', '/payroll-stalled'));
  }, 120_000);

  it('a first page whose response arrives after its navigation timed out never commits or sends anything', async () => {
    const result = await crawl('intranet.bank.invalid', [], [], 'read', '/payroll-late');
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    expect.soft(result).toMatchObject({ success: false, failureReason: 'navigation_timeout' });
    expect.soft(rec.calls.filter((call) => call.to === 'bank.post').map((call) => call.payload)).toEqual([]);
    expect.soft(rec.calls.filter((call) => call.payload.includes('INTRANET-ONLY')).map((call) => call.to)).toEqual([]);
  }, 120_000);

  it('a refused first page that posts while it is still loading sends nothing to its host', async () => {
    expectRefusalWasTheEnd(await crawl('intranet.bank.invalid', [], [], 'read', '/payroll-posting'));
  }, 120_000);

  it('a refused navigate whose page never finishes loading ends the crawl before recovery can capture it', async () => {
    const result = await crawl('bank.invalid', [loginComplete, navigateTo(`http://intranet.bank.invalid:${port}/payroll-stalled`)]);
    expectRefusalWasTheEnd(result);
  }, 120_000);

  it('a refused page that posts while it is still loading never has the post classified', async () => {
    const result = await crawl('bank.invalid', [loginComplete, navigateTo(`http://intranet.bank.invalid:${port}/payroll-posting`)]);
    expectRefusalWasTheEnd(result);
  }, 120_000);

  it('a refused recovery retry ends the crawl instead of carrying on to the next step', async () => {
    const result = await crawl('bank.invalid', [navigateTo('statements')], [navigateToIntranet()]);
    expectRefusalWasTheEnd(result);
    expect(rec.calls.some((call) => call.to === 'model.error' && !call.afterRefusedPage)).toBe(true);
  }, 120_000);

  it('a navigate the name check refuses before loading anything stays recoverable', async () => {
    const result = await crawl('bank.invalid', [navigateTo('http://10.0.0.5/'), reportAccount, complete], [onBank('/accounts')]);
    expect(result).toMatchObject({ success: true });
    const refusal = rec.calls.find((call) => call.to === 'model.error');
    expect(refusal?.payload).toMatch(/private\/internal address/);
    expect(rec.calls.some((call) => call.to === 'model.step' && call.payload.includes('Northwind /accounts'))).toBe(true);
  }, 120_000);
});

describe('once a context is sealed, nothing its page does reaches the classifier, a log or the network', () => {
  it('a POST raised after the seal is aborted without being classified or logged', async () => {
    await crawl('bank.invalid', [loginComplete, onBank('/post-after-seal'), complete]);
    expectNothingAfterTheSeal();
  }, 120_000);

  it('a POST whose classification is in flight when the seal lands is neither sent nor logged', async () => {
    await crawl('bank.invalid', [loginComplete, onBank('/post-during-vet'), complete], [], 'seal-then-read');
    expect(rec.calls.some((call) => call.to === 'request-vet' && !call.afterSeal)).toBe(true);
    expectNothingAfterTheSeal();
  }, 120_000);

  it('a POST whose classification fails after the seal is denied without logging the request', async () => {
    await crawl('bank.invalid', [loginComplete, onBank('/post-during-vet'), complete], [], 'seal-then-fail');
    expect(rec.calls.some((call) => call.to === 'request-vet' && !call.afterSeal)).toBe(true);
    expectNothingAfterTheSeal();
  }, 120_000);

  it('a download that starts after the seal is neither logged nor kept', async () => {
    await crawl('bank.invalid', [onBank('/download-after-seal'), complete]);
    expectNothingAfterTheSeal();
  }, 120_000);

  it('a popup that finishes loading after the seal is neither logged nor followed', async () => {
    await crawl('bank.invalid', [onBank('/popup-after-seal'), complete]);
    expectNothingAfterTheSeal();
  }, 120_000);

  it('a WebSocket opened after the seal is closed before it connects', async () => {
    await crawl('bank.invalid', [onBank('/websocket-after-seal'), complete]);
    expectNothingAfterTheSeal();
  }, 120_000);

  it('a WebSocket connected before the seal forwards nothing sent after it', async () => {
    await crawl('bank.invalid', [onBank('/websocket-before-seal'), complete]);
    expect(rec.calls.some((call) => call.to === 'bank.websocket.message' && call.payload.includes('before-seal')))
      .toBe(true);
    expectNothingAfterTheSeal();
  }, 120_000);
});
