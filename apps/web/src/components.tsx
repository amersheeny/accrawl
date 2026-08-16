/** Shared console primitives: status badges, modals, copy button, empty/loading states, formatters. */
import {
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import QRCodeLib from 'qrcode';
import type { CrawlCost } from './api';
import { REVIEWED_STATUS_COPY } from './status-copy';

/** Render `value` as a scannable QR code (data-URL PNG on a white quiet-zone so phone cameras read it). */
export function QRCode({
  value,
  size = 180,
  alt = 'Pairing QR code',
}: {
  value: string;
  size?: number;
  alt?: string;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let stop = false;
    setSrc(null); setFailed(false);
    QRCodeLib.toDataURL(value, { width: size, margin: 2, errorCorrectionLevel: 'M' })
      .then((url) => { if (!stop) setSrc(url); })
      .catch(() => { if (!stop) setFailed(true); });
    return () => { stop = true; };
  }, [value, size]);
  if (failed) return null; // never block the copy-the-code fallback on a QR render failure
  return src
    ? <img src={src} width={size} height={size} alt={alt} style={{ display: 'block', borderRadius: 10, background: '#fff' }} />
    : <div style={{ width: size, height: size, borderRadius: 10, background: 'var(--panel)' }} aria-hidden />;
}

// ─── Status semantics ────────────────────────────────────────────────────────
// One place that maps every backend status word to a tone + human label, so state never renders as
// undifferentiated raw text.

export type Tone = 'ok' | 'busy' | 'warn' | 'err' | 'neutral';

const STATUS_MAP: Record<string, { tone: Tone; label: string }> = {
  // session statuses
  starting: { tone: 'busy', label: 'Starting' },
  logging_in: { tone: 'busy', label: 'Signing in' },
  navigating: { tone: 'busy', label: 'Navigating' },
  waiting_for_otp: { tone: 'warn', label: 'Waiting for 2FA code' },
  extracting: { tone: 'busy', label: 'Extracting data' },
  cancelling: { tone: 'busy', label: REVIEWED_STATUS_COPY.cancelling },
  completed: { tone: 'ok', label: 'Completed' },
  failed: { tone: 'err', label: 'Failed' },
  cancelled: { tone: 'neutral', label: 'Cancelled' },
  // connection statuses
  connecting: { tone: 'neutral', label: 'Not crawled yet' },
  connected: { tone: 'ok', label: 'Connected' },
  syncing: { tone: 'busy', label: 'Crawling now' },
  needs_reauth: { tone: 'err', label: 'Needs re-authentication' },
  error: { tone: 'err', label: 'Error' },
  disabled: { tone: 'neutral', label: 'Disabled' },
  // institution scan
  pending: { tone: 'warn', label: 'Check pending' },
  passed: { tone: 'ok', label: 'Approved' },
  // device
  active: { tone: 'ok', label: 'Active' },
  revoked: { tone: 'neutral', label: 'Revoked' },
};

export function statusInfo(status: string): { tone: Tone; label: string } {
  return STATUS_MAP[status] ?? { tone: 'neutral', label: status.replace(/_/g, ' ') };
}

/** A session status that means the crawl is still running. */
export function isActiveStatus(status: string): boolean {
  return [
    'starting', 'logging_in', 'navigating', 'waiting_for_otp', 'extracting', 'cancelling',
  ].includes(status);
}

export function StatusBadge({ status, pulse }: { status: string; pulse?: boolean }) {
  const { tone, label } = statusInfo(status);
  return (
    <span className={`badge badge-${tone}`}>
      {(pulse ?? tone === 'busy') && <span className="pulse-dot" aria-hidden />}
      {label}
    </span>
  );
}

export function Spinner({ size = 14 }: { size?: number }) {
  return <span className="spinner" style={{ width: size, height: size }} aria-label="loading" />;
}

// ─── Confirm modal (replaces window.confirm / window.prompt) ─────────────────

export interface ConfirmState {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  /** When set, the user must type this exact value to enable the confirm button (trust-critical flows). */
  typeToConfirm?: string;
  typePlaceholder?: string;
  onConfirm: (typed: string) => void | Promise<void>;
}

export function ConfirmModal({ state, onClose }: { state: ConfirmState | null; onClose: () => void }) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => { setTyped(''); setBusy(false); }, [state]);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!state || !dialog) return;
    const previouslyFocused = document.activeElement;
    if (!dialog.open) dialog.showModal();
    dialog.focus();
    return () => {
      if (dialog.open) dialog.close();
      if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus();
    };
  }, [state]);
  if (!state) return null;
  const ready = !state.typeToConfirm || typed.trim().toLowerCase() === state.typeToConfirm.trim().toLowerCase();
  async function go() {
    if (!state) return;
    setBusy(true);
    try { await state.onConfirm(typed.trim()); onClose(); } finally { setBusy(false); }
  }
  return (
    <dialog
      ref={dialogRef}
      className="modal-backdrop"
      aria-labelledby={titleId}
      tabIndex={-1}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          if (!busy) onClose();
        }
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3 id={titleId}>{state.title}</h3>
        <div className="modal-body">{state.body}</div>
        {state.typeToConfirm && (
          <input
            autoFocus
            placeholder={state.typePlaceholder ?? state.typeToConfirm}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && ready && !busy) void go(); }}
          />
        )}
        <div className="modal-actions">
          <button className="ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button className={state.danger ? 'danger' : ''} disabled={!ready || busy} onClick={() => void go()}>
            {busy ? 'Working…' : state.confirmLabel}
          </button>
        </div>
      </div>
    </dialog>
  );
}

// ─── Small helpers ────────────────────────────────────────────────────────────

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="ghost small"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? 'Copied ✓' : label}
    </button>
  );
}

export function EmptyState({ title, hint, children }: { title: string; hint?: string; children?: ReactNode }) {
  return (
    <div className="empty-state">
      <p className="empty-title">{title}</p>
      {hint && <p className="muted">{hint}</p>}
      {children}
    </div>
  );
}

export function LoadingRows({ cols }: { cols: number }) {
  return (
    <>
      {[0, 1, 2].map((r) => (
        <tr key={r} className="skeleton-row">
          {Array.from({ length: cols }, (_, c) => <td key={c}><span className="skeleton" /></td>)}
        </tr>
      ))}
    </>
  );
}

/** Dismissible banner. tone: err | ok | warn | info */
export function Banner({ tone, children, onClose }: { tone: 'err' | 'ok' | 'warn' | 'info'; children: ReactNode; onClose?: () => void }) {
  return (
    <div className={`banner banner-${tone}`} role={tone === 'err' ? 'alert' : 'status'}>
      <div className="banner-body">{children}</div>
      {onClose && <button className="banner-close" aria-label="Dismiss" onClick={onClose}>×</button>}
    </div>
  );
}

/** Re-render every `ms` — powers the live elapsed clock and stall detection. */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/** Ref that is true until the component unmounts — guards setState-after-unmount in async handlers. */
export function useMounted(): { readonly current: boolean } {
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);
  return mounted;
}

// ─── Formatters ───────────────────────────────────────────────────────────────

export function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function fmtWhen(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function fmtAgo(iso: string | null | undefined, now: number): string {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function fmtMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount);
  } catch {
    return `${amount.toLocaleString()} ${currency}`; // unknown/blank currency code — never crash a money cell
  }
}

export function fmtUsd(v: number): string {
  return v >= 0.01 ? `$${v.toFixed(2)}` : v > 0 ? `$${v.toFixed(4)}` : '$0.00';
}

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function costSummary(cost: CrawlCost | null | undefined): string {
  if (!cost) return '—';
  return `${fmtUsd(cost.totalCostUsd)} · ${cost.modelId}`;
}

/** Humanize a cron schedule for the common shapes we generate; fall back to the raw expression. */
export function fmtSchedule(cron: string): string {
  const m = /^(\d{1,2}) (\d{1,2}) \* \* \*$/.exec(cron.trim());
  if (m) {
    const hh = String(m[2]).padStart(2, '0');
    const mm = String(m[1]).padStart(2, '0');
    return `Daily at ${hh}:${mm}`;
  }
  return cron;
}
