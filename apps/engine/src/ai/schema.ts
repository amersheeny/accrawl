/**
 * AI Tool Contracts
 *
 * Defines step action schemas in two forms:
 * - Zod schemas: for validating function call args received from the model
 * - Native Gemini Schema objects: for function declarations sent to the API
 *
 * Using native Gemini Schema (parameters field) instead of parametersJsonSchema
 * ensures Gemini's grammar engine compiles grammars correctly without encountering
 * unsupported JSON Schema features (e.g. additionalProperties: false).
 */

import { z, toJSONSchema } from 'zod';
import GenAI = require('@google/genai');
import type { Schema } from '@google/genai' with { 'resolution-mode': 'require' };
import type { CreditCardLiability, PensionDetail } from '@accrawl/contracts';

const { Type } = GenAI;

// ─── Schema helpers ───────────────────────────────────────────────────────────

type JsonSchemaObject = Record<string, unknown>;

function toProviderJsonSchema(schema: z.ZodTypeAny): JsonSchemaObject {
  const json = toJSONSchema(schema) as JsonSchemaObject;
  // Providers don't need the draft metadata field.
  delete json.$schema;
  return json;
}

function formatZodError(error: z.ZodError): string {
  return z.prettifyError(error).replace(/\n+/g, ' | ').trim();
}

function parseOrThrow<T>(schema: z.ZodType<T>, input: unknown, context: string): T {
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data;
  throw new Error(`${context}: ${formatZodError(parsed.error)}`);
}

// ─── Actions ─────────────────────────────────────────────────────────────────

/** Action types that require a selector field */
export const SELECTOR_ACTIONS = ['click', 'fill', 'select'] as const;

/** Action types that have NO selector field */
export const NO_SELECTOR_ACTIONS = ['wait', 'scroll', 'navigate', 'loginFlowRestarted', 'waitForOtp', 'loginComplete', 'complete', 'error', 'reportData'] as const;

/** All supported agent step actions */
export const ALL_ACTIONS = [...SELECTOR_ACTIONS, ...NO_SELECTOR_ACTIONS] as const;

export type StepAction = (typeof ALL_ACTIONS)[number];

/** Browser-executable actions (non-terminal). */
export const EXECUTABLE_ACTIONS = ['click', 'fill', 'select', 'wait', 'scroll', 'navigate'] as const;

export type ExecutableAction = (typeof EXECUTABLE_ACTIONS)[number];

// ─── Shared data item schemas ────────────────────────────────────────────────

// Optional read-side overlays (spec §9/§10). Only meaningful on credit / pension accounts; the model
// fills them ONLY when the values are explicitly visible. Kept lean to avoid bloating the grammar.
const CREDIT_CARD_LIABILITY_SCHEMA = z.object({
  aprs: z.array(z.object({
    percentage: z.number(),
    type: z.enum(['purchase', 'cash', 'balance_transfer', 'penalty', 'other']).optional(),
  }).strict()).optional(),
  lastStatementDate: z.string().optional(),
  lastStatementBalance: z.number().optional(),
  minimumPaymentAmount: z.number().optional(),
  nextPaymentDueDate: z.string().optional(),
}).strict();

const PENSION_DETAIL_SCHEMA = z.object({
  scheme: z.enum(['defined_benefit', 'defined_contribution', 'provident_fund', 'study_fund', 'other']).optional(),
  employer: z.string().optional(),
  contributionsToDate: z.number().optional(),
  vestedValue: z.number().optional(),
}).strict();

const ACCOUNT_ITEM_SCHEMA = z.object({
  providerAccountId: z.string(),
  name: z.string(),
  description: z.string(),
  currency: z.string(),
  type: z.enum(['current', 'savings', 'credit', 'investment', 'broker_cash', 'pension', 'study_fund', 'loan', 'mortgage', 'other']),
  balance: z.number(),
  available: z.number().optional(),
  limit: z.number().optional(),
  creditCardLiability: CREDIT_CARD_LIABILITY_SCHEMA.optional(),
  pensionDetail: PENSION_DETAIL_SCHEMA.optional(),
}).strict();

const TRANSACTION_ITEM_SCHEMA = z.object({
  providerAccountId: z.string(),
  providerTransactionId: z.string(),
  bookingDate: z.string(),
  amount: z.number(),
  currency: z.string(),
  merchant: z.string().optional(),
  description: z.string(),
  providerCategory: z.string().optional(),
  isPending: z.boolean(),
  // OPTIONAL — set ONLY when this row is a status/id update for an
  // already-stored transaction the model was shown in `recentTransactions`.
  // The model must copy the canonical id verbatim from the prior list. The
  // backend uses this to merge the new state onto the existing doc instead of
  // creating a new one.
  existingCanonicalId: z.string().optional(),
  // EXPLICIT multiplicity (prompt rule 26b): N genuinely identical page rows are
  // represented by one entry with count: N. Accidental repeated entries collapse;
  // only this deliberate claim materializes multiple records at hand-off.
  count: z.number().int().min(1).optional(),
}).strict();

const POSITION_ITEM_SCHEMA = z.object({
  providerPositionId: z.string(),
  providerAccountId: z.string().min(1),
  identifier: z.string(),
  ticker: z.string().optional(),
  name: z.string(),
  quantity: z.number(),
  currency: z.string(),
  valueNative: z.number(),
  costBasisNative: z.number().optional(),
  isin: z.string().optional(),
  exchange: z.string().optional(),
  securityType: z.string().optional(),
}).strict();

const MEMORY_NOTE_ITEM_SCHEMA = z.object({
  key: z.string().describe('Short structural label (e.g. selector name, page label). No user data.'),
  value: z.string().describe('Structural/navigational value only — a CSS selector, URL, page layout observation. NEVER a financial amount, balance, account number, or any user data.'),
}).strict();

const REPORT_DATA_PAYLOAD_SCHEMA = z.object({
  description: z.string(),
  accounts: z.array(ACCOUNT_ITEM_SCHEMA).optional(),
  transactions: z.array(TRANSACTION_ITEM_SCHEMA).optional(),
  positions: z.array(POSITION_ITEM_SCHEMA).optional(),
  memoryNotes: z.array(MEMORY_NOTE_ITEM_SCHEMA).optional(),
}).strict();

// ─── Step payload schemas by action (without action discriminant) ───────────

const optionalMemoryNotes = {
  memoryNotes: z.array(MEMORY_NOTE_ITEM_SCHEMA).optional()
    .describe('Structural notes only (selectors, URLs, layout). NEVER include user financial data — no balances, amounts, account numbers.'),
};

/**
 * Model-declared classification of a terminal error. The model saw the page,
 * so it is the authority on WHY the crawl cannot continue (bot-block page vs
 * closed-hours notice vs rejected credentials). The platform maps these onto
 * CrawlFailureReason for alerting/retry policy — no text-pattern guessing.
 */
export const STEP_ERROR_CATEGORIES = [
  'access_blocked',
  'outside_operating_hours',
  'credentials_rejected',
  'site_unavailable',
  'other',
] as const;
export type StepErrorCategory = typeof STEP_ERROR_CATEGORIES[number];

const STEP_ERROR_CATEGORY_DESCRIPTION =
  'Classify the unrecoverable error: "access_blocked" = the site is blocking automated/this-network access ' +
  '(bot-detection page, WAF block, interactive CAPTCHA challenge, "unusual activity" page); ' +
  '"outside_operating_hours" = the site says it is closed at this time; ' +
  '"credentials_rejected" = the site explicitly rejected the username/password as invalid (only when the page says so); ' +
  '"site_unavailable" = the site itself is down or erroring (maintenance page, 5xx error page, endless load); ' +
  '"other" = anything else.';

const STEP_PAYLOAD_SCHEMAS_BY_ACTION = {
  click: z.object({
    description: z.string(),
    selector: z.string(),
    ...optionalMemoryNotes,
  }).strict(),
  fill: z.object({
    description: z.string(),
    selector: z.string(),
    value: z.string(),
    ...optionalMemoryNotes,
  }).strict(),
  select: z.object({
    description: z.string(),
    selector: z.string(),
    value: z.string(),
    ...optionalMemoryNotes,
  }).strict(),
  wait: z.object({
    description: z.string(),
    ms: z.number().optional(),
    ...optionalMemoryNotes,
  }).strict(),
  scroll: z.object({
    description: z.string(),
    direction: z.enum(['up', 'down']).optional(),
    amount: z.number().optional(),
    ...optionalMemoryNotes,
  }).strict(),
  navigate: z.object({
    description: z.string(),
    url: z.string().startsWith('http'),
    ...optionalMemoryNotes,
  }).strict(),
  loginFlowRestarted: z.object({
    description: z.string(),
    ...optionalMemoryNotes,
  }).strict(),
  waitForOtp: z.object({
    description: z.string(),
    otpEvidence: z.string().describe(
      'Cite NEW content that appeared on the page after submit that confirms an OTP/verification step is active. ' +
      'You must reference content that was NOT on the login form before submit — e.g. ' +
      '"New input #otp-code appeared after submit", "page now shows \'Enter the code sent to ***1234\' which was not present before." ' +
      'Text already on the login form (like "Login via SMS" or "one-time password") is NOT evidence.'
    ),
    ...optionalMemoryNotes,
  }).strict(),
  loginComplete: z.object({
    description: z.string(),
    ...optionalMemoryNotes,
  }).strict(),
  complete: z.object({
    description: z.string(),
    ...optionalMemoryNotes,
  }).strict(),
  error: z.object({
    description: z.string(),
    message: z.string().optional(),
    // Optional in validation so a category-less call still terminates the
    // crawl cleanly; the Gemini declaration marks it required so the model
    // always classifies.
    category: z.enum(STEP_ERROR_CATEGORIES).optional()
      .describe(STEP_ERROR_CATEGORY_DESCRIPTION),
    ...optionalMemoryNotes,
  }).strict(),
  reportData: REPORT_DATA_PAYLOAD_SCHEMA,
} as const satisfies Record<StepAction, z.ZodTypeAny>;

interface DataReport {
  accounts: Array<{ providerAccountId: string; name: string; description: string; currency: string; type: 'current' | 'savings' | 'credit' | 'investment' | 'broker_cash' | 'pension' | 'study_fund' | 'loan' | 'mortgage' | 'other'; balance: number; available?: number; limit?: number; creditCardLiability?: CreditCardLiability; pensionDetail?: PensionDetail }>;
  transactions: Array<{ providerAccountId: string; providerTransactionId: string; bookingDate: string; amount: number; currency: string; merchant?: string; description: string; providerCategory?: string; isPending: boolean; existingCanonicalId?: string; count?: number }>;
  positions: Array<{ providerPositionId: string; providerAccountId: string; symbol?: string; name: string; quantity: number; currency: string; valueNative: number; costBasisNative?: number; isin?: string; exchange?: string; securityType?: string }>;
  memoryNotes: Array<{ key: string; value: string }>;
}

interface ReportPositionInput {
  providerPositionId?: string;
  providerAccountId: string;
  identifier: string;
  ticker?: string;
  name: string;
  quantity: number;
  currency: string;
  valueNative: number;
  costBasisNative?: number;
  isin?: string;
  exchange?: string;
  securityType?: string;
}

interface ReportDataPayload {
  description: string;
  accounts?: DataReport['accounts'];
  transactions?: DataReport['transactions'];
  positions?: ReportPositionInput[];
  memoryNotes?: DataReport['memoryNotes'];
}

/**
 * Normalized step response consumed by the agent loop.
 * Non-report actions are normalized with empty data arrays.
 */
export interface StepResponse extends DataReport {
  action: StepAction;
  description: string;
  selector?: string;
  value?: string;
  ms?: number;
  direction?: 'up' | 'down';
  amount?: number;
  url?: string;
  message?: string;
  category?: StepErrorCategory;
  otpEvidence?: string;
}

export type ExecutableStepResponse = StepResponse & { action: ExecutableAction };

function emptyDataReport(): DataReport {
  return { accounts: [], transactions: [], positions: [], memoryNotes: [] };
}

// ─── Step tool names and Gemini function declarations ───────────────────────

export const STEP_TOOL_NAMES_BY_ACTION = {
  click: ['step_click'],
  fill: ['step_fill'],
  select: ['step_select'],
  wait: ['step_wait'],
  scroll: ['step_scroll'],
  navigate: ['step_navigate'],
  loginFlowRestarted: ['step_login_flow_restarted'],
  waitForOtp: ['step_wait_for_otp'],
  loginComplete: ['step_login_complete'],
  complete: ['step_complete'],
  error: ['step_error'],
  reportData: ['step_report_data'],
} as const satisfies Record<StepAction, readonly string[]>;

export type StepToolName = typeof STEP_TOOL_NAMES_BY_ACTION[keyof typeof STEP_TOOL_NAMES_BY_ACTION][number];

export const STEP_PRIMARY_TOOL_NAME_BY_ACTION = Object.fromEntries(
  (Object.entries(STEP_TOOL_NAMES_BY_ACTION) as Array<[StepAction, readonly StepToolName[]]>).map(([action, names]) => [action, names[0]]),
) as Record<StepAction, StepToolName>;

export const STEP_ACTION_BY_TOOL_NAME = Object.fromEntries(
  (Object.entries(STEP_TOOL_NAMES_BY_ACTION) as Array<[StepAction, readonly StepToolName[]]>)
    .flatMap(([action, names]) => names.map(name => [name, action])),
) as Record<StepToolName, StepAction>;

export function isStepToolName(name: string): boolean {
  return STEP_ACTION_BY_TOOL_NAME[name as StepToolName] !== undefined;
}

const STEP_TOOL_ZOD_SCHEMAS = {
  step_click: STEP_PAYLOAD_SCHEMAS_BY_ACTION.click,
  step_fill: STEP_PAYLOAD_SCHEMAS_BY_ACTION.fill,
  step_select: STEP_PAYLOAD_SCHEMAS_BY_ACTION.select,
  step_wait: STEP_PAYLOAD_SCHEMAS_BY_ACTION.wait,
  step_scroll: STEP_PAYLOAD_SCHEMAS_BY_ACTION.scroll,
  step_navigate: STEP_PAYLOAD_SCHEMAS_BY_ACTION.navigate,
  step_login_flow_restarted: STEP_PAYLOAD_SCHEMAS_BY_ACTION.loginFlowRestarted,
  step_wait_for_otp: STEP_PAYLOAD_SCHEMAS_BY_ACTION.waitForOtp,
  step_login_complete: STEP_PAYLOAD_SCHEMAS_BY_ACTION.loginComplete,
  step_complete: STEP_PAYLOAD_SCHEMAS_BY_ACTION.complete,
  step_error: STEP_PAYLOAD_SCHEMAS_BY_ACTION.error,
  step_report_data: REPORT_DATA_PAYLOAD_SCHEMA,
} as const satisfies Record<StepToolName, z.ZodTypeAny>;

/** Per-tool input payload schemas (Zod) used for inspection/testing/debugging. */
export const STEP_INPUT_ZOD_SCHEMA_BY_TOOL_NAME = STEP_TOOL_ZOD_SCHEMAS;

/** Per-tool input payload schemas (JSON Schema) for inspection/testing/debugging. */
export const STEP_INPUT_SCHEMA_BY_TOOL_NAME = Object.fromEntries(
  (Object.entries(STEP_TOOL_ZOD_SCHEMAS) as Array<[StepToolName, z.ZodTypeAny]>).map(([toolName, schema]) => [
    toolName,
    toProviderJsonSchema(schema),
  ]),
) as Record<StepToolName, JsonSchemaObject>;

// ─── Native Gemini Schema objects for step function declarations ─────────────
//
// Using parameters (native Schema) instead of parametersJsonSchema so Gemini's
// grammar engine compiles grammars directly without encountering unsupported
// JSON Schema features like additionalProperties: false.
//
// Constraints below use ONLY what Gemini's structured-output grammar engine
// actually enforces for STRING fields: `format` (e.g. 'date') and `enum`.
// Per the Gemini structured-output docs, `pattern` (regex) is NOT supported and
// is silently ignored — so we never add a `pattern`, which would give a false
// sense of enforcement. Constraining bookingDate with format:'date' is what
// prevents the documented incident where the model emitted reasoning text into
// an unconstrained date field.

/**
 * Every current ISO-4217 currency code, taken from the runtime's own ICU data
 * (`Intl.supportedValuesOf('currency')`) — no dependency, no network, and no table anyone has to
 * maintain by eye. Historical codes are excluded by ICU, so a bank cannot be reported in a currency
 * that no longer exists.
 *
 * The enum exists to stop the model inventing a code, NOT to decide which currencies the product
 * serves. That distinction was previously lost: this list held 31 codes chosen as one FX provider's
 * reference set, which is 19% of the world's currencies, and because the model is CONSTRAINED to the
 * enum it could not report an account in any of the other 131 — it had to emit a wrong code instead.
 * An account in dirhams, riyals, naira, rupees, dong or new Taiwan dollars was therefore not rejected
 * but silently MISLABELLED, and every figure derived from it was wrong. Storage never agreed with that
 * restriction anyway; it validates the shape (`^[A-Z]{3}$`) and always has.
 *
 * currency-codes.test.ts fails if the runtime knows a code this list does not, so the list cannot
 * quietly fall behind ICU again.
 */
export const SUPPORTED_CURRENCY_CODES = [
  'AED', 'AFN', 'ALL', 'AMD', 'ANG', 'AOA', 'ARS', 'AUD', 'AWG', 'AZN',
  'BAM', 'BBD', 'BDT', 'BGN', 'BHD', 'BIF', 'BMD', 'BND', 'BOB', 'BRL',
  'BSD', 'BTN', 'BWP', 'BYN', 'BZD', 'CAD', 'CDF', 'CHF', 'CLP', 'CNY',
  'COP', 'CRC', 'CUC', 'CUP', 'CVE', 'CZK', 'DJF', 'DKK', 'DOP', 'DZD',
  'EGP', 'ERN', 'ETB', 'EUR', 'FJD', 'FKP', 'GBP', 'GEL', 'GHS', 'GIP',
  'GMD', 'GNF', 'GTQ', 'GYD', 'HKD', 'HNL', 'HRK', 'HTG', 'HUF', 'IDR',
  'ILS', 'INR', 'IQD', 'IRR', 'ISK', 'JMD', 'JOD', 'JPY', 'KES', 'KGS',
  'KHR', 'KMF', 'KPW', 'KRW', 'KWD', 'KYD', 'KZT', 'LAK', 'LBP', 'LKR',
  'LRD', 'LSL', 'LYD', 'MAD', 'MDL', 'MGA', 'MKD', 'MMK', 'MNT', 'MOP',
  'MRU', 'MUR', 'MVR', 'MWK', 'MXN', 'MYR', 'MZN', 'NAD', 'NGN', 'NIO',
  'NOK', 'NPR', 'NZD', 'OMR', 'PAB', 'PEN', 'PGK', 'PHP', 'PKR', 'PLN',
  'PYG', 'QAR', 'RON', 'RSD', 'RUB', 'RWF', 'SAR', 'SBD', 'SCR', 'SDG',
  'SEK', 'SGD', 'SHP', 'SLE', 'SLL', 'SOS', 'SRD', 'SSP', 'STN', 'SVC',
  'SYP', 'SZL', 'THB', 'TJS', 'TMT', 'TND', 'TOP', 'TRY', 'TTD', 'TWD',
  'TZS', 'UAH', 'UGX', 'USD', 'UYU', 'UZS', 'VES', 'VND', 'VUV', 'WST',
  'XAF', 'XCD', 'XCG', 'XDR', 'XOF', 'XPF', 'XSU', 'YER', 'ZAR', 'ZMW',
  'ZWG', 'ZWL',
] as const;

const GEMINI_CURRENCY_FIELD = (context: string): Schema => ({
  type: Type.STRING,
  enum: [...SUPPORTED_CURRENCY_CODES],
  description: `${context} as an ISO-4217 currency code (e.g. USD, EUR, GBP). Must be one of the listed codes.`,
});

const GEMINI_ACCOUNT_ITEM_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    providerAccountId: { type: Type.STRING, description: 'Stable, unique identifier for THIS account — prefer a durable value the bank shows (account number, masked number, or internal id) over the display name. Reuse known IDs for matching accounts. You MUST reuse this exact value as the providerAccountId on every transaction belonging to this account.' },
    name: { type: Type.STRING, description: 'Human-readable account name as shown on the site.' },
    description: { type: Type.STRING, description: 'Short account description or subtype shown on the site.' },
    currency: GEMINI_CURRENCY_FIELD('Account currency'),
    type: {
      type: Type.STRING,
      enum: ['current', 'savings', 'credit', 'investment', 'broker_cash', 'pension', 'study_fund', 'loan', 'mortgage', 'other'],
      description:
        'Closest canonical account type for the visible product or wrapper. Judge by WHAT THE PRODUCT IS, not by the words in its name: in many markets retirement products are never called "pension", so the name is unreliable and the product\'s legal character decides. ' +
        'broker_cash = standalone brokerage cash balances. ' +
        'pension = a RETIREMENT vehicle: money designated for retirement income, normally restricted until a retirement age or qualifying event. This includes insurer-managed policies that combine life cover with a retirement savings component — such a policy is a pension, NEVER an investment, however the insurer brands it. It also includes employer/workplace schemes, self-directed retirement accounts, and defined-benefit entitlements. ' +
        'study_fund = a medium-term savings vehicle that is its own statutory category, distinct from retirement saving: contributions are not designated for retirement, and the balance becomes liquid after a fixed qualifying period. Use ONLY for a product that is genuinely that separate legal category; never map an ordinary savings or retirement product here. ' +
        'investment = general market investments with no retirement designation — withdrawable at will, even when supervised by the same regulator as retirement products. ' +
        'credit = credit/charge cards, one account per card. loan = a borrowing product (personal, student, or other loan); mortgage = a home loan. ' +
        'other = pure RISK insurance with no accumulated savings (health, critical illness, term life) — see the balance rule: these get balance 0.',
    },
    balance: { type: Type.NUMBER, description: 'Current balance or provider-reported total for the specific account or wrapper. Do not use profit/loss, change metrics, or individual holding rows as an account balance. Never use a policy premium (recurring cost) as a balance — risk-insurance products with no accumulated value get balance 0. SIGN: for a CREDIT, LOAN, or MORTGAGE product report the amount OWED as a POSITIVE number, however the site writes it — a site showing "-1,234.00", "1,234.00 DR", "1,234.00 CR", or "1,234.00" beside a localised word meaning "to be charged" for a debt of 1,234 all report 1234. A credit account in credit (the issuer owes the customer) is negative. Every other account type keeps the site\'s own sign, so an overdrawn current account is negative.' },
    available: { type: Type.NUMBER, description: 'OPTIONAL. The spendable/available balance if the site shows one distinct from the current balance (funds available to spend, including any arranged overdraft or remaining credit). Omit if not separately shown.' },
    limit: { type: Type.NUMBER, description: 'OPTIONAL. The credit limit (credit-card accounts) or arranged overdraft limit (current accounts) if shown. Omit if not shown.' },
    creditCardLiability: {
      type: Type.OBJECT,
      description: 'OPTIONAL. Credit-card statement/APR detail, ONLY for credit-card accounts and ONLY when explicitly visible. Omit the whole object if none of these are shown.',
      properties: {
        aprs: {
          type: Type.ARRAY,
          description: 'Interest rates shown for the card (e.g. purchase APR). Each entry: { percentage, type? }.',
          items: {
            type: Type.OBJECT,
            properties: {
              percentage: { type: Type.NUMBER, description: 'The APR as a percentage number (e.g. 19.9).' },
              type: { type: Type.STRING, enum: ['purchase', 'cash', 'balance_transfer', 'penalty', 'other'], description: 'Which APR this is, if labelled.' },
            },
            required: ['percentage'],
          },
        },
        lastStatementDate: { type: Type.STRING, format: 'date', description: 'Last statement date (YYYY-MM-DD) if shown.' },
        lastStatementBalance: { type: Type.NUMBER, description: 'Last statement balance if shown.' },
        minimumPaymentAmount: { type: Type.NUMBER, description: 'Minimum payment due if shown.' },
        nextPaymentDueDate: { type: Type.STRING, format: 'date', description: 'Next payment due date (YYYY-MM-DD) if shown.' },
      },
    },
    pensionDetail: {
      type: Type.OBJECT,
      description: 'OPTIONAL. Pension detail, ONLY for pension/retirement accounts and ONLY when explicitly visible. Omit the whole object if none are shown.',
      properties: {
        scheme: { type: Type.STRING, enum: ['defined_benefit', 'defined_contribution', 'provident_fund', 'study_fund', 'other'], description: 'The pension scheme kind if identifiable.' },
        employer: { type: Type.STRING, description: 'Sponsoring employer if shown.' },
        contributionsToDate: { type: Type.NUMBER, description: 'Total contributions to date if shown.' },
        vestedValue: { type: Type.NUMBER, description: 'Vested value if shown.' },
      },
    },
  },
  required: ['providerAccountId', 'name', 'description', 'currency', 'type', 'balance'],
};

const GEMINI_TRANSACTION_ITEM_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    providerAccountId: { type: Type.STRING, description: 'The providerAccountId of the account this transaction belongs to. It MUST be identical, character-for-character, to the providerAccountId you assigned that account (the already-extracted-accounts context lists each account\'s providerAccountId). Copy that exact id — do NOT put the account\'s display name or a re-derived label here, or the transaction will not link to its account.' },
    providerTransactionId: { type: Type.STRING, description: 'Stable provider-side transaction identifier if visible; otherwise use NONE.' },
    // format:'date' is grammar-enforced by Gemini structured output (ISO YYYY-MM-DD),
    // so the model cannot emit free-form text here. This is the field that was
    // corrupted in the documented incident when it was an unconstrained string.
    bookingDate: { type: Type.STRING, format: 'date', description: 'Booking date in ISO YYYY-MM-DD format.' },
    amount: { type: Type.NUMBER, description: 'Signed transaction amount using the provider\'s actual economic meaning. Preserve explicit signs when shown; otherwise infer sign only from clear debit/credit or inflow/outflow evidence.' },
    currency: GEMINI_CURRENCY_FIELD('Transaction currency'),
    merchant: { type: Type.STRING, description: 'Merchant/payee/payer name if explicitly visible.' },
    description: { type: Type.STRING, description: 'Transaction description transcribed VERBATIM from the site text — never paraphrase, translate, re-order words, or normalize. The same statement line must yield the exact same description on every crawl; a re-worded description makes the system store the same charge twice.' },
    providerCategory: { type: Type.STRING, description: 'Raw provider category or bank classification if visible.' },
    isPending: { type: Type.BOOLEAN, description: 'Whether the transaction is pending at the provider.' },
    existingCanonicalId: { type: Type.STRING, description: 'Set ONLY when this row is a status or providerTransactionId update for an entry already shown in the previously-extracted-transactions list. Copy verbatim from that list. Leave unset for brand-new transactions.' },
    count: { type: Type.INTEGER, description: 'Number of IDENTICAL occurrences of this exact transaction on the page (same account, date, amount, currency, description; no bank reference distinguishing them). Default 1. Use a value above 1 ONLY when the page genuinely shows that many separate identical rows (e.g. two identical same-day purchases). NEVER list the same transaction as two array entries — repeated identical entries are treated as ONE transaction.' },
  },
  required: ['providerAccountId', 'providerTransactionId', 'bookingDate', 'amount', 'currency', 'description', 'isPending'],
};

const GEMINI_POSITION_ITEM_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    providerPositionId: { type: Type.STRING, description: 'Stable position identifier that persists across crawls. Reuse known providerPositionId from previous crawls for matching positions. For new positions: use the provider\'s internal security number, ISIN, or lot ID — NOT the market ticker (the ticker goes in the separate "ticker" field).' },
    providerAccountId: { type: Type.STRING, description: 'REQUIRED. The providerAccountId of the brokerage/investment account that HOLDS this position. Copy it character-for-character from the account you reported. If the page does not expose a separate wrapper, first report the page\'s portfolio as an account and use that exact providerAccountId.' },
    identifier: { type: Type.STRING, description: 'The provider\'s internal/stable holding code as shown on the site (e.g. a broker security number or row id). This is NOT the market ticker — it is the broker\'s own identifier and may be a numeric code.' },
    ticker: { type: Type.STRING, description: 'The security\'s real MARKET TICKER as it trades on its exchange — e.g. AAPL, GOOG, PLTR, SPY. This is the public exchange symbol, NOT the provider\'s internal security number. The ticker is usually visible in the holding row, often embedded in the name (e.g. "AAPLE COM(AAPL)" → AAPL, "QUALCOMM(QCOM)" → QCOM, "PYPL US" → PYPL, "GOOG US" → GOOG); use that. If the row shows only a company name for a well-known listed security, use that company\'s known exchange ticker. Leave this field empty ONLY when the security genuinely has no public market ticker (e.g. a locally-listed mutual or tracking fund identified solely by name or an internal provider number).' },
    name: { type: Type.STRING, description: 'Full holding or instrument name as shown on the site.' },
    quantity: { type: Type.NUMBER, description: 'Actual units, shares, contracts, participation units, or equivalent holding quantity shown by the provider. Do not invent placeholder quantities.' },
    currency: GEMINI_CURRENCY_FIELD('Holding trading/valuation currency'),
    valueNative: { type: Type.NUMBER, description: 'Current market value of THIS single holding only, in its native currency (approximately quantity × current unit price), read from this row\'s own value cell. NEVER the account or portfolio total — if several rows would share one identical value, you are copying the wrong cell. Not a per-unit price, not profit/loss.' },
    costBasisNative: { type: Type.NUMBER, description: 'Total invested or cost-basis amount for the full holding when explicitly visible or directly implied by a provider-reported total invested amount.' },
    isin: { type: Type.STRING, description: 'The security\'s ISIN if shown on the page (a 12-character code, 2 letters + 10 alphanumerics, e.g. US0378331005, DE0005557508). ISINs are commonly shown for locally-listed mutual/tracking funds and bonds that have no ticker — capture it when visible, as it uniquely identifies the security. Leave empty if not shown; never guess one.' },
    exchange: { type: Type.STRING, description: 'The listing exchange / market code if shown (e.g. TASE, LSE, NASDAQ, NYSE). Leave empty if not shown.' },
    securityType: { type: Type.STRING, description: 'The instrument type as labelled by the provider if shown (e.g. ETF, mutual fund, tracking fund, bond, stock, money market). Helpful for funds with no ticker. Leave empty if not shown; never guess.' },
  },
  required: ['providerAccountId', 'identifier', 'name', 'quantity', 'currency', 'valueNative'],
};

const GEMINI_MEMORY_NOTE_ITEM_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    key: { type: Type.STRING, description: 'Short structural label (e.g. selector name, page label). No user data.' },
    value: { type: Type.STRING, description: 'Structural/navigational value only — a CSS selector, URL, page layout observation. NEVER a financial amount, balance, account number, or any user data.' },
  },
  required: ['key', 'value'],
};

const GEMINI_OPTIONAL_MEMORY_NOTES: Record<string, Schema> = {
  memoryNotes: {
    type: Type.ARRAY,
    items: GEMINI_MEMORY_NOTE_ITEM_SCHEMA,
    description: 'Structural notes only (selectors, URLs, layout). NEVER include user financial data — no balances, amounts, account numbers.',
  },
};

const GEMINI_STEP_SCHEMAS: Record<StepToolName, Schema> = {
  step_click: {
    type: Type.OBJECT,
    properties: {
      description: { type: Type.STRING },
      selector: { type: Type.STRING },
      ...GEMINI_OPTIONAL_MEMORY_NOTES,
    },
    required: ['description', 'selector'],
  },
  step_fill: {
    type: Type.OBJECT,
    properties: {
      description: { type: Type.STRING },
      selector: { type: Type.STRING },
      value: { type: Type.STRING },
      ...GEMINI_OPTIONAL_MEMORY_NOTES,
    },
    required: ['description', 'selector', 'value'],
  },
  step_select: {
    type: Type.OBJECT,
    properties: {
      description: { type: Type.STRING },
      selector: { type: Type.STRING },
      value: { type: Type.STRING },
      ...GEMINI_OPTIONAL_MEMORY_NOTES,
    },
    required: ['description', 'selector', 'value'],
  },
  step_wait: {
    type: Type.OBJECT,
    properties: {
      description: { type: Type.STRING },
      ms: { type: Type.NUMBER },
      ...GEMINI_OPTIONAL_MEMORY_NOTES,
    },
    required: ['description'],
  },
  step_scroll: {
    type: Type.OBJECT,
    properties: {
      description: { type: Type.STRING },
      direction: { type: Type.STRING, enum: ['up', 'down'] },
      amount: { type: Type.NUMBER },
      ...GEMINI_OPTIONAL_MEMORY_NOTES,
    },
    required: ['description'],
  },
  step_navigate: {
    type: Type.OBJECT,
    properties: {
      description: { type: Type.STRING },
      url: { type: Type.STRING, description: 'Full URL, must start with http' },
      ...GEMINI_OPTIONAL_MEMORY_NOTES,
    },
    required: ['description', 'url'],
  },
  step_login_flow_restarted: {
    type: Type.OBJECT,
    properties: { description: { type: Type.STRING }, ...GEMINI_OPTIONAL_MEMORY_NOTES },
    required: ['description'],
  },
  step_wait_for_otp: {
    type: Type.OBJECT,
    properties: {
      description: { type: Type.STRING },
      otpEvidence: {
        type: Type.STRING,
        description: 'Cite NEW content that appeared after submit confirming an OTP/verification step is active. Must reference content NOT on the login form before submit. Login form text like "Login via SMS" is NOT evidence.',
      },
      ...GEMINI_OPTIONAL_MEMORY_NOTES,
    },
    required: ['description', 'otpEvidence'],
  },
  step_login_complete: {
    type: Type.OBJECT,
    properties: { description: { type: Type.STRING }, ...GEMINI_OPTIONAL_MEMORY_NOTES },
    required: ['description'],
  },
  step_complete: {
    type: Type.OBJECT,
    properties: { description: { type: Type.STRING }, ...GEMINI_OPTIONAL_MEMORY_NOTES },
    required: ['description'],
  },
  step_error: {
    type: Type.OBJECT,
    properties: {
      description: { type: Type.STRING },
      message: { type: Type.STRING },
      category: {
        type: Type.STRING,
        enum: [...STEP_ERROR_CATEGORIES],
        description: STEP_ERROR_CATEGORY_DESCRIPTION,
      },
      ...GEMINI_OPTIONAL_MEMORY_NOTES,
    },
    required: ['description', 'category'],
  },
  step_report_data: {
    type: Type.OBJECT,
    properties: {
      description: {
        type: Type.STRING,
        description: 'Briefly describe what newly visible financial data is being reported from the current page or provided file.',
      },
      accounts: {
        type: Type.ARRAY,
        items: GEMINI_ACCOUNT_ITEM_SCHEMA,
        description: 'Account, balance, cash, or portfolio summary rows visible in current evidence.',
      },
      transactions: {
        type: Type.ARRAY,
        items: GEMINI_TRANSACTION_ITEM_SCHEMA,
        description: 'Transaction or activity-history rows visible in current evidence.',
      },
      positions: {
        type: Type.ARRAY,
        items: GEMINI_POSITION_ITEM_SCHEMA,
        description: 'Holding or position rows visible in current evidence. Mixed portfolio pages may include positions together with balances in the same report call.',
      },
      memoryNotes: {
        type: Type.ARRAY,
        items: GEMINI_MEMORY_NOTE_ITEM_SCHEMA,
        description: 'Structural notes only (selectors, URLs, layout). NEVER include user financial data — no balances, amounts, account numbers.',
      },
    },
    required: ['description'],
  },
};

const STEP_TOOL_DESCRIPTION_BY_NAME: Record<StepToolName, string> = {
  step_click: `Execute the 'click' browser step. You may optionally include memoryNotes about previous successful operation. Wait for post-action feedback before concluding success/failure.`,
  step_fill: `Execute the 'fill' browser step. You may optionally include memoryNotes about previous successful operation. Wait for post-action feedback before concluding success/failure.`,
  step_select: `Execute the 'select' browser step. You may optionally include memoryNotes about previous successful operation. Wait for post-action feedback before concluding success/failure.`,
  step_wait: `Execute the 'wait' browser step. You may optionally include memoryNotes about previous successful operation. Wait for post-action feedback before concluding success/failure.`,
  step_scroll: `Execute the 'scroll' browser step. You may optionally include memoryNotes about previous successful operation. Wait for post-action feedback before concluding success/failure.`,
  step_navigate: `Execute the 'navigate' browser step. You may optionally include memoryNotes about previous successful operation. Wait for post-action feedback before concluding success/failure.`,
  step_login_flow_restarted: `Signal that authentication has restarted after an earlier successful login. Use this once when you are bounced back into login/verification so the system can prepare for a fresh OTP if needed. You may optionally include memoryNotes about previous successful operation.`,
  step_wait_for_otp: `Signal that OTP/2FA is required. PREREQUISITE: Before calling this tool, you MUST have verified via readHtml, searchHtml, or getScreenshot that the page now shows NEW OTP-specific content that was NOT on the login form before submit — a new OTP code input field, a "code sent" message, or a verification-specific view. Text already on the login form (like "Login via SMS" or "one-time password") is NOT evidence. If you cannot find new OTP-specific content, the submit likely failed — diagnose and retry instead. Provide the evidence in the otpEvidence field.`,
  step_login_complete: `Signal that login is complete and financial extraction can begin. You may optionally include memoryNotes about previous successful operation.`,
  step_complete: `Signal that extraction is complete. You may optionally include memoryNotes about previous successful operation.`,
  step_error: `Signal an unrecoverable error state, classifying WHY via the category field (access_blocked / outside_operating_hours / credentials_rejected / site_unavailable / other). You may optionally include memoryNotes about previous successful operation.`,
  step_report_data: `Report newly visible financial data from the current page or provided file. You may include any combination of accounts, transactions, positions, and structural memoryNotes that current evidence supports. Mixed pages often contain balances and positions together; return one valid report with only schema-supported fields.`,
};

export const GEMINI_STEP_FUNCTION_DECLARATIONS = (Object.keys(GEMINI_STEP_SCHEMAS) as StepToolName[]).map(name => ({
  name,
  description: STEP_TOOL_DESCRIPTION_BY_NAME[name],
  parameters: GEMINI_STEP_SCHEMAS[name],
}));

export const GEMINI_STEP_FUNCTION_NAMES = GEMINI_STEP_FUNCTION_DECLARATIONS.map(d => d.name);

/**
 * Placeholder strings the model sometimes emits for an optional field instead of
 * omitting it (e.g. ticker:"NONE" for a security with no public symbol). A real
 * market ticker is never one of these, so normalize them to "absent" — otherwise
 * a sentinel like "NONE" reaches storage as the symbol and triggers a bogus
 * Yahoo lookup and breaks cash detection downstream. This sanitizes the model's
 * REPRESENTATION of "no ticker"; it does not override the model's decision.
 */
const TICKER_PLACEHOLDERS = new Set(['', 'NONE', 'N/A', 'NA', 'N.A.', 'NULL', 'NIL', 'UNKNOWN', '-', '--', '—', '–']);

function normalizeTicker(ticker?: string): string | undefined {
  if (!ticker) return undefined;
  const trimmed = ticker.trim();
  if (TICKER_PLACEHOLDERS.has(trimmed.toUpperCase())) return undefined;
  return trimmed;
}

/** Same placeholder-stripping for other optional identity fields (isin, exchange,
 *  securityType) — a "NONE"/"-" sentinel must not reach storage. */
function cleanOptionalField(value?: string): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (TICKER_PLACEHOLDERS.has(trimmed.toUpperCase())) return undefined;
  return trimmed;
}

function buildReportStepResponse(payload: ReportDataPayload): StepResponse {
  return {
    action: 'reportData',
    description: payload.description,
    accounts: payload.accounts ?? [],
    transactions: payload.transactions ?? [],
    positions: (payload.positions ?? []).map(position => {
      // providerPositionId = the provider's stable internal code (e.g. a broker's
      // own numeric security id). symbol = the real market ticker, kept in its own
      // field and omitted when the security has no public ticker (e.g. a
      // locally-listed tracking fund) — the two are never conflated.
      const ticker = normalizeTicker(position.ticker);
      const isin = cleanOptionalField(position.isin);
      const exchange = cleanOptionalField(position.exchange);
      const securityType = cleanOptionalField(position.securityType);
      return {
        providerPositionId: position.providerPositionId || position.identifier,
        providerAccountId: position.providerAccountId,
        ...(ticker ? { symbol: ticker } : {}),
        name: position.name,
        quantity: position.quantity,
        currency: position.currency,
        valueNative: position.valueNative,
        ...(position.costBasisNative !== undefined ? { costBasisNative: position.costBasisNative } : {}),
        ...(isin ? { isin } : {}),
        ...(exchange ? { exchange } : {}),
        ...(securityType ? { securityType } : {}),
      };
    }),
    memoryNotes: payload.memoryNotes ?? [],
  };
}

/**
 * Gemini path: map provider-enforced function args into StepResponse without
 * local schema validation/parsing.
 *
 * Contract enforcement is delegated to Gemini's native Schema grammar engine
 * via the parameters field in GEMINI_STEP_FUNCTION_DECLARATIONS.
 */
export function mapStepToolCallUnchecked(toolName: string, input: Record<string, unknown>): StepResponse {
  const action = STEP_ACTION_BY_TOOL_NAME[toolName as StepToolName];
  if (!action) {
    throw new Error(`Unknown step tool/function name "${toolName}"`);
  }

  if (toolName === 'step_report_data') {
    const payload = input as unknown as ReportDataPayload;
    return buildReportStepResponse(payload);
  }

  // Extract optional memoryNotes from any step tool input
  const notes = (input.memoryNotes as DataReport['memoryNotes'] | undefined) ?? [];

  switch (action) {
    case 'click': {
      const payload = input as { description: string; selector: string };
      return { action, description: payload.description, selector: payload.selector, ...emptyDataReport(), memoryNotes: notes };
    }
    case 'fill': {
      const payload = input as { description: string; selector: string; value: string };
      return { action, description: payload.description, selector: payload.selector, value: payload.value, ...emptyDataReport(), memoryNotes: notes };
    }
    case 'select': {
      const payload = input as { description: string; selector: string; value: string };
      return { action, description: payload.description, selector: payload.selector, value: payload.value, ...emptyDataReport(), memoryNotes: notes };
    }
    case 'wait': {
      const payload = input as { description: string; ms?: number };
      return { action, description: payload.description, ...(payload.ms !== undefined ? { ms: payload.ms } : {}), ...emptyDataReport(), memoryNotes: notes };
    }
    case 'scroll': {
      const payload = input as { description: string; direction?: 'up' | 'down'; amount?: number };
      return {
        action,
        description: payload.description,
        ...(payload.direction !== undefined ? { direction: payload.direction } : {}),
        ...(payload.amount !== undefined ? { amount: payload.amount } : {}),
        ...emptyDataReport(),
        memoryNotes: notes,
      };
    }
    case 'navigate': {
      const payload = input as { description: string; url: string };
      return { action, description: payload.description, url: payload.url, ...emptyDataReport(), memoryNotes: notes };
    }
    case 'loginFlowRestarted': {
      const payload = input as { description: string };
      return { action, description: payload.description, ...emptyDataReport(), memoryNotes: notes };
    }
    case 'waitForOtp': {
      const payload = input as { description: string; otpEvidence: string };
      return { action, description: payload.description, otpEvidence: payload.otpEvidence, ...emptyDataReport(), memoryNotes: notes };
    }
    case 'loginComplete': {
      const payload = input as { description: string };
      return { action, description: payload.description, ...emptyDataReport(), memoryNotes: notes };
    }
    case 'complete': {
      const payload = input as { description: string };
      return { action, description: payload.description, ...emptyDataReport(), memoryNotes: notes };
    }
    case 'error': {
      const payload = input as { description: string; message?: string; category?: StepErrorCategory };
      return {
        action,
        description: payload.description,
        ...(payload.message !== undefined ? { message: payload.message } : {}),
        ...(payload.category !== undefined ? { category: payload.category } : {}),
        ...emptyDataReport(),
        memoryNotes: notes,
      };
    }
    case 'reportData':
      throw new Error(`Unhandled reportData tool/function name "${toolName}"`);
    default:
      throw new Error(`Unknown step action "${action}"`);
  }
}

// ─── Gemini info phase function declarations ────────────────────────────────

const GEMINI_INFO_SCHEMAS_NATIVE: Record<string, Schema> = {
  info_read_html: {
    type: Type.OBJECT,
    properties: {
      start: { type: Type.NUMBER, description: 'Start character offset' },
      end: { type: Type.NUMBER, description: 'End character offset. Must be at most start + 50000.' },
      reason: { type: Type.STRING },
    },
    required: ['start', 'end', 'reason'],
  },
  info_search_html: {
    type: Type.OBJECT,
    properties: { query: { type: Type.STRING } },
    required: ['query'],
  },
  info_get_screenshot: {
    type: Type.OBJECT,
    properties: { reason: { type: Type.STRING } },
    required: ['reason'],
  },
  info_step: {
    type: Type.OBJECT,
    properties: {},
  },
};

export const GEMINI_INFO_FUNCTION_DECLARATIONS = [
  {
    name: 'info_read_html',
    description: 'Request an HTML range (max 50000 chars per call). Input: { start, end, reason }. The range end-start must not exceed 50000.',
    parameters: GEMINI_INFO_SCHEMAS_NATIVE.info_read_html,
  },
  {
    name: 'info_search_html',
    description: 'Search the HTML for a query string. Input: { query }.',
    parameters: GEMINI_INFO_SCHEMAS_NATIVE.info_search_html,
  },
  {
    name: 'info_get_screenshot',
    description: 'Request the current screenshot. Input: { reason }.',
    parameters: GEMINI_INFO_SCHEMAS_NATIVE.info_get_screenshot,
  },
  {
    name: 'info_step',
    description: 'Signal readiness for step execution.',
    parameters: GEMINI_INFO_SCHEMAS_NATIVE.info_step,
  },
] as const;

export const GEMINI_INFO_FUNCTION_NAMES = GEMINI_INFO_FUNCTION_DECLARATIONS.map(d => d.name);

export type GeminiInfoFunctionName = (typeof GEMINI_INFO_FUNCTION_NAMES)[number];

export function isGeminiInfoFunctionName(name: string): name is GeminiInfoFunctionName {
  return GEMINI_INFO_FUNCTION_NAMES.includes(name as GeminiInfoFunctionName);
}

// ─── Unified tool set for Interactions API (single-phase) ─────────────────────

/**
 * Combined info + step function declarations for the Interactions API unified loop.
 * Excludes info_step — the model calls step tools directly when ready.
 */
export const GEMINI_ALL_FUNCTION_DECLARATIONS = [
  ...GEMINI_INFO_FUNCTION_DECLARATIONS.filter(d => d.name !== 'info_step'),
  ...GEMINI_STEP_FUNCTION_DECLARATIONS,
];

export const GEMINI_ALL_FUNCTION_NAMES = GEMINI_ALL_FUNCTION_DECLARATIONS.map(d => d.name);

/**
 * Gemini path: map provider-enforced info function args without local
 * schema validation/parsing.
 */
export function mapGeminiInfoFunctionCallUnchecked(
  name: GeminiInfoFunctionName,
  args: Record<string, unknown>,
): InfoOutput {
  switch (name) {
    case 'info_read_html': {
      const payload = args as { start: number; end: number; reason: string };
      return { tool: 'readHtml', ...payload };
    }
    case 'info_search_html': {
      const payload = args as { query: string };
      return { tool: 'searchHtml', ...payload };
    }
    case 'info_get_screenshot': {
      const payload = args as { reason: string };
      return { tool: 'getScreenshot', ...payload };
    }
    case 'info_step':
      return { tool: 'step' };
    default:
      throw new Error(`Unknown Gemini info function "${name}"`);
  }
}

// ─── Info phase (Zod schemas for validation) ─────────────────────────────────

const READ_HTML_INFO_SCHEMA = z.object({
  tool: z.literal('readHtml'),
  start: z.number(),
  end: z.number(),
  reason: z.string(),
}).strict();

const SEARCH_HTML_INFO_SCHEMA = z.object({
  tool: z.literal('searchHtml'),
  query: z.string(),
}).strict();

const GET_SCREENSHOT_INFO_SCHEMA = z.object({
  tool: z.literal('getScreenshot'),
  reason: z.string(),
}).strict();

const STEP_SIGNAL_INFO_SCHEMA = z.object({
  tool: z.literal('step'),
}).strict();

const INFO_OUTPUT_ZOD_SCHEMA = z.discriminatedUnion('tool', [
  READ_HTML_INFO_SCHEMA,
  SEARCH_HTML_INFO_SCHEMA,
  GET_SCREENSHOT_INFO_SCHEMA,
  STEP_SIGNAL_INFO_SCHEMA,
]);

/** Discriminated union for info phase output. */
export type InfoOutput = z.infer<typeof INFO_OUTPUT_ZOD_SCHEMA>;

export interface ReadHtmlRequest { start: number; end: number; reason: string; }
export interface SearchHtmlRequest { query: string; }
export interface GetScreenshotRequest { reason: string; }

// ─── Gemini info Zod schemas for validation ──────────────────────────────────

const GEMINI_INFO_ZOD_SCHEMAS = {
  info_read_html: READ_HTML_INFO_SCHEMA.omit({ tool: true }),
  info_search_html: SEARCH_HTML_INFO_SCHEMA.omit({ tool: true }),
  info_get_screenshot: GET_SCREENSHOT_INFO_SCHEMA.omit({ tool: true }),
  info_step: z.object({}).strict(),
} as const;

export function parseGeminiInfoFunctionCall(name: string, args: unknown): InfoOutput {
  switch (name) {
    case 'info_read_html': {
      const payload = parseOrThrow(GEMINI_INFO_ZOD_SCHEMAS.info_read_html, args, 'Invalid info_read_html payload');
      return { tool: 'readHtml', ...payload };
    }
    case 'info_search_html': {
      const payload = parseOrThrow(GEMINI_INFO_ZOD_SCHEMAS.info_search_html, args, 'Invalid info_search_html payload');
      return { tool: 'searchHtml', ...payload };
    }
    case 'info_get_screenshot': {
      const payload = parseOrThrow(GEMINI_INFO_ZOD_SCHEMAS.info_get_screenshot, args, 'Invalid info_get_screenshot payload');
      return { tool: 'getScreenshot', ...payload };
    }
    case 'info_step': {
      parseOrThrow(GEMINI_INFO_ZOD_SCHEMAS.info_step, args, 'Invalid info_step payload');
      return { tool: 'step' };
    }
    default:
      throw new Error(`Unknown Gemini info function "${name}"`);
  }
}

// ─── Step tool result contract ───────────────────────────────────────────────

export const STEP_TOOL_RESULT_ACK = {
  status: 'accepted' as const,
  execution: 'async' as const,
  feedbackChannel: 'ACTION_FEEDBACK' as const,
  note: 'Action queued for browser execution. Evaluate ACTION_FEEDBACK in the next turn before concluding success/failure.',
};

// ─── Backward-compat flat schema (used by existing tests) ───────────────────

export const STEP_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: [...ALL_ACTIONS] },
    description: { type: 'string' },
    selector: { type: 'string' },
    value: { type: 'string' },
    ms: { type: 'number' },
    direction: { type: 'string', enum: ['up', 'down'] },
    amount: { type: 'number' },
    url: { type: 'string' },
    message: { type: 'string' },
    otpEvidence: { type: 'string' },
    accounts: toProviderJsonSchema(z.array(ACCOUNT_ITEM_SCHEMA)),
    transactions: toProviderJsonSchema(z.array(TRANSACTION_ITEM_SCHEMA)),
    positions: toProviderJsonSchema(z.array(POSITION_ITEM_SCHEMA)),
    memoryNotes: toProviderJsonSchema(z.array(MEMORY_NOTE_ITEM_SCHEMA)),
  },
  required: ['action', 'description', 'accounts', 'transactions', 'positions', 'memoryNotes'],
  additionalProperties: false,
} as const;

/**
 * Transform a JSON schema by replacing `{ type:'string', const: X }` literals
 * with `{ type:'string', enum:[X] }` equivalents.
 */
export function constToEnum(schema: object): object {
  return JSON.parse(JSON.stringify(schema, (_key, val) => {
    if (val && typeof val === 'object' && typeof (val as Record<string, unknown>).const === 'string') {
      const { const: constVal, ...rest } = val as Record<string, unknown>;
      return { ...rest, enum: [constVal] };
    }
    return val;
  })) as object;
}
