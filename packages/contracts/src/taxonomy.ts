/**
 * Normalized account & security taxonomy for the read-side data contract (see
 * `docs/spec-data-api.md`). Two-level `type` + `subtype`, the industry-dominant shape
 * (Plaid/MX/Yodlee), with pension a FIRST-CLASS type (following Moneyhub/Finicity) because
 * Accrawl serves pensions, provident funds, and study funds directly.
 *
 * The engine still emits the legacy flat `NormalizedAccount.type`; this module is the
 * deterministic, lossless projection to `(type, subtype)`, applied at read time — no data
 * migration. Keep `mapAccountType` total: an unknown input degrades to `other/other`, never throws.
 */

// ─── Account taxonomy ───────────────────────────────────────────────

export const ACCOUNT_TYPES = ['depository', 'credit', 'investment', 'pension', 'loan', 'other'] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

/** Subtypes scoped to each top-level type. Every list ends in `other` as the in-type fallback. */
export const ACCOUNT_SUBTYPES = {
  depository: ['current', 'savings', 'money_market', 'cd', 'other'],
  credit: ['credit_card', 'charge_card', 'other'],
  investment: ['brokerage', 'brokerage_cash', 'managed', 'crypto', 'other'],
  pension: ['pension', 'defined_benefit', 'defined_contribution', 'provident_fund', 'study_fund', 'other'],
  loan: ['mortgage', 'personal', 'student', 'other'],
  other: ['other'],
} as const satisfies Record<AccountType, readonly string[]>;

export type AccountSubtype = (typeof ACCOUNT_SUBTYPES)[AccountType][number];

export interface AccountClassification {
  type: AccountType;
  subtype: string;
}

/**
 * Lossless map from the legacy `NormalizedAccount.type` 8-value enum to `(type, subtype)`.
 * This is the single source of truth for §5.2 of the spec. Reversible for the ten known values.
 */
const LEGACY_ACCOUNT_TYPE_MAP: Readonly<Record<string, AccountClassification>> = {
  current: { type: 'depository', subtype: 'current' },
  savings: { type: 'depository', subtype: 'savings' },
  credit: { type: 'credit', subtype: 'credit_card' },
  investment: { type: 'investment', subtype: 'brokerage' },
  broker_cash: { type: 'investment', subtype: 'brokerage_cash' },
  pension: { type: 'pension', subtype: 'pension' },
  study_fund: { type: 'pension', subtype: 'study_fund' },
  loan: { type: 'loan', subtype: 'other' },
  mortgage: { type: 'loan', subtype: 'mortgage' },
  other: { type: 'other', subtype: 'other' },
};

/** Total projection: any legacy/unknown type → a valid `(type, subtype)`. Never throws. */
export function mapAccountType(legacyType: string): AccountClassification {
  return LEGACY_ACCOUNT_TYPE_MAP[legacyType] ?? { type: 'other', subtype: 'other' };
}

// ─── Security taxonomy ──────────────────────────────────────────────

export const SECURITY_TYPES = ['equity', 'etf', 'mutual_fund', 'bond', 'cash', 'crypto', 'derivative', 'other'] as const;
export type SecurityType = (typeof SECURITY_TYPES)[number];

/**
 * Best-effort map from a provider's free-text `securityType` label to the canonical enum. Order
 * matters: the more specific patterns are tested first (an "ETF" is never a plain equity; a
 * "money market fund" is cash, not a mutual fund). Unknown/absent → `other`.
 */
export function mapSecurityType(raw?: string): SecurityType {
  if (!raw) return 'other';
  const s = raw.toLowerCase();
  if (/\betf\b|exchange[-\s]?traded/.test(s)) return 'etf';
  if (/money[-\s]?market|(^|\s)cash(\s|$)/.test(s)) return 'cash';
  if (/crypto|bitcoin|ether|digital asset/.test(s)) return 'crypto';
  if (/option|future|warrant|derivative|\bcfd\b|swap/.test(s)) return 'derivative';
  if (/bond|fixed[-\s]?income|treasur|gilt|debt|note/.test(s)) return 'bond';
  if (/mutual|tracking fund|\bfund\b|unit trust|oeic|sicav/.test(s)) return 'mutual_fund';
  if (/stock|equity|share|common|ordinary|\badr\b/.test(s)) return 'equity';
  return 'other';
}
