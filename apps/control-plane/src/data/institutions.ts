/**
 * Institution catalogue data access (the per-bank "recipe").
 *
 * The canonical (anti-phishing) domain is derived from the loginUrl — never accepted from the
 * caller — so a config can't claim a login domain different from where it actually points. When
 * an update changes that domain, every connection on the institution is un-verified (its
 * loginDomainVerified is reset) so it can't run until the operator re-approves the new domain.
 *
 * User-authored configs are `source: 'local'` and `scanStatus: 'passed'`; they remain private to
 * their owner unless a platform-authorized caller publishes a separate copy. Imported/community
 * configs enter as 'imported'/'pending' and must pass the malice-scan before the engine will run them.
 */
import { and, eq, isNull, or, type SQL } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import type { Db } from '../db/client';
import { institutions, connections } from '../db/schema';
import type { ExtractionHints, LoginHints } from '@accrawl/contracts';
import { deriveCanonicalDomain, isHostWithinDomain, isRegistrableHost, isSecureLoginUrl } from '../lib/domain';
import type { InstitutionAccess } from '../storage/user-data-store';

export type InstitutionType = (typeof institutions.type.enumValues)[number];

export interface InstitutionInput {
  id: string;
  name: string;
  loginUrl: string;
  type: InstitutionType;
  country?: string;
  logo?: string;
  allowedDomains?: string[];
  playbook?: string;
  extractionHints?: ExtractionHints;
  loginHints?: LoginHints;
  requires2fa?: boolean;
  otpSenderPattern?: string;
  useDeviceProxy?: boolean;
  model?: string | null;
  thinkingLevel?: string | null;
  maxSteps?: number;
  timeoutSeconds?: number;
  transactionLookbackDays?: number;
}

/** The loginUrl has no registrable domain (raw IP / localhost / malformed) — can't anchor anti-phishing. */
export class InvalidLoginUrlError extends Error {
  constructor(loginUrl: string) {
    super(`loginUrl has no registrable (eTLD+1) domain: ${loginUrl}`);
    this.name = 'InvalidLoginUrlError';
  }
}

/** The loginUrl would carry the operator's bank credentials over plain HTTP, where anyone on the path
 *  can read them and rewrite the page that asks for them — which is also what the canonical-domain
 *  anti-phishing anchor is meant to prevent. */
export class InsecureLoginUrlError extends Error {
  constructor(loginUrl: string) {
    super(`loginUrl must use https: (credentials would otherwise cross the network in the clear): ${loginUrl}`);
    this.name = 'InsecureLoginUrlError';
  }
}

/** An allowedDomains entry that isn't a registrable host (a bare public suffix / IP / localhost) —
 *  it would widen the engine's egress pin to an entire TLD and defeat the §1 exfiltration control. */
export class InvalidAllowedDomainError extends Error {
  constructor(domain: string) {
    super(`allowedDomains entry is not a registrable host: ${domain}`);
    this.name = 'InvalidAllowedDomainError';
  }
}

/** Every allowedDomain must be a specific registrable host (e.g. cdn.assets.com), never a bare suffix. */
export function validateAllowedDomains(domains: string[] | undefined): void {
  for (const d of domains ?? []) {
    if (typeof d !== 'string' || !isRegistrableHost(d)) throw new InvalidAllowedDomainError(String(d));
  }
}

export type InstitutionRow = typeof institutions.$inferSelect;

/** Private ids are opaque, stable for one owner+slug, and unlinkable across
 *  different institution slugs. The caller-facing slug remains catalogKey. */
export function privateInstitutionId(ownerSubject: string, catalogKey: string): string {
  return `u-${createHash('sha256')
    .update(ownerSubject)
    .update('\0')
    .update(catalogKey)
    .digest('hex')
    .slice(0, 62)}`;
}

/** A published row is a separate stable copy of its private source. */
export function publishedInstitutionId(sourceId: string): string {
  return `a-${createHash('sha256')
    .update('published\0')
    .update(sourceId)
    .digest('hex')
    .slice(0, 62)}`;
}

/** Copy only caller-settable recipe fields when an administrator publishes a
 *  private institution. Ownership, trust state, timestamps, and ids never
 *  cross the publication boundary implicitly. */
export function institutionInputForPublishedCopy(
  row: InstitutionRow,
): InstitutionInput {
  const id = publishedInstitutionId(row.id);
  return {
    id,
    name: row.name,
    loginUrl: row.loginUrl,
    type: row.type,
    country: row.country ?? undefined,
    logo: row.logo ?? undefined,
    allowedDomains: [...row.allowedDomains],
    playbook: row.playbook ?? undefined,
    extractionHints: row.extractionHints ?? undefined,
    loginHints: row.loginHints ?? undefined,
    requires2fa: row.requires2fa,
    otpSenderPattern: row.otpSenderPattern ?? undefined,
    useDeviceProxy: row.useDeviceProxy,
    model: row.model,
    thinkingLevel: row.thinkingLevel,
    maxSteps: row.maxSteps,
    timeoutSeconds: row.timeoutSeconds,
    transactionLookbackDays: row.transactionLookbackDays,
  };
}

export function institutionMatchesAccess(
  row: Pick<InstitutionRow, 'ownerSubject'>,
  access: InstitutionAccess,
): boolean {
  if (access.kind === 'all') return true;
  if (access.kind === 'public') return row.ownerSubject == null;
  if (access.kind === 'owned') return row.ownerSubject === access.ownerSubject;
  return row.ownerSubject == null || row.ownerSubject === access.ownerSubject;
}

function institutionAccessPredicate(access: InstitutionAccess): SQL | undefined {
  if (access.kind === 'all') return undefined;
  if (access.kind === 'public') return isNull(institutions.ownerSubject);
  if (access.kind === 'owned') return eq(institutions.ownerSubject, access.ownerSubject);
  return or(
    isNull(institutions.ownerSubject),
    eq(institutions.ownerSubject, access.ownerSubject),
  );
}

/**
 * The ONLY institution fields a caller may set. canonicalDomain (derived from loginUrl), source, and
 * scanStatus are trust/anti-phishing fields and are NEVER caller-settable — building writes from this
 * allowlist (instead of spreading caller input) makes that structural.
 */
const CALLER_SETTABLE_FIELDS = [
  'name', 'loginUrl', 'type', 'country', 'logo', 'allowedDomains', 'playbook', 'extractionHints',
  'loginHints', 'requires2fa', 'otpSenderPattern', 'useDeviceProxy', 'model', 'thinkingLevel', 'maxSteps',
  'timeoutSeconds', 'transactionLookbackDays',
] as const;

function pickSettable(input: Partial<InstitutionInput>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of CALLER_SETTABLE_FIELDS) {
    if (input[key] !== undefined) out[key] = input[key];
  }
  return out;
}

export type ConfigSource = (typeof institutions.source.enumValues)[number];
export type ScanStatus = (typeof institutions.scanStatus.enumValues)[number];
export type SetInstitutionScanStatusResult =
  | { status: 'updated'; institution: InstitutionRow }
  | { status: 'not_found' }
  | { status: 'stale'; institution: InstitutionRow };

export interface InstitutionUpdatePlan {
  row: InstitutionRow;
  resetLoginDomainVerification: boolean;
  canonicalDomainChanged: boolean;
}

/** Build one complete canonical row without relying on storage-specific defaults. */
export function prepareInstitutionInsert(
  input: InstitutionInput,
  source: ConfigSource,
  scanStatus: ScanStatus,
  ownerSubject: string | null = null,
  now = new Date(),
): InstitutionRow {
  if (!isSecureLoginUrl(input.loginUrl)) throw new InsecureLoginUrlError(input.loginUrl);
  const canonicalDomain = deriveCanonicalDomain(input.loginUrl);
  if (!canonicalDomain) throw new InvalidLoginUrlError(input.loginUrl);
  validateAllowedDomains(input.allowedDomains);
  return {
    id: ownerSubject == null ? input.id : privateInstitutionId(ownerSubject, input.id),
    ownerSubject,
    catalogKey: input.id,
    name: input.name,
    loginUrl: input.loginUrl,
    canonicalDomain,
    allowedDomains: input.allowedDomains ?? [],
    type: input.type,
    country: input.country ?? null,
    logo: input.logo ?? null,
    playbook: input.playbook ?? null,
    extractionHints: input.extractionHints ?? null,
    loginHints: input.loginHints ?? null,
    requires2fa: input.requires2fa ?? false,
    otpSenderPattern: input.otpSenderPattern ?? null,
    useDeviceProxy: input.useDeviceProxy ?? false,
    model: input.model ?? null,
    thinkingLevel: input.thinkingLevel ?? null,
    maxSteps: input.maxSteps ?? 120,
    timeoutSeconds: input.timeoutSeconds ?? 900,
    transactionLookbackDays: input.transactionLookbackDays ?? 14,
    source,
    scanStatus,
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
}

/** Storage-neutral anti-phishing update plan, shared by every backend. */
export function prepareInstitutionUpdate(
  existing: InstitutionRow,
  patch: Partial<Omit<InstitutionInput, 'id'>>,
  now = new Date(),
): InstitutionUpdatePlan {
  validateAllowedDomains(patch.allowedDomains);
  const values = { ...pickSettable(patch), updatedAt: now } as Partial<InstitutionRow>;
  let canonicalDomainChanged = false;
  let allowedDomainsChanged = false;

  if (patch.loginUrl !== undefined) {
    if (!isSecureLoginUrl(patch.loginUrl)) throw new InsecureLoginUrlError(patch.loginUrl);
    const canonicalDomain = deriveCanonicalDomain(patch.loginUrl);
    if (!canonicalDomain) throw new InvalidLoginUrlError(patch.loginUrl);
    values.canonicalDomain = canonicalDomain;
    canonicalDomainChanged = existing.canonicalDomain !== canonicalDomain;
  }
  if (patch.allowedDomains !== undefined) {
    const before = [...(existing.allowedDomains ?? [])]
      .map((value) => value.toLowerCase())
      .sort();
    const after = [...patch.allowedDomains]
      .map((value) => value.toLowerCase())
      .sort();
    allowedDomainsChanged = JSON.stringify(before) !== JSON.stringify(after);
  }
  const next = { ...existing, ...values };
  if (existing.source === 'imported'
    && institutionScanFingerprint(existing) !== institutionScanFingerprint(next)) {
    values.scanStatus = 'pending';
  }

  return {
    row: { ...existing, ...values },
    resetLoginDomainVerification: canonicalDomainChanged || allowedDomainsChanged,
    canonicalDomainChanged,
  };
}

/**
 * Stable digest of every stored field supplied to the imported-config Safety
 * check. A verdict may be persisted only while this digest still matches the
 * scanned snapshot.
 */
export function institutionScanFingerprint(
  institution: Pick<
    InstitutionRow,
    'name' | 'loginUrl' | 'canonicalDomain' | 'allowedDomains' | 'playbook'
  >,
): string {
  return createHash('sha256')
    .update(JSON.stringify([
      institution.name,
      institution.loginUrl,
      institution.canonicalDomain.toLowerCase(),
      [...institution.allowedDomains]
        .map((value) => value.toLowerCase())
        .sort(),
      institution.playbook ?? null,
    ]))
    .digest('base64url');
}

/** Stable digest of every institution field that widens credential-bearing egress. */
export function institutionTrustFingerprint(
  institution: Pick<InstitutionRow, 'canonicalDomain' | 'allowedDomains'>,
): string {
  return createHash('sha256')
    .update(JSON.stringify([
      institution.canonicalDomain.toLowerCase(),
      [...institution.allowedDomains]
        .map((value) => value.toLowerCase())
        .sort(),
    ]))
    .digest('base64url');
}

/** Core insert. The trust fields (source, scanStatus) are passed by the CALLING FUNCTION, never by the
 *  external caller, and are written AFTER the input spread — so a request body can never inject them. */
async function insertInstitution(
  db: Db,
  input: InstitutionInput,
  source: ConfigSource,
  scanStatus: ScanStatus,
  ownerSubject: string | null = null,
): Promise<InstitutionRow> {
  const prepared = prepareInstitutionInsert(input, source, scanStatus, ownerSubject);
  const [row] = await db
    .insert(institutions)
    .values(prepared)
    .returning();
  return row;
}

/** Locally authored config in this deployment → runnable (source 'local', scan 'passed'). */
export async function createInstitution(
  db: Db,
  input: InstitutionInput,
  ownerSubject: string | null = null,
): Promise<InstitutionRow> {
  return insertInstitution(db, input, 'local', 'passed', ownerSubject);
}

/** An imported community config → UNTRUSTED: source 'imported', scanStatus 'pending'. The malice-scan must
 *  set it to 'passed' before the engine will run it (enforced in run-crawl.ts). Any connection later added to
 *  it still has to pass the anti-phishing loginDomainVerified check — importing never pre-verifies a domain. */
export async function createImportedInstitution(
  db: Db,
  input: InstitutionInput,
  ownerSubject: string | null = null,
): Promise<InstitutionRow> {
  return insertInstitution(db, input, 'imported', 'pending', ownerSubject);
}

/**
 * Set the malice-scan result only when the stored scan input still matches the
 * exact snapshot that was checked. The row lock makes the fingerprint compare
 * and verdict update one atomic operation.
 */
export async function setInstitutionScanStatus(
  db: Db,
  id: string,
  scanStatus: ScanStatus,
  expectedScanFingerprint: string,
  access: InstitutionAccess = { kind: 'public' },
): Promise<SetInstitutionScanStatusResult> {
  return db.transaction(async (tx) => {
    const predicate = institutionAccessPredicate(access);
    const [existing] = await tx
      .select()
      .from(institutions)
      .where(predicate ? and(eq(institutions.id, id), predicate) : eq(institutions.id, id))
      .limit(1)
      .for('update');
    if (!existing) return { status: 'not_found' };
    if (institutionScanFingerprint(existing) !== expectedScanFingerprint) {
      return { status: 'stale', institution: existing };
    }
    const [row] = await tx
      .update(institutions)
      .set({ scanStatus, updatedAt: new Date() })
      .where(eq(institutions.id, id))
      .returning();
    return { status: 'updated', institution: row };
  });
}

export async function getInstitution(
  db: Db,
  id: string,
  access: InstitutionAccess = { kind: 'public' },
): Promise<InstitutionRow | null> {
  const predicate = institutionAccessPredicate(access);
  const [row] = await db.select().from(institutions)
    .where(predicate ? and(eq(institutions.id, id), predicate) : eq(institutions.id, id))
    .limit(1);
  return row ?? null;
}

export async function listInstitutions(
  db: Db,
  access: InstitutionAccess = { kind: 'public' },
): Promise<InstitutionRow[]> {
  const predicate = institutionAccessPredicate(access);
  return predicate
    ? db.select().from(institutions).where(predicate)
    : db.select().from(institutions);
}

/** Update an institution. `id` cannot be changed. A loginUrl change re-derives canonicalDomain and,
 *  if it actually changed, resets loginDomainVerified on all of this institution's connections. */
export async function updateInstitution(
  db: Db,
  id: string,
  patch: Partial<Omit<InstitutionInput, 'id'>>,
  access: InstitutionAccess = { kind: 'public' },
): Promise<InstitutionRow | null> {
  // Explicit allowlist — never spread `patch` (which could carry canonicalDomain/source/scanStatus and
  // re-anchor anti-phishing to an attacker domain). canonicalDomain is only ever set from loginUrl below.
  // The whole thing runs in ONE transaction: the domain change and the connection-verification reset must
  // be atomic. Otherwise a concurrent verifyLoginDomain could slip into the committed window — verify a
  // connection against the OLD domain just before it changes — and leave it verified for the new,
  // unapproved domain. The reset runs LAST so it also overwrites any verify that committed first.
  return db.transaction(async (tx) => {
    const predicate = institutionAccessPredicate(access);
    const [existing] = await tx.select()
      .from(institutions)
      .where(predicate ? and(eq(institutions.id, id), predicate) : eq(institutions.id, id))
      .limit(1);
    if (!existing) return null;
    const plan = prepareInstitutionUpdate(existing, patch);
    const { id: _id, createdAt: _createdAt, ...values } = plan.row;
    const [row] = await tx.update(institutions)
      .set(values)
      .where(predicate ? and(eq(institutions.id, id), predicate) : eq(institutions.id, id))
      .returning();

    if (plan.resetLoginDomainVerification) {
      // Anti-phishing: the login domain OR the egress allowlist moved — force re-approval before any
      // connection can run, so the operator re-confirms every destination the agent may reach (not just
      // the login domain). allowedDomains is a trust field, not a cosmetic one.
      await tx.update(connections).set({ loginDomainVerified: false }).where(eq(connections.institutionId, id));
    }
    if (plan.canonicalDomainChanged) {
      // Also clear any loginUrlOverride that no longer sits within the new canonical domain — it pointed at
      // the OLD bank domain and is now meaningless / an off-domain credential target. The connection falls
      // back to the new institution loginUrl; the operator can set a fresh in-domain override if needed.
      const newDomain = row.canonicalDomain;
      const conns = await tx
        .select({ id: connections.id, loginUrlOverride: connections.loginUrlOverride })
        .from(connections)
        .where(eq(connections.institutionId, id));
      for (const c of conns) {
        if (c.loginUrlOverride && !isHostWithinDomain(c.loginUrlOverride, newDomain)) {
          await tx.update(connections).set({ loginUrlOverride: null }).where(eq(connections.id, c.id));
        }
      }
    }
    return row;
  });
}

/** Delete an institution. Throws the underlying FK violation (Postgres 23503) when connections
 *  still reference it — the route surfaces that as a 409. Returns false if the id didn't exist. */
export async function deleteInstitution(
  db: Db,
  id: string,
  access: InstitutionAccess = { kind: 'public' },
): Promise<boolean> {
  const predicate = institutionAccessPredicate(access);
  const res = await db.delete(institutions)
    .where(predicate ? and(eq(institutions.id, id), predicate) : eq(institutions.id, id))
    .returning({ id: institutions.id });
  return res.length > 0;
}
