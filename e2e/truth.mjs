/**
 * Ground-truth data + credentials for the e2e — imported by both the fake bank (to serve) and the
 * harness (to assert). The crawl must reproduce TRUTH exactly through the full login + OTP + extract path.
 */
export const CREDS = { username: 'alice.morgan', password: 'C0rrect-Horse-Battery' };
export const PHONE_LAST4 = '4567';

// The crawl only collects transactions inside its lookback window, so fixed dates would age out of it.
// The anchor is exported so the fake bank, a child process, renders the same dates even across midnight.
process.env.ACCRAWL_E2E_TODAY ??= new Date().toISOString().slice(0, 10);
const daysBefore = (days) => {
  const date = new Date(`${process.env.ACCRAWL_E2E_TODAY}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
};

export const TRUTH = {
  accounts: [
    { name: 'Everyday Checking', number: '****1234', balance: 4820.55, currency: 'USD' },
    { name: 'High-Yield Savings', number: '****5678', balance: 23150.0, currency: 'USD' },
  ],
  transactions: [
    { date: daysBefore(3), description: 'Whole Foods Market', amount: -82.31 },
    { date: daysBefore(4), description: 'Payroll - ACME Corp', amount: 3200.0 },
    { date: daysBefore(6), description: 'Shell Gas Station', amount: -54.1 },
    { date: daysBefore(8), description: 'Transfer to Savings', amount: -500.0 },
  ],
  // A credit card that is NOT a row in the accounts table: the dashboard shows it only as a charge
  // tile ("balance due") linking to /cards — the shape real banks use. The crawl must record it as its
  // OWN account, not as part of the checking account: type credit, balance = amount OWED as a POSITIVE
  // number (the schema sign rule), and extract its transactions from the /cards page.
  card: {
    name: 'Platinum Card',
    number: '****9012',
    owed: 312.45,
    currency: 'USD',
    transactions: [
      { date: daysBefore(5), description: 'Blue Bottle Coffee', amount: -14.2 },
      { date: daysBefore(7), description: 'City Parking Meters', amount: -28.25 },
      { date: daysBefore(9), description: 'Streaming Plus Subscription', amount: -15.99 },
    ],
  },
};

/**
 * One message for each expected transaction, checking and card, that does not match exactly one stored row by its
 * description and signed amount, or whose row carries a booking date other than the truth's.
 */
export function expectedTransactionErrors(stored) {
  return [...TRUTH.transactions, ...TRUTH.card.transactions].flatMap((t) => {
    const rows = stored.filter((row) => row.description === t.description
      && typeof row.amount === 'number' && Math.abs(row.amount - t.amount) < 0.005);
    if (rows.length !== 1) {
      return [`transaction ${t.amount} (${t.description}) matches ${rows.length} stored rows, expected exactly one`];
    }
    if (rows[0].bookingDate !== t.date) {
      return [`transaction ${t.amount} (${t.description}) is booked on ${rows[0].bookingDate}, expected ${t.date}`];
    }
    return [];
  });
}
