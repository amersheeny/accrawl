import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openApiSpec, DOCUMENTED_CONSUMER_ENDPOINTS } from './spec';

/**
 * Keeps the hand-authored spec honest against the real routes. The probes are UNAUTHENTICATED: every
 * documented route's auth guard rejects a no-token request with 401 BEFORE touching the DB, so a real route
 * returns 401 and a phantom (undocumented) route returns 404 — no database is needed, and buildServer connects
 * to Postgres lazily so a dummy URL is fine.
 *
 * Coverage boundary: this proves the documented paths are REAL routes, all consumer endpoints are documented,
 * and no $ref dangles. It does NOT re-verify each endpoint's SCOPE/ownership enforcement or that a consumer
 * (not operator) can reach it — those are enforced + tested per-route in crawl.test.ts / sessions.test.ts /
 * data.test.ts (and the spec's documented scopes were cross-checked against the guards in review). An
 * API-key-accessibility probe was tried here but is inherently flaky on the pglite single-connection test
 * socket under a rapid loop of api-key auths (each fires verifyApiKey's fire-and-forget lastUsedAt write).
 */
const paths = openApiSpec.paths as Record<string, Record<string, unknown>>;

describe('OpenAPI provider spec', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    process.env.DATABASE_URL = 'postgres://localhost:1/none';
    process.env.CREDENTIAL_ENC_KEY = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
    const { buildServer } = await import('../index');
    app = await buildServer();
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    try { const { sql } = await import('../db/client'); await sql.end({ timeout: 1 }); } catch { /* never connected */ }
    delete process.env.DATABASE_URL;
    delete process.env.CREDENTIAL_ENC_KEY;
  });

  it('is structurally valid OpenAPI 3.1 with an api-key security scheme', () => {
    expect(openApiSpec.openapi).toBe('3.1.0');
    expect(openApiSpec.info.title).toBeTruthy();
    expect(Object.keys(paths).length).toBeGreaterThan(0);
    expect(openApiSpec.components.securitySchemes.apiKey.scheme).toBe('bearer');
  });

  it('is served at GET /api/openapi.json (public, no auth)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/openapi.json' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.openapi).toBe('3.1.0');
    expect(body.paths['/api/v1/connections'].get).toBeTruthy();
  });

  it('documents EVERY consumer endpoint (nothing missing from the contract)', () => {
    for (const { method, path: p } of DOCUMENTED_CONSUMER_ENDPOINTS) {
      expect(paths[p]?.[method], `${method.toUpperCase()} ${p} missing from the spec`).toBeTruthy();
    }
  });

  // The public API reads data Accrawl already retrieved. It has no write, and no crawl vocabulary —
  // starting a run, watching a session, relaying a passcode all belong to the owner's own console. This is
  // the mechanical statement of that: a documented POST, or any path naming the crawl surface, fails here.
  it('IS READ-ONLY: every documented path+method is a GET', () => {
    for (const [p, methods] of Object.entries(paths)) {
      for (const method of Object.keys(methods)) {
        expect(method, `${method.toUpperCase()} ${p} is documented, but the public API only reads`).toBe('get');
      }
    }
    for (const { method, path: p } of DOCUMENTED_CONSUMER_ENDPOINTS) {
      expect(method, `${p} is listed as a consumer endpoint with a non-GET method`).toBe('get');
    }
  });

  it('EXPOSES NO CRAWL SURFACE: no documented path reaches sessions, crawls, or syncs', () => {
    for (const p of Object.keys(paths)) {
      expect(/\/(crawl|sessions|syncs|refresh)(\/|$)/.test(p), `${p} exposes the retrieval surface`).toBe(false);
    }
  });

  it('NO PHANTOM PATHS: every documented path+method is a REAL route (inject → never 404)', async () => {
    for (const [p, methods] of Object.entries(paths)) {
      for (const method of Object.keys(methods)) {
        const url = p.replace(/\{[^}]+\}/g, 'x'); // {id} -> a dummy value
        const res = await app.inject({ method: method.toUpperCase() as 'GET' | 'POST', url });
        expect(res.statusCode, `${method.toUpperCase()} ${p} is documented but is not a registered route`).not.toBe(404);
      }
    }
  });

  it('has NO dangling $ref (every schema reference resolves)', () => {
    const defined = new Set(Object.keys(openApiSpec.components.schemas));
    const refs: string[] = [];
    const walk = (o: unknown): void => {
      if (Array.isArray(o)) { o.forEach(walk); return; }
      if (o && typeof o === 'object') {
        for (const [k, v] of Object.entries(o)) {
          if (k === '$ref' && typeof v === 'string') refs.push(v);
          else walk(v);
        }
      }
    };
    walk(openApiSpec);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      expect(ref.startsWith('#/components/schemas/'), `unexpected $ref form: ${ref}`).toBe(true);
      expect(defined.has(ref.replace('#/components/schemas/', '')), `dangling $ref: ${ref}`).toBe(true);
    }
  });
});
