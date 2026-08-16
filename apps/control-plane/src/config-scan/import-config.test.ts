import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import type { Db } from '../db/client';
import {
  ConfigImportError,
  importConfigsFromUrl,
  importInstitution,
  importInstitutionWithPersistence,
  MAX_CONFIGS_PER_IMPORT,
  rescanInstitution,
  rescanInstitutionWithPersistence,
  type ConfigScanner,
  type ConfigValidator,
  type InstitutionConfigPersistence,
} from './import-config';
import { SsrfError } from '../lib/ssrf';
import {
  deleteInstitution,
  getInstitution,
  updateInstitution,
} from '../data/institutions';

describe('config import + malice-scan orchestration (pglite)', () => {
  let client: PGlite;
  let db: Db;

  beforeAll(async () => {
    client = new PGlite();
    db = drizzle(client, { schema }) as unknown as Db;
    const dir = path.resolve(__dirname, '../../migrations');
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
      await client.exec(fs.readFileSync(path.join(dir, f), 'utf8'));
    }
  });
  afterAll(async () => { await client.close(); });
  beforeEach(async () => { await client.exec('truncate institutions cascade'); });

  const cfg = (id: string) => ({ id, name: 'Imported Bank', loginUrl: 'https://login.imported.com/', type: 'bank' as const, playbook: 'read only' });
  const pass: ConfigScanner = vi.fn(async () => ({ verdict: 'passed' as const, reason: 'read-only' }));
  const fail: ConfigScanner = vi.fn(async () => ({ verdict: 'failed' as const, reason: 'moves money' }));
  const boom: ConfigScanner = vi.fn(async () => { throw new Error('gemini down'); });

  it('import stores as UNTRUSTED (imported/pending) then records a passing scan verdict', async () => {
    const scan = vi.fn(pass);
    const out = await importInstitution(db, cfg('imp-ok'), scan);
    expect(out.institution.source).toBe('imported');
    expect(out.institution.scanStatus).toBe('passed');
    expect(out.scan).toEqual({
      status: 'passed',
      reason: 'read-only',
      outcome: 'completed',
    });
    // The scanner saw the SERVER-DERIVED canonical domain, never a caller-supplied one.
    expect(scan).toHaveBeenCalledWith(expect.objectContaining({ canonicalDomain: 'imported.com', name: 'Imported Bank' }));
    // Persisted status matches.
    expect((await getInstitution(db, 'imp-ok'))?.scanStatus).toBe('passed');
  });

  it('import records a FAILED scan verdict (config stored but not runnable)', async () => {
    const out = await importInstitution(db, cfg('imp-bad'), fail);
    expect(out.institution.scanStatus).toBe('failed');
    expect(out.scan.status).toBe('failed');
    expect(out.scan.outcome).toBe('completed');
    expect((await getInstitution(db, 'imp-bad'))?.scanStatus).toBe('failed');
  });

  it('FAIL-CLOSED: a scan error leaves the imported config as PENDING (never passed)', async () => {
    const out = await importInstitution(db, cfg('imp-err'), boom);
    expect(out.institution.scanStatus).toBe('pending');
    expect(out.scan.status).toBe('pending');
    expect(out.scan.outcome).toBe('unavailable');
    expect(out.scan.reason).toMatch(/scan could not complete/);
    expect((await getInstitution(db, 'imp-err'))?.scanStatus).toBe('pending');
  });

  it('rescan updates the verdict on a successful scan (pending -> passed)', async () => {
    await importInstitution(db, cfg('imp-rescan'), boom); // lands pending
    const out = await rescanInstitution(db, 'imp-rescan', pass);
    expect(out?.scan.status).toBe('passed');
    expect(out?.scan.outcome).toBe('completed');
    expect((await getInstitution(db, 'imp-rescan'))?.scanStatus).toBe('passed');
  });

  it('rescan does NOT downgrade an existing verdict when the scan model errors (transient failure is not distrust)', async () => {
    await importInstitution(db, cfg('imp-keep'), pass); // lands passed
    const out = await rescanInstitution(db, 'imp-keep', boom);
    expect(out?.scan.status).toBe('passed'); // unchanged
    expect(out?.scan.outcome).toBe('unavailable');
    expect(out?.scan.reason).toMatch(/status unchanged/);
    expect((await getInstitution(db, 'imp-keep'))?.scanStatus).toBe('passed');
  });

  it('surfaces persistence failures instead of misreporting scanner unavailability', async () => {
    const row = (await importInstitution(db, cfg('imp-storage'), boom))
      .institution;
    const persistence: InstitutionConfigPersistence = {
      createInstitutionConfig: async () => row,
      getInstitution: async () => row,
      setInstitutionScanStatus: async () => {
        throw new Error('database write unavailable');
      },
    };

    await expect(importInstitutionWithPersistence(
      persistence,
      cfg('imp-storage'),
      pass,
      'owner',
    )).rejects.toThrow('database write unavailable');
    await expect(rescanInstitutionWithPersistence(
      persistence,
      row.id,
      pass,
      { kind: 'owned', ownerSubject: 'owner' },
    )).rejects.toThrow('database write unavailable');
  });

  it('rescan returns null for a missing institution', async () => {
    expect(await rescanInstitution(db, 'nope', pass)).toBeNull();
  });

  it('discards a stale passing verdict when the institution changes during its Safety check', async () => {
    let markScanStarted!: () => void;
    let finishScan!: () => void;
    const scanStarted = new Promise<void>((resolve) => {
      markScanStarted = resolve;
    });
    const scanMayFinish = new Promise<void>((resolve) => {
      finishScan = resolve;
    });
    const delayedPass: ConfigScanner = vi.fn(async () => {
      markScanStarted();
      await scanMayFinish;
      return { verdict: 'passed', reason: 'read-only' };
    });

    const importing = importInstitution(db, cfg('imp-race'), delayedPass);
    await scanStarted;
    await updateInstitution(db, 'imp-race', {
      playbook: 'transfer money',
    });
    finishScan();

    const out = await importing;
    expect(out.institution).toMatchObject({
      playbook: 'transfer money',
      scanStatus: 'pending',
    });
    expect(out.scan).toEqual({
      status: 'pending',
      reason:
        'The institution changed while the Safety check was running. Run the Safety check again.',
      outcome: 'stale',
    });
    expect((await getInstitution(db, 'imp-race'))?.scanStatus).toBe('pending');
  });

  it('reports a missing institution when it is deleted during its Safety check', async () => {
    let markScanStarted!: () => void;
    let finishScan!: () => void;
    const scanStarted = new Promise<void>((resolve) => {
      markScanStarted = resolve;
    });
    const scanMayFinish = new Promise<void>((resolve) => {
      finishScan = resolve;
    });
    const delayedPass: ConfigScanner = vi.fn(async () => {
      markScanStarted();
      await scanMayFinish;
      return { verdict: 'passed', reason: 'read-only' };
    });

    const importing = importInstitution(db, cfg('imp-deleted'), delayedPass);
    await scanStarted;
    expect(await deleteInstitution(db, 'imp-deleted')).toBe(true);
    finishScan();

    await expect(importing).rejects.toThrow('institution not found');
  });

  // ── import-by-URL / subscription list ──────────────────────────────────────
  const validate: ConfigValidator = (raw) => {
    const r = raw as Record<string, unknown>;
    return r && typeof r.id === 'string' && typeof r.name === 'string' && typeof r.loginUrl === 'string' && typeof r.type === 'string'
      ? { ok: true, data: r as never }
      : { ok: false, error: 'invalid config' };
  };
  const fetchReturning = (json: unknown | string) => async () => (typeof json === 'string' ? json : JSON.stringify(json));

  it('imports a SINGLE config object from a URL (scanned, imported/pending→passed)', async () => {
    const out = await importConfigsFromUrl(db, 'https://feed.example/one.json', {
      scan: pass, validate, fetchText: fetchReturning({ id: 'u1', name: 'One', loginUrl: 'https://login.one.com/', type: 'bank', playbook: 'read' }),
    });
    expect(out.imported).toHaveLength(1);
    expect(out.failed).toHaveLength(0);
    expect(out.imported[0].institution.source).toBe('imported');
    expect(out.imported[0].scan.status).toBe('passed');
    expect((await getInstitution(db, 'u1'))?.scanStatus).toBe('passed');
  });

  it('imports an ARRAY (subscription list); a schema-invalid entry lands in `failed` without aborting the rest', async () => {
    const out = await importConfigsFromUrl(db, 'https://feed.example/list.json', {
      scan: pass, validate,
      fetchText: fetchReturning([
        { id: 'u2', name: 'Two', loginUrl: 'https://login.two.com/', type: 'bank' },
        { name: 'no-id-here' }, // invalid → failed
        { id: 'u3', name: 'Three', loginUrl: 'https://login.three.com/', type: 'broker' },
      ]),
    });
    expect(out.imported.map((o) => o.institution.id).sort()).toEqual(['u2', 'u3']);
    expect(out.failed).toEqual([{ index: 1, error: 'invalid config' }]);
  });

  it('a per-config import error (duplicate id) is captured in `failed`, not thrown', async () => {
    await importInstitution(db, cfg('dup'), pass); // pre-existing
    const out = await importConfigsFromUrl(db, 'https://feed.example/dup.json', {
      scan: pass, validate, fetchText: fetchReturning([{ id: 'dup', name: 'Dup', loginUrl: 'https://login.dup.com/', type: 'bank' }]),
    });
    expect(out.imported).toHaveLength(0);
    expect(out.failed[0]).toMatchObject({ index: 0, id: 'dup' });
  });

  it('throws ConfigImportError on non-JSON, empty array, and over the count cap', async () => {
    await expect(importConfigsFromUrl(db, 'https://f/x', { scan: pass, validate, fetchText: fetchReturning('<html>not json</html>') })).rejects.toBeInstanceOf(ConfigImportError);
    await expect(importConfigsFromUrl(db, 'https://f/x', { scan: pass, validate, fetchText: fetchReturning([]) })).rejects.toThrow(/no configs/);
    const tooMany = Array.from({ length: MAX_CONFIGS_PER_IMPORT + 1 }, (_, i) => ({ id: `x${i}`, name: 'X', loginUrl: 'https://x.com/', type: 'bank' }));
    await expect(importConfigsFromUrl(db, 'https://f/x', { scan: pass, validate, fetchText: fetchReturning(tooMany) })).rejects.toThrow(/max/);
  });

  it('propagates an SsrfError from the guarded fetch (blocked/redirect/bad-scheme URL)', async () => {
    const blocked = async () => { throw new SsrfError('https://evil resolves to a blocked address (169.254.169.254)'); };
    await expect(importConfigsFromUrl(db, 'https://evil/x', { scan: pass, validate, fetchText: blocked })).rejects.toBeInstanceOf(SsrfError);
  });
});
