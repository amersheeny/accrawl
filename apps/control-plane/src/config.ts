/**
 * Control-plane configuration (env). Secrets support the `_FILE` / Docker-secrets convention via
 * readSecret() (prefer NAME_FILE over a raw NAME env var). Per-subsystem secrets that aren't needed to
 * boot a read-only/health path are read lazily where used (e.g. the credential master key in the cipher,
 * the operator credential in the DB).
 */
import { readSecret } from './lib/secrets';

/**
 * Which of the registered implementations this deployment uses. Not a fixed list: a deployment that
 * keeps records or starts workers somewhere else registers that itself, and the registry — which is the
 * only place that knows what exists — rejects a name it has nothing for, naming what it does have. A
 * list here could only be a second, staler copy of that, and would name implementations this repository
 * deliberately does not contain.
 */
function persistenceBackend(): string {
  return process.env.PERSISTENCE_BACKEND?.trim() || 'postgres';
}

function engineDispatchMode(): string {
  return process.env.ENGINE_DISPATCH_MODE?.trim() || 'http';
}

/**
 * The four values a Companion needs to register with this deployment's push project.
 *
 * All four or none: a partial configuration would let the app register with something the sender cannot
 * reach, which fails as a phone that never wakes rather than as an error anyone sees. None of them is a
 * secret — every app that ships with them exposes them — so they are plain settings rather than
 * readSecret() lookups.
 */
function companionPushClient(): {
  applicationId: string;
  apiKey: string;
  projectId: string;
  senderId: string;
} | undefined {
  const applicationId = process.env.COMPANION_PUSH_CLIENT_APP_ID?.trim();
  const apiKey = process.env.COMPANION_PUSH_CLIENT_API_KEY?.trim();
  const projectId = process.env.COMPANION_PUSH_PROJECT_ID?.trim();
  const senderId = process.env.COMPANION_PUSH_CLIENT_SENDER_ID?.trim();
  if (!applicationId || !apiKey || !projectId || !senderId) return undefined;
  return { applicationId, apiKey, projectId, senderId };
}

const configuredPersistenceBackend = persistenceBackend();
const configuredEngineDispatchMode = engineDispatchMode();

export const config = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: parseInt(process.env.PORT ?? '3000', 10),
  /** Deployed build stamp — the git short SHA `./accrawl start` bakes in at launch (env ACCRAWL_VERSION).
   *  Surfaced by GET /version so `./accrawl status` can detect a stale (un-rebuilt) deployment; "unknown"
   *  for a bare `docker compose up` outside the lifecycle script / a git checkout. */
  version: process.env.ACCRAWL_VERSION ?? 'unknown',
  /** Postgres connection string (carries the DB password) — supports DATABASE_URL_FILE. */
  databaseUrl: readSecret('DATABASE_URL') ?? 'postgres://accrawl:accrawl@localhost:5432/accrawl',
  /**
   * Proof that whoever claims this deployment is the person who installed it — supports
   * SETUP_CLAIM_TOKEN_FILE.
   *
   * Setting the first password is one unauthenticated write, and until it happens the deployment belongs
   * to nobody. Whoever arrives first used to win it, permanently, and the loser was told the deployment
   * was already initialized. A deployment reachable while it waits — which is every deployment with a
   * domain, since obtaining a certificate requires being reachable — could be claimed by a stranger.
   *
   * This is generated where the deployment is installed and shown to the person installing it, so
   * claiming it needs something only they have rather than a request that arrives sooner. Location is not
   * used as proof: behind a proxy every caller shares its address, so a check on where a request came
   * from would read the proxy and admit everyone.
   */
  setupClaimToken: readSecret('SETUP_CLAIM_TOKEN'),
  /** Where user-facing records are kept. PostgreSQL is the default and needs nothing registered. */
  persistenceBackend: configuredPersistenceBackend,
  /**
   * What a paired Companion must register with to receive this deployment's wake-ups, handed to it
   * after pairing rather than built into it. Undefined when this deployment sends no wakes, which is a
   * working deployment: the code is typed into the console instead.
   */
  companionPushClient: companionPushClient(),
  /** Crawl engine base URL (internal network). */
  engineUrl: process.env.ENGINE_URL ?? 'http://localhost:8080',
  /** Phone-reachable device-proxy tunnel WS base (e.g. wss://host/tunnel) handed to the companion so it
   *  knows where to connect; undefined until the operator publishes the tunnel endpoint. */
  engineWsUrl: process.env.ENGINE_WS_URL,
  /** Defense-in-depth bearer the control-plane sends to the engine (engine is not host-published).
   *  Also the HMAC root the tunnel token's signing key is HKDF-derived from (deriveTunnelKey). */
  engineSharedSecret: readSecret('ENGINE_SHARED_SECRET'),
  /** Where the engine writes run artifacts (screenshots) in PLATFORM=local/postgres. */
  runsDir: process.env.RUNS_DIR ?? './runs',
  /** The shared screenshots dir this process READS to serve step screenshots to the console (the engine
   *  writes it; compose mounts the same volume into both, read-only here). Falls back to RUNS_DIR for the
   *  non-Docker dev path where both apps run from the repo; undefined disables the screenshot route. */
  screenshotDir: process.env.SCREENSHOT_DIR ?? process.env.RUNS_DIR,
  /** Start the pg-boss scheduler in this process (the worker that runs scheduled crawls). */
  schedulerEnabled: process.env.SCHEDULER_ENABLED === 'true',
  /** Hosted-cell tenant catalog. Unset preserves the single implicit self-hosted tenant. */
  tenantDirectoryFile: process.env.TENANT_DIRECTORY_FILE,
  /** Trust x-accrawl-tenant-host from an authenticated private service caller.
   * Enable only on a core reachable solely from inside; public edges must strip and
   * replace the header before forwarding. */
  trustInternalTenantHostHeader:
    process.env.TRUST_INTERNAL_TENANT_HOST_HEADER === 'true',
  /** Engine dispatch transport: long-lived HTTP or one ephemeral worker per crawl. */
  engineDispatchMode: configuredEngineDispatchMode,
  /** Google Gemini API key — the control-plane uses it ONLY to extract the OTP from an SMS body the
   *  companion relays (the LLM-first replacement for the old regex extractor). Read lazily where used so a
   *  read-only/health path can boot without it; supports GEMINI_API_KEY_FILE. */
  geminiApiKey: readSecret('GEMINI_API_KEY'),
  /** Model used for OTP extraction. A small/fast Gemini model is plenty for "pull the code out of one SMS";
   *  the crawl agent picks its own model per-institution. */
  otpExtractModel: process.env.OTP_EXTRACT_MODEL ?? 'gemini-2.5-flash',
  /** Model used for the config malice-scan (classifying an imported community playbook as a safe read-only
   *  recipe vs. one that exfiltrates data or moves money). It must reason about intent, but still runs once
   *  per import — never per crawl. Read lazily; supports MALICE_SCAN_MODEL. */
  maliceScanModel: process.env.MALICE_SCAN_MODEL ?? 'gemini-2.5-flash',
  /** Model used to AI-draft an initial institution config from a login-page recon (authoring aid). Runs once
   *  per draft request, operator-initiated. Read lazily; supports AUTHOR_DRAFT_MODEL. */
  authorDraftModel: process.env.AUTHOR_DRAFT_MODEL ?? 'gemini-2.5-flash',
} as const;

export function isProduction(): boolean {
  return config.nodeEnv === 'production';
}
