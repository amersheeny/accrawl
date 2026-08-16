/**
 * Email-OTP IMAP watcher (tier-b 2FA). Polls the operator's configured inbox for UNSEEN messages and routes
 * each to an awaiting crawl session via routeEmailToAwaitingSession (which reuses the SMS relay's server-side
 * sender-binding + LLM extraction). Config-gated: does nothing unless an ENABLED email-OTP config is set.
 *
 * pollEmailOtpOnce is the testable unit (injectable ImapFlow ctor + router) — validated against a real
 * greenmail SMTP+IMAP server. startEmailOtpWatcher is the lifecycle loop: it re-reads the (live) config each
 * tick so an operator's enable/disable/update takes effect without a restart, and a poll error is logged +
 * retried next tick — a flaky mailbox never crashes the control-plane.
 */
import { ImapFlow, type ImapFlowOptions } from 'imapflow';
import { simpleParser } from 'mailparser';
import type { Db } from '../db/client';
import { routeEmailToAwaitingSession, type EmailRouteOutcome, type IncomingEmail } from './route-email';
import {
  getEmailOtpConfigWithPassword,
  type EmailOtpConfigWithPassword,
} from '../data/email-otp-config';

export interface EmailPollConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  folder: string;
}

export interface PollDeps {
  ImapFlowCtor?: typeof ImapFlow;
  route?: (db: Db, email: IncomingEmail) => Promise<EmailRouteOutcome>;
  log?: (msg: string) => void;
}

export interface PollSummary {
  processed: number;
  submitted: number;
  skipped: number;
}

/** One IMAP poll: connect, fetch UNSEEN messages, route each to an awaiting session, mark each \Seen. */
export async function pollEmailOtpOnce(db: Db, cfg: EmailPollConfig, deps: PollDeps = {}): Promise<PollSummary> {
  const Ctor = deps.ImapFlowCtor ?? ImapFlow;
  const route = deps.route ?? routeEmailToAwaitingSession;
  const log = deps.log ?? (() => {});
  const client = new Ctor({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.pass },
    logger: false,
    // Fail fast rather than hang the poll loop on a stuck/unreachable mailbox — the tick logs + retries.
    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
    socketTimeout: 60_000,
  } as ImapFlowOptions);

  const summary: PollSummary = { processed: 0, submitted: 0, skipped: 0 };
  await client.connect();
  try {
    const lock = await client.getMailboxLock(cfg.folder);
    try {
      const uids = (await client.search({ seen: false }, { uid: true })) || [];
      // Process one UID at a time with DISCRETE commands (fetchOne, then the STORE): imapflow runs one command
      // per connection, so issuing messageFlagsAdd WHILE a streaming `for await (client.fetch(...))` iterator is
      // still open deadlocks the connection. fetchOne completes before we mark \Seen, avoiding that.
      for (const uid of uids) {
        const msg = await client.fetchOne(uid, { uid: true, source: true }, { uid: true });
        if (!msg || !msg.source) continue;
        summary.processed++;
        const parsed = await simpleParser(msg.source as Buffer);
        const from = parsed.from?.value?.[0]?.address ?? '';
        const outcome = await route(db, { from, subject: parsed.subject ?? '', text: parsed.text ?? '' });
        if (outcome.action === 'submitted' && outcome.result.status === 'accepted') {
          summary.submitted++;
          log(`email-otp: submitted OTP for session ${outcome.sessionId}`);
        } else {
          summary.skipped++;
          log(`email-otp: skipped (${outcome.action === 'skipped' ? outcome.reason : `submit -> ${outcome.result.status}`})`);
        }
        // Mark \Seen so the next poll never reprocesses it — including a non-matching email (it won't suddenly
        // start matching, and leaving it UNSEEN would re-route it every tick).
        await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
  return summary;
}

export interface WatcherHandle {
  stop: () => Promise<void>;
}

export interface WatcherLease {
  isHeld: () => Promise<boolean>;
  release: () => Promise<void>;
}

export interface WatcherOptions {
  pollMs?: number;
  log?: (msg: string) => void;
  getConfig?: (db: Db) => Promise<EmailOtpConfigWithPassword | null>;
  poll?: (
    db: Db,
    config: EmailPollConfig,
    deps: Pick<PollDeps, 'log'>,
  ) => Promise<PollSummary>;
  tryAcquireLease?: () => Promise<WatcherLease | null>;
}

/**
 * Start the email-OTP poll loop. Each tick re-reads the live config, so enabling,
 * disabling, updating, or deleting it takes effect without a process restart.
 * Hosted replicas supply a session-scoped PostgreSQL lease; exactly one replica
 * polls while standbys keep trying to acquire leadership after a failure.
 */
export async function startEmailOtpWatcher(
  db: Db,
  opts: WatcherOptions = {},
): Promise<WatcherHandle> {
  const pollMs = opts.pollMs ?? 5000;
  const log = opts.log ?? ((m: string) => console.log(m));
  const getConfig = opts.getConfig ?? getEmailOtpConfigWithPassword;
  const poll = opts.poll ?? pollEmailOtpOnce;

  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let lease: WatcherLease | null = null;
  let currentTick: Promise<void> | null = null;

  const releaseLease = async (): Promise<void> => {
    const activeLease = lease;
    lease = null;
    if (activeLease) await activeLease.release();
  };

  async function runTick(): Promise<void> {
    if (stopped) return;
    try {
      const live = await getConfig(db);
      if (!live?.enabled) {
        await releaseLease();
        return;
      }

      if (lease && !(await lease.isHeld())) await releaseLease();
      if (!lease && opts.tryAcquireLease) {
        lease = await opts.tryAcquireLease();
        if (!lease) return;
      }

      await poll(
        db,
        {
          host: live.host,
          port: live.port,
          secure: live.secure,
          user: live.username,
          pass: live.password,
          folder: live.folder,
        },
        { log },
      );
    } catch (err) {
      log(`email-otp watcher poll failed (will retry): ${err instanceof Error ? err.message : err}`);
    }
  }

  const launch = (): void => {
    if (stopped || currentTick) return;
    currentTick = runTick().finally(() => {
      currentTick = null;
      if (!stopped) timer = setTimeout(launch, pollMs);
    });
  };

  launch();
  log('email-otp watcher started');
  return {
    stop: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      await currentTick;
      await releaseLease();
    },
  };
}
