import { createServer, type Server } from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair, type CryptoKey } from 'jose';
import {
  openIdConnectVerifier,
  registerInboundIdentityVerifier,
  resetInboundIdentityVerifierForTest,
  resolveInboundIdentityVerifier,
} from './inbound-identity';

const AUDIENCE = 'https://accrawl-crawler.example.run.app';

let issuer = '';
let server: Server;
let signingKey: CryptoKey;
let servedIssuer = () => issuer;

/**
 * A real issuer: a key pair, a discovery document, and a JWKS — served over loopback HTTP. Every
 * case below signs a genuine token with that key and puts it through the verifier the product would
 * use, so what is exercised is the actual signature/issuer/audience checking rather than a stub.
 */
beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  signingKey = privateKey;
  const jwk = { ...await exportJWK(publicKey), kid: 'test-key', alg: 'RS256', use: 'sig' };
  server = createServer((request, response) => {
    if (request.url === '/.well-known/openid-configuration') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ issuer: servedIssuer(), jwks_uri: `${issuer}/jwks` }));
      return;
    }
    if (request.url === '/jwks') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ keys: [jwk] }));
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (typeof address === 'string' || !address) throw new Error('the test issuer did not bind a port');
  issuer = `http://127.0.0.1:${address.port}`;
});

afterAll(() => {
  server.close();
});

beforeEach(() => {
  process.env.NODE_ENV = 'test';
  resetInboundIdentityVerifierForTest();
  servedIssuer = () => issuer;
});

afterEach(() => {
  resetInboundIdentityVerifierForTest();
});

function mint(claims: Record<string, unknown>, options: { issuer?: string; audience?: string; expires?: string } = {}) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuer(options.issuer ?? issuer)
    .setAudience(options.audience ?? AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(options.expires ?? '5m')
    .sign(signingKey);
}

describe('the built-in OpenID Connect verifier', () => {
  it('is offered only when the deployment configured an issuer', () => {
    expect(openIdConnectVerifier({})).toBeUndefined();
    expect(openIdConnectVerifier({ OIDC_ISSUER: issuer })).toBeDefined();
    expect(openIdConnectVerifier({ OIDC_JWKS_URL: `${issuer}/jwks` })).toBeDefined();
  });

  it('accepts a genuinely signed token and reports who it names', async () => {
    const verifier = openIdConnectVerifier({ OIDC_ISSUER: issuer })!;
    const identity = await verifier.verify(
      await mint({ sub: '1234', email: 'core@example.iam', email_verified: true }),
      AUDIENCE,
    );
    expect(identity).toEqual({ subject: '1234', email: 'core@example.iam', emailVerified: true });
  });

  it('finds the keys itself through discovery, and again without re-fetching them', async () => {
    const verifier = openIdConnectVerifier({ OIDC_ISSUER: issuer })!;
    await verifier.verify(await mint({ sub: '1' }), AUDIENCE);
    // Point discovery at a bogus issuer: a second verify must not consult it again.
    servedIssuer = () => 'https://somewhere.else';
    await expect(verifier.verify(await mint({ sub: '2' }), AUDIENCE)).resolves.toMatchObject({ subject: '2' });
  });

  it('rejects a token minted for another audience', async () => {
    const verifier = openIdConnectVerifier({ OIDC_ISSUER: issuer })!;
    await expect(verifier.verify(
      await mint({ sub: '1' }, { audience: 'https://somebody-else.example' }),
      AUDIENCE,
    )).rejects.toThrow();
  });

  it('rejects a token from another issuer', async () => {
    const verifier = openIdConnectVerifier({ OIDC_ISSUER: issuer })!;
    await expect(verifier.verify(
      await mint({ sub: '1' }, { issuer: 'https://somebody-else.example' }),
      AUDIENCE,
    )).rejects.toThrow();
  });

  it('rejects an expired token', async () => {
    const verifier = openIdConnectVerifier({ OIDC_ISSUER: issuer })!;
    await expect(verifier.verify(await mint({ sub: '1' }, { expires: '-1m' }), AUDIENCE))
      .rejects.toThrow();
  });

  it('rejects a token signed with a key nobody published', async () => {
    const { privateKey } = await generateKeyPair('RS256', { extractable: true });
    const forged = await new SignJWT({ sub: '1' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuer(issuer)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);
    const verifier = openIdConnectVerifier({ OIDC_ISSUER: issuer })!;
    await expect(verifier.verify(forged, AUDIENCE)).rejects.toThrow();
  });

  it('refuses a discovery document that names a different issuer', async () => {
    servedIssuer = () => 'https://somebody-else.example';
    const verifier = openIdConnectVerifier({ OIDC_ISSUER: issuer })!;
    await expect(verifier.verify(await mint({ sub: '1' }), AUDIENCE))
      .rejects.toThrow(/names a different issuer/);
  });

  it('refuses to fetch keys over plain HTTP off the local machine', () => {
    expect(() => openIdConnectVerifier({ OIDC_ISSUER: 'http://issuer.example' }))
      .toThrow(/must be an https URL/);
  });

  it('gives way to a verifier the deployment registered', async () => {
    process.env.OIDC_ISSUER = issuer;
    try {
      registerInboundIdentityVerifier({ verify: async () => ({ subject: 'supplied' }) });
      const resolved = resolveInboundIdentityVerifier()!;
      await expect(resolved.verify('anything', AUDIENCE)).resolves.toEqual({ subject: 'supplied' });
    } finally {
      delete process.env.OIDC_ISSUER;
    }
  });
});

