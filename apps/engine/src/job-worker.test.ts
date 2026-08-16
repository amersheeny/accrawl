import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import postgres, { type Sql } from 'postgres';
import { createHash } from 'node:crypto';
import {
  encryptCrawlJobPayload,
  type CrawlRequest,
  type CrawlResponse,
} from '@accrawl/contracts';
import {
  isSuccessfulFinalization,
  OwnershipFenceError,
  runJobWorker,
  startOwnershipMonitor,
  waitForOwningJob,
} from './job-worker';
import { CrawlCleanupError } from './crawl-executor';

const PORT = 54369;
const KEY = Buffer.alloc(32, 7).toString('base64');
const TOKEN = 'one-job-capability';

describe('one-shot crawl job worker', () => {
  let client: PGlite;
  let server: PGLiteSocketServer;
  let admin: Sql;
  let jobId: string;
  let secretsDir: string;
  let request: CrawlRequest;

  beforeAll(async () => {
    client = new PGlite();
    const migrations = path.resolve(__dirname, '../../control-plane/migrations');
    for (const file of readdirSync(migrations).filter((name) => name.endsWith('.sql')).sort()) {
      await client.exec(readFileSync(path.join(migrations, file), 'utf8'));
    }
    server = new PGLiteSocketServer({ db: client, port: PORT });
    await server.start();
    admin = postgres(`postgres://localhost:${PORT}/postgres`, { max: 1 });
    await admin`
      insert into institutions (id, name, login_url, canonical_domain, type)
      values ('bank', 'Bank', 'https://bank.test', 'bank.test', 'bank')`;
    const [connection] = await admin`
      insert into connections (institution_id, username_ct, password_ct)
      values ('bank', 'ciphertext', 'ciphertext') returning id`;
    const [session] = await admin`
      insert into sessions (connection_id, lease_owner, lease_expires_at, heartbeat_at)
      values (${connection.id}, 'control', now() + interval '1 hour', now()) returning id`;
    jobId = session.id as string;
    request = {
      sessionId: jobId,
      loginUrl: 'https://bank.test/login',
      username: 'secret-user',
      password: 'secret-password',
      requires2fa: false,
      maxSteps: 20,
      timeoutSeconds: 300,
    };
    await admin`
      insert into crawl_jobs (
        id, session_id, encrypted_payload, claim_token, claim_token_hash
      )
      values (
        ${jobId},
        ${jobId},
        ${encryptCrawlJobPayload(KEY, 'tenant-a', jobId, request)},
        ${TOKEN},
        ${createHash('sha256').update(TOKEN, 'utf8').digest('hex')}
      )`;
    secretsDir = mkdtempSync(path.join(tmpdir(), 'accrawl-worker-'));
    const secrets = {
      database: `postgres://localhost:${PORT}/postgres`,
      job: KEY,
      gemini: 'test-gemini-key',
      shared: 'test-engine-shared-secret',
    };
    for (const [name, value] of Object.entries(secrets)) {
      writeFileSync(path.join(secretsDir, name), value, { mode: 0o600 });
    }
    process.env.ENGINE_DATABASE_URL_FILE = path.join(secretsDir, 'database');
    process.env.JOB_ENCRYPTION_KEY_FILE = path.join(secretsDir, 'job');
    process.env.GEMINI_API_KEY_FILE = path.join(secretsDir, 'gemini');
    process.env.ENGINE_SHARED_SECRET_FILE = path.join(secretsDir, 'shared');
    process.env.ENGINE_JOB_ID = jobId;
    process.env.ENGINE_JOB_TOKEN = TOKEN;
    process.env.ACCRAWL_TENANT_ID = 'tenant-a';
  });

  afterAll(async () => {
    await admin?.end();
    await server?.stop();
    await client?.close();
    rmSync(secretsDir, { recursive: true, force: true });
    for (const name of [
      'ENGINE_DATABASE_URL',
      'ENGINE_DATABASE_URL_FILE',
      'JOB_ENCRYPTION_KEY',
      'JOB_ENCRYPTION_KEY_FILE',
      'GEMINI_API_KEY',
      'GEMINI_API_KEY_FILE',
      'ENGINE_SHARED_SECRET',
      'ENGINE_SHARED_SECRET_FILE',
      'ENGINE_JOB_ID',
      'ENGINE_JOB_TOKEN',
      'ACCRAWL_TENANT_ID',
      'ACCRAWL_WORKER_NAME',
    ]) delete process.env[name];
  });

  it('claims, decrypts, executes, finalizes, and scrubs one exact job', async () => {
    let executed: CrawlRequest | undefined;
    // pglite-socket is a deliberately tiny test wire server; give the worker the
    // only live client connection, then reconnect for the assertion.
    await admin.end();
    await runJobWorker({
      execute: async (payload): Promise<CrawlResponse> => {
        executed = payload;
        return { success: true, stepsExecuted: 1 };
      },
      closeBrowser: async () => undefined,
      installSignalHandlers: false,
    });
    admin = postgres(`postgres://localhost:${PORT}/postgres`, { max: 1 });
    expect(executed?.username).toBe('secret-user');
    expect(executed?.password).toBe('secret-password');
    const [job] = await admin`
      select status, encrypted_payload, claim_token from crawl_jobs where id = ${jobId}`;
    expect(job).toMatchObject({
      status: 'succeeded',
      encrypted_payload: '',
      claim_token: '',
    });
  });

  it('terminates without terminalizing the durable job when a cleanup fence rejects', async () => {
    const cleanupToken = 'cleanup-fence-capability';
    const [connection] = await admin`
      insert into connections (institution_id, username_ct, password_ct)
      values ('bank', 'ciphertext', 'ciphertext') returning id`;
    const [session] = await admin`
      insert into sessions (connection_id, lease_owner, lease_expires_at, heartbeat_at)
      values (${connection.id}, 'control', now() + interval '1 hour', now()) returning id`;
    const cleanupJobId = session.id as string;
    const cleanupRequest = { ...request, sessionId: cleanupJobId };
    await admin`
      insert into crawl_jobs (
        id, session_id, encrypted_payload, claim_token, claim_token_hash
      )
      values (
        ${cleanupJobId},
        ${cleanupJobId},
        ${encryptCrawlJobPayload(KEY, 'tenant-a', cleanupJobId, cleanupRequest)},
        ${cleanupToken},
        ${createHash('sha256').update(cleanupToken, 'utf8').digest('hex')}
      )`;

    process.env.ENGINE_JOB_ID = cleanupJobId;
    process.env.ENGINE_JOB_TOKEN = cleanupToken;
    const terminated = new Error('test PID-1 termination');
    await admin.end();

    await expect(runJobWorker({
      execute: async () => {
        throw new CrawlCleanupError(cleanupJobId, new Error('browser remained active'));
      },
      closeBrowser: async () => undefined,
      installSignalHandlers: false,
      terminate: (() => {
        throw terminated;
      }) as (code: number) => never,
    })).rejects.toBe(terminated);

    admin = postgres(`postgres://localhost:${PORT}/postgres`, { max: 1 });
    const [job] = await admin`
      select status, encrypted_payload, claim_token from crawl_jobs where id = ${cleanupJobId}`;
    const [durableSession] = await admin`
      select status, completed_at from sessions where id = ${cleanupJobId}`;
    expect(job.status).toBe('running');
    expect(job.encrypted_payload).not.toBe('');
    expect(job.claim_token).toBe(cleanupToken);
    expect(durableSession.status).toBe('starting');
    expect(durableSession.completed_at).toBeNull();

    process.env.ENGINE_JOB_ID = jobId;
    process.env.ENGINE_JOB_TOKEN = TOKEN;
  });

  it('keeps a duplicate pod non-terminal until job cleanup and session promotion both succeed', async () => {
    const statuses = [
      { job_status: 'running', session_status: 'extracting' },
      { job_status: 'succeeded', session_status: 'extracting' },
      { job_status: 'succeeded', session_status: 'completed' },
    ];
    let polls = 0;
    const fakeSql = (async (strings: TemplateStringsArray) => {
      expect(strings.join(' ')).toContain('accrawl_observe_crawl_job');
      return [statuses[polls++]];
    }) as unknown as Sql;

    await expect(waitForOwningJob(fakeSql, jobId, TOKEN, async () => undefined))
      .resolves.toBe('succeeded');
    expect(polls).toBe(3);
  });

  it('fails closed when a duplicate pod cannot find its owning job', async () => {
    const fakeSql = (async () => []) as unknown as Sql;
    await expect(waitForOwningJob(fakeSql, jobId, TOKEN, async () => undefined))
      .resolves.toBeNull();
  });

  it('does not fail the Kubernetes Job on a transient owner-status read error', async () => {
    let polls = 0;
    const fakeSql = (async () => {
      polls += 1;
      if (polls === 1) throw new Error('temporary database disconnect');
      return [{ job_status: 'succeeded', session_status: 'completed' }];
    }) as unknown as Sql;

    await expect(waitForOwningJob(fakeSql, jobId, TOKEN, async () => undefined))
      .resolves.toBe('succeeded');
    expect(polls).toBe(2);
  });

  it('mirrors a completed session after the reaper scrubs its stranded job as failed', async () => {
    const fakeSql = (async () => [{
      job_status: 'failed',
      session_status: 'completed',
    }]) as unknown as Sql;

    await expect(waitForOwningJob(fakeSql, jobId, TOKEN, async () => undefined))
      .resolves.toBe('succeeded');
  });
});

describe('durable crawl-job ownership', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fences immediately when the heartbeat observes operator cancellation', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const fence = vi.fn(async () => undefined);
    const monitor = startOwnershipMonitor({
      heartbeat: async () => 'cancel_requested',
      fence,
      leaseMs: 100,
      heartbeatMs: 10,
      fenceGraceMs: 20,
      confirmedAt: 0,
    });

    await vi.advanceTimersByTimeAsync(10);

    await expect(monitor.fenced).resolves.toMatch(/revoked.*cancel_requested/);
    expect(fence).toHaveBeenCalledOnce();
  });

  it('fences synchronously when the confirmed lease window already expired', async () => {
    const fence = vi.fn(async () => undefined);
    const monitor = startOwnershipMonitor({
      heartbeat: async () => 'running',
      fence,
      leaseMs: 100,
      heartbeatMs: 25,
      fenceGraceMs: 20,
      confirmedAt: 0,
      now: () => 80,
    });

    // No timer turn is needed: callers can safely inspect an AbortSignal before
    // starting the first irreversible crawl action.
    expect(fence).toHaveBeenCalledOnce();
    await expect(monitor.fenced).resolves.toBe('crawl-job ownership lease expired');
  });

  it('does not renew on heartbeat errors and fences before the last confirmed lease expires', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const fence = vi.fn(async () => undefined);
    const monitor = startOwnershipMonitor({
      heartbeat: async () => {
        throw new Error('database unavailable');
      },
      fence,
      leaseMs: 100,
      heartbeatMs: 25,
      fenceGraceMs: 20,
      confirmedAt: 0,
    });

    await vi.advanceTimersByTimeAsync(79);
    expect(fence).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    await expect(monitor.fenced).resolves.toBe('crawl-job ownership lease expired');
    expect(fence).toHaveBeenCalledOnce();
  });

  it('rejects the ownership fence when any teardown action fails', async () => {
    const monitor = startOwnershipMonitor({
      heartbeat: async () => 'running',
      fence: async () => {
        throw new Error('browser context remained open');
      },
      leaseMs: 100,
      heartbeatMs: 25,
      fenceGraceMs: 20,
      confirmedAt: 0,
      now: () => 80,
    });

    await expect(monitor.fenced).rejects.toMatchObject({
      name: 'OwnershipFenceError',
      fenceReason: 'crawl-job ownership lease expired',
    } satisfies Partial<OwnershipFenceError>);
  });

  it('renews only from an exact running heartbeat response', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const fence = vi.fn(async () => undefined);
    const monitor = startOwnershipMonitor({
      heartbeat: async () => 'running',
      fence,
      leaseMs: 100,
      heartbeatMs: 25,
      fenceGraceMs: 20,
      confirmedAt: 0,
    });

    await vi.advanceTimersByTimeAsync(100);
    expect(fence).not.toHaveBeenCalled();
    monitor.stop();
    await vi.advanceTimersByTimeAsync(200);
    expect(fence).not.toHaveBeenCalled();
  });

  it('reports success only when both crawl work and the fenced finalization agree', () => {
    expect(isSuccessfulFinalization(
      { success: true, stepsExecuted: 1 },
      'succeeded',
    )).toBe(true);
    expect(isSuccessfulFinalization(
      { success: true, stepsExecuted: 1 },
      'cancelled',
    )).toBe(false);
    expect(isSuccessfulFinalization(
      { success: true, stepsExecuted: 1 },
      null,
    )).toBe(false);
    expect(isSuccessfulFinalization(
      { success: false, error: 'failed', stepsExecuted: 1 },
      'succeeded',
    )).toBe(false);
  });
});
