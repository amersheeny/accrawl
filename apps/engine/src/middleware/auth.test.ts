import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { verifyInboundIdentity, assertInboundAuthConfig, inboundAuthMode } from './auth';
import {
  registerInboundIdentityVerifier,
  resetInboundIdentityVerifierForTest,
  type InboundIdentity,
} from './inbound-identity';

const CRAWLER_URL = 'https://accrawl-crawler.example.run.app';

interface MockRes {
  statusCode: number;
  body: unknown;
  status: (code: number) => MockRes;
  json: (body: unknown) => MockRes;
}

function makeRes(): MockRes {
  const res: MockRes = {
    statusCode: 200,
    body: undefined,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
  };
  return res;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function callMiddleware(headers: Record<string, string>): Promise<{ res: MockRes; nextCalled: boolean }> {
  const req = { headers } as any;
  const res = makeRes();
  let nextCalled = false;
  const next = () => {
    nextCalled = true;
  };
  return verifyInboundIdentity(req, res as any, next).then(() => ({ res, nextCalled }));
}

/** A verifier stands in for whatever issues caller identities here; these cases are about what the
 *  engine does with the answer, not about how a signature is checked (see inbound-identity.test.ts). */
const verify = vi.fn<(token: string, audience: string | undefined) => Promise<InboundIdentity>>();

function clearAuthEnvironment(): void {
  // 'test' rather than unset: the reset helpers refuse to run outside it, and it is not production
  // either way, so every case starts from the same non-production baseline.
  process.env.NODE_ENV = 'test';
  delete process.env.ENGINE_INBOUND_AUTH;
  delete process.env.CRAWLER_AUDIENCE;
  delete process.env.ENGINE_SHARED_SECRET;
  delete process.env.ENGINE_ALLOWED_CALLER;
  delete process.env.CRAWLER_INVOKER_SA;
  delete process.env.OIDC_ISSUER;
  delete process.env.OIDC_JWKS_URL;
}

beforeEach(() => {
  clearAuthEnvironment();
  resetInboundIdentityVerifierForTest();
  verify.mockReset();
  verify.mockResolvedValue({ subject: 'caller' });
});

afterEach(() => {
  clearAuthEnvironment();
  resetInboundIdentityVerifierForTest();
});

describe('inboundAuthMode', () => {
  it('infers the proof from what the deployment configured', () => {
    // Neither variable set: local development, nothing to prove.
    expect(inboundAuthMode({})).toBe('none');
    // The documented compose deployment.
    expect(inboundAuthMode({ ENGINE_SHARED_SECRET: 's3cret' })).toBe('shared-secret');
    // An existing token deployment keeps verifying without setting anything new.
    expect(inboundAuthMode({ CRAWLER_AUDIENCE: CRAWLER_URL })).toBe('token');
  });

  it('lets the deployment say so outright, and refuses a mode it does not have', () => {
    expect(inboundAuthMode({ ENGINE_INBOUND_AUTH: 'none', CRAWLER_AUDIENCE: CRAWLER_URL })).toBe('none');
    expect(() => inboundAuthMode({ ENGINE_INBOUND_AUTH: 'oidc' })).toThrow(/is not a mode/);
  });
});

describe('verifyInboundIdentity — nothing to prove', () => {
  it('lets every caller through in local development', async () => {
    const { res, nextCalled } = await callMiddleware({ authorization: 'Bearer anything' });
    expect(nextCalled).toBe(true);
    expect(res.statusCode).toBe(200);
  });
});

describe('verifyInboundIdentity — identity tokens', () => {
  beforeEach(() => {
    registerInboundIdentityVerifier({ verify });
  });

  it('rejects with 500 in production when CRAWLER_AUDIENCE is unset (fail closed)', async () => {
    process.env.ENGINE_INBOUND_AUTH = 'token';
    process.env.NODE_ENV = 'production';
    // CRAWLER_AUDIENCE deliberately unset
    const { res, nextCalled } = await callMiddleware({ authorization: 'Bearer token' });
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(500);
    // Must NOT have attempted a no-op (audience-less) verification.
    expect(verify).not.toHaveBeenCalled();
  });

  it('rejects with 500 when tokens are required but no verifier is configured', async () => {
    resetInboundIdentityVerifierForTest();
    process.env.ENGINE_INBOUND_AUTH = 'token';
    process.env.CRAWLER_AUDIENCE = CRAWLER_URL;
    const { res, nextCalled } = await callMiddleware({ authorization: 'Bearer token' });
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(500);
  });

  it('accepts a token minted for the correct audience in production', async () => {
    process.env.NODE_ENV = 'production';
    process.env.CRAWLER_AUDIENCE = CRAWLER_URL;

    const { res, nextCalled } = await callMiddleware({ authorization: 'Bearer good-token' });

    expect(nextCalled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(verify).toHaveBeenCalledWith('good-token', CRAWLER_URL);
  });

  it('rejects a token the verifier will not accept', async () => {
    process.env.NODE_ENV = 'production';
    process.env.CRAWLER_AUDIENCE = CRAWLER_URL;
    verify.mockRejectedValue(new Error('unexpected "aud" claim value'));

    const { res, nextCalled } = await callMiddleware({ authorization: 'Bearer wrong-aud-token' });

    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(401);
    expect((res.body as { error: string }).error).toBe('Invalid identity token');
  });

  it('rejects a missing Authorization header', async () => {
    process.env.NODE_ENV = 'production';
    process.env.CRAWLER_AUDIENCE = CRAWLER_URL;

    const { res, nextCalled } = await callMiddleware({});
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(401);
    expect((res.body as { error: string }).error).toBe('Missing or invalid Authorization header');
    expect(verify).not.toHaveBeenCalled();
  });

  it('pins the caller to one identity when the deployment names one', async () => {
    process.env.CRAWLER_AUDIENCE = CRAWLER_URL;
    process.env.ENGINE_ALLOWED_CALLER = 'core@example.iam';

    verify.mockResolvedValue({ subject: '1234', email: 'someone-else@example.iam', emailVerified: true });
    const denied = await callMiddleware({ authorization: 'Bearer token' });
    expect(denied.nextCalled).toBe(false);
    expect(denied.res.statusCode).toBe(403);

    verify.mockResolvedValue({ subject: '1234', email: 'core@example.iam', emailVerified: true });
    const allowed = await callMiddleware({ authorization: 'Bearer token' });
    expect(allowed.nextCalled).toBe(true);
  });

  it('does not accept an email the issuer has not verified', async () => {
    process.env.CRAWLER_AUDIENCE = CRAWLER_URL;
    process.env.CRAWLER_INVOKER_SA = 'core@example.iam';
    verify.mockResolvedValue({ subject: '1234', email: 'core@example.iam', emailVerified: false });

    const { res, nextCalled } = await callMiddleware({ authorization: 'Bearer token' });
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(403);
  });
});

describe('assertInboundAuthConfig', () => {
  it('throws when tokens are required in production without an audience', () => {
    registerInboundIdentityVerifier({ verify });
    process.env.ENGINE_INBOUND_AUTH = 'token';
    process.env.NODE_ENV = 'production';
    expect(() => assertInboundAuthConfig(true)).toThrow(/CRAWLER_AUDIENCE is not set/);
  });

  it('throws when tokens are required but nothing can verify one', () => {
    process.env.ENGINE_INBOUND_AUTH = 'token';
    process.env.CRAWLER_AUDIENCE = CRAWLER_URL;
    expect(() => assertInboundAuthConfig(true)).toThrow(/no verifier is configured/);
  });

  it('accepts the built-in OpenID Connect verifier as that configuration', () => {
    process.env.CRAWLER_AUDIENCE = CRAWLER_URL;
    process.env.OIDC_ISSUER = 'https://issuer.example';
    expect(() => assertInboundAuthConfig(true)).not.toThrow();
  });

  it('does NOT throw for the documented compose deployment in production', () => {
    // Compose sets NODE_ENV=production and authenticates the engine with ENGINE_SHARED_SECRET, not
    // tokens. Regression guard for a boot crash that would take the self-host engine down.
    process.env.NODE_ENV = 'production';
    process.env.ENGINE_SHARED_SECRET = 's3cret-value';
    expect(() => assertInboundAuthConfig(true)).not.toThrow();
  });

  it('throws when the shared secret it was told to use is missing', () => {
    process.env.ENGINE_INBOUND_AUTH = 'shared-secret';
    expect(() => assertInboundAuthConfig(true)).toThrow(/ENGINE_SHARED_SECRET is not set/);
  });

  it('warns rather than crashing when a production deployment proves nothing', () => {
    // Before, this configuration refused to boot on one hosting platform and booted openly on every
    // other. It now boots everywhere and says plainly what it is doing.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.NODE_ENV = 'production';
    expect(() => assertInboundAuthConfig(true)).not.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unauthenticated'));
    warn.mockRestore();
  });

  it('stays quiet when the deployment declares that it authenticates elsewhere', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.NODE_ENV = 'production';
    process.env.ENGINE_INBOUND_AUTH = 'none';
    expect(() => assertInboundAuthConfig(true)).not.toThrow();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('does not block the tunnel service, which serves no crawl routes', () => {
    process.env.ENGINE_INBOUND_AUTH = 'token';
    process.env.NODE_ENV = 'production';
    expect(() => assertInboundAuthConfig(false)).not.toThrow();
  });

  it('does not require an audience outside production', () => {
    registerInboundIdentityVerifier({ verify });
    process.env.ENGINE_INBOUND_AUTH = 'token';
    expect(() => assertInboundAuthConfig(true)).not.toThrow();
  });
});

describe('verifyInboundIdentity — shared secret', () => {
  beforeEach(() => {
    process.env.ENGINE_SHARED_SECRET = 's3cret-value';
  });

  it('allows a request whose bearer matches the shared secret', async () => {
    const { res, nextCalled } = await callMiddleware({ authorization: 'Bearer s3cret-value' });
    expect(nextCalled).toBe(true);
    expect(res.statusCode).toBe(200);
  });

  it('rejects a wrong bearer with 401', async () => {
    const { res, nextCalled } = await callMiddleware({ authorization: 'Bearer nope' });
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(401);
    expect((res.body as { error: string }).error).toBe('invalid engine shared secret');
  });

  it('rejects a missing Authorization header with 401', async () => {
    const { res, nextCalled } = await callMiddleware({});
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(401);
  });

  it('rejects rather than opening up when the secret it was told to use is missing', async () => {
    process.env.ENGINE_INBOUND_AUTH = 'shared-secret';
    delete process.env.ENGINE_SHARED_SECRET;
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { res, nextCalled } = await callMiddleware({ authorization: 'Bearer anything' });
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(500);
    error.mockRestore();
  });
});
