/**
 * Import a community/third-party config and run it through the malice-scan gate.
 *
 * Importing is deliberately two steps: (1) persist the config as UNTRUSTED (source 'imported', scanStatus
 * 'pending'), then (2) run the LLM malice-scan and record its verdict. Splitting them means a config is
 * durably stored (the operator can review/re-scan it) even if the scan model is momentarily unreachable — and
 * it is NEVER runnable until a scan actually passes (the run-crawl gate blocks 'pending' and 'failed').
 *
 * FAIL-CLOSED: if the scan throws (no GEMINI_API_KEY, API/network error), the config stays 'pending' — never
 * marked safe. On IMPORT the config had no prior trust, so 'pending' is the natural resting state. On RE-SCAN
 * we do NOT downgrade an existing verdict on a transient model error (that would let a flaky model nuke a
 * working config); rescan only CHANGES status on a SUCCESSFUL scan.
 */
import type { Db } from '../db/client';
import {
  createImportedInstitution,
  getInstitution,
  institutionScanFingerprint,
  setInstitutionScanStatus,
  type ConfigSource,
  type InstitutionInput,
  type ScanStatus,
  type SetInstitutionScanStatusResult,
} from '../data/institutions';
import { institutions } from '../db/schema';
import type { InstitutionAccess } from '../storage/user-data-store';
import { scanConfigForMalice, type MaliceScanInput, type MaliceScanResult } from './malice-scan';
import { fetchTextFromUrl } from '../lib/ssrf';
import { CONTROL_PLANE_INSTITUTION_COPY } from '../institution-copy';

type InstitutionRow = typeof institutions.$inferSelect;
export interface InstitutionConfigPersistence {
  createInstitutionConfig(
    input: InstitutionInput,
    source: ConfigSource,
    scanStatus: ScanStatus,
    ownerSubject: string | null,
  ): Promise<InstitutionRow>;
  getInstitution(id: string, access: InstitutionAccess): Promise<InstitutionRow | null>;
  setInstitutionScanStatus(
    id: string,
    scanStatus: ScanStatus,
    expectedScanFingerprint: string,
    access: InstitutionAccess,
  ): Promise<SetInstitutionScanStatusResult>;
}

/** Injectable scanner (defaults to the live Gemini scan) so callers/tests can supply a mock. */
export type ConfigScanner = (input: MaliceScanInput) => Promise<MaliceScanResult>;

export interface ImportOutcome {
  institution: InstitutionRow;
  scan: {
    status: ScanStatus;
    reason: string;
    outcome: 'completed' | 'stale' | 'unavailable';
  };
}

function postgresInstitutionPersistence(db: Db): InstitutionConfigPersistence {
  return {
    createInstitutionConfig: (input, source, scanStatus, ownerSubject) => {
      if (source !== 'imported' || scanStatus !== 'pending') {
        throw new Error('unsupported institution trust transition');
      }
      return createImportedInstitution(db, input, ownerSubject);
    },
    getInstitution: (id, access) => getInstitution(db, id, access),
    setInstitutionScanStatus: (id, scanStatus, expectedScanFingerprint, access) =>
      setInstitutionScanStatus(
        db,
        id,
        scanStatus,
        expectedScanFingerprint,
        access,
      ),
  };
}

/** Build the scan input from a stored institution row (server-derived canonicalDomain + allowlist). */
function scanInputFor(row: InstitutionRow): MaliceScanInput {
  return {
    name: row.name,
    loginUrl: row.loginUrl,
    canonicalDomain: row.canonicalDomain,
    allowedDomains: row.allowedDomains,
    playbook: row.playbook,
  };
}

/**
 * Persist an imported config (UNTRUSTED → 'pending') then scan it. The returned institution reflects the
 * final scanStatus. A scan error leaves it 'pending' with the error surfaced in `scan.reason`.
 */
export async function importInstitution(
  db: Db,
  input: InstitutionInput,
  scan: ConfigScanner = scanConfigForMalice,
): Promise<ImportOutcome> {
  return importInstitutionWithPersistence(
    postgresInstitutionPersistence(db),
    input,
    scan,
  );
}

export async function importInstitutionWithPersistence(
  persistence: InstitutionConfigPersistence,
  input: InstitutionInput,
  scan: ConfigScanner = scanConfigForMalice,
  ownerSubject: string | null = null,
): Promise<ImportOutcome> {
  const row = await persistence.createInstitutionConfig(
    input,
    'imported',
    'pending',
    ownerSubject,
  );
  let result: MaliceScanResult;
  try {
    result = await scan(scanInputFor(row));
  } catch (err) {
    // Fail-closed: the config stays 'pending' (the run gate blocks it). Operator re-scans once the model is
    // reachable. Never mark passed. The error message is safe to surface (it carries no playbook/data).
    const message = err instanceof Error ? err.message : String(err);
    return {
      institution: row,
      scan: {
        status: 'pending',
        reason: `scan could not complete (${message}) — saved as pending; blocked until a successful re-scan`,
        outcome: 'unavailable',
      },
    };
  }
  const updated = await persistence.setInstitutionScanStatus(
    row.id,
    result.verdict,
    institutionScanFingerprint(row),
    ownerSubject == null
      ? { kind: 'public' }
      : { kind: 'owned', ownerSubject },
  );
  if (updated.status === 'not_found') {
    throw new ConfigImportError(CONTROL_PLANE_INSTITUTION_COPY.notFound);
  }
  if (updated.status === 'stale') {
    return {
      institution: updated.institution,
      scan: {
        status: updated.institution.scanStatus,
        reason: CONTROL_PLANE_INSTITUTION_COPY.safetyCheckStale,
        outcome: 'stale',
      },
    };
  }
  return {
    institution: updated.institution,
    scan: {
      status: result.verdict,
      reason: result.reason,
      outcome: 'completed',
    },
  };
}

/**
 * Re-run the malice-scan on an existing config (e.g. after the operator reviewed/edited it, or the scan model
 * became reachable). Returns null if the id doesn't exist. On a SUCCESSFUL scan the verdict is written; on a
 * scan ERROR the existing status is left UNCHANGED (a transient model failure never distrusts a config that
 * previously passed — nor trusts one that didn't).
 */
export async function rescanInstitution(
  db: Db,
  id: string,
  scan: ConfigScanner = scanConfigForMalice,
): Promise<ImportOutcome | null> {
  return rescanInstitutionWithPersistence(
    postgresInstitutionPersistence(db),
    id,
    scan,
  );
}

export async function rescanInstitutionWithPersistence(
  persistence: InstitutionConfigPersistence,
  id: string,
  scan: ConfigScanner = scanConfigForMalice,
  access: InstitutionAccess = { kind: 'public' },
): Promise<ImportOutcome | null> {
  const inst = await persistence.getInstitution(id, access);
  if (!inst) return null;
  let result: MaliceScanResult;
  try {
    result = await scan(scanInputFor(inst));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      institution: inst,
      scan: {
        status: inst.scanStatus,
        reason: `scan could not complete (${message}) — status unchanged (${inst.scanStatus})`,
        outcome: 'unavailable',
      },
    };
  }
  const updated = await persistence.setInstitutionScanStatus(
    id,
    result.verdict,
    institutionScanFingerprint(inst),
    access,
  );
  if (updated.status === 'not_found') return null;
  if (updated.status === 'stale') {
    return {
      institution: updated.institution,
      scan: {
        status: updated.institution.scanStatus,
        reason: CONTROL_PLANE_INSTITUTION_COPY.safetyCheckStale,
        outcome: 'stale',
      },
    };
  }
  return {
    institution: updated.institution,
    scan: {
      status: result.verdict,
      reason: result.reason,
      outcome: 'completed',
    },
  };
}

// ─── Import-by-URL / subscription list ──────────────────────────────────────

/** A JSON payload / individual config the URL import couldn't accept (bad JSON, schema-invalid, or an import
 *  error like a duplicate id). Non-fatal for a subscription list — the valid configs still import. */
export class ConfigImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigImportError';
  }
}

/** Cap the number of configs a single subscription URL can push in one import (a hostile/huge list can't fan
 *  out into unbounded scan/DB work). */
export const MAX_CONFIGS_PER_IMPORT = 200;

/** Validates one raw parsed object into an InstitutionInput. Supplied by the route (owns the zod schema), so
 *  the orchestration stays schema-agnostic and testable. */
export type ConfigValidator = (raw: unknown) => { ok: true; data: InstitutionInput } | { ok: false; error: string };

export interface ImportUrlDeps {
  scan?: ConfigScanner;
  validate: ConfigValidator;
  /** Test seam: swap the guarded fetch (defaults to the real SSRF-guarded https fetch). */
  fetchText?: (url: string) => Promise<string>;
}

export interface ImportUrlResult {
  imported: ImportOutcome[];
  failed: { index: number; id?: string; error: string }[];
}

/**
 * Import one config or a subscription LIST from an operator-supplied URL. The fetch is SSRF-guarded
 * (https-only, private-address-blocked, no redirects, size/time capped). The body is JSON: a single config
 * object OR an array of them. Each config is validated then scanned+imported independently — one bad entry in
 * a list doesn't abort the rest (it lands in `failed`). Throws ConfigImportError/SsrfError for whole-payload
 * problems (bad URL, blocked address, non-JSON, empty, over the count cap).
 */
export async function importConfigsFromUrl(db: Db, url: string, deps: ImportUrlDeps): Promise<ImportUrlResult> {
  return importConfigsFromUrlWithPersistence(
    postgresInstitutionPersistence(db),
    url,
    deps,
  );
}

export async function importConfigsFromUrlWithPersistence(
  persistence: InstitutionConfigPersistence,
  url: string,
  deps: ImportUrlDeps,
  ownerSubject: string | null = null,
): Promise<ImportUrlResult> {
  const fetchText = deps.fetchText ?? fetchTextFromUrl;
  const text = await fetchText(url); // SsrfError propagates (bad scheme / blocked address / redirect / oversize)

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ConfigImportError('fetched content is not valid JSON');
  }
  const raws = Array.isArray(parsed) ? parsed : [parsed];
  if (raws.length === 0) throw new ConfigImportError('no configs found at the URL');
  if (raws.length > MAX_CONFIGS_PER_IMPORT) {
    throw new ConfigImportError(`subscription has ${raws.length} configs (max ${MAX_CONFIGS_PER_IMPORT} per import)`);
  }

  const imported: ImportOutcome[] = [];
  const failed: ImportUrlResult['failed'] = [];
  for (let i = 0; i < raws.length; i++) {
    const v = deps.validate(raws[i]);
    if (!v.ok) {
      failed.push({ index: i, error: v.error });
      continue;
    }
    try {
      imported.push(await importInstitutionWithPersistence(
        persistence,
        v.data,
        deps.scan,
        ownerSubject,
      ));
    } catch (err) {
      // e.g. duplicate id (23505) or an invalid loginUrl — record and keep importing the rest of the list.
      failed.push({ index: i, id: v.data.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { imported, failed };
}
