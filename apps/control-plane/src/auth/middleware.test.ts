import { describe, it, expect, vi, beforeEach } from 'vitest';

// Unit-test the auth DECISION MATRIX for requireOperatorOrApiKey without a DB: mock the two verifiers it
// calls (keyHasScope stays real — it's a pure scope-membership check). The route WIRING (grant enforcement,
// 401 on no creds) is covered by the integration tests in routes/crawl.test.ts.
vi.mock('../db/client', () => ({ db: {} }));
vi.mock('./operator', () => ({ verifyOperatorToken: vi.fn() }));
vi.mock('../data/devices', () => ({ verifyDeviceToken: vi.fn() }));
vi.mock('./apiKeys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./apiKeys')>();
  return { ...actual, verifyApiKey: vi.fn() };
});

import {
  requireOperatorOrApiKey,
  requireOperatorOrDevice,
  requireOperatorOrPublicApiKey,
} from './middleware';
import { verifyOperatorToken } from './operator';
import { verifyApiKey } from './apiKeys';
import { verifyDeviceToken } from '../data/devices';

function ctx(authHeader?: string, method = 'GET') {
  const req = { method, headers: authHeader ? { authorization: authHeader } : {} } as Record<string, unknown> & { operator?: boolean; apiKey?: { id: string } };
  const out: { code?: number; body?: unknown } = {};
  const reply = { code(c: number) { out.code = c; return reply; }, send(b: unknown) { out.body = b; return reply; } };
  return { req, reply, out };
}

describe('requireOperatorOrApiKey (auth decision matrix)', () => {
  const mw = requireOperatorOrApiKey('read:companion') as unknown as (req: unknown, reply: unknown) => Promise<void>;
  beforeEach(() => { vi.mocked(verifyOperatorToken).mockReset(); vi.mocked(verifyApiKey).mockReset(); });

  it('accepts a valid operator token, sets req.operator, does not consult api keys', async () => {
    vi.mocked(verifyOperatorToken).mockResolvedValue(true);
    const { req, reply, out } = ctx('Bearer op');
    await mw(req, reply);
    expect(req.operator).toBe(true);
    expect(req.apiKey).toBeUndefined();
    expect(out.code).toBeUndefined(); // no rejection
    expect(verifyApiKey).not.toHaveBeenCalled();
  });

  it('accepts an api key that HOLDS the required scope, sets req.apiKey (not operator)', async () => {
    vi.mocked(verifyOperatorToken).mockResolvedValue(false);
    vi.mocked(verifyApiKey).mockResolvedValue({ id: 'k1', scopes: ['read:companion'], connectionGrants: ['*'] });
    const { req, reply, out } = ctx('Bearer acck_x');
    await mw(req, reply);
    expect(req.apiKey?.id).toBe('k1');
    expect(req.operator).toBeUndefined();
    expect(out.code).toBeUndefined();
  });

  it('rejects an api key MISSING the required scope (403) and never sets req.apiKey', async () => {
    vi.mocked(verifyOperatorToken).mockResolvedValue(false);
    vi.mocked(verifyApiKey).mockResolvedValue({ id: 'k1', scopes: ['read:data'], connectionGrants: ['*'] });
    const { req, reply, out } = ctx('Bearer acck_x');
    await mw(req, reply);
    expect(out.code).toBe(403);
    expect(req.apiKey).toBeUndefined();
  });

  it('rejects an unknown / invalid / revoked token (401)', async () => {
    vi.mocked(verifyOperatorToken).mockResolvedValue(false);
    vi.mocked(verifyApiKey).mockResolvedValue(null);
    const { req, reply, out } = ctx('Bearer bad');
    await mw(req, reply);
    expect(out.code).toBe(401);
  });

  it('rejects an OAuth access token on an internal API', async () => {
    vi.mocked(verifyOperatorToken).mockResolvedValue(false);
    vi.mocked(verifyApiKey).mockResolvedValue({
      id: 'oauth-key',
      oauthGrantId: 'grant-1',
      scopes: ['read:companion'],
      connectionGrants: ['*'],
    } as never);
    const { req, reply, out } = ctx('Bearer acck_oauth');
    await mw(req, reply);
    expect(out.code).toBe(404);
    expect(req.apiKey).toBeUndefined();
  });

  it('rejects a missing Authorization header (401) without hitting either verifier', async () => {
    const { req, reply, out } = ctx();
    await mw(req, reply);
    expect(out.code).toBe(401);
    expect(verifyOperatorToken).not.toHaveBeenCalled();
    expect(verifyApiKey).not.toHaveBeenCalled();
  });
});

describe('requireOperatorOrPublicApiKey', () => {
  const mw = requireOperatorOrPublicApiKey('read:data') as unknown as (
    req: unknown,
    reply: unknown,
  ) => Promise<void>;
  beforeEach(() => { vi.mocked(verifyOperatorToken).mockReset(); vi.mocked(verifyApiKey).mockReset(); });

  it('accepts an OAuth access token on the documented public API', async () => {
    vi.mocked(verifyOperatorToken).mockResolvedValue(false);
    vi.mocked(verifyApiKey).mockResolvedValue({
      id: 'oauth-key',
      oauthGrantId: 'grant-1',
      scopes: ['read:data'],
      connectionGrants: ['connection-1'],
    } as never);
    const { req, reply, out } = ctx('Bearer acck_oauth');
    await mw(req, reply);
    expect(out.code).toBeUndefined();
    expect(req.apiKey?.id).toBe('oauth-key');
  });

  // The public API reads already-retrieved data; it never writes. The guard itself refuses a write method,
  // so a future route cannot turn a consumer credential into a write by picking the wrong preHandler.
  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('refuses %s outright (405) — before authenticating anything', async (method) => {
    const { req, reply, out } = ctx('Bearer acck_oauth', method);
    await mw(req, reply);
    expect(out.code).toBe(405);
    expect(verifyOperatorToken).not.toHaveBeenCalled();
    expect(verifyApiKey).not.toHaveBeenCalled();
  });
});

// A one-time passcode is part of HOW a crawl gets in, so the OTP surface takes the operator or the owner's
// own paired device — never an API credential, manual or OAuth.
describe('requireOperatorOrDevice (the OTP surface)', () => {
  const mw = requireOperatorOrDevice as unknown as (req: unknown, reply: unknown) => Promise<void>;
  beforeEach(() => {
    vi.mocked(verifyOperatorToken).mockReset();
    vi.mocked(verifyDeviceToken).mockReset();
    vi.mocked(verifyApiKey).mockReset();
  });

  it('accepts the operator (does not consult device or api key)', async () => {
    vi.mocked(verifyOperatorToken).mockResolvedValue(true);
    const { req, reply, out } = ctx('Bearer op', 'POST');
    await mw(req, reply);
    expect(req.operator).toBe(true);
    expect(out.code).toBeUndefined();
    expect(verifyDeviceToken).not.toHaveBeenCalled();
    expect(verifyApiKey).not.toHaveBeenCalled();
  });

  it('accepts a paired device', async () => {
    vi.mocked(verifyOperatorToken).mockResolvedValue(false);
    vi.mocked(verifyDeviceToken).mockResolvedValue({ id: 'd1' } as never);
    const { req, reply, out } = ctx('Bearer acdv_x', 'POST');
    await mw(req, reply);
    expect((req as { device?: { id: string } }).device?.id).toBe('d1');
    expect(out.code).toBeUndefined();
  });

  it('REFUSES an api key, however scoped, and never consults one (401)', async () => {
    vi.mocked(verifyOperatorToken).mockResolvedValue(false);
    vi.mocked(verifyDeviceToken).mockResolvedValue(null);
    const { req, reply, out } = ctx('Bearer acck_x', 'POST');
    await mw(req, reply);
    expect(out.code).toBe(401);
    expect(req.apiKey).toBeUndefined();
    expect(verifyApiKey).not.toHaveBeenCalled();
  });

  it('rejects an unknown token (401) and a missing header (401)', async () => {
    vi.mocked(verifyOperatorToken).mockResolvedValue(false);
    vi.mocked(verifyDeviceToken).mockResolvedValue(null);
    const bad = ctx('Bearer bad', 'POST');
    await mw(bad.req, bad.reply);
    expect(bad.out.code).toBe(401);
    const none = ctx(undefined, 'POST');
    await mw(none.req, none.reply);
    expect(none.out.code).toBe(401);
  });
});
