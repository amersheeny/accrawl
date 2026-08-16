/**
 * Connection data access — the user's credentials + crawl config for one institution.
 *
 * Credentials are encrypted at rest with the envelope cipher, AAD-bound to (connectionId, field).
 * The connectionId is generated HERE (app-side) before insert so the AAD can bind to it. Plaintext
 * and ciphertext never leave this module: every API-facing function returns a `ConnectionView` that
 * omits the *_ct columns. The orchestrator gets plaintext only via decryptConnectionCredentials,
 * which is never called from a route.
 *
 * loginDomainVerified starts false; verifyLoginDomain flips it only when the operator re-submits the
 * institution's exact canonical domain (anti-phishing — the operator must actively confirm where the
 * agent will type the credentials before the connection can run).
 */
import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/client';
import { connections, connectionsDue, institutions, sessions, type CrawlStats } from '../db/schema';
import { encryptSecret, decryptSecret } from '../crypto/cipher';
import { isHostWithinDomain } from '../lib/domain';
import { LOCKED_SESSION_STATUSES } from './sessions';
import {
  MAX_CONSECUTIVE_CRAWL_FAILURES,
  isAuthCrawlFailureReason,
} from './crawl-bookkeeping';
import {
  DEFAULT_CRAWL_SCHEDULE,
  DEFAULT_CRAWL_TIMEZONE,
  nextRunFromCron,
} from '../scheduling/crawl-schedule';
import { SELF_HOSTED_OPERATOR_SUBJECT } from '../auth/subjects';

export interface ConnectionInput {
  institutionId: string;
  username: string;
  password: string;
  dob?: string;
  phone?: string;
  loginUrlOverride?: string;
  customInstructions?: string;
  crawlScheduleEnabled?: boolean;
  crawlSchedule?: string;
  crawlTimezone?: string;
  nickname?: string;
}

export type ConnectionUpdate = Partial<Omit<ConnectionInput, 'institutionId'>>;

/** A connection with NO secret material — safe to return from the API. */
export interface ConnectionView {
  id: string;
  institutionId: string;
  status: string;
  loginDomainVerified: boolean;
  loginUrlOverride: string | null;
  customInstructions: string | null;
  crawlScheduleEnabled: boolean;
  crawlSchedule: string;
  crawlTimezone: string;
  nextCrawlAt: Date | null;
  nickname: string | null;
  consecutiveFailures: number;
  crawlStats: CrawlStats;
  safeErrorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
}

type ConnectionRow = typeof connections.$inferSelect;

export class DomainMismatchError extends Error {
  constructor() {
    super('submitted domain does not match the institution canonical domain');
    this.name = 'DomainMismatchError';
  }
}

export class LoginUrlOverrideError extends Error {
  constructor() {
    super('loginUrlOverride must be within the institution canonical domain');
    this.name = 'LoginUrlOverrideError';
  }
}

/**
 * A loginUrlOverride may only point WITHIN the institution's canonical (operator-verified) domain —
 * never to a different eTLD+1. Otherwise an override could move the effective login target to an
 * attacker domain after the operator already verified the connection. Throws if the institution is
 * missing or the override is off-domain.
 */
async function assertOverrideWithinInstitution(db: Db, institutionId: string, override: string): Promise<void> {
  const [inst] = await db
    .select({ canonicalDomain: institutions.canonicalDomain })
    .from(institutions)
    .where(eq(institutions.id, institutionId))
    .limit(1);
  if (!inst || !isHostWithinDomain(override, inst.canonicalDomain)) {
    throw new LoginUrlOverrideError();
  }
}

export type ConnectionViewSource = Pick<
  ConnectionRow,
  | 'id'
  | 'institutionId'
  | 'status'
  | 'loginDomainVerified'
  | 'loginUrlOverride'
  | 'customInstructions'
  | 'crawlScheduleEnabled'
  | 'crawlSchedule'
  | 'crawlTimezone'
  | 'nickname'
  | 'consecutiveFailures'
  | 'crawlStats'
  | 'safeErrorMessage'
  | 'createdAt'
  | 'updatedAt'
>;

export function toConnectionView(
  row: ConnectionViewSource,
  nextCrawlAt: Date | null = null,
): ConnectionView {
  return {
    id: row.id,
    institutionId: row.institutionId,
    status: row.status,
    loginDomainVerified: row.loginDomainVerified,
    loginUrlOverride: row.loginUrlOverride,
    customInstructions: row.customInstructions,
    crawlScheduleEnabled: row.crawlScheduleEnabled,
    crawlSchedule: row.crawlSchedule,
    crawlTimezone: row.crawlTimezone,
    nextCrawlAt,
    nickname: row.nickname,
    consecutiveFailures: row.consecutiveFailures,
    crawlStats: row.crawlStats,
    safeErrorMessage: row.safeErrorMessage,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function createConnection(
  db: Db,
  input: ConnectionInput,
  ownerSubject: string = SELF_HOSTED_OPERATOR_SUBJECT,
): Promise<ConnectionView> {
  if (input.loginUrlOverride) {
    await assertOverrideWithinInstitution(db, input.institutionId, input.loginUrlOverride);
  }
  const id = randomUUID();
  const seal = (field: string, value: string) => encryptSecret(value, { connectionId: id, field });
  const [row] = await db
    .insert(connections)
    .values({
      id,
      ownerSubject,
      institutionId: input.institutionId,
      usernameCt: seal('username', input.username),
      passwordCt: seal('password', input.password),
      dobCt: input.dob ? seal('dob', input.dob) : null,
      phoneCt: input.phone ? seal('phone', input.phone) : null,
      loginUrlOverride: input.loginUrlOverride,
      customInstructions: input.customInstructions,
      crawlScheduleEnabled: input.crawlScheduleEnabled ?? true,
      crawlSchedule: input.crawlSchedule ?? DEFAULT_CRAWL_SCHEDULE,
      crawlTimezone: input.crawlTimezone ?? DEFAULT_CRAWL_TIMEZONE,
      nickname: input.nickname,
    })
    .returning();
  return toConnectionView(row, null);
}

export async function getConnection(
  db: Db,
  id: string,
  ownerSubject: string = SELF_HOSTED_OPERATOR_SUBJECT,
): Promise<ConnectionView | null> {
  const [row] = await db
    .select({ connection: connections, nextCrawlAt: connectionsDue.nextCrawlAt })
    .from(connections)
    .leftJoin(connectionsDue, eq(connectionsDue.connectionId, connections.id))
    .where(and(
      eq(connections.id, id),
      eq(connections.ownerSubject, ownerSubject),
    ))
    .limit(1);
  return row ? toConnectionView(row.connection, row.nextCrawlAt) : null;
}

/** List connections. If `ids` is given (an API key's connection grants), restrict to those. */
export async function listConnections(
  db: Db,
  ids?: string[],
  ownerSubject: string = SELF_HOSTED_OPERATOR_SUBJECT,
): Promise<ConnectionView[]> {
  const query = db
    .select({ connection: connections, nextCrawlAt: connectionsDue.nextCrawlAt })
    .from(connections)
    .leftJoin(connectionsDue, eq(connectionsDue.connectionId, connections.id));
  const rows = ids
    ? await query.where(and(
      eq(connections.ownerSubject, ownerSubject),
      inArray(connections.id, ids),
    ))
    : await query.where(eq(connections.ownerSubject, ownerSubject));
  return rows.map((row) => toConnectionView(row.connection, row.nextCrawlAt));
}

export async function updateConnection(
  db: Db,
  id: string,
  patch: ConnectionUpdate,
  ownerSubject: string = SELF_HOSTED_OPERATOR_SUBJECT,
): Promise<ConnectionView | null> {
  if (patch.loginUrlOverride) {
    const [conn] = await db
      .select({ institutionId: connections.institutionId })
      .from(connections)
      .where(and(eq(connections.id, id), eq(connections.ownerSubject, ownerSubject)))
      .limit(1);
    if (!conn) return null;
    await assertOverrideWithinInstitution(db, conn.institutionId, patch.loginUrlOverride);
  }
  const updatedAt = new Date();
  const values: Record<string, unknown> = { updatedAt };
  const seal = (field: string, value: string) => encryptSecret(value, { connectionId: id, field });
  if (patch.username !== undefined) values.usernameCt = seal('username', patch.username);
  if (patch.password !== undefined) values.passwordCt = seal('password', patch.password);
  if (patch.dob !== undefined) values.dobCt = patch.dob ? seal('dob', patch.dob) : null;
  if (patch.phone !== undefined) values.phoneCt = patch.phone ? seal('phone', patch.phone) : null;
  if (patch.loginUrlOverride !== undefined) values.loginUrlOverride = patch.loginUrlOverride;
  if (patch.customInstructions !== undefined) values.customInstructions = patch.customInstructions;
  if (patch.crawlScheduleEnabled !== undefined) values.crawlScheduleEnabled = patch.crawlScheduleEnabled;
  if (patch.crawlSchedule !== undefined) values.crawlSchedule = patch.crawlSchedule;
  if (patch.crawlTimezone !== undefined) values.crawlTimezone = patch.crawlTimezone;
  if (patch.nickname !== undefined) values.nickname = patch.nickname;

  const scheduleChanged = patch.crawlScheduleEnabled !== undefined
    || patch.crawlSchedule !== undefined
    || patch.crawlTimezone !== undefined;
  if (!scheduleChanged) {
    const [row] = await db.update(connections).set(values).where(and(
      eq(connections.id, id),
      eq(connections.ownerSubject, ownerSubject),
    )).returning();
    if (!row) return null;
    const [due] = await db.select({ nextCrawlAt: connectionsDue.nextCrawlAt })
      .from(connectionsDue)
      .where(eq(connectionsDue.connectionId, id))
      .limit(1);
    return toConnectionView(row, due?.nextCrawlAt ?? null);
  }

  // Match the scheduler's lock order (due row, then connection) so a schedule
  // edit cannot deadlock a concurrent tick. Re-time only normal-rotation
  // connections; an auth stop or persistent-failure backoff remains intact.
  return db.transaction(async (tx) => {
    await tx
      .select({ connectionId: connectionsDue.connectionId })
      .from(connectionsDue)
      .where(eq(connectionsDue.connectionId, id))
      .for('update')
      .limit(1);
    const [current] = await tx
      .select()
      .from(connections)
      .where(and(eq(connections.id, id), eq(connections.ownerSubject, ownerSubject)))
      .for('update')
      .limit(1);
    if (!current) return null;

    const crawlScheduleEnabled = patch.crawlScheduleEnabled ?? current.crawlScheduleEnabled;
    const crawlSchedule = patch.crawlSchedule ?? current.crawlSchedule;
    const crawlTimezone = patch.crawlTimezone ?? current.crawlTimezone;
    const crawlScheduleRevision = current.crawlScheduleRevision + 1;
    const [row] = await tx.update(connections).set({
      ...values,
      crawlScheduleRevision,
      crawlScheduleClaim: null,
    }).where(and(
      eq(connections.id, id),
      eq(connections.ownerSubject, ownerSubject),
    )).returning();
    if (!crawlScheduleEnabled) {
      await tx.delete(connectionsDue).where(eq(connectionsDue.connectionId, id));
      return row ? toConnectionView(row, null) : null;
    }
    const normalRotation = ['connected', 'connecting', 'error', 'syncing'].includes(current.status)
      && current.consecutiveFailures <= MAX_CONSECUTIVE_CRAWL_FAILURES;
    if (current.loginDomainVerified && normalRotation) {
      const nextCrawlAt = nextRunFromCron(crawlSchedule, crawlTimezone, updatedAt);
      await tx
        .insert(connectionsDue)
        .values({ connectionId: id, nextCrawlAt })
        .onConflictDoUpdate({
          target: connectionsDue.connectionId,
          set: { nextCrawlAt },
        });
      return row ? toConnectionView(row, nextCrawlAt) : null;
    }
    const [due] = await tx.select({ nextCrawlAt: connectionsDue.nextCrawlAt })
      .from(connectionsDue)
      .where(eq(connectionsDue.connectionId, id))
      .limit(1);
    if (due) return row ? toConnectionView(row, due.nextCrawlAt) : null;
    if (current.loginDomainVerified) {
      const delayDays = current.consecutiveFailures > MAX_CONSECUTIVE_CRAWL_FAILURES
        && !isAuthCrawlFailureReason(current.crawlStats?.lastFailureReason)
        ? 7
        : 1;
      const nextCrawlAt = new Date(updatedAt.getTime() + delayDays * 24 * 60 * 60 * 1000);
      await tx.insert(connectionsDue).values({ connectionId: id, nextCrawlAt });
      return row ? toConnectionView(row, nextCrawlAt) : null;
    }
    return row ? toConnectionView(row, null) : null;
  });
}

export type DeleteConnectionResult = 'deleted' | 'not_found' | 'active_crawl';

export async function deleteConnection(
  db: Db,
  id: string,
  ownerSubject: string = SELF_HOSTED_OPERATOR_SUBJECT,
): Promise<DeleteConnectionResult> {
  return db.transaction(async (tx) => {
    // The scheduler and schedule editor lock due-row then connection. Follow
    // that order here as well; the parent lock still serializes a concurrent
    // crawl-session FK insert, so a live worker's durable fence is never cascaded.
    await tx.select({ connectionId: connectionsDue.connectionId })
      .from(connectionsDue)
      .where(eq(connectionsDue.connectionId, id))
      .for('update')
      .limit(1);
    const [connection] = await tx.select({ id: connections.id })
      .from(connections)
      .where(and(eq(connections.id, id), eq(connections.ownerSubject, ownerSubject)))
      .for('update')
      .limit(1);
    if (!connection) return 'not_found';
    const [locked] = await tx.select({ id: sessions.id })
      .from(sessions)
      .where(and(
        eq(sessions.connectionId, id),
        inArray(sessions.status, [...LOCKED_SESSION_STATUSES]),
      ))
      .limit(1);
    if (locked) return 'active_crawl';
    await tx.delete(connections).where(and(
      eq(connections.id, id),
      eq(connections.ownerSubject, ownerSubject),
    ));
    return 'deleted';
  });
}

/** Anti-phishing approval: flip loginDomainVerified only if the operator re-submits the institution's
 *  exact canonical domain. Returns null if the connection doesn't exist; throws DomainMismatchError on a
 *  mismatch (a possible phishing config). */
export async function verifyLoginDomain(
  db: Db,
  id: string,
  submittedDomain: string,
  ownerSubject: string = SELF_HOSTED_OPERATOR_SUBJECT,
): Promise<ConnectionView | null> {
  const submitted = submittedDomain.trim().toLowerCase();
  const [target] = await db
    .select({ institutionId: connections.institutionId })
    .from(connections)
    .where(and(eq(connections.id, id), eq(connections.ownerSubject, ownerSubject)))
    .limit(1);
  if (!target) return null;
  // Lock the connection's institution row FOR SHARE, THEN compare + set — all in one transaction.
  // A bare correlated-subquery check-and-set is NOT enough: under READ COMMITTED, when the UPDATE waits on
  // a connection row that a concurrent updateInstitution is resetting, Postgres re-checks the target row
  // but re-evaluates the institution subquery (a non-target read) against the ORIGINAL snapshot — so it can
  // still match the OLD domain after the change committed. Locking the institution row serializes against
  // updateInstitution's row-exclusive UPDATE: we either run fully before it (its reset then overwrites our
  // verify) or fully after it (and read the NEW domain here, which no longer matches).
  return db.transaction(async (tx) => {
    // Institution first matches updateInstitution's lock order. The scheduler
    // never locks an institution, so due -> connection remains safe afterward.
    const [inst] = await tx
      .select({ canonicalDomain: institutions.canonicalDomain })
      .from(institutions)
      .where(eq(institutions.id, target.institutionId))
      .for('share')
      .limit(1);
    await tx.select({ connectionId: connectionsDue.connectionId })
      .from(connectionsDue)
      .where(eq(connectionsDue.connectionId, id))
      .for('update')
      .limit(1);
    const [conn] = await tx
      .select({ institutionId: connections.institutionId })
      .from(connections)
      .where(and(eq(connections.id, id), eq(connections.ownerSubject, ownerSubject)))
      .for('update')
      .limit(1);
    if (!conn) return null;

    if (
      conn.institutionId !== target.institutionId
      || !inst
      || inst.canonicalDomain.trim().toLowerCase() !== submitted
    ) {
      throw new DomainMismatchError();
    }

    const now = new Date();
    const [row] = await tx
      .update(connections)
      .set({ loginDomainVerified: true, updatedAt: now })
      .where(and(eq(connections.id, id), eq(connections.ownerSubject, ownerSubject)))
      .returning();
    if (!row) return null;
    if (row.crawlScheduleEnabled) {
      const nextCrawlAt = nextRunFromCron(
        row.crawlSchedule,
        row.crawlTimezone,
        now,
      );
      await tx.insert(connectionsDue)
        .values({ connectionId: id, nextCrawlAt })
        .onConflictDoUpdate({
          target: connectionsDue.connectionId,
          set: { nextCrawlAt },
        });
      return toConnectionView(row, nextCrawlAt);
    }
    await tx.delete(connectionsDue).where(eq(connectionsDue.connectionId, id));
    return toConnectionView(row, null);
  });
}

/** Decrypt a connection's credentials for an engine dispatch. NEVER call from a route — orchestrator only. */
export function decryptConnectionCredentials(row: ConnectionRow): {
  username: string;
  password: string;
  dob?: string;
  phone?: string;
} {
  const open = (field: string, ct: string) => decryptSecret(ct, { connectionId: row.id, field });
  return {
    username: open('username', row.usernameCt),
    password: open('password', row.passwordCt),
    dob: row.dobCt ? open('dob', row.dobCt) : undefined,
    phone: row.phoneCt ? open('phone', row.phoneCt) : undefined,
  };
}
