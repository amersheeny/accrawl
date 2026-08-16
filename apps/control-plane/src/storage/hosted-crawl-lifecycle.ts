/**
 * The extra operations a store needs when crawls run somewhere else.
 *
 * A deployment that runs a crawl in its own process watches it directly. One that starts a worker
 * elsewhere cannot: the worker may die, its acknowledgement may be lost, and the schedule that asked for
 * the crawl still has to move on exactly once. These operations are how the control-plane keeps that
 * lifecycle honest, and they are named here so a caller can ask for them by capability rather than by
 * assuming which implementation is underneath.
 */
import type { UserDataStore } from './user-data-store';

/** A due scheduled occurrence, as handed to whoever wakes the control-plane up for it. */
export interface ScheduledConnectionTask {
  connectionId: string;
  scheduleRevision: number;
  dueAt: string;
  sequence: number;
}

/** What a reconciliation found: nothing to do, still running, or finished with deliveries maybe pending. */
export type HostedCrawlLifecycleResult =
  | { state: 'missing' }
  | { state: 'active'; reconcileAt: Date }
  | { state: 'terminal'; pendingDeliveries: boolean; reconcileAt?: Date };

export interface HostedCrawlLifecycleStore extends UserDataStore {
  /** Bring one crawl to a conclusion: finish it, fail it, or leave it running and ask to be woken again. */
  reconcileCrawlLifecycle(sessionId: string): Promise<HostedCrawlLifecycleResult>;
  /** Whether a due occurrence is still the one to run, already superseded, or not yet ready. */
  scheduledConnectionState(
    task: ScheduledConnectionTask,
  ): Promise<'stale' | 'pending' | 'early' | 'due'>;
  /** Re-arm an occurrence that arrived before its time. */
  rearmEarlyScheduledConnection(task: ScheduledConnectionTask): Promise<void>;
  /** Move the schedule to its next occurrence and say whether this one may run. */
  advanceScheduledConnection(
    task: ScheduledConnectionTask,
  ): Promise<'dispatch' | 'advanced_without_dispatch' | 'retry' | 'stale'>;
  /** Arm any connection that should have a scheduled occurrence and does not. */
  ensureScheduledConnections(): Promise<number>;
}
