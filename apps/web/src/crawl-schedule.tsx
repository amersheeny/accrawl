import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import type { Connection, ConnectionPatch, NewConnection } from './api';
import { SCHEDULE_COPY } from './schedule-copy';

export type ScheduleFrequency = 'manual' | 'daily' | 'weekly' | 'monthly' | 'custom';

export interface ScheduleFormValue {
  frequency: ScheduleFrequency;
  time: string;
  timezone: string;
  weekday: string;
  monthday: string;
}

const WEEKDAYS = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
] as const;

export function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export function defaultScheduleForm(): ScheduleFormValue {
  return {
    frequency: 'daily',
    time: '06:00',
    timezone: browserTimezone(),
    weekday: '1',
    monthday: '1',
  };
}

function validClock(hour: number, minute: number): boolean {
  return Number.isInteger(hour) && hour >= 0 && hour < 24
    && Number.isInteger(minute) && minute >= 0 && minute < 60;
}

export function scheduleFormFromConnection(connection: Connection): ScheduleFormValue {
  const base = defaultScheduleForm();
  base.timezone = connection.crawlTimezone;
  if (!connection.crawlScheduleEnabled) base.frequency = 'manual';
  const fields = connection.crawlSchedule.trim().split(/\s+/);
  if (fields.length !== 5) return { ...base, frequency: connection.crawlScheduleEnabled ? 'custom' : 'manual' };
  const [minuteText, hourText, monthday, month, weekday] = fields;
  const minute = Number(minuteText);
  const hour = Number(hourText);
  if (!validClock(hour, minute) || month !== '*') {
    return { ...base, frequency: connection.crawlScheduleEnabled ? 'custom' : 'manual' };
  }
  base.time = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  if (monthday === '*' && weekday === '*') base.frequency = 'daily';
  else if (monthday === '*' && /^[0-6]$/.test(weekday)) {
    base.frequency = 'weekly';
    base.weekday = weekday;
  } else if (weekday === '*' && (monthday === 'L' || /^(?:[1-9]|1\d|2[0-8])$/.test(monthday))) {
    base.frequency = 'monthly';
    base.monthday = monthday;
  } else if (connection.crawlScheduleEnabled) base.frequency = 'custom';
  if (!connection.crawlScheduleEnabled) base.frequency = 'manual';
  return base;
}

export function schedulePatch(
  value: ScheduleFormValue,
): Pick<ConnectionPatch, 'crawlScheduleEnabled' | 'crawlSchedule' | 'crawlTimezone'> | null {
  if (value.frequency === 'custom') return null;
  if (value.frequency === 'manual') {
    return { crawlScheduleEnabled: false, crawlTimezone: value.timezone };
  }
  const match = /^(\d{2}):(\d{2})$/.exec(value.time);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!validClock(hour, minute) || !value.timezone) return null;
  let cron = `${minute} ${hour} * * *`;
  if (value.frequency === 'weekly') {
    if (!/^[0-6]$/.test(value.weekday)) return null;
    cron = `${minute} ${hour} * * ${value.weekday}`;
  }
  if (value.frequency === 'monthly') {
    if (!(value.monthday === 'L' || /^(?:[1-9]|1\d|2[0-8])$/.test(value.monthday))) return null;
    cron = `${minute} ${hour} ${value.monthday} * *`;
  }
  return { crawlScheduleEnabled: true, crawlSchedule: cron, crawlTimezone: value.timezone };
}

function timezoneOptions(current: string): string[] {
  const intl = Intl as typeof Intl & { supportedValuesOf?: (key: 'timeZone') => string[] };
  const values = intl.supportedValuesOf?.('timeZone') ?? [];
  return [...new Set([current, 'UTC', ...values])].sort();
}

export function ScheduleFields({
  value,
  onChange,
  existingCron,
}: {
  value: ScheduleFormValue;
  onChange: (value: ScheduleFormValue) => void;
  existingCron?: string;
}) {
  const update = (patch: Partial<ScheduleFormValue>) => onChange({ ...value, ...patch });
  return (
    <div className="schedule-fields">
      <div className="form-grid">
        <label className="field"><span>{SCHEDULE_COPY.automaticCrawls}</span>
          <select value={value.frequency} onChange={(event) => update({ frequency: event.target.value as ScheduleFrequency })}>
            {value.frequency === 'custom' && <option value="custom">{existingCron}</option>}
            <option value="manual">{SCHEDULE_COPY.manualOnly}</option>
            <option value="daily">{SCHEDULE_COPY.daily}</option>
            <option value="weekly">{SCHEDULE_COPY.weekly}</option>
            <option value="monthly">{SCHEDULE_COPY.monthly}</option>
          </select>
        </label>
        {value.frequency !== 'manual' && value.frequency !== 'custom' && (
          <label className="field"><span>{SCHEDULE_COPY.localTime}</span>
            <input type="time" value={value.time} onChange={(event) => update({ time: event.target.value })} />
          </label>
        )}
        {value.frequency === 'weekly' && (
          <label className="field"><span>{SCHEDULE_COPY.dayOfWeek}</span>
            <select value={value.weekday} onChange={(event) => update({ weekday: event.target.value })}>
              {WEEKDAYS.map((day, index) => <option key={day} value={index}>{day}</option>)}
            </select>
          </label>
        )}
        {value.frequency === 'monthly' && (
          <label className="field"><span>{SCHEDULE_COPY.dayOfMonth}</span>
            <select value={value.monthday} onChange={(event) => update({ monthday: event.target.value })}>
              {Array.from({ length: 28 }, (_, index) => index + 1).map((day) => <option key={day} value={day}>{day}</option>)}
              <option value="L">{SCHEDULE_COPY.lastDay}</option>
            </select>
          </label>
        )}
        <label className="field"><span>{SCHEDULE_COPY.timezone}</span>
          <select value={value.timezone} onChange={(event) => update({ timezone: event.target.value })}>
            {timezoneOptions(value.timezone).map((timezone) => <option key={timezone} value={timezone}>{timezone}</option>)}
          </select>
        </label>
      </div>
    </div>
  );
}

export function scheduleForNewConnection(value: ScheduleFormValue): Pick<NewConnection, 'crawlScheduleEnabled' | 'crawlSchedule' | 'crawlTimezone'> | null {
  return schedulePatch(value);
}

export function formatSchedule(connection: Connection): string {
  if (!connection.crawlScheduleEnabled) return SCHEDULE_COPY.noAutomaticCrawls;
  const form = scheduleFormFromConnection(connection);
  if (form.frequency === 'daily') return `Daily at ${form.time}`;
  if (form.frequency === 'weekly') return `Weekly on ${WEEKDAYS[Number(form.weekday)]} at ${form.time}`;
  if (form.frequency === 'monthly' && form.monthday === 'L') return `Monthly on the last day at ${form.time}`;
  if (form.frequency === 'monthly') return `Monthly on day ${form.monthday} at ${form.time}`;
  return connection.crawlSchedule;
}

export function formatNextCrawl(connection: Connection): string | null {
  if (!connection.crawlScheduleEnabled) return SCHEDULE_COPY.manualOnlyHint;
  if (!connection.loginDomainVerified) return SCHEDULE_COPY.unverifiedHint;
  if (!connection.nextCrawlAt) return null;
  const formatted = new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: connection.crawlTimezone,
    timeZoneName: 'short',
  }).format(new Date(connection.nextCrawlAt));
  return `${SCHEDULE_COPY.nextAttempt} ${formatted}`;
}

export function ScheduleModal({
  connection,
  onClose,
  onSave,
}: {
  connection: Connection | null;
  onClose: () => void;
  onSave: (patch: ConnectionPatch) => Promise<void>;
}) {
  const [value, setValue] = useState(defaultScheduleForm);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    if (!connection) return;
    setValue(scheduleFormFromConnection(connection));
    setError(null);
    setBusy(false);
    const dialog = dialogRef.current;
    const previouslyFocused = document.activeElement;
    if (dialog && !dialog.open) dialog.showModal();
    return () => {
      if (dialog?.open) dialog.close();
      if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus();
    };
  }, [connection]);
  if (!connection) return null;
  const patch = schedulePatch(value);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!patch) { setError(SCHEDULE_COPY.invalid); return; }
    setBusy(true); setError(null);
    try { await onSave(patch); onClose(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setBusy(false); }
  }
  return (
    <dialog
      ref={dialogRef}
      className="modal-backdrop"
      aria-labelledby={titleId}
      onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}
      onClick={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}
    >
      <form className="modal schedule-modal" onSubmit={submit} onClick={(event) => event.stopPropagation()}>
        <h3 id={titleId}>{SCHEDULE_COPY.editScheduleTitle}</h3>
        <ScheduleFields value={value} onChange={setValue} existingCron={connection.crawlSchedule} />
        {error && <p className="field-error" role="alert">{error}</p>}
        <div className="modal-actions">
          <button type="button" className="ghost" disabled={busy} onClick={onClose}>Cancel</button>
          <button disabled={busy || !patch}>{SCHEDULE_COPY.saveSchedule}</button>
        </div>
      </form>
    </dialog>
  );
}
