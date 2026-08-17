import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { ImapFlow } from 'imapflow';
import { pollEmailOtpOnce } from './watcher';
import type { Db } from '../db/client';

// Validates the watcher's REAL IMAP read path (connect → search UNSEEN → fetch → MIME-parse → \Seen) against a
// live greenmail IMAP server. We inject the message via IMAP APPEND (the watcher only READS IMAP; SMTP→mailbox
// delivery is greenmail's concern, not the watcher's, and its user-resolution is fiddly). The ROUTER is mocked
// here — its logic + the LLM extraction are unit-tested in route-email.test.ts / the submitOtpFromSms tests;
// this proves only the wire+parse layer those can't.
//
// The package test command runs this Docker-backed integration test after the
// parallel unit suite so the JVM does not contend with dozens of test workers.

// Resolved from PATH: an absolute package-manager prefix is one machine's layout, not a
// requirement. DOCKER_BIN still overrides for an install that is not on PATH.
const DOCKER = process.env.DOCKER_BIN || 'docker';
const CONTAINER = `accrawl-greenmail-otptest-${process.pid}`;
const GREENMAIL_IMAGE =
  'greenmail/standalone:2.1.12@sha256:9f32971b4f25d32b4de6fa2e297423768441c65e4541f6aecd7631c890a229a7';
const AUTH = { user: 'otpuser', pass: 'otppass' };
let imapPort = 0;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait until greenmail's IMAP is fully ready — a real imapflow connect+logout, not just a bound TCP port (the
 *  port binds before the protocol handler is up, which caused "Unexpected close" on early connects). */
async function imapReady(): Promise<boolean> {
  for (let i = 0; i < 60; i++) {
    try {
      const c = new ImapFlow({ host: '127.0.0.1', port: imapPort, secure: false, auth: AUTH, logger: false, connectionTimeout: 3000, greetingTimeout: 3000 });
      await c.connect();
      await c.logout();
      return true;
    } catch { await sleep(500); }
  }
  return false;
}

const rawEmail = (from: string, subject: string, body: string): Buffer =>
  Buffer.from([`From: ${from}`, `To: otpuser@localhost`, `Subject: ${subject}`, 'Content-Type: text/plain; charset=utf-8', '', body].join('\r\n'));

async function appendToInbox(msg: Buffer): Promise<void> {
  const c = new ImapFlow({ host: '127.0.0.1', port: imapPort, secure: false, auth: AUTH, logger: false, connectionTimeout: 5000, greetingTimeout: 5000 });
  await c.connect();
  await c.append('INBOX', msg, []); // no flags → UNSEEN
  await c.logout();
}

/** Set once beforeAll has a live container; false means the test reports SKIPPED rather than passing. */
let greenmailReady = false;

describe('email-OTP watcher — real IMAP via greenmail', () => {
  beforeAll(async () => {
    // A contributor with no container runtime still gets the rest of the suite, and this test
    // reports as skipped rather than passing. A runtime that EXISTS but refuses is a different
    // thing — a broken or stopped daemon — and is surfaced as a failure, because silently
    // dropping the integration test is how a release loses coverage without anyone noticing.
    try {
      execFileSync(DOCKER, ['info'], { stdio: 'ignore' });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error(
          `"${DOCKER} info" failed, so the real-IMAP integration test cannot run. The runtime is ` +
            `installed but not usable — start it, or fix its permissions. (${(e as Error).message})`,
        );
      }
      console.warn(
        `[watcher.greenmail.test] SKIPPING the real-IMAP integration test: no "${DOCKER}" ` +
          'executable found, so there is no container runtime. Set DOCKER_BIN if yours is not on PATH.',
      );
      return;
    }
    const r = spawnSync(DOCKER, [
      'run', '--rm', '-d', '--name', CONTAINER,
      '-p', '127.0.0.1::3143',
      '-e', `GREENMAIL_OPTS=-Dgreenmail.setup.test.all -Dgreenmail.hostname=0.0.0.0 -Dgreenmail.users=${AUTH.user}:${AUTH.pass}`,
      GREENMAIL_IMAGE,
    ], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`greenmail start failed: ${r.stderr || r.stdout}`);
    const published = execFileSync(
      DOCKER,
      ['port', CONTAINER, '3143/tcp'],
      { encoding: 'utf8' },
    ).trim();
    const port = Number.parseInt(published.match(/:(\d+)$/u)?.[1] ?? '', 10);
    if (!Number.isInteger(port) || port <= 0) {
      throw new Error(`greenmail did not publish an IMAP port: ${published}`);
    }
    imapPort = port;
    if (!(await imapReady())) throw new Error('greenmail IMAP never became ready');
    greenmailReady = true;
  }, 60_000);

  afterAll(() => { spawnSync(DOCKER, ['rm', '-f', CONTAINER], { stdio: 'ignore' }); });

  it('fetches an UNSEEN email, MIME-parses from/subject/text, routes it, and marks it \\Seen', async (ctx) => {
    // Reports as SKIPPED, not passed: this asserts a real IMAP wire path and cannot run without the server.
    if (!greenmailReady) ctx.skip();
    await appendToInbox(rawEmail('noreply@northwind-bank.com', 'Your verification code', 'Northwind Bank: your verification code is 246810. It expires in 5 minutes.'));

    const route = vi.fn(async () => ({ action: 'submitted' as const, sessionId: 's1', result: { status: 'accepted' as const } }));
    const cfg = { host: '127.0.0.1', port: imapPort, secure: false, user: AUTH.user, pass: AUTH.pass, folder: 'INBOX' };

    const summary = await pollEmailOtpOnce({} as Db, cfg, { route });
    expect(summary.processed).toBe(1);
    expect(summary.submitted).toBe(1);
    // The wire+parse layer handed the router exactly the sender ADDRESS, the subject, and the plaintext body.
    expect(route).toHaveBeenCalledWith(expect.anything(), {
      from: 'noreply@northwind-bank.com',
      subject: 'Your verification code',
      text: expect.stringContaining('246810'),
    });

    // A second poll finds nothing — the message was marked \Seen (no reprocessing).
    const again = await pollEmailOtpOnce({} as Db, cfg, { route });
    expect(again.processed).toBe(0);
    expect(route).toHaveBeenCalledTimes(1);
  }, 30_000);
});
