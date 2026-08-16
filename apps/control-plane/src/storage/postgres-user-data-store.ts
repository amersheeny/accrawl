import {
  InstitutionConfigAlreadyExistsError,
  UnknownInstitutionError,
  type UserDataStore,
} from './user-data-store';
import type { Db } from '../db/client';
import {
  createConnection,
  deleteConnection,
  getConnection,
  listConnections,
  updateConnection,
  verifyLoginDomain,
} from '../data/connections';
import {
  listAccountTransactions,
  listAllAccounts,
  listUnassignedTransactions,
} from '../data/account-views';
import {
  listConnectionAccountsContract,
  listConnectionHoldings,
  listConnectionTransactionsContract,
  transactionSyncPage,
} from '../data/public-data';
import {
  activateOrganizationProvisioning,
  createOrganization,
  getOrganization,
  listOrganizationSharedBalances,
  listOrganizationSharedConnections,
  listOrganizations,
  listOwnerShares,
  organizationCanAccessConnection,
  replaceOrganizationShare,
  revokeOrganizationShare,
  setOrganizationDisabled,
} from '../data/organization-shares';
import { writeAudit } from '../auth/audit';
import { and, eq } from 'drizzle-orm';
import { accounts, connections, institutions } from '../db/schema';
import {
  createImportedInstitution,
  createInstitution,
  deleteInstitution,
  getInstitution,
  institutionInputForPublishedCopy,
  listInstitutions,
  prepareInstitutionInsert,
  setInstitutionScanStatus,
  updateInstitution,
} from '../data/institutions';
import { postgresErrorCode } from '../lib/postgres-error';
import { runCrawl } from '../orchestration/run-crawl';
import { getSyncView } from '../data/sync-view';
import { sessions } from '../db/schema';
import {
  finalizeSessionCancellation,
  requestSessionCancellation,
} from '../data/cancel-session';
import { dispatchCancelToEngine } from '../orchestration/dispatch-engine';
import {
  getSessionRecords,
  getSessionView,
  getStepScreenshotRef,
  listAwaitingOtpSessions,
  listConnectionSessions,
  listRecentSessions,
  listSessionEvents,
  listSessionSteps,
  submitOtp,
} from '../data/session-io';

/**
 * Thin compatibility adapter around the existing, battle-tested PostgreSQL
 * domain functions. Keeping it as an explicit implementation lets HTTP routes
 * move to UserDataStore without changing self-hosted behavior.
 */
export class PostgresUserDataStore implements UserDataStore {
  constructor(private readonly db: Db) {}

  getInstitution = (
    id: string,
    access: Parameters<UserDataStore['getInstitution']>[1] = { kind: 'public' },
  ) => getInstitution(this.db, id, access);

  listInstitutions = (
    access: Parameters<UserDataStore['listInstitutions']>[0] = { kind: 'public' },
  ) => listInstitutions(this.db, access);

  async createInstitutionConfig(
    input: Parameters<UserDataStore['createInstitutionConfig']>[0],
    source: Parameters<UserDataStore['createInstitutionConfig']>[1],
    scanStatus: Parameters<UserDataStore['createInstitutionConfig']>[2],
    ownerSubject: Parameters<UserDataStore['createInstitutionConfig']>[3] = null,
  ): ReturnType<UserDataStore['createInstitutionConfig']> {
    try {
      if (source === 'local' && scanStatus === 'passed') {
        return await createInstitution(this.db, input, ownerSubject);
      }
      if (source === 'imported' && scanStatus === 'pending') {
        return await createImportedInstitution(this.db, input, ownerSubject);
      }
      throw new Error('unsupported institution trust transition');
    } catch (error) {
      if (postgresErrorCode(error) === '23505') {
        throw new InstitutionConfigAlreadyExistsError();
      }
      throw error;
    }
  }

  async publishInstitutionConfig(
    id: string,
  ): ReturnType<UserDataStore['publishInstitutionConfig']> {
    return this.db.transaction(async (tx) => {
      const [source] = await tx
        .select()
        .from(institutions)
        .where(eq(institutions.id, id))
        .limit(1)
        .for('update');
      if (!source) return { status: 'not_found' };
      if (source.ownerSubject == null) return { status: 'already_published' };
      if (source.scanStatus !== 'passed') return { status: 'scan_required' };

      const prepared = prepareInstitutionInsert(
        institutionInputForPublishedCopy(source),
        source.source,
        source.scanStatus,
        null,
      );
      const [published] = await tx
        .insert(institutions)
        .values(prepared)
        .onConflictDoNothing({ target: institutions.id })
        .returning();
      return published
        ? { status: 'published', institution: published }
        : { status: 'copy_exists', institutionName: source.name };
    });
  }

  updateInstitutionConfig = (
    id: string,
    patch: Parameters<UserDataStore['updateInstitutionConfig']>[1],
    access: Parameters<UserDataStore['updateInstitutionConfig']>[2] = { kind: 'public' },
  ) => updateInstitution(this.db, id, patch, access);

  async deleteInstitutionConfig(
    id: string,
    access: Parameters<UserDataStore['deleteInstitutionConfig']>[1] = { kind: 'public' },
  ): ReturnType<UserDataStore['deleteInstitutionConfig']> {
    try {
      return await deleteInstitution(this.db, id, access) ? 'deleted' : 'not_found';
    } catch (error) {
      const code = postgresErrorCode(error);
      if (code === '23001' || code === '23503') return 'in_use';
      throw error;
    }
  }

  setInstitutionScanStatus = (
    id: string,
    scanStatus: Parameters<UserDataStore['setInstitutionScanStatus']>[1],
    expectedScanFingerprint: Parameters<UserDataStore['setInstitutionScanStatus']>[2],
    access: Parameters<UserDataStore['setInstitutionScanStatus']>[3] = { kind: 'public' },
  ) => setInstitutionScanStatus(
    this.db,
    id,
    scanStatus,
    expectedScanFingerprint,
    access,
  );

  async createConnection(
    input: Parameters<UserDataStore['createConnection']>[0],
    ownerSubject: string,
  ): ReturnType<UserDataStore['createConnection']> {
    const institution = await getInstitution(this.db, input.institutionId, {
      kind: 'visible',
      ownerSubject,
    });
    if (!institution) throw new UnknownInstitutionError();
    return createConnection(this.db, input, ownerSubject);
  }

  getConnection = (id: string, ownerSubject: string) =>
    getConnection(this.db, id, ownerSubject);

  listConnections = (ownerSubject: string, ids?: string[]) =>
    listConnections(this.db, ids, ownerSubject);

  updateConnection = (
    id: string,
    patch: Parameters<UserDataStore['updateConnection']>[1],
    ownerSubject: string,
  ) => updateConnection(this.db, id, patch, ownerSubject);

  deleteConnection = (id: string, ownerSubject: string) =>
    deleteConnection(this.db, id, ownerSubject);

  verifyLoginDomain = (id: string, submittedDomain: string, ownerSubject: string) =>
    verifyLoginDomain(this.db, id, submittedDomain, ownerSubject);

  async actorOwnsConnection(ownerSubject: string, connectionId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: connections.id })
      .from(connections)
      .where(and(
        eq(connections.id, connectionId),
        eq(connections.ownerSubject, ownerSubject),
      ))
      .limit(1);
    return !!row;
  }

  async actorOwnsAccount(ownerSubject: string, accountId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: accounts.id })
      .from(accounts)
      .innerJoin(connections, eq(accounts.connectionId, connections.id))
      .where(and(
        eq(accounts.id, accountId),
        eq(connections.ownerSubject, ownerSubject),
      ))
      .limit(1);
    return !!row;
  }

  async getAccountConnectionId(accountId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ connectionId: accounts.connectionId })
      .from(accounts)
      .where(eq(accounts.id, accountId))
      .limit(1);
    return row?.connectionId ?? null;
  }

  listAllAccounts = (ownerSubject: string) =>
    listAllAccounts(this.db, ownerSubject);

  listAccountTransactions = (accountId: string, limit: number, offset: number) =>
    listAccountTransactions(this.db, accountId, limit, offset);

  listUnassignedTransactions = (connectionId: string, limit: number, offset: number) =>
    listUnassignedTransactions(this.db, connectionId, limit, offset);

  listConnectionAccountsContract = (connectionId: string, limit: number, offset: number) =>
    listConnectionAccountsContract(this.db, connectionId, limit, offset);

  listConnectionTransactionsContract = (
    connectionId: string,
    limit: number,
    offset: number,
    from?: string,
    to?: string,
  ) => listConnectionTransactionsContract(this.db, connectionId, limit, offset, from, to);

  listConnectionHoldings = (connectionId: string, limit: number, offset: number) =>
    listConnectionHoldings(this.db, connectionId, limit, offset);

  transactionSyncPage = (connectionId: string, cursor: string | undefined, limit: number) =>
    transactionSyncPage(this.db, connectionId, cursor, limit);

  runCrawl = (
    deps: Parameters<UserDataStore['runCrawl']>[0],
    input: Parameters<UserDataStore['runCrawl']>[1],
  ) => runCrawl(this.db, deps, input);

  async actorOwnsSync(ownerSubject: string, syncId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ connectionId: sessions.connectionId })
      .from(sessions)
      .where(eq(sessions.id, syncId))
      .limit(1);
    return !!row && this.actorOwnsConnection(ownerSubject, row.connectionId);
  }

  async getSyncConnectionId(syncId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ connectionId: sessions.connectionId })
      .from(sessions)
      .where(eq(sessions.id, syncId))
      .limit(1);
    return row?.connectionId ?? null;
  }

  getSyncView = (syncId: string) => getSyncView(this.db, syncId);

  getSessionView = (sessionId: string) => getSessionView(this.db, sessionId);

  listSessionSteps = (sessionId: string) =>
    listSessionSteps(this.db, sessionId);

  getStepScreenshotRef = (sessionId: string, stepNumber: number) =>
    getStepScreenshotRef(this.db, sessionId, stepNumber);

  listConnectionSessions = (connectionId: string, limit?: number) =>
    listConnectionSessions(this.db, connectionId, limit);

  listRecentSessions = (ownerSubject: string, limit?: number) =>
    listRecentSessions(this.db, limit, ownerSubject);

  listAwaitingOtpSessions = (ownerSubject: string) =>
    listAwaitingOtpSessions(this.db, ownerSubject);

  getSessionRecords = (sessionId: string) =>
    getSessionRecords(this.db, sessionId);

  submitOtp = (
    sessionId: string,
    code: string,
    idempotencyKey?: string,
  ) => submitOtp(this.db, sessionId, code, idempotencyKey);

  listSessionEvents = (sessionId: string, sinceSeq?: number) =>
    listSessionEvents(this.db, sessionId, sinceSeq);

  async cancelSession(
    syncId: string,
  ): ReturnType<UserDataStore['cancelSession']> {
    const requested = await requestSessionCancellation(this.db, syncId);
    if (requested === 'not_found') return 'not_found';
    if (requested === 'already_terminal') return 'already_terminal';
    if (requested === 'already_cancelled') return 'cancelled';
    await dispatchCancelToEngine(syncId);
    const finalized = await finalizeSessionCancellation(this.db, syncId);
    return finalized ? 'cancelled' : 'already_terminal';
  }

  listOrganizations = (includeDisabled = false) =>
    listOrganizations(this.db, includeDisabled);

  getOrganization = (id: string, includeDisabled = false) =>
    getOrganization(this.db, id, includeDisabled);

  createOrganization = (input: Parameters<UserDataStore['createOrganization']>[0]) =>
    createOrganization(this.db, input);

  activateOrganizationProvisioning = (id: string, provisioningId: string) =>
    activateOrganizationProvisioning(this.db, id, provisioningId);

  setOrganizationDisabled = (id: string, disabled: boolean) =>
    setOrganizationDisabled(this.db, id, disabled);

  listOwnerShares = (ownerSubject: string) =>
    listOwnerShares(this.db, ownerSubject);

  replaceOrganizationShare = (
    input: Parameters<UserDataStore['replaceOrganizationShare']>[0],
  ) => replaceOrganizationShare(this.db, input);

  revokeOrganizationShare = (shareId: string, ownerSubject: string) =>
    revokeOrganizationShare(this.db, shareId, ownerSubject);

  listOrganizationSharedBalances = (organizationId: string, now = new Date()) =>
    listOrganizationSharedBalances(this.db, organizationId, now);

  listOrganizationSharedConnections = (organizationId: string, now = new Date()) =>
    listOrganizationSharedConnections(this.db, organizationId, now);

  organizationCanAccessConnection = (
    input: Parameters<UserDataStore['organizationCanAccessConnection']>[0],
  ) => organizationCanAccessConnection(this.db, input);

  writeAudit = (entry: Parameters<UserDataStore['writeAudit']>[0]) =>
    writeAudit(this.db, entry);
}
