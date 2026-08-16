/**
 * Strict-TLS regression guard (security). The crawl agent types real bank credentials, so createContext must
 * REJECT an untrusted/forged TLS cert, not silently accept it. This is critical for device-proxy (tunnel)
 * crawls: egress exits through the operator's phone, and a malicious/compromised relay could point the SOCKS5
 * CONNECT at an attacker host and present a self-signed cert for the bank domain — with cert validation off
 * (the old `ignoreHTTPSErrors: true`), Chromium would accept it and hand over the credentials. This test stands
 * up a self-signed HTTPS endpoint and asserts the SHIPPED createContext refuses to load it (it would LOAD under
 * the old setting — a real fail-before / pass-after). Skips gracefully without openssl / a Chromium binary.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createServer as createHttpsServer, type Server } from 'node:https';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContext, closeBrowser } from './browser-pool';

describe('createContext — strict TLS rejects a forged/self-signed cert (tunnel-MITM defense)', () => {
  let available = false;
  let dir = '';
  let server: Server | undefined;
  let port = 0;

  beforeAll(async () => {
    try {
      dir = mkdtempSync(join(tmpdir(), 'accrawl-tls-'));
      const key = join(dir, 'k.pem');
      const cert = join(dir, 'c.pem');
      execFileSync(
        'openssl',
        ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=bank.example'],
        { stdio: 'ignore' },
      );
      server = createHttpsServer({ key: readFileSync(key), cert: readFileSync(cert) }, (_req, res) => res.end('secret-bank-page'));
      await new Promise<void>((resolve, reject) => {
        server!.once('error', reject);
        server!.listen(0, '127.0.0.1', () => resolve());
      });
      port = (server!.address() as { port: number }).port;
      // Prove the engine browser can launch here; otherwise SKIP (don't fail) the security assertion.
      const probe = await createContext();
      await probe.close();
      available = true;
    } catch (e) {
      console.warn('[browser-pool.tls.browser.test] openssl/https/chromium unavailable — skipping:', (e as Error).message);
    }
  }, 60000);

  afterAll(async () => {
    server?.close();
    if (dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } }
    await closeBrowser().catch(() => {});
  });

  it('a self-signed HTTPS endpoint is REJECTED (it would LOAD under ignoreHTTPSErrors:true)', async () => {
    if (!available) return;
    const ctx = await createContext();
    try {
      const page = await ctx.newPage();
      await expect(page.goto(`https://127.0.0.1:${port}/`, { timeout: 15000 })).rejects.toThrow();
    } finally {
      await ctx.close();
    }
  }, 30000);
});
