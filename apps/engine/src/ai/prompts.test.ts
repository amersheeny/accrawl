/**
 * Tests for system prompt construction.
 */

import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { buildSystemPrompt, buildStepContext } from './prompts';

const CURRENT_PROMPTS_SOURCE = readFileSync(new URL('./prompts.ts', import.meta.url), 'utf8');
const CANONICAL_PRE_GEMINI_PROMPTS_SOURCE = readFileSync(
  new URL('./__fixtures__/prompts/pre_gemini_prompts_source.txt', import.meta.url),
  'utf8',
);
const DEFAULT_PROMPT_GOLDEN = readFileSync(
  new URL('./__fixtures__/prompts/default.prompt.txt', import.meta.url),
  'utf8',
).replace(/\n$/, '');
const COMBINED_PROMPT_GOLDEN = readFileSync(
  new URL('./__fixtures__/prompts/combined.prompt.txt', import.meta.url),
  'utf8',
).replace(/\n$/, '');
const COMBINED_PROMPT_OPTIONS: Parameters<typeof buildSystemPrompt>[0] = {
  playbook: 'Click the "Login" tab first, then enter credentials.',
  customInstructions: 'Skip the popup dialog',
  loginHints: {
    usernameField: '#user-input',
    passwordField: '#pass-input',
    dobField: '#dob-input',
    phoneField: '#phone-input',
    submitButton: 'button.login-btn',
  },
  extractionHints: {
    dateFormat: 'DD/MM/YYYY',
    currency: 'EUR',
    accountsSelector: '.accounts',
    transactionsSelector: '.transactions',
    positionsSelector: '.positions',
  },
  existingAccounts: [
    { providerAccountId: '4242-credit-eur', name: 'Credit Card 4242', currency: 'EUR', type: 'credit', balance: -125.40 },
    { providerAccountId: '1881-credit-eur', name: 'Credit Card 1881', currency: 'EUR', type: 'credit', balance: -410.55 },
  ],
  existingPositions: [
    { providerPositionId: 'AAPL', providerAccountId: 'portfolio-a', symbol: 'AAPL', name: 'Apple Inc.', currency: 'USD', quantity: 95 },
    { providerPositionId: '111203', providerAccountId: 'portfolio-a', symbol: '111203', name: 'QUALCOMM INC', currency: 'USD', quantity: 67 },
  ],
  crawlMemory: 'sms_tab_selector: #sms-login-tab\nportfolio_page: /tab/pf7\nholdings_section_start: char 14000',
};

describe('buildSystemPrompt', () => {
  it('matches canonical pre-Gemini prompt source word-for-word', () => {
    expect(CURRENT_PROMPTS_SOURCE).toBe(CANONICAL_PRE_GEMINI_PROMPTS_SOURCE);
  });

  it('matches default prompt golden output word-for-word', () => {
    expect(buildSystemPrompt({})).toBe(DEFAULT_PROMPT_GOLDEN);
  });

  it('matches combined prompt golden output word-for-word', () => {
    expect(buildSystemPrompt(COMBINED_PROMPT_OPTIONS)).toBe(COMBINED_PROMPT_GOLDEN);
  });

  it('includes core navigation rules', () => {
    const prompt = buildSystemPrompt({});
    expect(prompt).toContain('Navigation Rules');
    expect(prompt).toContain('USERNAME');
    expect(prompt).toContain('PASSWORD');
    expect(prompt).toContain('DOB');
  });

  it('includes extraction rules', () => {
    const prompt = buildSystemPrompt({});
    expect(prompt).toContain('Account Extraction');
    expect(prompt).toContain('Transaction Extraction');
    expect(prompt).toContain('Position Extraction');
  });

  it('includes action field requirements', () => {
    const prompt = buildSystemPrompt({});
    expect(prompt).toContain('Action Field Requirements');
    expect(prompt).toContain('**click**: selector (required)');
    expect(prompt).toContain('**wait**: ms (required). Do NOT include selector');
    expect(prompt).toContain('**waitForOtp**: no extra fields. Do NOT include selector');
  });

  it('includes OTP_CODE placeholder in credential list and fill docs', () => {
    const prompt = buildSystemPrompt({});
    expect(prompt).toContain('OTP_CODE');
    expect(prompt).toContain('OTP_CODE — for the OTP/verification code field');
    expect(prompt).toContain('USERNAME/PASSWORD/DOB/PHONE/OTP_CODE');
  });

  it('includes pre-action validation rules', () => {
    const prompt = buildSystemPrompt({});
    expect(prompt).toContain('Pre-Action Validation');
    expect(prompt).toContain('Selector check');
    expect(prompt).toContain('Value check');
    expect(prompt).toContain('Visibility check');
  });

  it('includes CSS selector guidance', () => {
    const prompt = buildSystemPrompt({});
    expect(prompt).toContain('CSS Selectors');
    expect(prompt).toContain(':has-text');
    expect(prompt).toContain(':contains()');
  });

  it('appends playbook when provided', () => {
    const prompt = buildSystemPrompt({
      playbook: 'Click the "Login" tab first, then enter credentials.',
    });
    expect(prompt).toContain('Institution-Specific Instructions');
    expect(prompt).toContain('Click the "Login" tab first');
  });

  it('appends custom instructions when provided', () => {
    const prompt = buildSystemPrompt({
      customInstructions: 'Skip the popup dialog',
    });
    expect(prompt).toContain('User Custom Instructions');
    expect(prompt).toContain('Skip the popup dialog');
  });

  it('appends login hints when provided', () => {
    const prompt = buildSystemPrompt({
      loginHints: {
        usernameField: '#user-input',
        passwordField: '#pass-input',
        submitButton: 'button.login-btn',
      },
    });
    expect(prompt).toContain('Login Form Hints');
    expect(prompt).toContain('#user-input');
    expect(prompt).toContain('#pass-input');
    expect(prompt).toContain('button.login-btn');
  });

  it('appends extraction hints when provided', () => {
    const prompt = buildSystemPrompt({
      extractionHints: {
        dateFormat: 'DD/MM/YYYY',
        currency: 'EUR',
      },
    });
    expect(prompt).toContain('Extraction Hints');
    expect(prompt).toContain('DD/MM/YYYY');
    expect(prompt).toContain('EUR');
  });

  it('appends known accounts section with providerAccountIds', () => {
    const prompt = buildSystemPrompt({
      existingAccounts: [
        { providerAccountId: '4242-credit-eur', name: 'Credit Card 4242', currency: 'EUR', type: 'credit', balance: -125.40 },
        { providerAccountId: '1881-credit-eur', name: 'Credit Card 1881', currency: 'EUR', type: 'credit', balance: -410.55 },
      ],
    });
    expect(prompt).toContain('Known Accounts from Previous Crawls');
    expect(prompt).toContain('4242-credit-eur');
    expect(prompt).toContain('1881-credit-eur');
    expect(prompt).toContain('You MUST reuse the exact providerAccountId values below');
  });

  it('does not include known accounts section when empty', () => {
    const prompt = buildSystemPrompt({ existingAccounts: [] });
    expect(prompt).not.toContain('Known Accounts');
  });

  it('does not include known accounts section when undefined', () => {
    const prompt = buildSystemPrompt({});
    expect(prompt).not.toContain('Known Accounts');
  });

  it('appends known positions section with providerPositionIds', () => {
    const prompt = buildSystemPrompt({
      existingPositions: [
        { providerPositionId: 'AAPL', providerAccountId: 'portfolio-a', symbol: 'AAPL', name: 'Apple Inc.', currency: 'USD', quantity: 95 },
        { providerPositionId: '111203', providerAccountId: 'portfolio-a', symbol: '111203', name: 'QUALCOMM INC', currency: 'USD', quantity: 67 },
      ],
    });
    expect(prompt).toContain('Position ID Reference');
    expect(prompt).toContain('AAPL');
    expect(prompt).toContain('111203');
    expect(prompt).toContain('matches an entry below in the same owning account');
    expect(prompt).toContain('portfolio-a');
  });

  it('does not include known positions section when empty', () => {
    const prompt = buildSystemPrompt({ existingPositions: [] });
    expect(prompt).not.toContain('Position ID Reference');
  });

  it('does not include known positions section when undefined', () => {
    const prompt = buildSystemPrompt({});
    expect(prompt).not.toContain('Position ID Reference');
  });

  it('omits sections with no applicable hints', () => {
    const prompt = buildSystemPrompt({
      loginHints: {},
      extractionHints: {},
    });
    expect(prompt).not.toContain('Login Form Hints');
    expect(prompt).not.toContain('Extraction Hints');
  });

  it('includes providerAccountId reuse instruction in main rules', () => {
    const prompt = buildSystemPrompt({});
    expect(prompt).toContain('providerAccountId');
  });

  it('instructs model to set providerAccountId on every transaction', () => {
    const prompt = buildSystemPrompt({});
    expect(prompt).toContain('providerAccountId on transactions');
    expect(prompt).toContain('Every transaction MUST include a providerAccountId');
  });

  it('requires explicit count claims for genuinely identical transaction rows', () => {
    const prompt = buildSystemPrompt({});
    expect(prompt).toContain("identical multiples use 'count'");
    expect(prompt).toContain("return them as ONE entry with 'count': N");
    expect(prompt).toContain('Repeated identical entries in your output are treated as ONE transaction');
  });

  it('keeps arithmetic-only account and position collapse forbidden', () => {
    const prompt = buildSystemPrompt({});
    expect(prompt).toContain('never drop an account merely because its balance equals the sum of others');
    expect(prompt).toContain('NEVER drop a real holding merely because the holdings total differs');
    expect(prompt).toContain('No numeric ratio decides anything');
    expect(prompt).toContain('never a shared date or a label alone');
  });

  it('uses semantic one-to-one matching for recent transaction deltas', () => {
    const prompt = buildSystemPrompt({
      cutoffDate: '2026-07-01',
      recentTransactions: [{
        providerAccountId: 'account-a',
        providerTransactionId: 'REF-1',
        bookingDate: '2026-07-20',
        amount: -10,
        currency: 'GBP',
        description: 'Cafe',
        isPending: false,
      }],
    });
    expect(prompt).toContain('TRANSCRIPTION DRIFT');
    expect(prompt).toContain('Match them ONE-TO-ONE');
    expect(prompt).toContain('same providerAccountId, same bookingDate, same amount, same currency, same description, same isPending state');
    expect(prompt).toContain('status changed from pending to posted');
    expect(prompt).toContain('TWO POSTED ROWS WITH DISTINCT REAL IDS ARE DISTINCT PAYMENTS');
    expect(prompt).toContain('surplus as ONE Rule-3 entry with `count`');
    expect(prompt).toContain('"NONE"/"content:..."/"occurrence:..."');
  });

  it('renders the explicit first-crawl 90-day cutoff without stored history', () => {
    const prompt = buildSystemPrompt({ cutoffDate: '2026-05-05', recentTransactions: [] });
    expect(prompt).toContain('NO stored transactions for this connection with a booking date on or after 2026-05-05');
    expect(prompt).toContain('extract EVERY transaction with a booking date on or after 2026-05-05');
  });

  it('renders the complete seven-day stored context supplied for a later crawl', () => {
    const recentTransactions = Array.from({ length: 7 }, (_, index) => ({
      providerAccountId: 'account-a',
      providerTransactionId: `REF-${index + 1}`,
      bookingDate: `2026-07-${String(25 + index).padStart(2, '0')}`,
      amount: -(index + 1),
      currency: 'GBP',
      description: `Payment ${index + 1}`,
      isPending: false,
    }));
    const prompt = buildSystemPrompt({ cutoffDate: '2026-07-25', recentTransactions });
    expect(prompt).toContain('from 2026-07-25 to today');
    expect(prompt).not.toContain('reaches further back than the 2026-07-25 extraction cutoff');
    for (const transaction of recentTransactions) {
      expect(prompt).toContain(transaction.providerTransactionId);
      expect(prompt).toContain(transaction.bookingDate);
    }
  });

  const historyExemptionOptions = {
    cutoffDate: '2026-08-04',
    historyFloorDate: '2026-05-13',
    recentTransactions: [{
      providerAccountId: 'account-a',
      providerTransactionId: 'REF-1',
      bookingDate: '2026-08-03',
      amount: -8.75,
      currency: 'EUR',
      description: 'Direct channel fee',
      isPending: false,
    }],
    existingAccounts: [
      { providerAccountId: 'account-a', name: 'Current account', currency: 'EUR', type: 'current', balance: 12345.67 },
      { providerAccountId: 'card-1881', name: 'Credit card', currency: 'EUR', type: 'credit', balance: 250.00 },
    ],
  } satisfies Parameters<typeof buildSystemPrompt>[0];

  it('exempts an account we hold no transactions for from the cutoff', () => {
    // The card was discovered on an earlier crawl, so it IS known — and its
    // history was never captured, because the crawl that found it was bounded by
    // the connection's window. Keying the exemption on novelty would leave it
    // empty forever; it is keyed on having no stored transactions.
    const prompt = buildSystemPrompt({
      ...historyExemptionOptions,
      accountsWithoutStoredHistory: ['card-1881'],
    });
    expect(prompt).toContain('EXCEPTION — an account we hold NO transactions for');
    expect(prompt).toContain('extract back to 2026-05-13');
    expect(prompt).toContain('these known accounts, for which we have stored no transactions at all: "card-1881"');
    expect(prompt).toContain('every row you extract for it is new (Rule 3)');
    // The decision procedure needs the same exemption, or step 1 discards the
    // row before the exception is ever reached.
    expect(prompt).toContain('UNLESS the row belongs to an account the Rule 1 EXCEPTION names');
    // And it must not become a blanket licence for accounts that DO have history.
    expect(prompt).toContain('an account not named here and present in the Known Accounts list keeps the 2026-08-04 floor');
  });

  it('states plainly when every known account already has stored history', () => {
    const prompt = buildSystemPrompt({ ...historyExemptionOptions, accountsWithoutStoredHistory: [] });
    expect(prompt).toContain('(none this crawl — every known account already has stored transactions.)');
    expect(prompt).not.toContain('these known accounts, for which we have stored no transactions at all:');
  });

  it('gives the reach-back a terminal condition so an empty account cannot loop', () => {
    // A reach-back over accounts that turn out to have no rows (an empty FX
    // page, a card carrying only an upcoming charge) must END. Without an
    // explicit exit the model re-navigates hunting for rows that do not exist
    // until the wall clock kills the crawl — and a timed-out crawl stores
    // nothing, losing the accounts it had already extracted.
    const prompt = buildSystemPrompt({
      ...historyExemptionOptions,
      accountsWithoutStoredHistory: ['card-1881'],
    });
    expect(prompt).toContain('WHEN TO STOP: this reach-back is ONE pass per account');
    expect(prompt).toContain('An empty result is a complete, correct answer, not a reason to look again');
    expect(prompt).toContain('Do NOT re-open a page you have already read for that account');
  });

  it('forbids re-reading a page for any account, not only exempted ones', () => {
    const prompt = buildSystemPrompt({});
    expect(prompt).toContain('37d. **An empty result is an answer — never re-read a page hoping it changes.**');
    expect(prompt).toContain('If you find yourself visiting a page for the second time, the correct action is "complete"');
  });

  it('does not push the crawl to patrol the site for products', () => {
    // Discovery is driven by the institution's own instructions and the pages
    // the crawl already visits. A blanket "enumerate every product" rule and a
    // pre-completion product patrol both sent real crawls through loan,
    // deposit and investment sections they had no reason to open — 39 steps
    // where 16 had sufficed, at nine times the cost.
    const prompt = buildSystemPrompt({});
    expect(prompt).not.toContain('Accounts are enumerated from the SITE');
    expect(prompt).not.toContain('Product-coverage check');
  });

  it('falls back to the cutoff when no history floor is supplied', () => {
    const prompt = buildSystemPrompt({ cutoffDate: '2026-08-04', recentTransactions: [] });
    expect(prompt).toContain('extract its transactions back to 2026-08-04');
  });

  it('requires explicit evidence before classifying credential rejection', () => {
    const prompt = buildSystemPrompt({});
    expect(prompt).toContain('Evidence bar for **credentials_rejected**');
    expect(prompt).toContain('your message must QUOTE the on-page text you observed');
  });
});

describe('buildStepContext', () => {
  it('includes current URL', () => {
    const ctx = buildStepContext({ goal: 'Navigate', currentUrl: 'https://bank.example.com/dashboard' });
    expect(ctx).toContain('https://bank.example.com/dashboard');
  });

  it('includes goal', () => {
    const ctx = buildStepContext({ goal: 'Extract all account data', currentUrl: 'https://x.com' });
    expect(ctx).toContain('Extract all account data');
  });

  it('formats as key-value lines', () => {
    const ctx = buildStepContext({ goal: 'login', currentUrl: 'https://a.com' });
    expect(ctx).toBe('Current URL: https://a.com\nCurrent Goal: login');
  });

  it('does not collapse same-URL account or currency views into page-coverage state', () => {
    const firstView = buildStepContext({
      goal: 'extract the EUR account view',
      currentUrl: 'https://a.com/accounts',
    });
    const secondView = buildStepContext({
      goal: 'extract the USD account view',
      currentUrl: 'https://a.com/accounts',
    });
    expect(firstView).toBe('Current URL: https://a.com/accounts\nCurrent Goal: extract the EUR account view');
    expect(secondView).toBe('Current URL: https://a.com/accounts\nCurrent Goal: extract the USD account view');
    expect(`${firstView}\n${secondView}`).not.toMatch(/covered page|do not revisit/i);
  });
});
