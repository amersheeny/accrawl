/**
 * Ground-truth data + credentials for the e2e — imported by both the fake bank (to serve) and the
 * harness (to assert). The crawl must reproduce TRUTH exactly through the full login + OTP + extract path.
 */
export const CREDS = { username: 'alice.morgan', password: 'C0rrect-Horse-Battery' };
export const PHONE_LAST4 = '4567';

export const TRUTH = {
  accounts: [
    { name: 'Everyday Checking', number: '****1234', balance: 4820.55, currency: 'USD' },
    { name: 'High-Yield Savings', number: '****5678', balance: 23150.0, currency: 'USD' },
  ],
  transactions: [
    { date: '2026-06-25', description: 'Whole Foods Market', amount: -82.31 },
    { date: '2026-06-24', description: 'Payroll - ACME Corp', amount: 3200.0 },
    { date: '2026-06-22', description: 'Shell Gas Station', amount: -54.1 },
    { date: '2026-06-20', description: 'Transfer to Savings', amount: -500.0 },
  ],
  // A credit card that is NOT a row in the accounts table: the dashboard shows it only as a charge
  // tile ("balance due") linking to /cards — the shape real banks use, and exactly the shape that
  // used to be dropped as a "sub-breakdown" of the checking account. The crawl must record it as its
  // OWN account, type credit, balance = amount OWED as a POSITIVE number (the schema sign rule),
  // and extract its transactions from the /cards page.
  card: {
    name: 'Platinum Card',
    number: '****9012',
    owed: 312.45,
    currency: 'USD',
    transactions: [
      { date: '2026-06-23', description: 'Blue Bottle Coffee', amount: -14.2 },
      { date: '2026-06-21', description: 'City Parking Meters', amount: -28.25 },
      { date: '2026-06-19', description: 'Streaming Plus Subscription', amount: -15.99 },
    ],
  },
};
