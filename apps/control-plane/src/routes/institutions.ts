/**
 * Institution catalogue routes. canonicalDomain is derived server-side from loginUrl — never
 * accepted from the client — so a config can't misrepresent its login domain.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { institutions } from '../db/schema';
import {
  requireInstitutionActor,
  requirePlatformAdmin,
} from '../auth/middleware';
import {
  InvalidLoginUrlError,
  InsecureLoginUrlError,
  InvalidAllowedDomainError,
  publishedInstitutionId,
  type InstitutionRow,
} from '../data/institutions';
import {
  importInstitutionWithPersistence,
  rescanInstitutionWithPersistence,
  importConfigsFromUrlWithPersistence,
  ConfigImportError,
  type ConfigScanner,
} from '../config-scan/import-config';
import { SsrfError } from '../lib/ssrf';
import { draftInstitutionConfig } from '../authoring/draft-config';
import { MAX_CRAWL_SECONDS } from '../lib/crawl-budget';
import { getUserDataStore } from '../storage';
import { InstitutionConfigAlreadyExistsError } from '../storage/user-data-store';
import type { InstitutionAccess } from '../storage/user-data-store';
import { requireOperatorSubject } from '../auth/subjects';
import { CONTROL_PLANE_INSTITUTION_COPY } from '../institution-copy';

const baseFields = {
  name: z.string().min(1).max(200),
  loginUrl: z.string().url(),
  type: z.enum(institutions.type.enumValues),
  country: z.string().max(8).optional(),
  logo: z.string().url().optional(),
  allowedDomains: z.array(z.string().max(253)).max(50).optional(),
  playbook: z.string().max(20000).optional(),
  requires2fa: z.boolean().optional(),
  otpSenderPattern: z.string().max(200).optional(),
  useDeviceProxy: z.boolean().optional(),
  // Nullable so a PATCH can clear a per-institution override back to the engine default.
  model: z.string().max(100).nullable().optional(),
  thinkingLevel: z.enum(['minimal', 'low', 'medium', 'high']).nullable().optional(),
  maxSteps: z.number().int().positive().max(1000).optional(),
  timeoutSeconds: z.number().int().positive().max(MAX_CRAWL_SECONDS).optional(),
  transactionLookbackDays: z.number().int().nonnegative().max(3650).optional(),
};
const createSchema = z.object({ id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/), ...baseFields });
const updateSchema = z.object(baseFields).partial();

/** Route deps (injectable for tests). `scanConfig` swaps the live Gemini malice-scanner; `fetchText` swaps
 *  the SSRF-guarded URL fetch so the import-by-URL wire path can be driven from a local test server. */
export interface InstitutionRoutesOpts {
  scanConfig?: ConfigScanner;
  fetchText?: (url: string) => Promise<string>;
}

type InstitutionView = Omit<InstitutionRow, 'ownerSubject' | 'catalogKey'> & {
  visibility: 'published' | 'private';
  ownedByViewer: boolean;
  canManage: boolean;
  canPublish: boolean;
};

function actorAccess(
  req: FastifyRequest,
  ownerMode: 'visible' | 'owned',
): InstitutionAccess {
  if (req.platformAdmin) return { kind: 'all' };
  return { kind: ownerMode, ownerSubject: requireOperatorSubject(req) };
}

function institutionView(
  req: FastifyRequest,
  row: InstitutionRow,
  canPublish =
    req.platformAdmin === true
    && row.ownerSubject != null
    && row.scanStatus === 'passed',
): InstitutionView {
  const { ownerSubject, catalogKey: _catalogKey, ...safe } = row;
  return {
    ...safe,
    visibility: ownerSubject == null ? 'published' : 'private',
    ownedByViewer: ownerSubject != null && ownerSubject === req.operatorSubject,
    canManage: req.platformAdmin === true || ownerSubject === req.operatorSubject,
    canPublish,
  };
}

async function institutionViewWithPublicationState(
  req: FastifyRequest,
  store: Awaited<ReturnType<typeof getUserDataStore>>,
  row: InstitutionRow,
): Promise<InstitutionView> {
  if (
    !req.platformAdmin
    || row.ownerSubject == null
    || row.scanStatus !== 'passed'
  ) {
    return institutionView(req, row, false);
  }
  const published = await store.getInstitution(
    publishedInstitutionId(row.id),
    { kind: 'all' },
  );
  return institutionView(req, row, published == null);
}

export async function institutionRoutes(app: FastifyInstance, opts: InstitutionRoutesOpts = {}): Promise<void> {
  const scanConfig = opts.scanConfig;
  const validateConfig = (raw: unknown) => {
    const p = createSchema.safeParse(raw);
    return p.success ? { ok: true as const, data: p.data } : { ok: false as const, error: p.error.message };
  };
  app.post('/api/institutions', { preHandler: requireInstitutionActor }, async (req, reply) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    try {
      // Creation is private for every authenticated person, including a
      // catalogue manager. Publishing is an explicit, separate copy operation.
      const ownerSubject = requireOperatorSubject(req);
      const store = await getUserDataStore();
      const row = await store.createInstitutionConfig(
        parsed.data,
        'local',
        'passed',
        ownerSubject,
      );
      await store.writeAudit({
        actorType: 'operator',
        actorId: req.operatorSubject,
        action: 'institution.create',
        targetType: 'institution',
        targetId: row.id,
        sourceIp: req.ip,
      });
      return reply.code(201).send(institutionView(req, row));
    } catch (err) {
      if (err instanceof InvalidLoginUrlError || err instanceof InsecureLoginUrlError || err instanceof InvalidAllowedDomainError) return reply.code(400).send({ error: err.message });
      if (err instanceof InstitutionConfigAlreadyExistsError) return reply.code(409).send({ error: err.message });
      throw err;
    }
  });

  app.get('/api/institutions', { preHandler: requireInstitutionActor }, async (req) => {
    const rows = await (await getUserDataStore()).listInstitutions(
      actorAccess(req, 'visible'),
    );
    const ids = new Set(rows.map((row) => row.id));
    return {
      institutions: rows.map((row) => institutionView(
        req,
        row,
        req.platformAdmin === true
          && row.ownerSubject != null
          && row.scanStatus === 'passed'
          && !ids.has(publishedInstitutionId(row.id)),
      )),
    };
  });

  app.get('/api/institutions/:id', { preHandler: requireInstitutionActor }, async (req, reply) => {
    const store = await getUserDataStore();
    const row = await store.getInstitution(
      (req.params as { id: string }).id,
      actorAccess(req, 'visible'),
    );
    return row
      ? institutionViewWithPublicationState(req, store, row)
      : reply.code(404).send({ error: 'institution not found' });
  });

  app.patch('/api/institutions/:id', { preHandler: requireInstitutionActor }, async (req, reply) => {
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    try {
      const store = await getUserDataStore();
      const row = await store.updateInstitutionConfig(
        (req.params as { id: string }).id,
        parsed.data,
        actorAccess(req, 'owned'),
      );
      if (row) {
        await store.writeAudit({
          actorType: 'operator',
          actorId: req.operatorSubject,
          action: 'institution.update',
          targetType: 'institution',
          targetId: row.id,
          sourceIp: req.ip,
        });
      }
      return row
        ? institutionViewWithPublicationState(req, store, row)
        : reply.code(404).send({ error: 'institution not found' });
    } catch (err) {
      if (err instanceof InvalidLoginUrlError || err instanceof InsecureLoginUrlError || err instanceof InvalidAllowedDomainError) return reply.code(400).send({ error: err.message });
      throw err;
    }
  });

  app.delete('/api/institutions/:id', { preHandler: requireInstitutionActor }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const store = await getUserDataStore();
    const result = await store.deleteInstitutionConfig(
      id,
      actorAccess(req, 'owned'),
    );
    if (result === 'not_found') {
      return reply.code(404).send({ error: 'institution not found' });
    }
    if (result === 'in_use') {
      return reply.code(409).send({
        error: 'institution still has connections; remove them first',
      });
    }
    await store.writeAudit({
      actorType: 'operator',
      actorId: req.operatorSubject,
      action: 'institution.delete',
      targetType: 'institution',
      targetId: id,
      sourceIp: req.ip,
    });
    return reply.code(204).send();
  });

  // Publishing never changes a user's row in place. A platform-authorized
  // caller creates an independent public copy that users can consume but
  // cannot edit.
  app.post('/api/institutions/:id/publish', { preHandler: requirePlatformAdmin }, async (req, reply) => {
    const store = await getUserDataStore();
    const result = await store.publishInstitutionConfig(
      (req.params as { id: string }).id,
    );
    if (result.status === 'not_found') return reply.code(404).send();
    if (result.status === 'already_published') {
      return reply.code(409).send({
        code: 'institution_already_published',
        error: 'This institution is already published.',
      });
    }
    if (result.status === 'scan_required') {
      return reply.code(409).send({
        code: 'institution_publish_scan_required',
        error:
          'Resolve any Safety check issues, then wait for it to pass before you Publish a copy.',
      });
    }
    if (result.status === 'copy_exists') {
      return reply.code(409).send({
        code: 'institution_publish_copy_exists',
        error: `A published copy of ${result.institutionName} already exists in this Accrawl workspace.`,
      });
    }
    await store.writeAudit({
      actorType: 'operator',
      actorId: req.operatorSubject,
      action: 'institution.publish',
      targetType: 'institution',
      targetId: result.institution.id,
      sourceIp: req.ip,
    });
    return reply.code(201).send(institutionView(req, result.institution));
  });

  // Import an UNTRUSTED community config: it is stored as source 'imported' / scanStatus 'pending', then run
  // through the LLM malice-scan. It cannot run any crawl until the scan passes (run-crawl.ts gate) AND a
  // connection's login domain is operator-verified (anti-phishing). The response carries the scan verdict so
  // the operator sees immediately whether the import is runnable or was flagged. (URL/subscription fetch is a
  // follow-on; this takes the config inline.)
  app.post('/api/institutions/import', { preHandler: requirePlatformAdmin }, async (req, reply) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    try {
      const store = await getUserDataStore();
      const outcome = await importInstitutionWithPersistence(
        store,
        parsed.data,
        scanConfig,
        requireOperatorSubject(req),
      );
      await store.writeAudit({
        actorType: 'operator', actorId: req.operatorSubject, action: 'institution.import', targetType: 'institution',
        targetId: outcome.institution.id, sourceIp: req.ip,
      });
      return reply.code(201).send({
        institution: institutionView(req, outcome.institution),
        scan: outcome.scan,
      });
    } catch (err) {
      if (err instanceof InvalidLoginUrlError || err instanceof InsecureLoginUrlError || err instanceof InvalidAllowedDomainError) return reply.code(400).send({ error: err.message });
      if (err instanceof InstitutionConfigAlreadyExistsError) return reply.code(409).send({ error: err.message });
      if (err instanceof ConfigImportError
        && err.message === CONTROL_PLANE_INSTITUTION_COPY.notFound) {
        return reply.code(404).send({
          error: CONTROL_PLANE_INSTITUTION_COPY.notFound,
        });
      }
      throw err;
    }
  });

  // Authoring aid: AI-draft an initial config for a new institution from a light recon of its login page.
  // Returns a DRAFT (playbook + hints + 2FA guess) for the operator to review/edit/refine — it is NOT saved
  // or run. The recon fetch is SSRF-guarded; a recon failure degrades to a metadata-only draft.
  app.post('/api/institutions/draft', { preHandler: requirePlatformAdmin }, async (req, reply) => {
    const parsed = z.object({
      name: z.string().min(1).max(200),
      loginUrl: z.string().url(),
      type: z.enum(institutions.type.enumValues),
      country: z.string().max(8).optional(),
    }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    try {
      const result = await draftInstitutionConfig(parsed.data);
      await (await getUserDataStore()).writeAudit({ actorType: 'operator', actorId: req.operatorSubject, action: 'institution.draft', targetType: 'institution', sourceIp: req.ip });
      return result; // { draft, reconNote }
    } catch (err) {
      // The model call failed (missing GEMINI_API_KEY / API error) — surface as a 502 (upstream unavailable),
      // never a 500. Recon failures don't reach here (they degrade to a metadata-only draft inside the drafter).
      return reply.code(502).send({ error: `draft unavailable: ${err instanceof Error ? err.message : String(err)}` });
    }
  });

  // Import a config or a SUBSCRIPTION LIST from an operator-supplied URL. The fetch is SSRF-guarded
  // (https-only, private/loopback/reserved addresses blocked, no redirects, size/time capped). Each config in
  // the payload is validated + malice-scanned + stored 'imported'/'pending' independently; one bad entry in a
  // list doesn't abort the rest. 201 if at least one imported, 422 if all failed, 400 for a whole-payload
  // problem (blocked/bad URL, non-JSON, over the count cap).
  app.post('/api/institutions/import-url', { preHandler: requirePlatformAdmin }, async (req, reply) => {
    const parsed = z.object({ url: z.string().url() }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    try {
      const store = await getUserDataStore();
      const result = await importConfigsFromUrlWithPersistence(
        store,
        parsed.data.url,
        { scan: scanConfig, validate: validateConfig, fetchText: opts.fetchText },
        requireOperatorSubject(req),
      );
      await store.writeAudit({
        actorType: 'operator', actorId: req.operatorSubject, action: 'institution.import_url', targetType: 'institution',
        targetId: parsed.data.url, sourceIp: req.ip,
      });
      return reply.code(result.imported.length > 0 ? 201 : 422).send({
        ...result,
        imported: result.imported.map((outcome) => ({
          ...outcome,
          institution: institutionView(req, outcome.institution),
        })),
      });
    } catch (err) {
      if (err instanceof SsrfError || err instanceof ConfigImportError) return reply.code(400).send({ error: err.message });
      throw err;
    }
  });

  // Re-run the malice-scan on an existing config (after the operator reviewed/edited it, or the scan model
  // became reachable). On a successful scan the verdict is written; a scan error leaves the status unchanged.
  app.post('/api/institutions/:id/rescan', { preHandler: requirePlatformAdmin }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const store = await getUserDataStore();
    const outcome = await rescanInstitutionWithPersistence(
      store,
      id,
      scanConfig,
      { kind: 'all' },
    );
    if (!outcome) return reply.code(404).send({ error: 'institution not found' });
    await store.writeAudit({
      actorType: 'operator', actorId: req.operatorSubject, action: 'institution.rescan', targetType: 'institution', targetId: id, sourceIp: req.ip,
    });
    return {
      institution: await institutionViewWithPublicationState(
        req,
        store,
        outcome.institution,
      ),
      scan: outcome.scan,
    };
  });
}
