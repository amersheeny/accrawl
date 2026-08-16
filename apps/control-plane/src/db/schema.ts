/**
 * Accrawl control-plane Postgres schema (Drizzle).
 *
 * Design notes (from the adversarially-validated plan):
 *  - **Staging boundary**: the engine writes raw/unvalidated extraction to
 *    `stagedRecords` under a least-privilege role; the control-plane validates
 *    and transactionally writes the final `accounts`/`transactions`/`positions`
 *    + advances the watermark. Invalid/partial data never reaches the canonical
 *    tables.
 *  - **Lease + heartbeat**: `sessions.leaseExpiresAt`/`heartbeatAt` let a reaper
 *    fail a crashed crawl and prevent cron overlap.
 *  - **SSE replay**: `sessionEvents.seq` gives every event a per-session sequence
 *    so the UI can replay from `Last-Event-ID` after a disconnect.
 *  - **Encryption**: credential columns hold self-describing, versioned AEAD ciphertext,
 *    AAD-bound to (connection, field) so a token can't be reused in another row.
 *  - **Anti-phishing**: `institutions.canonicalDomain` + `connections.loginDomainVerified`
 *    — an imported config's `loginUrl` must be operator-verified before it can run.
 *  - **Scoped API keys**: `apiKeys.scopes` + `connectionGrants` bound per key.
 */
import {
  pgTable, pgEnum, text, integer, boolean, timestamp, jsonb, bigserial, uuid, index, uniqueIndex, check,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import type {
  CrawlCost, CrawlFailureReason, CrawlStepLog, ExtractionHints, LoginHints,
  NormalizedAccount, NormalizedPosition, NormalizedTransaction,
} from '@accrawl/contracts';

/** Statuses where the crawler may still perform work — used by progress writers and reaper indexes. */
const ACTIVE_SESSION_STATUSES = "'starting','logging_in','navigating','waiting_for_otp','extracting'";
/** Statuses that retain the one-crawl-per-connection lock. `cancelling` is a
 *  durable fence: it rejects new dispatches while the old worker is stopped. */
const LOCKED_SESSION_STATUSES =
  "'starting','logging_in','navigating','waiting_for_otp','extracting','cancelling'";

// ─── Enums ──────────────────────────────────────────────────────────

export const institutionType = pgEnum('institution_type', ['bank', 'broker', 'retirement']);
export const scanStatus = pgEnum('scan_status', ['pending', 'passed', 'failed']);
export const configSource = pgEnum('config_source', ['builtin', 'local', 'imported']);
export const connectionStatus = pgEnum('connection_status', [
  'connecting', 'connected', 'syncing', 'needs_reauth', 'error', 'disabled',
]);
export const sessionStatus = pgEnum('session_status', [
  'starting', 'logging_in', 'navigating', 'waiting_for_otp', 'extracting',
  'cancelling', 'completed', 'failed', 'cancelled',
]);
export const stagedKind = pgEnum('staged_kind', ['account', 'transaction', 'position']);
export const crawlJobStatus = pgEnum('crawl_job_status', [
  'queued', 'starting', 'running', 'succeeded', 'failed', 'cancel_requested', 'cancelled',
]);

// ─── Institution catalogue (the per-bank "recipe") ──────────────────

export const institutions = pgTable('institutions', {
  id: text('id').primaryKey(), // slug, e.g. "example-bank"
  /** Null means administrator-maintained and visible to every data owner in
   *  this tenant. A subject means the recipe is private to that owner. */
  ownerSubject: text('owner_subject'),
  /** Caller-facing slug retained when a private row receives an opaque,
   *  owner-namespaced storage id. Legacy rows may be null and fall back to id. */
  catalogKey: text('catalog_key'),
  name: text('name').notNull(),
  loginUrl: text('login_url').notNull(),
  /** Canonical login domain (eTLD+1) — the anti-phishing anchor. Always set (the CRUD derives
   *  it from loginUrl); an imported config can't run until a connection's loginDomainVerified
   *  is approved against it. */
  canonicalDomain: text('canonical_domain').notNull(),
  /** Additional domains the agent is allowed to reach (SSO/CDN), beyond eTLD+1 of loginUrl. */
  allowedDomains: jsonb('allowed_domains').$type<string[]>().notNull().default([]),
  type: institutionType('type').notNull(),
  country: text('country'),
  logo: text('logo'),
  playbook: text('playbook'),
  extractionHints: jsonb('extraction_hints').$type<ExtractionHints>(),
  loginHints: jsonb('login_hints').$type<LoginHints>(),
  requires2fa: boolean('requires_2fa').notNull().default(false),
  otpSenderPattern: text('otp_sender_pattern'),
  useDeviceProxy: boolean('use_device_proxy').notNull().default(false),
  model: text('model'),
  /** Per-crawl reasoning depth passed to the engine; null → the engine's default. */
  thinkingLevel: text('thinking_level'),
  maxSteps: integer('max_steps').notNull().default(120),
  timeoutSeconds: integer('timeout_seconds').notNull().default(900),
  transactionLookbackDays: integer('transaction_lookback_days').notNull().default(14),
  /** Where this config came from: 'builtin' (ships in the canonical catalogue), 'local'
   *  (created by the operator here), or 'imported' (pulled from a community URL/registry). */
  source: configSource('source').notNull().default('local'),
  /** Malice-scan result. The engine refuses to run a config whose scan is not 'passed'. */
  scanStatus: scanStatus('scan_status').notNull().default('pending'),
  version: integer('version').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byOwner: index('institutions_owner_idx').on(t.ownerSubject),
}));

// ─── Connections (the user's credentials + schedule) ────────────────

export interface CrawlStats {
  totalCount: number;
  completedCount: number;
  failedCount: number;
  consecutiveFailures: number;
  lastFailureReason?: CrawlFailureReason;
  avgCostUsd: number;
  recentCosts: number[];
  /** Transaction watermark (YYYY-MM-DD): the next crawl extracts from here back transactionLookbackDays. */
  lastSuccessfulTxCrawlDay?: string;
}

export const connections = pgTable('connections', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** Stable resource owner. Hosted mode uses the edge-attested Identity
   * Platform uid; self-hosted mode uses one reserved operator subject. */
  ownerSubject: text('owner_subject').notNull().default('self-hosted:operator'),
  institutionId: text('institution_id').notNull().references(() => institutions.id, { onDelete: 'restrict' }),
  // Self-describing AEAD ciphertext (AAD-bound to connection+field). Never plaintext at rest.
  usernameCt: text('username_ct').notNull(),
  passwordCt: text('password_ct').notNull(),
  dobCt: text('dob_ct'),
  phoneCt: text('phone_ct'),
  /** Operator approved this connection's login domain against the canonical record (anti-phishing). */
  loginDomainVerified: boolean('login_domain_verified').notNull().default(false),
  loginUrlOverride: text('login_url_override'),
  customInstructions: text('custom_instructions'),
  /** False keeps credentials usable for explicit Crawl now requests but removes this connection from rotation. */
  crawlScheduleEnabled: boolean('crawl_schedule_enabled').notNull().default(true),
  crawlSchedule: text('crawl_schedule').notNull().default('0 6 * * *'),
  /** IANA timezone used to interpret crawlSchedule as the operator's wall-clock time. */
  crawlTimezone: text('crawl_timezone').notNull().default('UTC'),
  /** Monotonic point-of-use fence carried by scheduled jobs; edits invalidate stale queued work. */
  crawlScheduleRevision: integer('crawl_schedule_revision').notNull().default(0),
  /** Single-use occurrence fence. A scheduled worker atomically consumes this before creating a session. */
  crawlScheduleClaim: uuid('crawl_schedule_claim'),
  crawlMemory: text('crawl_memory'),
  status: connectionStatus('status').notNull().default('connecting'),
  consecutiveFailures: integer('consecutive_failures').notNull().default(0),
  crawlStats: jsonb('crawl_stats').$type<CrawlStats>().notNull().default({
    totalCount: 0, completedCount: 0, failedCount: 0, consecutiveFailures: 0, avgCostUsd: 0, recentCosts: [],
  }),
  nickname: text('nickname'),
  safeErrorMessage: text('safe_error_message'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byOwner: index('connections_owner_idx').on(t.ownerSubject),
  byInstitution: index('connections_institution_idx').on(t.institutionId),
}));

// ─── Crawl sessions (one per crawl attempt) ─────────────────────────

export const sessions = pgTable('sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  connectionId: uuid('connection_id').notNull().references(() => connections.id, { onDelete: 'cascade' }),
  status: sessionStatus('status').notNull().default('starting'),
  currentStep: text('current_step'),
  stepCount: integer('step_count').notNull().default(0),
  // OTP handshake
  otpRequested: boolean('otp_requested').notNull().default(false),
  otpRequestedAt: timestamp('otp_requested_at', { withTimezone: true }),
  otpRelayOnline: boolean('otp_relay_online').notNull().default(false),
  otpRelayOnlineAt: timestamp('otp_relay_online_at', { withTimezone: true }),
  otpRelayReady: boolean('otp_relay_ready').notNull().default(false),
  otpRelayReadyAt: timestamp('otp_relay_ready_at', { withTimezone: true }),
  /** Who is expected to supply the 2FA code for the CURRENT request episode, decided by the control-plane
   *  the moment the episode is armed (it is the only side that can see the paired devices):
   *    'companion' — at least one live-capable phone is authorized for this connection, so the crawl waits
   *                  for that phone to confirm it can read the SMS before it ever reaches the login page;
   *    'manual'    — no phone is authorized at all, so nothing can ever confirm, and waiting is a guaranteed
   *                  timeout. The crawl proceeds and parks in waiting_for_otp for the operator to type the
   *                  code into the console instead.
   *  Null until the episode is armed. Reset with the rest of the relay state on every new episode. */
  otpRelayMode: text('otp_relay_mode'),
  /** Monotonic counter bumped every time the engine (re)arms the OTP relay for this session — i.e. each
   *  time it (re)enters the waiting_for_otp episode (first request, a resend, a restarted login). It scopes
   *  idempotency to ONE request episode: the companion folds this epoch into its dedupe key AND the server
   *  folds it into otpIdempotencyKey, so the SAME SMS body relayed for a genuinely NEW request (a fresh
   *  code that happens to read identically, or a resend) is accepted instead of being mistaken for a
   *  duplicate of the previous episode — while a true in-episode duplicate (same body, same epoch) is still
   *  a no-op. The engine bumps it in OtpProvider.prepare(). */
  otpRequestEpoch: integer('otp_request_epoch').notNull().default(0),
  otp: text('otp'),
  otpReceivedAt: timestamp('otp_received_at', { withTimezone: true }),
  /** Idempotency key of the LAST submitted OTP, so a retried/redelivered POST carrying the same key is a
   *  no-op instead of a second 2FA attempt. The companion derives the key from (sender|sessionId|epoch|
   *  sha256(body)), so it is scoped to the OTP-request episode (see otpRequestEpoch). Belt-and-braces behind
   *  the companion's own dedupe ledger: it also covers an operator double-submit and a companion that lost
   *  its ledger across a restart. */
  otpIdempotencyKey: text('otp_idempotency_key'),
  // Device-proxy tunnel claim (one-time)
  tunnelRequested: boolean('tunnel_requested').notNull().default(false),
  /** Exact paired device selected when a device-proxy crawl starts. Tunnel
   * authority stays bound to this row so another paired phone cannot claim it. */
  tunnelDeviceId: uuid('tunnel_device_id').references((): AnyPgColumn => devices.id, { onDelete: 'set null' }),
  tunnelClaimedAt: timestamp('tunnel_claimed_at', { withTimezone: true }),
  // Lease + heartbeat (overlap-prevention + crashed-engine reaper)
  leaseOwner: text('lease_owner'),
  leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
  heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }),
  cost: jsonb('cost').$type<CrawlCost>(),
  /** Change counts from the run's store step, surfaced retrieval-neutrally by GET /api/v1/syncs/:id
   *  (docs/spec-data-api.md §12.3). Written on a successful run; absent on failure or before completion. */
  syncCounts: jsonb('sync_counts').$type<{ accounts?: number; transactionsAdded?: number; transactionsModified?: number }>(),
  error: text('error'),
  failureReason: text('failure_reason').$type<CrawlFailureReason>(),
  crawlMemory: text('crawl_memory'),
  /** Engine success hand-off marker. Written in the same row-locked transaction
   *  as staged data + the successful done event. Cancellation requires NULL,
   *  so PostgreSQL's UPDATE row recheck makes completion vs cancellation a
   *  deterministic first-committer-wins decision without a cross-table
   *  snapshot race. The status remains active until canonical promotion. */
  promotionReadyAt: timestamp('promotion_ready_at', { withTimezone: true }),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }), // TTL cleanup
}, (t) => ({
  byConnection: index('sessions_connection_idx').on(t.connectionId),
  byStatus: index('sessions_status_idx').on(t.status),
  // The DB-enforced overlap lock: at most ONE in-flight crawl per connection. A second
  // concurrent dispatch fails to insert and is skipped. Terminal sessions don't count, so a
  // new crawl is allowed once the previous one completes/fails (or the reaper fails a dead one).
  oneActivePerConnection: uniqueIndex('sessions_active_connection_uq')
    .on(t.connectionId)
    .where(sql.raw(`status in (${LOCKED_SESSION_STATUSES})`)),
  // Reaper hot paths: find in-flight sessions whose worker died (stale heartbeat) or whose lease
  // expired, without scanning terminal history.
  activeByHeartbeat: index('sessions_active_heartbeat_idx')
    .on(t.heartbeatAt)
    .where(sql.raw(`status in (${ACTIVE_SESSION_STATUSES})`)),
  activeByLease: index('sessions_active_lease_idx')
    .on(t.leaseExpiresAt)
    .where(sql.raw(`status in (${ACTIVE_SESSION_STATUSES})`)),
  // Retention sweep hot path: the scheduler periodically deletes aged-out sessions (and their cascaded
  // events/steps/staged records) with `WHERE expires_at < now()`. This index lets that scan hit only the
  // due rows instead of the whole history.
  byExpiresAt: index('sessions_expires_at_idx').on(t.expiresAt),
}));

/**
 * Durable hand-off from the control-plane to an ephemeral crawl worker. The payload is an
 * AES-GCM envelope bound to (tenantId, jobId); plaintext credentials never enter the table
 * or Kubernetes Job spec. One row maps to one short-lived worker pod in hosted cell mode.
 */
export const crawlJobs = pgTable('crawl_jobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  sessionId: uuid('session_id').notNull().unique().references(() => sessions.id, { onDelete: 'cascade' }),
  encryptedPayload: text('encrypted_payload').notNull(),
  /** 256-bit bearer scoped to this one job; consumed only through SECURITY DEFINER job RPCs. */
  claimToken: text('claim_token').notNull(),
  /** Retained after plaintext capability scrubbing so a duplicate Pod can
   * observe its authoritative owner without gaining the claim capability. */
  claimTokenHash: text('claim_token_hash').notNull(),
  status: crawlJobStatus('status').notNull().default('queued'),
  leaseOwner: text('lease_owner'),
  leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
  heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }),
  workerName: text('worker_name'),
  error: text('error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  startedAt: timestamp('started_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
}, (t) => ({
  byStatusCreated: index('crawl_jobs_status_created_idx').on(t.status, t.createdAt),
  byLease: index('crawl_jobs_lease_idx').on(t.leaseExpiresAt),
}));

/** Per-step crawl log (engine-written telemetry). Heavy screenshots live in an object store; only a ref here. */
export const sessionSteps = pgTable('session_steps', {
  id: uuid('id').primaryKey().defaultRandom(),
  sessionId: uuid('session_id').notNull().references(() => sessions.id, { onDelete: 'cascade' }),
  stepNumber: integer('step_number').notNull(),
  screenshotRef: text('screenshot_ref'),
  log: jsonb('log').$type<CrawlStepLog>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  bySession: uniqueIndex('session_steps_session_step_idx').on(t.sessionId, t.stepNumber),
}));

/** Sequenced live-progress events for SSE replay (Last-Event-ID → replay from `seq`). */
export const sessionEvents = pgTable('session_events', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  sessionId: uuid('session_id').notNull().references(() => sessions.id, { onDelete: 'cascade' }),
  seq: integer('seq').notNull(),
  type: text('type').notNull(), // status | step | log | extract | otp_requested | done
  data: jsonb('data').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  bySessionSeq: uniqueIndex('session_events_session_seq_idx').on(t.sessionId, t.seq),
}));

/** Raw, UNVALIDATED extraction the engine stages; the control-plane validates → final tables. */
export const stagedRecords = pgTable('staged_records', {
  id: uuid('id').primaryKey().defaultRandom(),
  sessionId: uuid('session_id').notNull().references(() => sessions.id, { onDelete: 'cascade' }),
  kind: stagedKind('kind').notNull(),
  data: jsonb('data').notNull(), // raw normalized record as extracted (pre-Zod-validation)
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  bySession: index('staged_records_session_idx').on(t.sessionId),
}));

// ─── Final, validated canonical data ────────────────────────────────

export const accounts = pgTable('accounts', {
  id: text('id').primaryKey(), // deterministic hash(connectionId:providerAccountId)
  connectionId: uuid('connection_id').notNull().references(() => connections.id, { onDelete: 'cascade' }),
  data: jsonb('data').$type<NormalizedAccount>().notNull(),
  missingSinceCrawlCount: integer('missing_since_crawl_count').notNull().default(0),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byConnection: index('accounts_connection_idx').on(t.connectionId),
}));

export const transactions = pgTable('transactions', {
  // Bank-reference rows are account-namespaced. Fallback rows are additionally promotion-scoped,
  // so an occurrence UUID reused in another crawl remains independent. Explicit updates keep the
  // row's existing immutable id. Financial content never enters identity.
  id: text('id').primaryKey(),
  connectionId: uuid('connection_id').notNull().references(() => connections.id, { onDelete: 'cascade' }),
  data: jsonb('data').$type<NormalizedTransaction>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  // Bumped ONLY when an upsert actually changes `data` (e.g. pending→posted). Drives the read-side
  // change cursor's `modified` set (GET /api/v1/connections/:id/transactions/sync). A re-seen
  // unchanged transaction is not touched, so it does not resurface as a spurious modification.
  //
  // MILLISECOND precision on purpose: the change cursor's watermark is a JS `Date` (ms resolution),
  // so if the column stored microseconds a ms-truncated cursor would sort *before* the row and
  // re-emit it forever. `timestamp(3)` makes every write (incl. the `now()` default) ms-precision,
  // so the cursor round-trips losslessly by construction.
  updatedAt: timestamp('updated_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
}, (t) => ({
  byConnection: index('transactions_connection_idx').on(t.connectionId),
  // Cursor scan hot path: the change feed pages by (updatedAt, id) so it can resume deterministically.
  byUpdatedAt: index('transactions_updated_at_idx').on(t.updatedAt, t.id),
}));

/**
 * Private, session-scoped identity context for the exact transaction rows supplied to the crawler.
 *
 * The crawler sees only the stored row's canonical providerTransactionId. Promotion resolves a
 * returned `existingCanonicalId` through this table to the immutable stored row id actually shown
 * for this session; it never reconstructs row identity by hashing a mutable provider reference.
 * Persisting the mapping gives stranded-session recovery the same authority as the live path.
 */
export const sessionTransactionTargets = pgTable('session_transaction_targets', {
  id: uuid('id').primaryKey().defaultRandom(),
  sessionId: uuid('session_id').notNull().references(() => sessions.id, { onDelete: 'cascade' }),
  providerAccountId: text('provider_account_id').notNull(),
  canonicalId: text('canonical_id').notNull(),
  transactionId: text('transaction_id').notNull().references(() => transactions.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  exactTarget: uniqueIndex('session_transaction_targets_exact_uq')
    .on(t.sessionId, t.providerAccountId, t.canonicalId, t.transactionId),
  bySession: index('session_transaction_targets_session_idx').on(t.sessionId),
}));

/**
 * Durable private, promotion-scoped claim from one engine/staging observation UUID to the canonical
 * transaction row it produced. Crawl claims are session-scoped, so even an accidental UUID reuse in a
 * later session remains a new observation. Provider references can be absent or reused; this makes
 * replay idempotent without treating equal date/amount/description content as proof of sameness.
 */
export const transactionOccurrences = pgTable('transaction_occurrences', {
  id: uuid('id').primaryKey().defaultRandom(),
  connectionId: uuid('connection_id').notNull().references(() => connections.id, { onDelete: 'cascade' }),
  /** Populated for crawl promotions so claims expire with their session; null only for trusted direct stores. */
  sessionId: uuid('session_id').references(() => sessions.id, { onDelete: 'cascade' }),
  /** Session id in crawl paths; a fresh invocation id for trusted direct stores without a session envelope. */
  scopeId: text('scope_id').notNull(),
  occurrenceId: uuid('occurrence_id').notNull(),
  transactionId: text('transaction_id').notNull().references(() => transactions.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  occurrencePerScope: uniqueIndex('transaction_occurrences_connection_scope_occurrence_uq')
    .on(t.connectionId, t.scopeId, t.occurrenceId),
  bySession: index('transaction_occurrences_session_idx').on(t.sessionId),
  byTransaction: index('transaction_occurrences_transaction_idx').on(t.transactionId),
}));

export const positions = pgTable('positions', {
  id: text('id').primaryKey(), // deterministic hash(connectionId:providerPositionId)
  connectionId: uuid('connection_id').notNull().references(() => connections.id, { onDelete: 'cascade' }),
  data: jsonb('data').$type<NormalizedPosition>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byConnection: index('positions_connection_idx').on(t.connectionId),
}));

// ─── Auth: external API keys + paired devices + webhooks ────────────

export const apiKeys = pgTable('api_keys', {
  id: uuid('id').primaryKey().defaultRandom(),
  ownerSubject: text('owner_subject').notNull().default('self-hosted:operator'),
  name: text('name').notNull(),
  hashedKey: text('hashed_key').notNull().unique(),
  scopes: jsonb('scopes').$type<string[]>().notNull().default([]), // e.g. ['read:data','write:otp']
  connectionGrants: jsonb('connection_grants').$type<string[]>().notNull().default([]), // connectionIds, or ['*']
  // Set when this key is an OAuth-issued access token (minted by the /oauth/token exchange); NULL for a key
  // the operator minted directly. Cascades from the grant, so revoking/deleting a grant drops its tokens.
  grantId: uuid('grant_id').references((): AnyPgColumn => oauthGrants.id, { onDelete: 'cascade' }),
  /** Set only for a companion financial credential. It cannot outlive the
   * paired device and is rejected whenever that device is revoked. */
  deviceId: uuid('device_id').unique().references((): AnyPgColumn => devices.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  // Optional time-limit. NULL = never expires (manual revocation only); when set, the key is rejected
  // once past it, so a leaked key has a bounded blast radius.
  expiresAt: timestamp('expires_at', { withTimezone: true }),
}, (t) => ({
  byOwner: index('api_keys_owner_idx').on(t.ownerSubject),
}));

export const devices = pgTable('devices', {
  id: uuid('id').primaryKey().defaultRandom(),
  ownerSubject: text('owner_subject').notNull().default('self-hosted:operator'),
  name: text('name').notNull(),
  hashedToken: text('hashed_token').notNull().unique(),
  /** Exact connection ids selected during pairing. Wildcards are forbidden. */
  connectionGrants: jsonb('connection_grants').$type<string[]>().notNull().default([]),
  pushTransport: text('push_transport'), // fcm | unifiedpush | websocket
  pushToken: text('push_token'),
  pairedAt: timestamp('paired_at', { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
}, (t) => ({
  byOwner: index('devices_owner_idx').on(t.ownerSubject),
}));

/**
 * Short-lived, single-use companion pairing requests. QR/manual pairing
 * carries only the random request secret; final credentials are minted after
 * the phone claims it and the operator compares and approves the verification
 * code shown on both screens.
 */
export const devicePairingIntents = pgTable('device_pairing_intents', {
  id: uuid('id').primaryKey().defaultRandom(),
  ownerSubject: text('owner_subject').notNull(),
  name: text('name').notNull(),
  connectionGrants: jsonb('connection_grants').$type<string[]>().notNull().default([]),
  codeHash: text('code_hash').notNull().unique(),
  claimHash: text('claim_hash').unique(),
  verificationCode: text('verification_code'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  /** The credential pair minted by this intent. Retaining the structural link
   * lets an identical claimant recover from a lost completion response without
   * creating a second device or persisting either plaintext credential. */
  deviceId: uuid('device_id').unique().references(() => devices.id, { onDelete: 'set null' }),
  cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byOwner: index('device_pairing_intents_owner_idx').on(t.ownerSubject),
  byExpiry: index('device_pairing_intents_expiry_idx').on(t.expiresAt),
}));

export const webhooks = pgTable('webhooks', {
  id: uuid('id').primaryKey().defaultRandom(),
  ownerSubject: text('owner_subject').notNull().default('self-hosted:operator'),
  url: text('url').notNull(),
  secret: text('secret').notNull(), // HMAC signing secret
  events: jsonb('events').$type<string[]>().notNull().default([]),
  apiKeyId: uuid('api_key_id').references(() => apiKeys.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  disabledAt: timestamp('disabled_at', { withTimezone: true }),
}, (t) => ({
  byOwner: index('webhooks_owner_idx').on(t.ownerSubject),
}));

// ─── User-to-organisation sharing ─────────────────────────────────────────────

/**
 * A recipient organisation that an Accrawl user may share data with. Organisations
 * are administrative recipients, not resource owners: connections and financial
 * records always remain owned by the individual Identity Platform subject.
 */
export const organizations = pgTable('organizations', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  disabledAt: timestamp('disabled_at', { withTimezone: true }),
  provisioningId: text('provisioning_id'),
});

/**
 * An explicit, revocable user grant to one recipient organisation. Grants contain
 * exact current connection ids—never a wildcard—so adding a new bank connection
 * cannot silently expand an organisation's access.
 */
export const organizationShares = pgTable('organization_shares', {
  id: uuid('id').primaryKey().defaultRandom(),
  ownerSubject: text('owner_subject').notNull(),
  ownerEmail: text('owner_email').notNull(),
  organizationId: text('organization_id').notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  scopes: jsonb('scopes').$type<string[]>().notNull().default([]),
  connectionGrants: jsonb('connection_grants').$type<string[]>().notNull().default([]),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
}, (t) => ({
  byOwner: index('organization_shares_owner_idx').on(t.ownerSubject),
  byOrganization: index('organization_shares_organization_idx').on(t.organizationId),
  oneLiveSharePerRecipient: uniqueIndex('organization_shares_live_owner_organization_uq')
    .on(t.ownerSubject, t.organizationId)
    .where(sql`${t.revokedAt} is null`),
}));

// ─── OAuth 2.0 Authorization Server: "Connect with Accrawl" third-party access ──────
// Accrawl is the Authorization Server + Resource Server; the operator is the resource owner; a third-party
// app is the OAuth client. The flow is authorization-code + PKCE: the operator approves which scopes over
// which connections to share, a single-use code is exchanged for a scoped, expiring access token (an
// api_keys row), and that token flows through the SAME requireOperatorOrApiKey + keyGrantsConnection guards
// as an operator-minted key. See docs/spec-oauth.md.

/**
 * A registered third-party OAuth client (the "Connect with Accrawl" consumer app), created by the operator.
 * The clientSecret is shown ONCE and stored only as a SHA-256 hash (confidential clients); a public client
 * (isPublic) has no secret and MUST use PKCE. redirectUris is an exact-match allowlist; allowedScopes is the
 * ceiling consent can never exceed.
 */
export const oauthClients = pgTable('oauth_clients', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** Recipient organisation, not the financial-data owner. */
  recipientTenantId: text('recipient_tenant_id').notNull().default('self-hosted'),
  clientId: text('client_id').notNull().unique(), // public identifier the 3rd party embeds (accl_…)
  hashedSecret: text('hashed_secret'), // SHA-256 of the client_secret; NULL for public (PKCE-only) clients
  name: text('name').notNull(),
  isPublic: boolean('is_public').notNull().default(false),
  redirectUris: jsonb('redirect_uris').$type<string[]>().notNull().default([]), // exact-match allowlist
  allowedScopes: jsonb('allowed_scopes').$type<string[]>().notNull().default([]), // consent ceiling
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  disabledAt: timestamp('disabled_at', { withTimezone: true }),
});

/**
 * A single-use OAuth authorization code, minted when the operator approves a consent request and exchanged
 * exactly once at /oauth/token for an access token. Stored only as a SHA-256 hash; ~5-minute TTL; consumedAt
 * makes a replay a hard failure. Carries the exact redirect_uri (must match at exchange), the consented
 * scopes + connection grants, and the PKCE challenge.
 */
export const authorizationCodes = pgTable('authorization_codes', {
  id: uuid('id').primaryKey().defaultRandom(),
  ownerSubject: text('owner_subject').notNull().default('self-hosted:operator'),
  codeHash: text('code_hash').notNull().unique(),
  clientId: uuid('client_id').notNull().references(() => oauthClients.id, { onDelete: 'cascade' }),
  redirectUri: text('redirect_uri').notNull(),
  scopes: jsonb('scopes').$type<string[]>().notNull().default([]),
  connectionGrants: jsonb('connection_grants').$type<string[]>().notNull().default([]),
  codeChallenge: text('code_challenge'), // PKCE S256 challenge (required for public clients)
  codeChallengeMethod: text('code_challenge_method'), // 'S256' only ('plain' is rejected)
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byOwner: index('authorization_codes_owner_idx').on(t.ownerSubject),
  byClient: index('authorization_codes_client_idx').on(t.clientId),
}));

/**
 * The operator's standing consent for a client — the "connected app": which scopes over which connections,
 * with an expiry (the ~90-day / 3-month clock) and first-party operator revocation. Access tokens (api_keys
 * rows, via api_keys.grant_id) and refresh tokens reference the grant; revoking it invalidates them.
 */
export const oauthGrants = pgTable('oauth_grants', {
  id: uuid('id').primaryKey().defaultRandom(),
  ownerSubject: text('owner_subject').notNull().default('self-hosted:operator'),
  clientId: uuid('client_id').notNull().references(() => oauthClients.id, { onDelete: 'cascade' }),
  scopes: jsonb('scopes').$type<string[]>().notNull().default([]),
  connectionGrants: jsonb('connection_grants').$type<string[]>().notNull().default([]),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
}, (t) => ({
  byOwner: index('oauth_grants_owner_idx').on(t.ownerSubject),
  byClient: index('oauth_grants_client_idx').on(t.clientId),
}));

/**
 * A rotating, single-use refresh token bound to a grant. Stored only as a SHA-256 hash; presenting it mints
 * a fresh access+refresh pair and marks this one consumed (rotation with reuse-detection).
 */
export const oauthRefreshTokens = pgTable('oauth_refresh_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  tokenHash: text('token_hash').notNull().unique(),
  grantId: uuid('grant_id').notNull().references(() => oauthGrants.id, { onDelete: 'cascade' }),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
}, (t) => ({
  byGrant: index('oauth_refresh_tokens_grant_idx').on(t.grantId),
}));

/** The scheduler's due-rotation index (one row per connection); the cron handler advances it. */
export const connectionsDue = pgTable('connections_due', {
  connectionId: uuid('connection_id').primaryKey().references(() => connections.id, { onDelete: 'cascade' }),
  nextCrawlAt: timestamp('next_crawl_at', { withTimezone: true }).notNull(),
}, (t) => ({
  byNext: index('connections_due_next_idx').on(t.nextCrawlAt),
}));

/**
 * The single self-host operator credential, set by the first-run setup flow. Exactly one row (the CHECK
 * pins id=1). The admin password is stored ONLY as an argon2id hash — never plaintext. tokenSigningSecret
 * is a random secret minted at setup time and used to HMAC-sign operator session tokens, so rotating the
 * password (or re-running setup) invalidates outstanding tokens.
 */
export const operatorCredential = pgTable('operator_credential', {
  id: integer('id').primaryKey().notNull(),
  passwordHash: text('password_hash').notNull(),
  tokenSigningSecret: text('token_signing_secret').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  singleton: check('operator_credential_singleton', sql`${t.id} = 1`),
}));

/**
 * Per-deployment IMAP source for the email-OTP tier (tier-b 2FA). Single row (CHECK id=1). The watcher polls
 * this inbox and relays OTP emails to awaiting sessions (see email-otp/). The IMAP password is stored ONLY as
 * envelope ciphertext (passwordCt) — never plaintext, like connection credentials. `enabled` lets the operator
 * pause the watcher without deleting the config.
 */
export const emailOtpConfig = pgTable('email_otp_config', {
  id: integer('id').primaryKey().notNull(),
  host: text('host').notNull(),
  port: integer('port').notNull(),
  secure: boolean('secure').notNull().default(true), // implicit TLS (IMAPS, typically port 993)
  username: text('username').notNull(),
  passwordCt: text('password_ct').notNull(), // envelope-encrypted at rest
  folder: text('folder').notNull().default('INBOX'),
  enabled: boolean('enabled').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  singleton: check('email_otp_config_singleton', sql`${t.id} = 1`),
}));

/**
 * Append-only audit trail for sensitive admin actions (device pair/revoke, API-key create/revoke,
 * connection create/delete, manual crawl-now, OTP submit, session cancel). Write-only from the app — the
 * row is never updated or deleted in the request path; retention/pruning is an out-of-band concern. actorId
 * is nullable because some actors are anonymous-but-authenticated (e.g. the single operator has no id) or
 * a device's id is the relevant actor. sourceIp is the proxied client IP (req.ip, trustProxy-resolved).
 */
export const auditLog = pgTable('audit_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  actorType: text('actor_type').notNull(), // 'operator' | 'device' | 'api_key' | 'oauth_client' | 'system'
  actorId: text('actor_id'),
  action: text('action').notNull(), // e.g. 'connection.create', 'api_key.revoke', 'session.cancel'
  targetType: text('target_type'),
  targetId: text('target_id'),
  sourceIp: text('source_ip'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byCreatedAt: index('audit_log_created_at_idx').on(t.createdAt),
}));
