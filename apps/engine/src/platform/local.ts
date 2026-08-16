/**
 * Local platform implementation — zero external dependencies.
 *
 * Everything a self-hoster needs to run the engine with just GEMINI_API_KEY:
 *   - SessionStore   → run artifacts written under ${RUNS_DIR}/{sessionId}/
 *                      (session.json, steps.jsonl, results.json, logs.json).
 *                      There is no external canceller, so updateStatus never
 *                      throws CrawlCancelledError. The /crawl HTTP response is the
 *                      authoritative result channel; these files are for debugging.
 *   - ScreenshotSink → JPEG written to ${RUNS_DIR}/{sessionId}/step-NNN.jpg,
 *                      returned as a file:// URL.
 *   - OtpProvider    → waits for a code written to ${RUNS_DIR}/{sessionId}/otp.txt
 *                      (or the OTP_<sessionId> env var). prepare() is a no-op.
 *   - SecretCipher   → identity (credentials are supplied to /crawl in plaintext).
 */

import * as fs from 'fs';
import * as path from 'path';
import type {
  Platform,
  SessionStore,
  ScreenshotSink,
  OtpProvider,
  SecretCipher,
  TunnelStore,
  TunnelContext,
  CompletionResults,
  ScreenshotUploadResult,
} from './types';
import type { SessionLogger, LogLine } from '../utils/logger';

const RUNS_DIR = process.env.RUNS_DIR || path.join(process.cwd(), 'runs');

function sessionDir(sessionId: string): string {
  // sessionId is caller-supplied; keep it to a single path segment to avoid traversal.
  const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, '_');
  const dir = path.join(RUNS_DIR, safe);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function mergeJson(file: string, patch: Record<string, unknown>): void {
  let current: Record<string, unknown> = {};
  try {
    if (fs.existsSync(file)) current = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    current = {};
  }
  fs.writeFileSync(file, JSON.stringify({ ...current, ...patch }, null, 2));
}

const localSessionStore: SessionStore = {
  async claimWorker(): Promise<'claimed'> {
    return 'claimed';
  },

  async assertActive(_sessionId): Promise<void> {
    // Standalone mode has no external session owner or cancellation ledger.
  },

  async updateStatus(sessionId, status, currentStep, stepCount, _logger): Promise<void> {
    const patch: Record<string, unknown> = { status, currentStep, lastHeartbeatAt: new Date().toISOString() };
    if (stepCount !== undefined) patch.stepCount = stepCount;
    mergeJson(path.join(sessionDir(sessionId), 'session.json'), patch);
  },

  async appendStep(sessionId, stepLog, _logger): Promise<void> {
    fs.appendFileSync(path.join(sessionDir(sessionId), 'steps.jsonl'), JSON.stringify(stepLog) + '\n');
  },

  async complete(sessionId, success, error, results, _logger): Promise<void> {
    const dir = sessionDir(sessionId);
    mergeJson(path.join(dir, 'session.json'), {
      status: success ? 'completed' : 'failed',
      completedAt: new Date().toISOString(),
      ...(error ? { lastError: error } : {}),
      ...(results?.stepsExecuted !== undefined ? { stepsExecuted: results.stepsExecuted } : {}),
      ...(results?.cost ? { cost: results.cost } : {}),
      ...(results?.crawlMemory ? { crawlMemory: results.crawlMemory } : {}),
      ...(results?.failureReason ? { failureReason: results.failureReason } : {}),
    });
    const details: CompletionResults = {
      accounts: results?.accounts,
      transactions: results?.transactions,
      positions: results?.positions,
      stepLogs: results?.stepLogs,
    };
    fs.writeFileSync(path.join(dir, 'results.json'), JSON.stringify(details, null, 2));
  },

  startHeartbeat(_sessionId, _intervalMs): () => void {
    // No external poller in local mode — nothing to heartbeat to.
    return () => {};
  },

  async flushLogs(sessionId, lines: LogLine[]): Promise<void> {
    const MAX_LINES = 2000;
    const truncated = lines.length > MAX_LINES ? lines.slice(-MAX_LINES) : lines;
    fs.writeFileSync(path.join(sessionDir(sessionId), 'logs.json'), JSON.stringify(truncated, null, 2));
  },
};

const localScreenshots: ScreenshotSink = {
  async upload(sessionId, stepNumber, base64Screenshot, logger): Promise<ScreenshotUploadResult | null> {
    try {
      const name = `step-${String(stepNumber).padStart(3, '0')}.jpg`;
      const file = path.join(sessionDir(sessionId), name);
      fs.writeFileSync(file, Buffer.from(base64Screenshot, 'base64'));
      return { path: file, url: `file://${file}` };
    } catch (error) {
      (logger ?? console).warn(`[Screenshot] Failed to write step ${stepNumber} for ${sessionId}:`, error);
      return null;
    }
  },
};

const localOtp: OtpProvider = {
  async prepare(_sessionId, _offlineTimeoutMs, _busyTimeoutMs, _pollIntervalMs, logger): Promise<void> {
    (logger ?? console).log('[OTP] Local mode — provide the code via the OTP_<sessionId> env var or otp.txt in the run dir.');
  },

  async waitForOtp(sessionId, timeoutMs, pollIntervalMs, logger): Promise<string> {
    const log = logger ?? console;
    const envKey = `OTP_${sessionId}`;
    const otpFile = path.join(sessionDir(sessionId), 'otp.txt');
    log.log(`[OTP] Waiting up to ${Math.round(timeoutMs / 1000)}s for ${envKey} or ${otpFile}`);
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const fromEnv = process.env[envKey];
      if (fromEnv && fromEnv.trim()) return fromEnv.trim();
      try {
        if (fs.existsSync(otpFile)) {
          const code = fs.readFileSync(otpFile, 'utf8').trim();
          if (code) {
            fs.rmSync(otpFile, { force: true });
            return code;
          }
        }
      } catch {
        // ignore transient read errors; keep polling
      }
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }
    throw new Error(`OTP timeout after ${timeoutMs}ms for session ${sessionId} (no ${envKey} env or otp.txt)`);
  },
};

const localCipher: SecretCipher = {
  // In local mode credentials are supplied to /crawl already in plaintext, so
  // "decryption" is the identity. (Only a hosted tunnel path stores ciphertext.)
  async decrypt(ciphertext: string): Promise<string> {
    return ciphertext;
  },
};

const localTunnel: TunnelStore = {
  // No control-plane in local mode — there's no single-use ledger to claim against, so a tunnel is
  // always claimable. This lets a self-hoster exercise the device-proxy WS path end-to-end without
  // the Postgres control-plane. (status 'starting' = an active crawl the tunnel-server will accept.)
  async loadTunnelContext(sessionId, _deviceId): Promise<TunnelContext | null> {
    return { sessionId, status: 'starting', tunnelRequested: true, claimed: true };
  },
  async releaseTunnelClaim(): Promise<void> {
    // No control-plane ledger in local mode — claims are always-won, so there is nothing to release.
  },
};

export function createLocalPlatform(): Platform {
  return {
    name: 'local',
    sessionStore: localSessionStore,
    screenshots: localScreenshots,
    otp: localOtp,
    cipher: localCipher,
    tunnel: localTunnel,
  };
}
