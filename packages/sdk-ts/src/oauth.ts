/**
 * The "Connect with Accrawl" OAuth 2.0 client — the server side of the Authorization-Code + PKCE flow a
 * third-party app uses to get an access token for a user's Accrawl connections.
 *
 * The dance (see docs/spec-oauth.md):
 *   1. startAuthorization() → redirect the user's browser to the returned `url` (Accrawl's consent page).
 *      Persist the returned `state` + `codeVerifier` against the user's session.
 *   2. Accrawl redirects back to your redirect_uri with `?code&state`. Check `state` matches, then
 *      exchangeCode({ code, codeVerifier }) → an { access_token, refresh_token, expires_in, scope }.
 *   3. The access_token IS an Accrawl API key (`acck_…`) — hand it to `new AccrawlClient({ apiKey })` to
 *      read the consented data. When it nears expiry, refresh({ refreshToken }) rotates the pair.
 *   4. On disconnect, revoke({ token }) the refresh token to drop the whole grant.
 *
 * PKCE (S256) is MANDATORY for every client — Accrawl rejects an authorize request without a code_challenge.
 * Because the code exchange presents the client_secret, this helper is SERVER-SIDE (Node): it uses node:crypto
 * for PKCE, and a secret must never reach a browser. A public client omits `clientSecret`.
 */
import { createHash, randomBytes } from 'node:crypto';
import { AccrawlApiError } from './errors';

/** The token endpoint's success body (RFC 6749 §5.1). `expires_in` counts down to the access token's expiry,
 *  the access token's own hour-long clock, NOT the grant's ~90-day consent window — refresh before it runs
 *  out, and rotation stays inside the window rather than extending it. */
export interface OAuthTokenResponse {
  access_token: string;
  token_type: string; // 'Bearer'
  expires_in: number; // seconds until the access token (and its grant) expire
  refresh_token: string;
  scope: string; // space-delimited granted scopes
}

/** A PKCE pair: keep `codeVerifier` server-side; send `codeChallenge` (+ method) on the authorize request. */
export interface PkcePair {
  codeVerifier: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
}

type FetchLike = (input: string, init?: {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}) => Promise<{ status: number; text: () => Promise<string> }>;

export interface AccrawlOAuthOptions {
  /** The Accrawl deployment's front-door base URL, e.g. https://accrawl.example.com. */
  baseUrl: string;
  /** Your registered client_id (`accl_…`). */
  clientId: string;
  /** Your client_secret (`acls_…`) — omit for a public client (one bound to the flow by PKCE only). */
  clientSecret?: string;
  /** The exact redirect_uri you registered; Accrawl matches it verbatim at both authorize and exchange. */
  redirectUri: string;
  /** Inject a fetch implementation (defaults to the global fetch). */
  fetch?: FetchLike;
}

export interface StartAuthorizationOptions {
  /** Requested scope(s) — a space-delimited string or an array. Defaults to `read:data`. */
  scope?: string | string[];
  /** CSRF token echoed back on the redirect; auto-generated (128-bit) if omitted. Persist + verify it. */
  state?: string;
}

/** What startAuthorization returns: the URL to redirect the browser to, plus the two values you must persist
 *  against the user's session to complete the flow (`state` for CSRF, `codeVerifier` for the exchange). */
export interface StartedAuthorization {
  url: string;
  state: string;
  codeVerifier: string;
}

/** Generate a PKCE pair: a high-entropy verifier (43-char base64url, the RFC 7636 unreserved set) and its
 *  S256 challenge. Exported standalone so a caller can drive buildAuthorizationUrl manually. */
export function generatePkce(): PkcePair {
  const codeVerifier = randomBytes(32).toString('base64url'); // 43 chars, unreserved
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
  return { codeVerifier, codeChallenge, codeChallengeMethod: 'S256' };
}

function scopeToString(scope: string | string[] | undefined): string {
  if (Array.isArray(scope)) return scope.join(' ');
  return scope ?? 'read:data';
}

export class AccrawlOAuthClient {
  private readonly baseUrl: string;
  private readonly clientId: string;
  private readonly clientSecret?: string;
  private readonly redirectUri: string;
  private readonly fetchImpl: FetchLike;

  constructor(opts: AccrawlOAuthOptions) {
    if (!opts.baseUrl) throw new Error('AccrawlOAuthClient: baseUrl is required');
    if (!opts.clientId) throw new Error('AccrawlOAuthClient: clientId is required');
    if (!opts.redirectUri) throw new Error('AccrawlOAuthClient: redirectUri is required');
    this.baseUrl = opts.baseUrl.replace(/\/+$/, ''); // no trailing slash
    this.clientId = opts.clientId;
    this.clientSecret = opts.clientSecret;
    this.redirectUri = opts.redirectUri;
    const f = opts.fetch ?? (globalThis.fetch as unknown as FetchLike | undefined);
    if (!f) throw new Error('AccrawlOAuthClient: no fetch available — pass opts.fetch');
    this.fetchImpl = f;
  }

  /**
   * Begin an authorization: generate PKCE + a CSRF `state`, and build the /oauth/authorize URL to redirect
   * the browser to. Returns the URL plus the `state` and `codeVerifier` you MUST persist (keyed to the user's
   * session) so `exchangeCode` can complete the flow when Accrawl redirects back.
   */
  startAuthorization(opts: StartAuthorizationOptions = {}): StartedAuthorization {
    const { codeVerifier, codeChallenge, codeChallengeMethod } = generatePkce();
    const state = opts.state ?? randomBytes(16).toString('base64url');
    const url = this.buildAuthorizationUrl({ scope: opts.scope, state, codeChallenge, codeChallengeMethod });
    return { url, state, codeVerifier };
  }

  /** Lower-level: build the /oauth/authorize URL from an explicit challenge + state (use when you manage PKCE
   *  and state yourself). Prefer startAuthorization, which generates and returns them for you. */
  buildAuthorizationUrl(params: {
    scope?: string | string[];
    state: string;
    codeChallenge: string;
    codeChallengeMethod?: 'S256';
  }): string {
    const q = new URLSearchParams({
      response_type: 'code',
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      scope: scopeToString(params.scope),
      state: params.state,
      code_challenge: params.codeChallenge,
      code_challenge_method: params.codeChallengeMethod ?? 'S256',
    });
    return `${this.baseUrl}/oauth/authorize?${q.toString()}`;
  }

  /**
   * Exchange the single-use authorization `code` for tokens (RFC 6749 §4.1.3). Presents the client_secret
   * (confidential clients) and the PKCE `codeVerifier` that pairs with the challenge you sent at authorize.
   * `redirectUri` defaults to the one this client was constructed with; Accrawl requires it to match the
   * authorize request exactly.
   */
  async exchangeCode(input: { code: string; codeVerifier: string; redirectUri?: string }): Promise<OAuthTokenResponse> {
    return this.tokenRequest({
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: input.redirectUri ?? this.redirectUri,
      code_verifier: input.codeVerifier,
    });
  }

  /** Rotate the token pair (RFC 6749 §6). Returns a NEW access + refresh token; the presented refresh token is
   *  consumed. Replaying a consumed refresh token is treated as theft and revokes the whole grant. */
  async refresh(input: { refreshToken: string }): Promise<OAuthTokenResponse> {
    return this.tokenRequest({ grant_type: 'refresh_token', refresh_token: input.refreshToken });
  }

  /**
   * Revoke a token (RFC 7009). Revoking a refresh token drops the whole grant (its access + refresh tokens);
   * revoking an access token drops just that token. Always resolves for a well-formed request — the endpoint
   * gives no token-existence oracle — so a 200 does not confirm the token existed.
   */
  async revoke(input: { token: string; tokenTypeHint?: 'access_token' | 'refresh_token' }): Promise<void> {
    const body: Record<string, string> = { token: input.token };
    if (input.tokenTypeHint) body.token_type_hint = input.tokenTypeHint;
    await this.formPost('/oauth/revoke', body);
  }

  /** POST the token endpoint with client authentication; parse the RFC-6749 success/error body. */
  private async tokenRequest(fields: Record<string, string>): Promise<OAuthTokenResponse> {
    const parsed = await this.formPost('/oauth/token', fields);
    return parsed as OAuthTokenResponse;
  }

  /** urlencoded POST to an OAuth endpoint with client_secret_post auth; throws AccrawlApiError on non-2xx. */
  private async formPost(path: string, fields: Record<string, string>): Promise<unknown> {
    const params = new URLSearchParams(fields);
    params.set('client_id', this.clientId);
    // client_secret_post: confidential clients present the secret in the body; public clients present none.
    if (this.clientSecret) params.set('client_secret', this.clientSecret);
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: params.toString(),
    });
    const text = await res.text();
    const parsed = text ? safeJson(text) : undefined;
    if (res.status < 200 || res.status >= 300) {
      // OAuth errors are `{ error, error_description }` (RFC 6749 §5.2) — surface the description as the message.
      const o = (parsed && typeof parsed === 'object' ? parsed : {}) as { error?: unknown; error_description?: unknown };
      const message = typeof o.error_description === 'string' ? o.error_description
        : typeof o.error === 'string' ? o.error
        : `Accrawl OAuth error (HTTP ${res.status})`;
      throw new AccrawlApiError(res.status, message, parsed);
    }
    return parsed;
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text; // non-JSON body — surface as-is in the error path
  }
}
