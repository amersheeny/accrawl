import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { CRAWL_MODELS, DEFAULT_CRAWL_MODEL } from '@accrawl/contracts/models';
import {
  api, setToken, ApiError,
  type Connection, type CreatedDevicePairingIntent, type Device, type Institution, type InstitutionPatch,
  type NewInstitution, type SessionSummary,
} from './api';
import {
  Banner, ConfirmModal, CopyButton, EmptyState, LoadingRows, QRCode, StatusBadge,
  fmtAgo, fmtWhen, isActiveStatus, statusInfo, useNow, type ConfirmState,
} from './components';
import { COMPANION_APK_URL, COMPANION_COPY } from './companion-copy';
import { crawlDisplayError } from './crawl-copy';
import { INSTITUTION_COPY } from './institution-copy';
import {
  defaultScheduleForm,
  formatNextCrawl,
  formatSchedule,
  scheduleForNewConnection,
  ScheduleFields,
  ScheduleModal,
  type ScheduleFormValue,
} from './crawl-schedule';
import { SCHEDULE_COPY } from './schedule-copy';

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ─── Auth screens ─────────────────────────────────────────────────────────────

export function Login() {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(true); // don't show the sign-in form until we know setup has run
  const nav = useNavigate();
  useEffect(() => {
    // First run: if no operator exists yet, go STRAIGHT to setup — never flash the sign-in form. Only show
    // the sign-in form once we know an operator was created (or the API is unreachable, as a fallback).
    api.setupStatus()
      .then((s) => { if (!s.initialized) nav('/setup', { replace: true }); else setChecking(false); })
      .catch(() => setChecking(false));
  }, [nav]);
  async function submit(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError(null);
    try { setToken((await api.login(password)).token); nav('/connections'); }
    catch (e) { setError(errMsg(e)); } finally { setBusy(false); }
  }
  if (checking) {
    return <div className="centered"><div className="card"><h1>Accrawl</h1><p className="muted">Loading…</p></div></div>;
  }
  return (
    <div className="centered">
      <form className="card" onSubmit={submit}>
        <h1>Accrawl</h1>
        <p className="muted">Sign in to your console</p>
        <input type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
        {error && <Banner tone="err">{error}</Banner>}
        <button disabled={busy || !password}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
    </div>
  );
}

export function Setup() {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [setupCode, setSetupCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nav = useNavigate();
  useEffect(() => {
    // If setup already ran, there is nothing to do here — go to login. (Ignore reachability errors: the
    // form itself will surface them on submit.)
    api.setupStatus().then((s) => { if (s.initialized) nav('/login', { replace: true }); }).catch(() => {});
  }, [nav]);
  async function submit(e: FormEvent) {
    e.preventDefault(); setError(null);
    if (password.length < 8) { setError('Password must be at least 8 characters.'); return; }
    if (password !== confirm) { setError('Passwords do not match.'); return; }
    if (!setupCode.trim()) { setError('Enter this deployment\'s setup code.'); return; }
    setBusy(true);
    try { setToken((await api.setup(password, setupCode.trim())).token); nav('/connections'); }
    catch (e) { setError(errMsg(e)); } finally { setBusy(false); }
  }
  return (
    <div className="centered">
      <form className="card" onSubmit={submit}>
        <h1>Welcome to Accrawl</h1>
        <p className="muted">Create a password to secure your console. You'll use it to sign in from now on.</p>
        <input type="text" placeholder="Setup code" value={setupCode} onChange={(e) => setSetupCode(e.target.value)} autoFocus autoComplete="off" spellCheck={false} />
        <p className="faint">./setup.sh saved this code in .env as SETUP_CLAIM_TOKEN. Enter it to confirm you have access to this deployment's configuration before setting its first password.</p>
        <input type="password" placeholder="Create a password (at least 8 characters)" value={password} onChange={(e) => setPassword(e.target.value)} />
        <input type="password" placeholder="Confirm password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        {error && <Banner tone="err">{error}</Banner>}
        <p className="faint">Your password is stored securely on your machine — never in plain text.</p>
        <button disabled={busy || !password || !confirm || !setupCode.trim()}>{busy ? 'Creating…' : 'Create password & continue'}</button>
      </form>
    </div>
  );
}

// ─── Institutions ─────────────────────────────────────────────────────────────

/** Derive the internal identifier from the display name — the operator never sees a "slug" field. */
function slugify(name: string): string {
  return name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'institution';
}

const EMPTY_INSTITUTION = {
  name: '', loginUrl: '', type: 'bank', requires2fa: false, otpSenderPattern: '', playbook: '', model: '',
  thinkingLevel: '', maxSteps: '', timeoutSeconds: '', transactionLookbackDays: '',
};

/** Parse an optional numeric form field: '' → undefined (create: use the default; edit: keep current). */
function numOrUndef(v: string): number | undefined {
  const n = Number(v);
  return v.trim() === '' || Number.isNaN(n) ? undefined : n;
}

export function Institutions() {
  const [items, setItems] = useState<Institution[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState(EMPTY_INSTITUTION);
  // When set, the form edits this existing institution instead of creating a new one.
  const [editing, setEditing] = useState<Institution | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);

  const load = useCallback(async () => {
    try { setItems((await api.listInstitutions()).institutions); } catch (e) { setError(errMsg(e)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  function startEdit(inst: Institution) {
    setEditing(inst);
    setForm({
      name: inst.name,
      loginUrl: inst.loginUrl,
      type: inst.type,
      requires2fa: inst.requires2fa,
      otpSenderPattern: inst.otpSenderPattern ?? '',
      playbook: inst.playbook ?? '',
      model: inst.model ?? '',
      thinkingLevel: inst.thinkingLevel ?? '',
      maxSteps: String(inst.maxSteps),
      timeoutSeconds: String(inst.timeoutSeconds),
      transactionLookbackDays: String(inst.transactionLookbackDays),
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function cancelEdit() {
    setEditing(null);
    setForm(EMPTY_INSTITUTION);
  }

  async function submit(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError(null);
    try {
      if (editing) {
        // Edit sends every field: an emptied field really clears (model uses null to mean "default").
        await api.updateInstitution(editing.id, {
          name: form.name.trim(),
          loginUrl: form.loginUrl.trim(),
          type: form.type,
          requires2fa: form.requires2fa,
          playbook: form.playbook.trim(),
          otpSenderPattern: form.requires2fa ? form.otpSenderPattern.trim() : '',
          model: form.model || null,
          thinkingLevel: (form.thinkingLevel || null) as InstitutionPatch['thinkingLevel'],
          maxSteps: numOrUndef(form.maxSteps),
          timeoutSeconds: numOrUndef(form.timeoutSeconds),
          transactionLookbackDays: numOrUndef(form.transactionLookbackDays),
        });
        setEditing(null);
      } else {
        const payload: NewInstitution = {
          id: slugify(form.name),
          name: form.name.trim(),
          loginUrl: form.loginUrl.trim(),
          type: form.type,
          requires2fa: form.requires2fa,
          // Drop empty optional strings so we never write "" over a field the operator left blank.
          playbook: form.playbook.trim() || undefined,
          otpSenderPattern: form.requires2fa ? (form.otpSenderPattern.trim() || undefined) : undefined,
          model: form.model || undefined,
          thinkingLevel: (form.thinkingLevel || undefined) as NewInstitution['thinkingLevel'],
          maxSteps: numOrUndef(form.maxSteps),
          timeoutSeconds: numOrUndef(form.timeoutSeconds),
          transactionLookbackDays: numOrUndef(form.transactionLookbackDays),
        };
        await api.createInstitution(payload);
      }
      setForm(EMPTY_INSTITUTION);
      await load();
    } catch (e) {
      if (!editing && e instanceof ApiError && e.status === 409) setError(`An institution named "${form.name.trim()}" already exists.`);
      else setError(errMsg(e));
    } finally { setBusy(false); }
  }

  function askRemove(inst: Institution) {
    setConfirm({
      title: `Delete ${inst.name}?`,
      body: <>This removes the institution's crawl recipe. Connections that use it must be deleted first — their saved credentials and crawl history are not touched by this action.</>,
      confirmLabel: 'Delete institution',
      danger: true,
      onConfirm: async () => {
        try { await api.deleteInstitution(inst.id); await load(); }
        catch (e) {
          setError(e instanceof ApiError && e.status !== 404
            ? `Couldn't delete ${inst.name}: remove its connections first.`
            : errMsg(e));
        }
      },
    });
  }

  function askPublish(inst: Institution) {
    setConfirm({
      title: INSTITUTION_COPY.publishHeading(inst.name),
      body: <>{INSTITUTION_COPY.publishBody}</>,
      confirmLabel: INSTITUTION_COPY.confirmPublish,
      onConfirm: async () => {
        setError(null);
        setSuccess(null);
        try {
          await api.publishInstitution(inst.id);
          setSuccess(INSTITUTION_COPY.publishSuccess(inst.name));
          await load();
        } catch (e) {
          if (e instanceof ApiError && e.code === 'institution_already_published') {
            setError(INSTITUTION_COPY.alreadyPublished);
          } else if (
            e instanceof ApiError
            && e.code === 'institution_publish_copy_exists'
          ) {
            setError(INSTITUTION_COPY.duplicatePublishedCopy(inst.name));
          } else {
            setError(INSTITUTION_COPY.publishFailure(inst.name));
          }
        }
      },
    });
  }

  function ownershipLabel(inst: Institution): string {
    if (inst.visibility === 'published') {
      return INSTITUTION_COPY.publishedBadge;
    }
    return inst.ownedByViewer
      ? INSTITUTION_COPY.privateYoursBadge
      : INSTITUTION_COPY.privateAnotherUsersBadge;
  }

  return (
    <div>
      <div className="page-head"><div><h1>Institutions</h1><p className="page-sub">Each institution is a recipe for crawling one bank or broker: where to sign in and how to find your data.</p></div></div>
      {error && <Banner tone="err" onClose={() => setError(null)}>{error}</Banner>}
      {success && <Banner tone="ok" onClose={() => setSuccess(null)}>{success}</Banner>}

      <div className="panel">
        <h3>{editing ? `Edit ${editing.name}` : 'Add an institution'}</h3>
        <form onSubmit={submit}>
          <div className="form-grid">
            <label className="field"><span>Name <span className="req">*</span></span>
              <input placeholder="e.g. First National Bank" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </label>
            <label className="field"><span>Sign-in page URL <span className="req">*</span></span>
              <input placeholder="https://login.yourbank.com/" value={form.loginUrl} onChange={(e) => setForm({ ...form, loginUrl: e.target.value })} />
              <span className="hint">
                {editing
                  ? 'Changing this re-runs the safety checks — you will be asked to verify the new domain on each connection.'
                  : 'The exact page where you normally enter your username and password.'}
              </span>
            </label>
            <label className="field"><span>Type</span>
              <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
                <option value="bank">Bank</option><option value="broker">Broker</option><option value="retirement">Retirement / pension</option>
              </select>
            </label>
            <label className="field"><span>AI model</span>
              <select value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })}>
                <option value="">Default ({CRAWL_MODELS.find((m) => m.id === DEFAULT_CRAWL_MODEL)?.label ?? DEFAULT_CRAWL_MODEL})</option>
                {CRAWL_MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
              </select>
              <span className="hint">Which Gemini model crawls this institution. Cheaper models cost less per crawl but may struggle with complex sites.</span>
            </label>
          </div>
          <div className="form-actions" style={{ justifyContent: 'flex-start' }}>
            <label className="check">
              <input type="checkbox" checked={form.requires2fa} onChange={(e) => setForm({ ...form, requires2fa: e.target.checked })} />
              Asks for a 2FA code (SMS or email) at sign-in
            </label>
          </div>
          {form.requires2fa && (
            <label className="field" style={{ marginTop: 10 }}><span>SMS sender name (optional — for automatic code relay)</span>
              <input placeholder="e.g. FNBANK" value={form.otpSenderPattern} onChange={(e) => setForm({ ...form, otpSenderPattern: e.target.value })} />
              <span className="hint">Must match the SMS sender exactly as it appears on your phone (not partially). Leave blank to type codes yourself during a crawl.</span>
            </label>
          )}
          <label className="field" style={{ marginTop: 10 }}><span>Instructions for the crawler (optional)</span>
            <textarea rows={3} placeholder={'Plain-English steps, e.g. "Sign in, open the Accounts overview, and read every account and its recent transactions."'}
              value={form.playbook} onChange={(e) => setForm({ ...form, playbook: e.target.value })} />
          </label>
          <details className="more">
            <summary>Advanced crawl settings (reasoning depth, step and time limits)</summary>
            <div className="form-grid">
              <label className="field"><span>Reasoning depth</span>
                <select value={form.thinkingLevel} onChange={(e) => setForm({ ...form, thinkingLevel: e.target.value })}>
                  <option value="">Default (Medium)</option>
                  <option value="minimal">Minimal</option>
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                </select>
                <span className="hint">How much the model thinks before each action. Lower is cheaper and faster; higher can help on complex sites.</span>
              </label>
              <label className="field"><span>Max steps per crawl</span>
                <input type="number" min={5} max={1000} placeholder="120" value={form.maxSteps}
                  onChange={(e) => setForm({ ...form, maxSteps: e.target.value })} />
                <span className="hint">The crawl fails if it needs more browser actions than this.</span>
              </label>
              <label className="field"><span>Time limit (seconds)</span>
                <input type="number" min={60} max={1800} placeholder="900" value={form.timeoutSeconds}
                  onChange={(e) => setForm({ ...form, timeoutSeconds: e.target.value })} />
                <span className="hint">The crawl stops when the time runs out (30 minutes at most).</span>
              </label>
              <label className="field"><span>Transaction lookback (days)</span>
                <input type="number" min={0} max={3650} placeholder="14" value={form.transactionLookbackDays}
                  onChange={(e) => setForm({ ...form, transactionLookbackDays: e.target.value })} />
                <span className="hint">How far behind the last successful crawl to re-check for late-posting transactions.</span>
              </label>
            </div>
          </details>
          <div className="form-actions">
            <button disabled={busy || !form.name.trim() || !form.loginUrl.trim()}>
              {busy ? 'Saving…' : editing ? 'Save changes' : 'Add institution'}
            </button>
            {editing && <button type="button" className="ghost" onClick={cancelEdit}>Cancel</button>}
          </div>
        </form>
      </div>

      <div className="panel">
        <div className="table-wrap">
          <table>
            <thead><tr><th>Institution</th><th>Sign-in domain</th><th>AI model</th><th>Safety check</th><th /></tr></thead>
            <tbody>
              {loading ? <LoadingRows cols={5} /> : items.map((i) => (
                <tr key={i.id}>
                  <td>
                    <div className="row-title">{i.name}</div>
                    <div className="row-sub institution-row-meta">
                      <span className="badge badge-neutral">{ownershipLabel(i)}</span>
                      <span>{i.type}{i.playbook ? ' · has crawler instructions' : ''}</span>
                    </div>
                  </td>
                  <td><code>{i.canonicalDomain}</code></td>
                  <td>{i.model ? <code>{i.model}</code> : <span className="muted">default</span>}</td>
                  <td><StatusBadge status={i.scanStatus} /></td>
                  <td><div className="actions">
                    {i.canPublish && (
                      <button className="ghost small" onClick={() => askPublish(i)}>
                        {INSTITUTION_COPY.publishAction}
                      </button>
                    )}
                    {i.canManage && (
                      <>
                        <button className="ghost small" onClick={() => startEdit(i)}>Edit</button>
                        <button className="danger small" onClick={() => askRemove(i)}>Delete</button>
                      </>
                    )}
                  </div></td>
                </tr>
              ))}
              {!loading && items.length === 0 && (
                <tr><td colSpan={5}><EmptyState title="No institutions yet" hint="Add your bank above — then create a connection with your sign-in details." /></td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
      <ConfirmModal state={confirm} onClose={() => setConfirm(null)} />
    </div>
  );
}

// ─── Connections ──────────────────────────────────────────────────────────────

const EMPTY_CONNECTION = { institutionId: '', username: '', password: '', nickname: '', dob: '', phone: '' };

export function Connections() {
  const [items, setItems] = useState<Connection[]>([]);
  const [insts, setInsts] = useState<Institution[]>([]);
  const [recent, setRecent] = useState<SessionSummary[]>([]);
  const [awaiting, setAwaiting] = useState<Array<{ id: string; institutionName: string | null }>>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState(EMPTY_CONNECTION);
  const [newSchedule, setNewSchedule] = useState<ScheduleFormValue>(defaultScheduleForm);
  const [editingSchedule, setEditingSchedule] = useState<Connection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const now = useNow(30_000);
  const nav = useNavigate();

  const load = useCallback(async () => {
    try {
      const [conns, institutions, sessions] = await Promise.all([
        api.listConnections(), api.listInstitutions(), api.listSessions(),
      ]);
      setItems(conns.connections); setInsts(institutions.institutions); setRecent(sessions.sessions);
    } catch (e) { setError(errMsg(e)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  // Surface any crawl waiting for a 2FA code — including scheduled crawls the operator didn't start.
  useEffect(() => {
    let stop = false;
    const poll = async () => {
      try { const r = await api.awaitingOtp(); if (!stop) setAwaiting(r.sessions); } catch { /* transient — next poll retries */ }
    };
    void poll();
    const t = setInterval(poll, 10_000);
    return () => { stop = true; clearInterval(t); };
  }, []);

  /** Latest session per connection (the /api/sessions list is newest-first). */
  const latestByConnection = new Map<string, SessionSummary>();
  for (const s of recent) if (!latestByConnection.has(s.connectionId)) latestByConnection.set(s.connectionId, s);

  async function create(e: FormEvent) {
    e.preventDefault(); setError(null);
    const schedule = scheduleForNewConnection(newSchedule);
    if (!schedule) { setError(SCHEDULE_COPY.invalid); return; }
    try {
      await api.createConnection({
        institutionId: form.institutionId, username: form.username, password: form.password,
        nickname: form.nickname.trim() || undefined, dob: form.dob.trim() || undefined, phone: form.phone.trim() || undefined,
        ...schedule,
      });
      setForm(EMPTY_CONNECTION);
      setNewSchedule(defaultScheduleForm());
      setNotice('Connection added. Confirm the sign-in domain below, then start your first crawl.');
      await load();
    } catch (e) { setError(errMsg(e)); }
  }

  function askVerify(c: Connection) {
    const inst = insts.find((i) => i.id === c.institutionId);
    const domain = inst?.canonicalDomain ?? '';
    setConfirm({
      title: 'Confirm the sign-in domain',
      body: (
        <>
          <p>Before Accrawl enters your credentials anywhere, confirm this is really <strong>{inst?.name ?? c.institutionId}</strong>'s sign-in domain — open your bank's website yourself and compare:</p>
          <p><span className="domain">{domain}</span></p>
          <p>Type the domain below to confirm. This protects you from a tampered recipe pointing at a look-alike site.</p>
        </>
      ),
      confirmLabel: 'Confirm domain',
      typeToConfirm: domain,
      typePlaceholder: domain,
      onConfirm: async (typed) => {
        try { await api.verifyDomain(c.id, typed); setNotice('Sign-in domain confirmed — you can crawl now.'); await load(); }
        catch (e) { setError(errMsg(e)); }
      },
    });
  }

  async function crawl(c: Connection) {
    setError(null); setNotice(null);
    try {
      const r = await api.crawlNow(c.id);
      if (r.sessionId) { nav(`/sessions/${r.sessionId}`); return; }
      setNotice('Crawl finished.');
      await load();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        const live = latestByConnection.get(c.id);
        setNotice(null);
        setError('A crawl is already running for this connection.');
        if (live && isActiveStatus(live.status)) nav(`/sessions/${live.id}`);
        else await load(); // refresh — the running session will appear in the list
      } else setError(errMsg(e));
    }
  }

  function askRemove(c: Connection) {
    const inst = insts.find((i) => i.id === c.institutionId);
    const label = `${inst?.name ?? c.institutionId}${c.nickname ? ` (${c.nickname})` : ''}`;
    setConfirm({
      title: `Delete the ${label} connection?`,
      body: <>This permanently deletes your saved sign-in credentials for <strong>{label}</strong> and its entire crawl history. It cannot be undone.</>,
      confirmLabel: 'Delete connection',
      danger: true,
      onConfirm: async () => {
        try { await api.deleteConnection(c.id); await load(); } catch (e) { setError(errMsg(e)); }
      },
    });
  }

  return (
    <div>
      <div className="page-head"><div><h1>Connections</h1><p className="page-sub">Your sign-ins at each institution. Credentials are encrypted the moment you save them.</p></div></div>

      {awaiting.map((s) => (
        <Banner key={s.id} tone="warn">
          A crawl{s.institutionName ? ` of ${s.institutionName}` : ''} is waiting for a 2FA code — <Link to={`/sessions/${s.id}`}>enter it now</Link>.
        </Banner>
      ))}
      {error && <Banner tone="err" onClose={() => setError(null)}>{error}</Banner>}
      {notice && <Banner tone="ok" onClose={() => setNotice(null)}>{notice}</Banner>}

      <div className="panel">
        <h3>Add a connection</h3>
        <form onSubmit={create}>
          <div className="form-grid">
            <label className="field"><span>Institution <span className="req">*</span></span>
              <select value={form.institutionId} onChange={(e) => setForm({ ...form, institutionId: e.target.value })}>
                <option value="">Choose…</option>
                {insts.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
              </select>
            </label>
            <label className="field"><span>Username <span className="req">*</span></span>
              <input autoComplete="off" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />
            </label>
            <label className="field"><span>Password <span className="req">*</span></span>
              <input type="password" autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
            </label>
          </div>
          <details className="more">
            <summary>More options (nickname, date of birth, phone)</summary>
            <div className="form-grid">
              <label className="field"><span>Nickname</span>
                <input placeholder="e.g. Joint account" value={form.nickname} onChange={(e) => setForm({ ...form, nickname: e.target.value })} />
              </label>
              <label className="field"><span>Date of birth</span>
                <input placeholder="Only if your bank asks for it at sign-in" value={form.dob} onChange={(e) => setForm({ ...form, dob: e.target.value })} />
              </label>
              <label className="field"><span>Phone number</span>
                <input placeholder="Only if your bank asks for it at sign-in" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
              </label>
            </div>
          </details>
          <div className="schedule-create">
            <ScheduleFields value={newSchedule} onChange={setNewSchedule} />
          </div>
          <div className="form-actions">
            <button disabled={!form.institutionId || !form.username || !form.password}>Add connection</button>
            {insts.length === 0 && <span className="muted">Add an <Link to="/institutions">institution</Link> first.</span>}
          </div>
        </form>
      </div>

      <div className="panel">
        <div className="table-wrap">
          <table>
            <thead><tr><th>Institution</th><th>Status</th><th>Last crawl</th><th>Schedule</th><th className="num">Actions</th></tr></thead>
            <tbody>
              {loading ? <LoadingRows cols={5} /> : items.map((c) => {
                const inst = insts.find((i) => i.id === c.institutionId);
                const last = latestByConnection.get(c.id);
                const lastActive = last && isActiveStatus(last.status);
                const lastCancelling = last?.status === 'cancelling';
                const nextCrawl = formatNextCrawl(c);
                return (
                  <tr key={c.id}>
                    <td>
                      <div className="row-title">{inst?.name ?? c.institutionId}{c.nickname ? ` · ${c.nickname}` : ''}</div>
                      {!c.loginDomainVerified && <div className="row-sub">Sign-in domain not confirmed yet</div>}
                      {c.safeErrorMessage && <div className="row-sub" style={{ color: 'var(--err)' }}>{crawlDisplayError(c.safeErrorMessage)}</div>}
                    </td>
                    <td><StatusBadge status={c.status} /></td>
                    <td>
                      {last ? (
                        <>
                          <Link to={`/sessions/${last.id}`}>
                            {lastCancelling
                              ? <StatusBadge status={last.status} />
                              : lastActive ? 'Running now' : fmtAgo(last.startedAt, now)}
                          </Link>
                          {!lastActive && <div className="row-sub"><StatusBadge status={last.status} /></div>}
                        </>
                      ) : <span className="muted">Never</span>}
                    </td>
                    <td>
                      <div className="row-title">{formatSchedule(c)}</div>
                      <div className="row-sub">{c.crawlTimezone}</div>
                      {nextCrawl && <div className="row-sub">{nextCrawl}</div>}
                    </td>
                    <td>
                      <div className="actions">
                        {c.loginDomainVerified
                          ? <button className="small" disabled={!!lastActive} onClick={() => void crawl(c)}>
                            {lastCancelling
                              ? statusInfo(last!.status).label
                              : lastActive ? 'Crawling…' : 'Crawl now'}
                          </button>
                          : <button className="small" onClick={() => askVerify(c)}>Confirm domain</button>}
                        {lastActive && <Link to={`/sessions/${last!.id}`}>Watch live</Link>}
                        <button className="ghost small" onClick={() => setEditingSchedule(c)}>{SCHEDULE_COPY.editSchedule}</button>
                        <button className="danger small" disabled={!!lastActive} onClick={() => askRemove(c)}>Delete</button>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {!loading && items.length === 0 && (
                <tr><td colSpan={5}><EmptyState title="No connections yet" hint={insts.length === 0 ? 'Start by adding an institution, then connect your sign-in here.' : 'Add your first connection above.'} /></td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
      <ScheduleModal
        connection={editingSchedule}
        onClose={() => setEditingSchedule(null)}
        onSave={async (patch) => {
          if (!editingSchedule) return;
          await api.updateConnection(editingSchedule.id, patch);
          setNotice(SCHEDULE_COPY.scheduleUpdated);
          await load();
        }}
      />
      <ConfirmModal state={confirm} onClose={() => setConfirm(null)} />
    </div>
  );
}

// ─── Devices ─────────────────────────────────────────────────────────────────

export function Devices() {
  const [items, setItems] = useState<Device[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');
  const [selectedConnections, setSelectedConnections] = useState<string[]>([]);
  const [pairing, setPairing] = useState<CreatedDevicePairingIntent | null>(null);
  const [pairingBusy, setPairingBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const now = useNow(1_000);

  const load = useCallback(async () => {
    try {
      const [devicesResult, connectionsResult] = await Promise.all([
        api.listDevices(),
        api.listConnections(),
      ]);
      setItems(devicesResult.devices);
      setConnections(connectionsResult.connections);
    } catch (e) { setError(errMsg(e)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (
      !pairing
      || pairing.status === 'expired'
      || pairing.status === 'used'
      || pairing.status === 'cancelled'
    ) return;
    const timer = window.setInterval(() => {
      void api.getDevicePairingIntent(pairing.id).then((next) => {
        setPairing((current) => current?.id === next.id
          ? { ...next, pairingCode: current.pairingCode }
          : current);
        if (next.status === 'used') void load();
      }).catch((pollError) => setError(errMsg(pollError)));
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [load, pairing]);

  async function createPairing(e: FormEvent) {
    e.preventDefault(); setError(null);
    if (selectedConnections.length === 0) {
      setError(COMPANION_COPY.selectAtLeastOne);
      return;
    }
    setPairingBusy(true);
    try {
      setPairing(await api.createDevicePairingIntent(name.trim(), selectedConnections));
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setPairingBusy(false);
    }
  }

  async function approvePairing() {
    if (!pairing) return;
    setPairingBusy(true);
    setError(null);
    try {
      const result = await api.approveDevicePairingIntent(pairing.id);
      setPairing({ ...pairing, status: result.status });
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setPairingBusy(false);
    }
  }

  async function cancelPairing() {
    if (!pairing) return;
    setPairingBusy(true);
    setError(null);
    try {
      await api.cancelDevicePairingIntent(pairing.id);
      setPairing({ ...pairing, status: 'cancelled' });
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setPairingBusy(false);
    }
  }

  function askRevoke(d: Device) {
    setConfirm({
      title: COMPANION_COPY.revokeDevice(d.name),
      body: <>{COMPANION_COPY.revokeConsequence}</>,
      confirmLabel: COMPANION_COPY.revokePhone,
      danger: true,
      onConfirm: async () => { try { await api.revokeDevice(d.id); await load(); } catch (e) { setError(errMsg(e)); } },
    });
  }

  const connectionLabel = (id: string): string => {
    const connection = connections.find((candidate) => candidate.id === id);
    return connection?.nickname?.trim() || connection?.institutionId || id;
  };
  const secondsRemaining = pairing
    ? Math.max(0, Math.ceil((new Date(pairing.expiresAt).getTime() - now) / 1_000))
    : 0;
  const expiry = secondsRemaining >= 60
    ? `${Math.floor(secondsRemaining / 60)}:${String(secondsRemaining % 60).padStart(2, '0')}`
    : `${secondsRemaining}s`;
  const qrPayload = pairing
    ? JSON.stringify({ v: 1, url: window.location.origin, pairingCode: pairing.pairingCode })
    : '';

  return (
    <div>
      <div className="page-head"><div><h1>{COMPANION_COPY.title}</h1><p className="page-sub">{COMPANION_COPY.subtitle}</p></div></div>
      {error && <Banner tone="err" onClose={() => setError(null)}>{error}</Banner>}

      <div className="panel companion-install">
        <div className="companion-install-copy">
          <h3>{COMPANION_COPY.installHeading}</h3>
          <p className="muted">{COMPANION_COPY.installDescription}</p>
          <a className="button-link" href={COMPANION_APK_URL}>
            {COMPANION_COPY.downloadForAndroid}
          </a>
        </div>
        <div className="companion-install-qr">
          <div className="faint">{COMPANION_COPY.downloadQrHelper}</div>
          <QRCode
            value={COMPANION_APK_URL}
            size={140}
            alt={COMPANION_COPY.downloadQrAlt}
          />
        </div>
      </div>

      <div className="panel">
        <h3>{COMPANION_COPY.howPairingWorks}</h3>
        <ol className="muted" style={{ margin: '4px 0 0 18px', padding: 0, display: 'grid', gap: 4 }}>
          <li>{COMPANION_COPY.install}</li>
          <li>{COMPANION_COPY.selectConnections}</li>
          <li>{COMPANION_COPY.createRequest}</li>
        </ol>
      </div>

      {pairing && (
        <Banner tone="warn">
          <strong>{COMPANION_COPY.pairingRequest}</strong>
          {pairing.status === 'waiting_for_phone' && (
            <div style={{ marginTop: 12, display: 'flex', gap: 20, alignItems: 'flex-start', flexWrap: 'wrap' }}>
              <div>
                <div className="faint" style={{ marginBottom: 6 }}>{COMPANION_COPY.qrExplanation}</div>
                <QRCode value={qrPayload} />
              </div>
              <div style={{ flex: '1 1 300px', display: 'grid', gap: 10 }}>
                <div><div className="faint">{COMPANION_COPY.manualAddress}</div><code>{window.location.origin}</code></div>
                <div><div className="faint">{COMPANION_COPY.manualCode}</div><code style={{ userSelect: 'all' }}>{pairing.pairingCode}</code> <CopyButton text={pairing.pairingCode} /></div>
                <div className="faint">{COMPANION_COPY.expiresIn(expiry)}</div>
                <div>{COMPANION_COPY.waitingForPhone}</div>
              </div>
            </div>
          )}
          {pairing.status === 'waiting_for_approval' && pairing.verificationCode && (
            <div style={{ marginTop: 12 }}>
              <p>{COMPANION_COPY.compareCode}</p>
              <code style={{ display: 'block', fontSize: '2rem', letterSpacing: '.35em', margin: '16px 0', userSelect: 'all' }}>
                {pairing.verificationCode}
              </code>
              <div className="actions">
                <button disabled={pairingBusy} onClick={() => void approvePairing()}>{COMPANION_COPY.approvePhone}</button>
                <button className="ghost" disabled={pairingBusy} onClick={() => void cancelPairing()}>{COMPANION_COPY.cancelPairing}</button>
              </div>
            </div>
          )}
          {pairing.status === 'approved' && <p>{COMPANION_COPY.pairingApproved}</p>}
          {pairing.status === 'expired' && <p>{COMPANION_COPY.pairingExpired}</p>}
          {pairing.status === 'used' && <p>{COMPANION_COPY.pairingUsed}</p>}
          {pairing.status === 'cancelled' && <p>{COMPANION_COPY.pairingCancelled}</p>}
          {(pairing.status === 'used' || pairing.status === 'cancelled' || pairing.status === 'expired') && (
            <button className="ghost small" onClick={() => {
              setPairing(null);
              setName('');
              setSelectedConnections([]);
            }}>
              {COMPANION_COPY.createAnotherRequest}
            </button>
          )}
          {pairing.status !== 'waiting_for_approval' && pairing.status !== 'used' && pairing.status !== 'cancelled' && pairing.status !== 'expired' && (
            <button className="ghost small" disabled={pairingBusy} onClick={() => void cancelPairing()}>
              {COMPANION_COPY.cancelPairing}
            </button>
          )}
        </Banner>
      )}

      <div className="panel">
        <form className="form-grid" onSubmit={createPairing}>
          <label className="field"><span>{COMPANION_COPY.deviceName}</span>
            <input placeholder={COMPANION_COPY.deviceNamePlaceholder} value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend>{COMPANION_COPY.connections}</legend>
            {connections.length === 0
              ? <span className="muted">{COMPANION_COPY.noConnections}</span>
              : connections.map((connection) => (
                <label key={connection.id} style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
                  <input
                    type="checkbox"
                    checked={selectedConnections.includes(connection.id)}
                    onChange={(event) => setSelectedConnections((current) =>
                      event.target.checked
                        ? [...current, connection.id]
                        : current.filter((id) => id !== connection.id))}
                  />
                  <span>{connectionLabel(connection.id)}</span>
                </label>
              ))}
          </fieldset>
          <div><button disabled={pairingBusy || !!pairing || !name.trim() || connections.length === 0}>{COMPANION_COPY.createPairingRequest}</button></div>
        </form>
      </div>

      <div className="panel">
        <h3>{COMPANION_COPY.pairedPhones}</h3>
        <div className="table-wrap">
          <table>
            <thead><tr><th>{COMPANION_COPY.device}</th><th>{COMPANION_COPY.access}</th><th>{COMPANION_COPY.status}</th><th>{COMPANION_COPY.lastSeen}</th><th className="num" /></tr></thead>
            <tbody>
              {loading ? <LoadingRows cols={5} /> : items.map((d) => (
                <tr key={d.id}>
                  <td><div className="row-title">{d.name}</div><div className="row-sub">{COMPANION_COPY.pairedAt(fmtWhen(d.pairedAt))}</div></td>
                  <td className="muted">{COMPANION_COPY.selectedConnectionCount(d.connectionGrants.length)}<div className="row-sub">{d.connectionGrants.map(connectionLabel).join(', ')}</div></td>
                  <td><StatusBadge status={d.revokedAt ? 'revoked' : 'active'} /></td>
                  <td className="muted">{d.lastSeenAt ? COMPANION_COPY.lastSeenAt(fmtAgo(d.lastSeenAt, now), fmtWhen(d.lastSeenAt)) : COMPANION_COPY.never}</td>
                  <td><div className="actions">{!d.revokedAt && <button className="danger small" onClick={() => askRevoke(d)}>{COMPANION_COPY.revokeAction}</button>}</div></td>
                </tr>
              ))}
              {!loading && items.length === 0 && (
                <tr><td colSpan={5}><EmptyState title={COMPANION_COPY.noDevices} hint={COMPANION_COPY.noDevicesHelp} /></td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
      <ConfirmModal state={confirm} onClose={() => setConfirm(null)} />
    </div>
  );
}
