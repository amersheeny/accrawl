/**
 * Accounts — everything Accrawl knows about your money, grouped by institution.
 *
 * Structural honesty (mirrors the backend's account-views):
 *  - transactions attach to an account only via the bank's own account reference (exact match);
 *  - transactions the bank didn't attribute are shown in a separate "not linked to an account" section;
 *  - holdings render per INSTITUTION CONNECTION (the bank rarely ties a position to one account), never
 *    invented onto an account.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { api, type AccountView, type ContractHolding, type ContractSecurity, type NormalizedTransaction } from './api';
import { Banner, EmptyState, Spinner, fmtAgo, fmtMoney, useNow } from './components';

function errMsg(e: unknown): string { return e instanceof Error ? e.message : String(e); }

const PAGE = 50;

interface TxState { items: Array<{ id: string; data: NormalizedTransaction }>; hasMore: boolean; loading: boolean }

/** Sum balances per currency — never a fake cross-currency total. */
function balanceTotals(accounts: AccountView[]): string {
  const byCcy = new Map<string, number>();
  for (const a of accounts) byCcy.set(a.data.currency, (byCcy.get(a.data.currency) ?? 0) + a.data.balance);
  return [...byCcy.entries()].map(([ccy, sum]) => fmtMoney(sum, ccy)).join('  +  ');
}

export function Accounts() {
  const [accounts, setAccounts] = useState<AccountView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openAccount, setOpenAccount] = useState<string | null>(null);
  const [tx, setTx] = useState<Record<string, TxState>>({});
  const [positions, setPositions] = useState<Record<string, { holdings: ContractHolding[]; securities: Record<string, ContractSecurity>; loading: boolean } | undefined>>({});
  const [unassigned, setUnassigned] = useState<Record<string, TxState | undefined>>({});
  const now = useNow(60_000);

  useEffect(() => {
    let stop = false;
    api.listAccounts()
      .then((r) => { if (!stop) setAccounts(r.accounts); })
      .catch((e) => { if (!stop) setError(errMsg(e)); })
      .finally(() => { if (!stop) setLoading(false); });
    return () => { stop = true; };
  }, []);

  const groups = useMemo(() => {
    const byConn = new Map<string, AccountView[]>();
    for (const a of accounts) {
      const list = byConn.get(a.connectionId) ?? [];
      list.push(a);
      byConn.set(a.connectionId, list);
    }
    return [...byConn.entries()];
  }, [accounts]);

  const loadTx = useCallback(async (accountId: string, offset: number) => {
    setTx((prev) => ({ ...prev, [accountId]: { items: prev[accountId]?.items ?? [], hasMore: false, loading: true } }));
    try {
      const page = await api.accountTransactions(accountId, PAGE, offset);
      setTx((prev) => ({
        ...prev,
        [accountId]: {
          items: offset === 0 ? page.items : [...(prev[accountId]?.items ?? []), ...page.items],
          hasMore: page.hasMore,
          loading: false,
        },
      }));
    } catch (e) {
      setError(errMsg(e));
      setTx((prev) => ({ ...prev, [accountId]: { items: prev[accountId]?.items ?? [], hasMore: false, loading: false } }));
    }
  }, []);

  function toggleAccount(a: AccountView) {
    const next = openAccount === a.id ? null : a.id;
    setOpenAccount(next);
    if (next && !tx[a.id]) void loadTx(a.id, 0);
  }

  async function togglePositions(connectionId: string) {
    if (positions[connectionId]) { setPositions((p) => ({ ...p, [connectionId]: undefined })); return; }
    setPositions((p) => ({ ...p, [connectionId]: { holdings: [], securities: {}, loading: true } }));
    try {
      const page = await api.connectionHoldings(connectionId);
      const securities = Object.fromEntries(page.securities.map((s) => [s.id, s]));
      setPositions((p) => ({ ...p, [connectionId]: { holdings: page.holdings, securities, loading: false } }));
    } catch (e) { setError(errMsg(e)); setPositions((p) => ({ ...p, [connectionId]: undefined })); }
  }

  async function toggleUnassigned(connectionId: string) {
    if (unassigned[connectionId]) { setUnassigned((p) => ({ ...p, [connectionId]: undefined })); return; }
    setUnassigned((p) => ({ ...p, [connectionId]: { items: [], hasMore: false, loading: true } }));
    try {
      const page = await api.unassignedTransactions(connectionId, PAGE, 0);
      setUnassigned((p) => ({ ...p, [connectionId]: { items: page.items, hasMore: page.hasMore, loading: false } }));
    } catch (e) { setError(errMsg(e)); setUnassigned((p) => ({ ...p, [connectionId]: undefined })); }
  }

  return (
    <div>
      <div className="page-head">
        <div><h1>Accounts</h1><p className="page-sub">Balances, transactions and positions from your latest crawls.</p></div>
      </div>
      {error && <Banner tone="err" onClose={() => setError(null)}>{error}</Banner>}

      {loading && <div className="panel"><Spinner /> <span className="muted">Loading your accounts…</span></div>}

      {!loading && accounts.length === 0 && (
        <div className="panel">
          <EmptyState title="No accounts yet" hint="Run a crawl from the Connections page — extracted accounts appear here automatically.">
            <Link to="/connections">Go to Connections →</Link>
          </EmptyState>
        </div>
      )}

      {groups.map(([connectionId, list]) => {
        const label = `${list[0].institutionName ?? 'Unknown institution'}${list[0].nickname ? ` · ${list[0].nickname}` : ''}`;
        const pos = positions[connectionId];
        const un = unassigned[connectionId];
        return (
          <section key={connectionId}>
            <div className="group-head">
              <h2>{label}</h2>
              <span className="muted">{balanceTotals(list)}</span>
            </div>

            <div className="card-grid" style={{ marginBottom: 12 }}>
              {list.map((a) => (
                <div key={a.id} className={`acct-card${openAccount === a.id ? ' open' : ''}`} onClick={() => toggleAccount(a)} role="button" tabIndex={0}
                  onKeyDown={(e) => { if (e.key === 'Enter') toggleAccount(a); }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                    <div className="row-title">{a.data.name}</div>
                    <span className="faint">{a.data.type}</span>
                  </div>
                  <div className={`acct-balance${a.data.balance > 0 ? '' : ''}`}>{fmtMoney(a.data.balance, a.data.currency)}</div>
                  <div className="faint" style={{ marginTop: 4 }}>
                    Updated {fmtAgo(a.lastSeenAt, now)}
                    {a.missingSinceCrawlCount > 0 && <span style={{ color: 'var(--warn)' }}> · not seen in the last {a.missingSinceCrawlCount} crawl{a.missingSinceCrawlCount === 1 ? '' : 's'}</span>}
                  </div>
                </div>
              ))}
            </div>

            {list.filter((a) => a.id === openAccount).map((a) => {
              const t = tx[a.id];
              return (
                <div key={a.id} className="panel">
                  <div className="panel-title"><h3 style={{ margin: 0 }}>{a.data.name} — transactions</h3>{t?.loading && <Spinner />}</div>
                  {t && t.items.length === 0 && !t.loading && <EmptyState title="No transactions recorded for this account yet" />}
                  {t && t.items.length > 0 && (
                    <div className="table-wrap">
                      <table>
                        <thead><tr><th>Date</th><th>Description</th><th className="num">Amount</th></tr></thead>
                        <tbody>
                          {t.items.map((row) => (
                            <tr key={row.id}>
                              <td className="muted" style={{ whiteSpace: 'nowrap' }}>{row.data.bookingDate}{row.data.isPending ? ' · pending' : ''}</td>
                              <td>{row.data.merchant || row.data.description}</td>
                              <td className={`num ${row.data.amount > 0 ? 'amount-pos' : ''}`}>{fmtMoney(row.data.amount, row.data.currency)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                  {t?.hasMore && (
                    <div className="form-actions"><button className="ghost small" disabled={t.loading} onClick={() => void loadTx(a.id, t.items.length)}>Load more</button></div>
                  )}
                </div>
              );
            })}

            <div style={{ display: 'flex', gap: 10, marginBottom: 8 }}>
              <button className="ghost small" onClick={() => void togglePositions(connectionId)}>
                {pos ? 'Hide portfolio positions' : 'Portfolio positions'}
              </button>
              <button className="ghost small" onClick={() => void toggleUnassigned(connectionId)}>
                {un ? 'Hide unlinked transactions' : 'Transactions not linked to an account'}
              </button>
            </div>

            {pos && (
              <div className="panel">
                <div className="panel-title"><h3 style={{ margin: 0 }}>Portfolio positions</h3><span className="faint">held at {list[0].institutionName ?? 'this institution'} (positions aren't tied to a single account by the bank's data)</span></div>
                {pos.loading ? <Spinner /> : pos.holdings.length === 0 ? <EmptyState title="No positions recorded" /> : (
                  <div className="table-wrap">
                    <table>
                      <thead><tr><th>Security</th><th className="num">Quantity</th><th className="num">Value</th></tr></thead>
                      <tbody>
                        {pos.holdings.map((h) => {
                          const sec = pos.securities[h.securityId];
                          const primary = sec?.ticker ?? sec?.name ?? h.securityId;
                          return (
                            <tr key={h.id}>
                              <td><div className="row-title">{primary}</div>{sec?.ticker && sec.name && <div className="row-sub">{sec.name}</div>}</td>
                              <td className="num">{h.quantity.toLocaleString()}</td>
                              <td className="num">{fmtMoney(h.value, h.currency)}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}

            {un && (
              <div className="panel">
                <div className="panel-title"><h3 style={{ margin: 0 }}>Transactions not linked to an account</h3><span className="faint">the bank's data didn't say which account these belong to</span></div>
                {un.loading ? <Spinner /> : un.items.length === 0 ? <EmptyState title="None — every transaction is linked to an account" /> : (
                  <div className="table-wrap">
                    <table>
                      <thead><tr><th>Date</th><th>Description</th><th className="num">Amount</th></tr></thead>
                      <tbody>
                        {un.items.map((row) => (
                          <tr key={row.id}>
                            <td className="muted" style={{ whiteSpace: 'nowrap' }}>{row.data.bookingDate}</td>
                            <td>{row.data.merchant || row.data.description}</td>
                            <td className={`num ${row.data.amount > 0 ? 'amount-pos' : ''}`}>{fmtMoney(row.data.amount, row.data.currency)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
