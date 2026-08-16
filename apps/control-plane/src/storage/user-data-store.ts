/**
 * Persistence boundary for the hosted user-data path.
 *
 * PostgreSQL remains the self-hosted implementation today. Hosted deployments
 * must not make route and authorization code depend on Drizzle's query builder,
 * because that makes a deployment storing records elsewhere a second implementation of every
 * HTTP route. This port captures the domain-level operations used by connection,
 * balance, and organisation-sharing flows. Implementations own only persistence
 * mechanics; validation, API schemas, and contract projections remain in the
 * public control-plane.
 */
import type {
  ContractAccount,
  ContractHolding,
  ContractSecurity,
  ContractTransaction,
  TransactionSyncPage,
} from '@accrawl/contracts';
import type { AuditEntry } from '../auth/audit';
import type {
  AccountTransactionsPage,
  AccountView,
} from '../data/account-views';
import type {
  ConnectionInput,
  ConnectionUpdate,
  ConnectionView,
  DeleteConnectionResult,
} from '../data/connections';
import type {
  OrganizationShareScope,
  OrganizationShareView,
  OrganizationView,
  SharedBalanceOwner,
  SharedConnectionOwner,
} from '../data/organization-shares';
import type {
  ConfigSource,
  InstitutionInput,
  InstitutionRow,
  ScanStatus,
  SetInstitutionScanStatusResult,
} from '../data/institutions';
import type { SyncView } from '@accrawl/contracts';
import type {
  RunCrawlDeps,
  RunCrawlResult,
} from '../orchestration/run-crawl';
import type {
  AwaitingOtpSession,
  ConnectionSessionView,
  RecentSessionView,
  SessionEvent,
  SessionRecords,
  SessionStepView,
  SessionView,
  SubmitOtpResult,
} from '../data/session-io';

export class UnknownInstitutionError extends Error {
  constructor() {
    super('unknown institutionId');
    this.name = 'UnknownInstitutionError';
  }
}

export class InstitutionConfigAlreadyExistsError extends Error {
  constructor() {
    super('institution id already exists');
    this.name = 'InstitutionConfigAlreadyExistsError';
  }
}

export interface CreateOrganizationInput {
  disabled?: boolean;
  id: string;
  name: string;
  provisioningId?: string;
}

export interface ReplaceOrganizationShareInput {
  ownerSubject: string;
  ownerEmail: string;
  organizationId: string;
  scopes: OrganizationShareScope[];
  connectionGrants: string[];
  expiresAt: Date;
}

export interface OrganizationConnectionAccessInput {
  organizationId: string;
  shareId: string;
  connectionId: string;
  scope: OrganizationShareScope;
  now?: Date;
}

export type CancelSessionResult =
  | 'cancelled'
  | 'not_found'
  | 'already_terminal';

export type InstitutionAccess =
  | { kind: 'all' }
  | { kind: 'visible'; ownerSubject: string }
  | { kind: 'owned'; ownerSubject: string }
  | { kind: 'public' };

export type PublishInstitutionConfigResult =
  | { status: 'published'; institution: InstitutionRow }
  | { status: 'not_found' }
  | { status: 'already_published' }
  | { status: 'scan_required' }
  | { status: 'copy_exists'; institutionName: string };

export interface UserDataStore {
  getInstitution(id: string, access: InstitutionAccess): Promise<InstitutionRow | null>;
  listInstitutions(access: InstitutionAccess): Promise<InstitutionRow[]>;
  createInstitutionConfig(
    input: InstitutionInput,
    source: ConfigSource,
    scanStatus: ScanStatus,
    ownerSubject: string | null,
  ): Promise<InstitutionRow>;
  publishInstitutionConfig(id: string): Promise<PublishInstitutionConfigResult>;
  updateInstitutionConfig(
    id: string,
    patch: Partial<Omit<InstitutionInput, 'id'>>,
    access: InstitutionAccess,
  ): Promise<InstitutionRow | null>;
  deleteInstitutionConfig(
    id: string,
    access: InstitutionAccess,
  ): Promise<'deleted' | 'not_found' | 'in_use'>;
  setInstitutionScanStatus(
    id: string,
    scanStatus: ScanStatus,
    expectedScanFingerprint: string,
    access: InstitutionAccess,
  ): Promise<SetInstitutionScanStatusResult>;

  createConnection(input: ConnectionInput, ownerSubject: string): Promise<ConnectionView>;
  getConnection(id: string, ownerSubject: string): Promise<ConnectionView | null>;
  listConnections(ownerSubject: string, ids?: string[]): Promise<ConnectionView[]>;
  updateConnection(
    id: string,
    patch: ConnectionUpdate,
    ownerSubject: string,
  ): Promise<ConnectionView | null>;
  deleteConnection(id: string, ownerSubject: string): Promise<DeleteConnectionResult>;
  verifyLoginDomain(
    id: string,
    submittedDomain: string,
    ownerSubject: string,
  ): Promise<ConnectionView | null>;
  actorOwnsConnection(ownerSubject: string, connectionId: string): Promise<boolean>;
  actorOwnsAccount(ownerSubject: string, accountId: string): Promise<boolean>;
  getAccountConnectionId(accountId: string): Promise<string | null>;

  listAllAccounts(ownerSubject: string): Promise<AccountView[]>;
  listAccountTransactions(
    accountId: string,
    limit: number,
    offset: number,
  ): Promise<AccountTransactionsPage | null>;
  listUnassignedTransactions(
    connectionId: string,
    limit: number,
    offset: number,
  ): Promise<AccountTransactionsPage>;
  listConnectionAccountsContract(
    connectionId: string,
    limit: number,
    offset: number,
  ): Promise<{ items: ContractAccount[]; hasMore: boolean }>;
  listConnectionTransactionsContract(
    connectionId: string,
    limit: number,
    offset: number,
    from?: string,
    to?: string,
  ): Promise<{ items: ContractTransaction[]; hasMore: boolean }>;
  listConnectionHoldings(
    connectionId: string,
    limit: number,
    offset: number,
  ): Promise<{
    holdings: ContractHolding[];
    securities: ContractSecurity[];
    hasMore: boolean;
  }>;
  transactionSyncPage(
    connectionId: string,
    cursor: string | undefined,
    limit: number,
  ): Promise<TransactionSyncPage>;
  runCrawl(
    deps: RunCrawlDeps,
    input: { connectionId: string; expectedScheduleRevision?: number },
  ): Promise<RunCrawlResult>;
  actorOwnsSync(ownerSubject: string, syncId: string): Promise<boolean>;
  getSyncConnectionId(syncId: string): Promise<string | null>;
  getSyncView(syncId: string): Promise<SyncView | null>;
  getSessionView(sessionId: string): Promise<SessionView | null>;
  listSessionSteps(sessionId: string): Promise<SessionStepView[]>;
  getStepScreenshotRef(
    sessionId: string,
    stepNumber: number,
  ): Promise<string | null>;
  listConnectionSessions(
    connectionId: string,
    limit?: number,
  ): Promise<ConnectionSessionView[]>;
  listRecentSessions(
    ownerSubject: string,
    limit?: number,
  ): Promise<RecentSessionView[]>;
  listAwaitingOtpSessions(ownerSubject: string): Promise<AwaitingOtpSession[]>;
  getSessionRecords(sessionId: string): Promise<SessionRecords>;
  submitOtp(
    sessionId: string,
    code: string,
    idempotencyKey?: string,
  ): Promise<SubmitOtpResult>;
  listSessionEvents(
    sessionId: string,
    sinceSeq?: number,
  ): Promise<SessionEvent[]>;
  cancelSession(syncId: string): Promise<CancelSessionResult>;

  listOrganizations(includeDisabled?: boolean): Promise<OrganizationView[]>;
  getOrganization(id: string, includeDisabled?: boolean): Promise<OrganizationView | null>;
  createOrganization(input: CreateOrganizationInput): Promise<OrganizationView>;
  activateOrganizationProvisioning(
    id: string,
    provisioningId: string,
  ): Promise<OrganizationView | null>;
  setOrganizationDisabled(id: string, disabled: boolean): Promise<OrganizationView | null>;
  listOwnerShares(ownerSubject: string): Promise<OrganizationShareView[]>;
  replaceOrganizationShare(
    input: ReplaceOrganizationShareInput,
  ): Promise<OrganizationShareView>;
  revokeOrganizationShare(shareId: string, ownerSubject: string): Promise<boolean>;
  listOrganizationSharedBalances(
    organizationId: string,
    now?: Date,
  ): Promise<SharedBalanceOwner[]>;
  listOrganizationSharedConnections(
    organizationId: string,
    now?: Date,
  ): Promise<SharedConnectionOwner[]>;
  organizationCanAccessConnection(
    input: OrganizationConnectionAccessInput,
  ): Promise<boolean>;

  /** Best-effort append-only security audit, matching the existing PostgreSQL contract. */
  writeAudit(entry: AuditEntry): Promise<void>;
}
