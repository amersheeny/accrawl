/** Crawl observability: the live session monitor (also the per-run detail page) and the crawl history. */
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';
import {
  api, fetchScreenshot, streamSessionEvents,
  type CrawlCost, type SessionRecords, type SessionStep, type SessionSummary, type SessionView, type SseEvent,
} from './api';
import {
  Banner, ConfirmModal, EmptyState, LoadingRows, Spinner, StatusBadge,
  costSummary, fmtDuration, fmtMoney, fmtTokens, fmtUsd, fmtWhen, isActiveStatus, statusInfo, useNow,
  type ConfirmState,
} from './components';
import { crawlDisplayError } from './crawl-copy';

function errMsg(e: unknown): string { return e instanceof Error ? e.message : String(e); }

/** How stale the engine's heartbeat may get (ms) before we warn the run may be stalled. The engine
 *  heartbeats every few seconds while healthy; 60s of silence on an active run is genuinely abnormal. */
const STALL_AFTER_MS = 60_000;

// ─── Live activity feed: humanize the SSE events ─────────────────────────────

interface FeedLine { key: string; when: number; text: string; tone?: 'err' | 'warn' }

function humanizeEvent(ev: SseEvent): FeedLine | null {
  const d = (ev.data ?? {}) as Record<string, unknown>;
  switch (ev.type) {
    case 'status': {
      const label = typeof d.status === 'string' ? statusInfo(d.status).label : null;
      const step = typeof d.currentStep === 'string' && d.currentStep ? ` — ${d.currentStep}` : '';
      return label ? { key: `s${ev.id}`, when: Date.now(), text: `${label}${step}` } : null;
    }
    case 'log': {
      const lines = Array.isArray(d.lines) ? d.lines.filter((l): l is string => typeof l === 'string') : [];
      if (!lines.length) return null;
      return { key: `l${ev.id}`, when: Date.now(), text: lines.join(' · ') };
    }
    case 'otp_requested':
      // Fired when the code relay is ARMED (at crawl start for a 2FA institution) — the bank hasn't
      // asked yet. The real "enter your code" prompt is the waiting_for_otp status + the OTP card.
      return { key: `o${ev.id}`, when: Date.now(), text: 'Watching for a 2FA code from your bank.' };
    case 'end':
      return { key: `e${ev.id}`, when: Date.now(), text: 'Crawl finished.' };
    case 'step': // the step timeline panel renders these richly — no feed noise
    default:
      return null;
  }
}

// ─── Screenshot viewer (auth'd blob fetches, cached object URLs) ─────────────

function useScreenshots(sessionId: string) {
  const cache = useRef(new Map<number, string>());
  const pending = useRef(new Set<number>());
  // Generation guard: bumped when the session changes or the page unmounts, so an in-flight fetch
  // from the previous session can never land in (or leak into) the current session's cache.
  const gen = useRef(0);
  const [, bump] = useState(0);
  const load = useCallback(async (step: number) => {
    if (cache.current.has(step) || pending.current.has(step)) return;
    pending.current.add(step);
    const startedGen = gen.current;
    try {
      const url = await fetchScreenshot(sessionId, step);
      if (!url) return;
      if (startedGen !== gen.current) { URL.revokeObjectURL(url); return; }
      cache.current.set(step, url);
      bump((n) => n + 1);
    } finally { pending.current.delete(step); }
  }, [sessionId]);
  useEffect(() => {
    const urls = cache.current;
    return () => {
      gen.current += 1;
      for (const u of urls.values()) URL.revokeObjectURL(u);
      urls.clear();
    };
  }, [sessionId]);
  return { shots: cache.current, load };
}

// ─── The monitor / run-detail page ────────────────────────────────────────────

export function SessionMonitor() {
  // Keyed by the session id: navigating between two runs (e.g. browser back/forward) remounts the
  // page with fresh state, so one run's feed/records/screenshots can never bleed into another's.
  const { id = '' } = useParams();
  return <SessionMonitorView key={id} id={id} />;
}

function SessionMonitorView({ id }: { id: string }) {
  const [view, setView] = useState<SessionView | null>(null);
  const [gone, setGone] = useState(false);
  const [label, setLabel] = useState<string | null>(null);
  const [steps, setSteps] = useState<SessionStep[]>([]);
  const [feed, setFeed] = useState<FeedLine[]>([]);
  const [records, setRecords] = useState<SessionRecords | null>(null);
  const [selectedStep, setSelectedStep] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [live, setLive] = useState<'connecting' | 'streaming' | 'reconnecting' | 'closed'>('connecting');
  const now = useNow(1000);
  const { shots, load: loadShot } = useScreenshots(id);
  const feedRef = useRef<HTMLDivElement>(null);

  const active = view ? isActiveStatus(view.status) : false;
  const cancelling = view?.status === 'cancelling';

  // Server state is the truth: fetch immediately, and poll while the run is active (SSE is the fast lane,
  // polling is the floor — the monitor can never freeze on a stale status again).
  useEffect(() => {
    if (!id) return;
    let stop = false;
    const tick = async () => {
      try {
        const v = await api.getSession(id);
        if (stop) return;
        setView(v);
        if (isActiveStatus(v.status) || steps.length === 0) {
          const s = await api.getSessionSteps(id);
          if (!stop) setSteps(s.steps);
        }
      } catch (e) {
        if (!stop) {
          if ((e as { status?: number }).status === 404) setGone(true);
          else setError(errMsg(e));
        }
      }
    };
    void tick();
    const t = setInterval(() => {
      // keep polling only while we believe the run is live (or before the first view arrived)
      if (!view || isActiveStatus(view.status)) void tick();
    }, 4000);
    return () => { stop = true; clearInterval(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- id + liveness drive the poll; `view`/`steps` are read fresh inside
  }, [id, active]);

  // Label the run with its institution (the history list carries the join).
  useEffect(() => {
    if (!id) return;
    let stop = false;
    api.listSessions()
      .then((r) => {
        const s = r.sessions.find((x) => x.id === id);
        if (s && !stop) setLabel(`${s.institutionName ?? 'Unknown institution'}${s.nickname ? ` · ${s.nickname}` : ''}`);
      })
      .catch(() => {}); // cosmetic only — the monitor works unlabeled
    return () => { stop = true; };
  }, [id]);

  // Live event stream (replay-safe reconnects). A clean server close WITHOUT `end` is a disconnect too.
  useEffect(() => {
    if (!id) return;
    const ctrl = new AbortController();
    let lastId = 0;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    // Late-resolving fetches must never write another session's data into this page after
    // unmount / a route change — everything below is gated on the effect's abort signal.
    const onTerminal = () => {
      stopped = true;
      setLive('closed');
      // Pull the authoritative final state (real outcome, cost) + the finished timeline.
      void api.getSession(id).then((v) => { if (!ctrl.signal.aborted) setView(v); }).catch(() => {});
      void api.getSessionSteps(id).then((r) => { if (!ctrl.signal.aborted) setSteps(r.steps); }).catch(() => {});
    };

    function connect(): void {
      if (stopped || ctrl.signal.aborted) return;
      setLive((s) => (s === 'connecting' ? s : 'reconnecting'));
      streamSessionEvents(id, (ev) => {
        setLive('streaming');
        const n = Number(ev.id);
        if (Number.isFinite(n) && n > lastId) lastId = n;
        if (ev.type === 'end') { onTerminal(); return; }
        if (ev.type === 'step') {
          // a new step landed — refresh the timeline soon (cheap, bounded by the poll anyway)
          void api.getSessionSteps(id).then((r) => { if (!ctrl.signal.aborted) setSteps(r.steps); }).catch(() => {});
        }
        if (ev.type === 'status') {
          const d = ev.data as { status?: string };
          if (d?.status) setView((v) => (v ? { ...v, status: d.status! } : v));
        }
        const line = humanizeEvent(ev);
        if (line) setFeed((prev) => [...prev.slice(-400), line]);
      }, ctrl.signal, lastId || undefined)
        .then(() => { if (!stopped && !ctrl.signal.aborted) timer = setTimeout(connect, 1500); })   // clean close, no `end` → reconnect
        .catch(() => { if (!stopped && !ctrl.signal.aborted) timer = setTimeout(connect, 1500); });
    }
    connect();
    return () => { stopped = true; clearTimeout(timer); ctrl.abort(); };
  }, [id]);

  // When the run is over, fetch what it extracted; keep the latest screenshot selected while live.
  const terminal = view ? !isActiveStatus(view.status) : false;
  useEffect(() => {
    if (!terminal) return;
    let stop = false;
    api.getSessionRecords(id).then((r) => { if (!stop) setRecords(r); }).catch(() => { if (!stop) setRecords(null); });
    return () => { stop = true; };
  }, [terminal, id]);

  const shotSteps = useMemo(() => steps.filter((s) => s.hasScreenshot), [steps]);
  const latestShotStep = shotSteps.length ? shotSteps[shotSteps.length - 1].stepNumber : null;
  const shownStep = selectedStep ?? latestShotStep;
  useEffect(() => { if (shownStep != null) void loadShot(shownStep); }, [shownStep, loadShot]);
  useEffect(() => { // prefetch the last few thumbnails
    for (const s of shotSteps.slice(-6)) void loadShot(s.stepNumber);
  }, [shotSteps, loadShot]);

  // Auto-scroll the feed (only if the user is already near the bottom).
  useEffect(() => {
    const el = feedRef.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 80) el.scrollTop = el.scrollHeight;
  }, [feed]);

  const startedMs = view?.startedAt ? new Date(view.startedAt).getTime() : null;
  const endedMs = view?.completedAt ? new Date(view.completedAt).getTime() : null;
  const elapsed = startedMs ? fmtDuration((endedMs ?? now) - startedMs) : '—';
  const heartbeatAge = view?.heartbeatAt ? now - new Date(view.heartbeatAt).getTime() : null;
  const stalled = active && !cancelling && heartbeatAge != null && heartbeatAge > STALL_AFTER_MS;
  // ONLY the waiting_for_otp status means "the bank asked for a code right now" (it is also the only
  // state where the OTP endpoint accepts one). view.otpRequested flips true when the relay is ARMED —
  // at crawl start for any 2FA institution — long before the bank asks, so it must not show the card.
  const waitingForOtp = view?.status === 'waiting_for_otp';

  function askCancel() {
    setConfirm({
      title: 'Stop this crawl?',
      body: <>The crawl stops where it is and the connection is released. Anything already extracted in this run is discarded.</>,
      confirmLabel: 'Stop crawl',
      danger: true,
      onConfirm: async () => {
        try { await api.cancelSession(id); const v = await api.getSession(id); setView(v); }
        catch (e) { setError(errMsg(e)); }
      },
    });
  }

  if (gone) {
    return (
      <div>
        <h1>Crawl not found</h1>
        <p className="page-sub">This run may have been cleaned up, or the link is wrong.</p>
        <Link to="/history">← Back to crawl history</Link>
      </div>
    );
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>{label ?? 'Crawl'}</h1>
          <p className="page-sub" style={{ marginBottom: 0 }}>
            Started {fmtWhen(view?.startedAt)} · <code>{id.slice(0, 8)}</code>
          </p>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          {view ? <StatusBadge status={view.status} /> : <Spinner />}
          {active && !cancelling && <button className="danger small" onClick={askCancel}>Stop crawl</button>}
        </div>
      </div>

      {error && <Banner tone="err" onClose={() => setError(null)}>{error}</Banner>}
      {stalled && (
        <Banner tone="warn">
          The crawler hasn't reported progress for {fmtDuration(heartbeatAge!)} — it may be stalled. If nothing
          changes, it will be marked failed automatically; you can also stop it now.
        </Banner>
      )}
      {view?.status === 'failed' && <Banner tone="err"><strong>This crawl failed.</strong>{view.error ? ` ${crawlDisplayError(view.error)}` : ''}</Banner>}
      {view?.status === 'cancelled' && <Banner tone="info">This crawl was cancelled.</Banner>}
      {view?.status === 'completed' && records && (
        <Banner tone="ok">
          <strong>Crawl completed.</strong> Extracted {records.counts.accounts} account{records.counts.accounts === 1 ? '' : 's'},{' '}
          {records.counts.transactions} transaction{records.counts.transactions === 1 ? '' : 's'} and {records.counts.positions} position{records.counts.positions === 1 ? '' : 's'} —
          see <Link to="/accounts">Accounts</Link> or the extracted data below.
        </Banner>
      )}

      {waitingForOtp && active && <OtpCard sessionId={id} />}

      <div className="panel">
        <div className="stat-row">
          <div className="stat"><div className="stat-label">{terminal ? 'Duration' : 'Running for'}</div><div className="stat-value">{elapsed}</div></div>
          <div className="stat"><div className="stat-label">Steps</div><div className="stat-value">{view?.stepCount ?? '—'}</div></div>
          <div className="stat"><div className="stat-label">Doing now</div><div className="stat-value" style={{ fontSize: 14, fontWeight: 500 }}>{active ? (view?.currentStep ?? statusInfo(view?.status ?? '').label) : '—'}</div></div>
          <div className="stat"><div className="stat-label">Cost</div><div className="stat-value">{view?.cost ? fmtUsd(view.cost.totalCostUsd) : '—'}</div></div>
          <div className="stat"><div className="stat-label">Live feed</div><div className="stat-value" style={{ fontSize: 14, fontWeight: 500 }}>
            {terminal ? 'ended' : live === 'streaming' ? <span style={{ color: 'var(--ok)' }}>connected</span> : <span style={{ color: 'var(--warn)' }}>{live}…</span>}
          </div></div>
        </div>
      </div>

      <div className="monitor-grid">
        <div className="panel" style={{ marginBottom: 0 }}>
          <div className="panel-title"><h3 style={{ margin: 0 }}>Step timeline</h3><span className="faint">{steps.length} recorded</span></div>
          {steps.length === 0 ? (
            <EmptyState title={active ? 'Waiting for the first step…' : 'No steps were recorded'} />
          ) : (
            <div className="timeline">
              {[...steps].reverse().map((s) => (
                <div key={s.stepNumber} className={`step-row${s.error ? ' error' : ''}`}>
                  <span className="step-n">{s.stepNumber}</span>
                  <span className="step-desc">
                    {s.description || s.action}
                    {s.error && <span style={{ color: 'var(--err)' }}> — {crawlDisplayError(s.error)}</span>}
                    {(s.accountsExtracted > 0 || s.transactionsExtracted > 0 || s.positionsExtracted > 0) && (
                      <span style={{ color: 'var(--ok)' }}>
                        {' '}· extracted{s.accountsExtracted ? ` ${s.accountsExtracted} acct` : ''}{s.transactionsExtracted ? ` ${s.transactionsExtracted} tx` : ''}{s.positionsExtracted ? ` ${s.positionsExtracted} pos` : ''}
                      </span>
                    )}
                    {s.url && <span className="url">{s.url}</span>}
                  </span>
                  <span className="step-meta">
                    {s.durationMs != null ? fmtDuration(s.durationMs) : ''}
                    {s.hasScreenshot && (
                      <button className="link-btn" style={{ marginLeft: 8 }} onClick={() => { setSelectedStep(s.stepNumber); void loadShot(s.stepNumber); }}>view</button>
                    )}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div>
          <div className="panel" style={{ marginBottom: 14 }}>
            <div className="panel-title"><h3 style={{ margin: 0 }}>Screenshots</h3>{shownStep != null && <span className="faint">step {shownStep}</span>}</div>
            <div className="shot-frame">
              {shownStep != null && shots.get(shownStep)
                ? <img src={shots.get(shownStep)} alt={`Step ${shownStep} screenshot`} />
                : <div className="shot-empty">{active ? 'Waiting for the first screenshot…' : 'No screenshots for this run'}</div>}
            </div>
            {shotSteps.length > 1 && (
              <div className="shot-strip">
                {shotSteps.map((s) => (
                  <button key={s.stepNumber} className={`shot-thumb${shownStep === s.stepNumber ? ' active' : ''}`}
                    onClick={() => { setSelectedStep(s.stepNumber); void loadShot(s.stepNumber); }}>
                    {shots.get(s.stepNumber) ? <img src={shots.get(s.stepNumber)} alt="" /> : null}
                    <span className="shot-n">{s.stepNumber}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="panel" style={{ marginBottom: 0 }}>
            <h3>Activity</h3>
            <div className="timeline" style={{ maxHeight: '28vh' }} ref={feedRef}>
              {feed.length === 0
                ? <span className="faint">{active ? 'Live updates appear here.' : 'This run has ended — see the timeline for what happened.'}</span>
                : feed.map((l) => (
                  <div key={l.key} className="step-row" style={l.tone === 'warn' ? { color: 'var(--warn)' } : undefined}>
                    <span className="step-desc">{l.text}</span>
                  </div>
                ))}
            </div>
          </div>
        </div>
      </div>

      {view?.cost && <CostPanel cost={view.cost} />}
      {terminal && records && (records.counts.accounts > 0 || records.counts.transactions > 0 || records.counts.positions > 0) && (
        <RecordsPanel records={records} />
      )}
      <ConfirmModal state={confirm} onClose={() => setConfirm(null)} />
    </div>
  );
}

function OtpCard({ sessionId }: { sessionId: string }) {
  const [otp, setOtp] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  // One idempotency key per entered code: a double-click or retried POST can never burn a second 2FA attempt.
  const keyRef = useRef(crypto.randomUUID());
  async function submit(e: FormEvent) {
    e.preventDefault(); setBusy(true); setMsg(null);
    try {
      await api.submitOtp(sessionId, otp.trim(), keyRef.current);
      setMsg({ tone: 'ok', text: 'Code sent — the crawl continues automatically.' });
      setOtp('');
      keyRef.current = crypto.randomUUID();
    } catch (e) {
      setMsg({ tone: 'err', text: errMsg(e) });
    } finally { setBusy(false); }
  }
  return (
    <div className="otp-card">
      <h3>The bank sent you a 2FA code</h3>
      <p className="muted" style={{ margin: '0 0 10px' }}>Check your phone or email and enter the code — the crawl is paused until you do.</p>
      <form onSubmit={submit} style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <input placeholder="Enter code" inputMode="numeric" autoComplete="one-time-code" value={otp} onChange={(e) => setOtp(e.target.value)} style={{ width: 160 }} autoFocus />
        <button disabled={busy || !otp.trim()}>{busy ? 'Sending…' : 'Submit code'}</button>
        {msg && <span style={{ color: msg.tone === 'ok' ? 'var(--ok)' : 'var(--err)' }}>{msg.text}</span>}
      </form>
    </div>
  );
}

function CostPanel({ cost }: { cost: CrawlCost }) {
  return (
    <div className="panel">
      <div className="panel-title"><h3 style={{ margin: 0 }}>Cost</h3><span className="faint">{cost.modelId}</span></div>
      <div className="stat-row">
        <div className="stat"><div className="stat-label">Total</div><div className="stat-value">{fmtUsd(cost.totalCostUsd)}</div></div>
        <div className="stat"><div className="stat-label">Input tokens</div><div className="stat-value">{fmtTokens(cost.inputTokens)}</div></div>
        <div className="stat"><div className="stat-label">Output tokens</div><div className="stat-value">{fmtTokens(cost.outputTokens)}</div></div>
        <div className="stat"><div className="stat-label">Cache read</div><div className="stat-value">{fmtTokens(cost.cacheReadInputTokens)}</div></div>
        <div className="stat"><div className="stat-label">Input / output cost</div><div className="stat-value" style={{ fontSize: 14 }}>{fmtUsd(cost.inputCostUsd)} / {fmtUsd(cost.outputCostUsd)}</div></div>
      </div>
    </div>
  );
}

function RecordsPanel({ records }: { records: SessionRecords }) {
  const [tab, setTab] = useState<'accounts' | 'transactions' | 'positions'>(
    records.counts.accounts ? 'accounts' : records.counts.transactions ? 'transactions' : 'positions',
  );
  return (
    <div className="panel">
      <div className="panel-title">
        <h3 style={{ margin: 0 }}>Extracted in this run</h3>
        <div style={{ display: 'flex', gap: 6 }}>
          {(['accounts', 'transactions', 'positions'] as const).map((t) => (
            <button key={t} className={tab === t ? 'small' : 'ghost small'} onClick={() => setTab(t)}>
              {t} ({records.counts[t]})
            </button>
          ))}
        </div>
      </div>
      <div className="table-wrap">
        {tab === 'accounts' && (
          <table>
            <thead><tr><th>Account</th><th>Type</th><th className="num">Balance</th></tr></thead>
            <tbody>
              {records.accounts.map((a, i) => (
                <tr key={i}><td><div className="row-title">{a.name}</div><div className="row-sub">{a.description}</div></td><td className="muted">{a.type}</td><td className="num">{fmtMoney(a.balance, a.currency)}</td></tr>
              ))}
            </tbody>
          </table>
        )}
        {tab === 'transactions' && (
          <table>
            <thead><tr><th>Date</th><th>Description</th><th className="num">Amount</th></tr></thead>
            <tbody>
              {records.transactions.map((t, i) => (
                <tr key={i}><td className="muted">{t.bookingDate}</td><td>{t.merchant || t.description}</td><td className={`num ${t.amount > 0 ? 'amount-pos' : ''}`}>{fmtMoney(t.amount, t.currency)}</td></tr>
              ))}
            </tbody>
          </table>
        )}
        {tab === 'positions' && (
          <table>
            <thead><tr><th>Security</th><th className="num">Quantity</th><th className="num">Value</th></tr></thead>
            <tbody>
              {records.positions.map((p, i) => (
                <tr key={i}><td><div className="row-title">{p.symbol ?? p.name}</div>{p.symbol && <div className="row-sub">{p.name}</div>}</td><td className="num">{p.quantity.toLocaleString()}</td><td className="num">{fmtMoney(p.valueNative, p.currency)}</td></tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ─── Crawl history ────────────────────────────────────────────────────────────

export function History() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const now = useNow(30_000);

  useEffect(() => {
    let stop = false;
    api.listSessions()
      .then((r) => { if (!stop) setSessions(r.sessions); })
      .catch((e) => { if (!stop) setError(errMsg(e)); })
      .finally(() => { if (!stop) setLoading(false); });
    return () => { stop = true; };
  }, []);

  const totalCost = sessions.reduce((sum, s) => sum + (s.cost?.totalCostUsd ?? 0), 0);
  const running = sessions.filter((s) => isActiveStatus(s.status));

  return (
    <div>
      <div className="page-head">
        <div><h1>Crawl history</h1><p className="page-sub">Every crawl run: what happened, how long it took, and what it cost.</p></div>
        <div className="stat" style={{ textAlign: 'right' }}>
          <div className="stat-label">Cost (last {sessions.length} runs)</div>
          <div className="stat-value">{fmtUsd(totalCost)}</div>
        </div>
      </div>
      {error && <Banner tone="err" onClose={() => setError(null)}>{error}</Banner>}
      {running.map((s) => (
        <Banner key={s.id} tone="info">
          {s.status === 'cancelling'
            ? <><StatusBadge status={s.status} /> — <Link to={`/sessions/${s.id}`}>view crawl progress</Link>.</>
            : <>A crawl{s.institutionName ? ` of ${s.institutionName}` : ''} is running — <Link to={`/sessions/${s.id}`}>view crawl progress</Link>.</>}
        </Banner>
      ))}

      <div className="panel">
        <div className="table-wrap">
          <table>
            <thead><tr><th>Institution</th><th>Started</th><th>Outcome</th><th className="num">Duration</th><th className="num">Steps</th><th className="num">Cost</th><th /></tr></thead>
            <tbody>
              {loading ? <LoadingRows cols={7} /> : sessions.map((s) => {
                const started = s.startedAt ? new Date(s.startedAt).getTime() : null;
                const ended = s.completedAt ? new Date(s.completedAt).getTime() : null;
                const activeRun = isActiveStatus(s.status);
                return (
                  <tr key={s.id}>
                    <td>
                      <div className="row-title">{s.institutionName ?? 'Unknown'}{s.nickname ? ` · ${s.nickname}` : ''}</div>
                      {s.error && <div className="row-sub" style={{ color: 'var(--err)' }}>{s.error.slice(0, 90)}</div>}
                    </td>
                    <td className="muted">{fmtWhen(s.startedAt)}</td>
                    <td><StatusBadge status={s.status} /></td>
                    <td className="num">{started ? fmtDuration((ended ?? (activeRun ? now : started)) - started) : '—'}</td>
                    <td className="num">{s.stepCount}</td>
                    <td className="num" title={s.cost ? `${fmtTokens(s.cost.inputTokens)} in / ${fmtTokens(s.cost.outputTokens)} out` : undefined}>{costSummary(s.cost)}</td>
                    <td><div className="actions"><Link to={`/sessions/${s.id}`}>{activeRun ? 'Watch live' : 'Details'}</Link></div></td>
                  </tr>
                );
              })}
              {!loading && sessions.length === 0 && (
                <tr><td colSpan={7}><EmptyState title="No crawls yet" hint="Start one from the Connections page — every run shows up here with its steps, screenshots, data and cost." /></td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
