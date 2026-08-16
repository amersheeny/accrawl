/**
 * Session-scoped logger.
 *
 * Prepends [SHORT_SESSION_ID] to every console line and accumulates all
 * entries so they can be flushed to durable storage at session end.
 */
import { safeBrowserUrlsInText } from './safe-browser-url';

export interface LogLine {
  ts: string;
  level: 'log' | 'warn' | 'error';
  msg: string;
}

export interface SessionLogger {
  log: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  getLines: () => LogLine[];
}

function formatArg(a: unknown): string {
  if (typeof a === 'string') return safeBrowserUrlsInText(a);
  if (a instanceof Error) {
    return safeBrowserUrlsInText(a.stack ?? a.message);
  }
  return safeBrowserUrlsInText(JSON.stringify(a));
}

function formatArgs(args: unknown[]): string {
  return args.map(formatArg).join(' ');
}

/**
 * Auto-flush callback type. Set by the crawl executor to wire up durable writes.
 * Called with current log lines whenever a flush is triggered.
 */
export type LogFlushCallback = (lines: LogLine[]) => void;

export function createSessionLogger(sessionId: string, autoFlush?: LogFlushCallback): SessionLogger {
  const tag = `[${sessionId.substring(0, 8)}]`;
  const lines: LogLine[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  function scheduleFlush(): void {
    if (!autoFlush || flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      autoFlush(lines);
    }, 1000); // Debounce: batch rapid log lines into one write per second
  }

  function emit(level: 'log' | 'warn' | 'error', args: unknown[]): void {
    const msg = formatArgs(args);
    lines.push({ ts: new Date().toISOString(), level, msg });
    // Emit the same sanitized representation that is buffered. Passing the
    // original objects back to console would reintroduce raw URL-bearing Error
    // messages even though the durable copy was clean.
    console[level](tag, msg);
    scheduleFlush();
  }

  return {
    log: (...args) => emit('log', args),
    warn: (...args) => emit('warn', args),
    error: (...args) => emit('error', args),
    getLines: () => lines,
  };
}
