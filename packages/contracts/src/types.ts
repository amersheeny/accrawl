/**
 * Accrawl shared contract — the crawl request/response and normalized domain
 * types that cross the engine ⇄ control-plane API ⇄ web UI boundary. Single
 * source of truth (consumed via `@accrawl/contracts`) so the three never drift.
 */

// ─── Crawl Request / Response ───────────────────────────────────────

export interface CrawlRecentTransaction {
  providerAccountId: string;
  /** Canonical id already stored for this transaction occurrence. */
  providerTransactionId: string;
  bookingDate: string;
  amount: number;
  currency: string;
  description: string;
  isPending: boolean;
}

/** Count and SHA-256 fence for one received-order transaction-history list. */
export interface RecentTransactionHistoryManifest {
  version: 'v1';
  itemCount: number;
  byteLength: number;
  chunkCount: number;
  sha256: string;
}

/** One ordered base64 fragment of the received-order transaction-history JSON bytes. */
export interface RecentTransactionHistoryChunk {
  index: number;
  byteLength: number;
  sha256: string;
  data: string;
}

/** Request payload sent by the caller (control-plane) to the crawl engine. */
export interface CrawlRequest {
  /** Session ID for tracking */
  sessionId: string;
  /**
   * Where a worker that runs somewhere else should look for its own session, and which attempt it is
   * allowed to claim. Present only when the durable session is kept outside this process.
   *
   * This is an internal control-plane → engine field. It never reaches public client APIs and carries
   * no secret.
   */
  workerContext?: {
    namespace: string;
    runtimePartitionId: string;
    attemptId: string;
  };
  /**
   * The same thing under the name it used to have.
   *
   * A release updates workers before the control plane, so for one release a new worker is fed by a
   * control plane that still emits the old name. Readers take whichever is present; the next release
   * drops this, once nothing emits it.
   *
   * @deprecated use {@link CrawlRequest.workerContext}
   */
  firestoreWorker?: {
    namespace: string;
    runtimePartitionId: string;
    attemptId: string;
  };
  /** Institution login URL */
  loginUrl: string;
  /** Registrable domains (SSO/CDN) the browser may reach beyond loginUrl's eTLD+1. Drives the
   *  engine egress guard — any request off the pinned domain + these is blocked as exfiltration. */
  allowedDomains?: string[];
  /** Plaintext username (decrypted by the caller) */
  username: string;
  /** Plaintext password (decrypted by the caller) */
  password: string;
  /** Plaintext date of birth (if required) */
  dob?: string;
  /** Plaintext phone number (if required) */
  phone?: string;
  /** AI agent playbook (institution-specific instructions) */
  playbook?: string;
  /** User custom instructions */
  customInstructions?: string;
  /** Extraction hints */
  extractionHints?: ExtractionHints;
  /** Login form hints */
  loginHints?: LoginHints;
  /** Whether this institution requires 2FA */
  requires2fa: boolean;
  /** OTP SMS sender regex pattern */
  otpSenderPattern?: string;
  /** Institution country code (for browser locale/timezone) */
  country?: string;
  /** Max AI agent steps */
  maxSteps: number;
  /** Timeout in seconds */
  timeoutSeconds: number;
  /** Route browser traffic through user's device via SOCKS5 tunnel */
  useDeviceProxy?: boolean;
  /** Short-lived HMAC tunnel token (control-plane-minted, session+device-bound) the engine presents to
   *  open the device-proxy WS. Only set when `useDeviceProxy` is true. */
  tunnelToken?: string;
  /** Gemini model ID to use (e.g. "gemini-2.5-flash", "gemini-2.5-flash-lite") */
  model?: string;
  /** Per-crawl reasoning depth. Omitted → the engine's default ('medium'). */
  thinkingLevel?: 'minimal' | 'low' | 'medium' | 'high';
  /** Known accounts from previous crawls — AI should reuse these providerAccountIds */
  existingAccounts?: Array<{
    providerAccountId: string;
    name: string;
    description?: string;
    currency: string;
    type: string;
    balance?: number;
  }>;
  /** Known positions from previous crawls — AI should reuse these providerPositionIds */
  existingPositions?: Array<{
    providerPositionId: string;
    providerAccountId?: string;
    symbol: string;
    name: string;
    currency: string;
    quantity: number;
  }>;
  /** Recent transactions from previous crawls. The model treats this as an
   *  occurrence-preserving multiset:
   *  - An observed row carrying the same trustworthy bank reference may be skipped.
   *  - `existingCanonicalId` is reserved for a one-to-one, evidence-backed
   *    pending→posted or synthetic→real-reference transition.
   *  - Equal-looking surplus rows remain separate new transaction occurrences. */
  recentTransactions?: CrawlRecentTransaction[];
  /** Required whenever `recentTransactions` is present. The engine verifies it
   *  before the list is allowed to influence model decisions. */
  recentTransactionsManifest?: RecentTransactionHistoryManifest;
  /** Hard floor for tx extraction (YYYY-MM-DD). Model must NOT return any
   *  transaction whose booking date is older than this date. Our system
   *  already has every tx older than the cutoff under its canonical id. */
  cutoffDate?: string;
  /** Floor for an account we hold no transactions for (YYYY-MM-DD), which
   *  `cutoffDate` must not govern: nothing is stored for such an account, so the
   *  cutoff's premise — that everything older is already held — is false for it.
   *  Matches the storage floor, so history extracted back to here is accepted. */
  historyFloorDate?: string;
  /** providerAccountIds of KNOWN accounts we hold no transactions for at all —
   *  computed from every stored row, not the windowed comparison list, so an
   *  account whose history merely predates the window is never included. These
   *  reach back to `historyFloorDate`; an account absent from `existingAccounts`
   *  is unknown and does the same. */
  accountsWithoutStoredHistory?: string[];
  /** Crawl memory — data location hints from previous crawls */
  crawlMemory?: CrawlMemory;
}

export interface ExtractionHints {
  dateFormat?: string;
  currency?: string;
  accountsSelector?: string;
  transactionsSelector?: string;
  positionsSelector?: string;
}

export interface LoginHints {
  usernameField?: string;
  passwordField?: string;
  dobField?: string;
  phoneField?: string;
  submitButton?: string;
}

/** Response returned by the crawl engine. */
/**
 * Immediate acknowledgment of a crawl dispatch. The engine validates the request, starts the crawl in
 * the background, and ACKs right away — the outcome is read from the session row / staged records, never
 * from a held HTTP response (a connection held for the length of a crawl dies on standard ~5-minute
 * client/proxy header timeouts).
 */
export interface CrawlAck {
  accepted: boolean;
  sessionId?: string;
  error?: string;
}

export interface CrawlResponse {
  success: boolean;
  accounts?: NormalizedAccount[];
  transactions?: NormalizedTransaction[];
  positions?: NormalizedPosition[];
  error?: string;
  /** Classified failure reason (only set on a failed crawl) for observability/alerting. */
  failureReason?: CrawlFailureReason;
  stepsExecuted: number;
  stepLogs?: CrawlStepLog[];
  /** AI token usage and cost for this crawl session */
  cost?: CrawlCost;
  /** Crawl memory — data location hints for future crawls */
  crawlMemory?: CrawlMemory;
}

// ─── Normalized Financial Data ──────────────────────────────────────

export interface NormalizedAccount {
  providerAccountId: string;
  name: string;
  description: string;
  currency: string;
  type: 'current' | 'savings' | 'credit' | 'investment' | 'broker_cash' | 'pension' | 'study_fund' | 'loan' | 'mortgage' | 'other';
  /** The booked/current balance (native currency). Projected to `balance.current` in the read contract. */
  balance: number;
  /** Spendable balance incl. pending flows and any overdraft/credit — when the institution exposes it. */
  available?: number;
  /** Credit limit (credit accounts) or arranged overdraft (depository) — when exposed. */
  limit?: number;
  /** Optional credit-card liability overlay; only meaningful on credit accounts. */
  creditCardLiability?: CreditCardLiability;
  /** Optional pension overlay; only meaningful on pension accounts. */
  pensionDetail?: PensionDetail;
}

/** Optional credit-card liability overlay (spec §9). Every field optional — institutions vary. */
export interface CreditCardLiability {
  /** APR entries. `type` mirrors the industry-common set (purchase/cash/balance_transfer/penalty/other). */
  aprs?: Array<{ percentage: number; type?: 'purchase' | 'cash' | 'balance_transfer' | 'penalty' | 'other' }>;
  lastStatementDate?: string; // YYYY-MM-DD
  lastStatementBalance?: number;
  minimumPaymentAmount?: number;
  nextPaymentDueDate?: string; // YYYY-MM-DD
}

/** Optional pension overlay (spec §10). Every field optional; `scheme` mirrors the account subtype. */
export interface PensionDetail {
  scheme?: 'defined_benefit' | 'defined_contribution' | 'provident_fund' | 'study_fund' | 'other';
  employer?: string;
  contributionsToDate?: number;
  vestedValue?: number;
}

export interface NormalizedTransaction {
  /** Account this transaction belongs to (should match a NormalizedAccount.providerAccountId) */
  providerAccountId?: string;
  providerTransactionId: string;
  bookingDate: string;
  amount: number;
  currency: string;
  merchant?: string;
  description: string;
  providerCategory?: string;
  /** Optional two-level enrichment overlay (spec §7.3). Accrawl's own taxonomy; `providerCategory`
   *  keeps the institution's raw label untouched alongside it. */
  category?: { primary: string; detailed?: string };
  isPending: boolean;
  /** Internal crawl-to-store update target. Present only when the observed row is a one-to-one
   *  update of a previously supplied canonical transaction. Never exposed by the read API. */
  existingCanonicalId?: string;
  /** Explicit prompt-rule-26b multiplicity. The model reports genuinely identical page rows as
   *  one transaction with `count: N`; the engine expands the claim before hand-off. Default 1. */
  count?: number;
  /** Internal occurrence identity accepted for storage/recovery compatibility. Transaction
   *  accumulation does not mint or use it as content identity. Never exposed by the read API. */
  extractionOccurrenceId?: string;
}

export interface NormalizedPosition {
  providerPositionId: string;
  /** Account this holding belongs to (matches a NormalizedAccount.providerAccountId). Optional
   *  because older records and providers that don't surface the link won't have it. */
  providerAccountId?: string;
  /** Real market ticker (e.g. AAPL). Omitted for securities with no public
   *  ticker (e.g. a locally-listed tracking fund); the provider's internal code
   *  lives in providerPositionId. */
  symbol?: string;
  name: string;
  quantity: number;
  currency: string;
  valueNative: number;
  costBasisNative?: number;
  /** ISIN if shown on the page — the strongest cross-broker identity + the key
   *  to classifying otherwise-anonymous funds (e.g. locally-listed tracking funds). */
  isin?: string;
  /** Listing exchange/market code if shown (e.g. LSE, NASDAQ, XETRA). */
  exchange?: string;
  /** Provider security-type label if shown (e.g. ETF, mutual fund, bond, stock). */
  securityType?: string;
}

// ─── Token Usage & Cost ─────────────────────────────────────────────

/** Raw token counts from a single AI API call. */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

/** Calculated cost for a crawl session in USD. */
export interface CrawlCost {
  /** Model ID used (e.g. "gemini-2.5-flash") */
  modelId: string;
  /** Total input tokens (excluding cache) */
  inputTokens: number;
  /** Total output tokens */
  outputTokens: number;
  /** Total cache creation tokens */
  cacheCreationInputTokens: number;
  /** Total cache read tokens */
  cacheReadInputTokens: number;
  /** Cost of input tokens in USD */
  inputCostUsd: number;
  /** Cost of output tokens in USD */
  outputCostUsd: number;
  /** Cost of cache creation tokens in USD */
  cacheCreationCostUsd: number;
  /** Cost of cache read tokens in USD */
  cacheReadCostUsd: number;
  /** Total cost in USD */
  totalCostUsd: number;
}

// ─── Crawl Step Log ─────────────────────────────────────────────────

/** A single step in the crawl log — persisted for run history. */
export interface CrawlStepLog {
  stepNumber: number;
  action: string;
  description?: string;
  selector?: string;
  /** Fill/select value (placeholder name like USERNAME/PASSWORD, or literal option text — never real credentials) */
  value?: string;
  /** Wait duration in milliseconds (for wait actions) */
  ms?: number;
  /** Scroll direction (for scroll actions) */
  direction?: 'up' | 'down';
  /** Scroll amount in pixels (for scroll actions) */
  amount?: number;
  /** Navigation target URL (for navigate actions — distinct from `url` which is the page URL after step) */
  navigateUrl?: string;
  /** Memory notes emitted by this step */
  memoryNotes?: Array<{ key: string; value: string }>;
  /** Exact post-action feedback injected into the next model turn (ACTION_FEEDBACK_JSON...). */
  actionFeedback?: string;
  /**
   * Present when the model's original action failed and error recovery executed
   * a (possibly different) retry action in its place. The top-level
   * action/selector/value fields describe what was ACTUALLY executed (the
   * substitute); this preserves the original failed action for the audit trail.
   */
  originalStep?: {
    action: string;
    description?: string;
    selector?: string;
  };
  url: string;
  durationMs: number;
  screenshotPath?: string;
  screenshotUrl?: string;
  accountsExtracted: number;
  transactionsExtracted: number;
  positionsExtracted: number;
  error?: string;
  timestamp: string; // ISO 8601
  /** Token usage for this step's AI API call */
  tokenUsage?: TokenUsage;
}

// ─── Crawl Memory ───────────────────────────────────────────────────

/**
 * Crawl memory — free-text notes from the AI about where data was found.
 * Stored on the connection and passed to the next crawl so the model can
 * look in known locations first, reducing token usage.
 *
 * Intentionally unstructured — the model writes whatever is useful for its
 * future self (page URLs, HTML char ranges, CSS selectors, layout notes).
 */
export type CrawlMemory = string;

// ─── Failure Taxonomy ───────────────────────────────────────────────
//
// Classified failure reason persisted on the crawl session. This is a
// transport/outcome classification — NOT an LLM decision. It lets a schema-drift
// outage be detected/alerted immediately (api_contract_drift) instead of hiding
// behind an opaque "internal_error". Keep classification narrow: only label a
// reason identifiable confidently from the error signature; everything else is
// internal_error.

export type CrawlFailureReason =
  | 'api_contract_drift'
  | 'bank_login_failed'
  | 'otp_timeout'
  | 'otp_relay_unreachable'
  | 'waf_block'
  | 'outside_hours'
  | 'site_unavailable'
  | 'instance_died'
  | 'page_capture_timeout'
  | 'navigation_timeout'
  | 'crawl_watchdog'
  | 'internal_error';
