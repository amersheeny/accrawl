/**
 * The navigate action through a phone's tunnel, in a real browser. Chromium reaches the bank only through the
 * engine's own SOCKS5 relay, so the address check has to read what the phone reported reaching.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import { chromium, type Browser } from 'playwright';
import { executeAction } from './actions';
import { createSocks5Server, type Socks5Server } from '../tunnel/socks5-server';
import { markTunnelled } from '../browser/tunnel-peers';

const NO_CREDS = { username: '', password: '' };

describe('navigate through a phone tunnel (browser)', () => {
  let browser: Browser | undefined;
  let bank: http.Server | undefined;
  let relay: Socks5Server | undefined;
  let url = '';

  beforeAll(async () => {
    bank = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<h1>Northwind</h1>');
    });
    await new Promise<void>((resolve) => bank!.listen(0, '127.0.0.1', resolve));
    const bankPort = (bank.address() as net.AddressInfo).port;
    // Stands in for the phone: whatever host the browser asks for is opened on the local bank.
    relay = await createSocks5Server();
    relay.onConnect((conn) => {
      const upstream = net.connect(bankPort, '127.0.0.1', () => {
        conn.socket.pipe(upstream);
        upstream.pipe(conn.socket);
        conn.sendSuccess();
      });
      upstream.on('error', () => conn.socket.destroy());
    });
    // .invalid never resolves, so the name check before navigation passes and only the address check decides.
    url = `http://bank.invalid:${bankPort}/`;

    const failures: string[] = [];
    for (const options of [{ channel: 'chrome' as const, args: ['--no-sandbox'] }, { args: ['--no-sandbox'] }]) {
      try {
        browser = await chromium.launch(options);
        return;
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
    }
    throw new Error(`these tests need Chrome or Playwright's Chromium, and neither launched:\n${failures.join('\n')}`);
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await relay?.close();
    bank?.close();
  });

  async function navigateWithPhoneReporting(addresses: string[]) {
    const context = await browser!.newContext({ proxy: { server: `socks5://127.0.0.1:${relay!.port}` } });
    markTunnelled(context, () => addresses);
    try {
      return await executeAction(await context.newPage(), { action: 'navigate', url } as never, NO_CREDS);
    } finally {
      await context.close();
    }
  }

  it('navigates when the phone reached a public address', async () => {
    await expect(navigateWithPhoneReporting(['93.184.216.34'])).resolves.toMatchObject({ status: 'success' });
  }, 60_000);

  it('refuses when the phone reached an internal address', async () => {
    await expect(navigateWithPhoneReporting(['10.0.0.5'])).rejects.toThrow(/bank\.invalid -> 10\.0\.0\.5/);
  }, 60_000);
});
