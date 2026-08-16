/**
 * OAuth 2.0 Authorization Server — the "Connect with Accrawl" flow (authorization-code + PKCE).
 *
 * Accrawl is the Authorization Server + Resource Server; the OPERATOR is the resource owner; a registered
 * third-party app is the client. Consent is authenticate-FIRST (like every real OAuth provider: you sign in
 * before you see the consent screen), which keeps the operator's connection inventory private. Flow:
 *   1. GET  /oauth/authorize          browser lands here from the 3rd-party "Connect" button. We validate
 *                                     client_id + EXACT redirect_uri (open-redirect guard), then render a
 *                                     SIGN-IN page naming the app + requested scopes — but NOT the operator's
 *                                     connections (this endpoint is reachable by anyone who knows a registered
 *                                     client_id + redirect_uri, so it must reveal nothing pre-authentication).
 *   2a. POST /oauth/authorize/decision  (no ticket) the operator submits their admin password. We verify it,
 *                                     then render the connection PICKER carrying a short-lived, request-bound
 *                                     consent ticket that proves the password check happened.
 *   2b. POST /oauth/authorize/decision  (with ticket) the operator ticks connections and approves. We verify
 *                                     the ticket, mint a single-use authorization_code, and 302 back to
 *                                     redirect_uri?code&state. (Deny at either step → error=access_denied.)
 *   3. POST /oauth/token              the 3rd-party SERVER exchanges the code (+ PKCE verifier / client
 *                                     secret) for a scoped, ~90-day access token — an api_keys row that flows
 *                                     through the SAME requireOperatorOrApiKey + keyGrantsConnection guards.
 *
 * Security invariants: the connection inventory is never rendered before the operator authenticates;
 * redirect_uri is exact-match against the client's registered allowlist and never inferred; the code is
 * stored only as a hash, expires in 5 min, and is atomically single-use; PKCE S256 is MANDATORY for every
 * client (public and confidential — per OAuth 2.1 / RFC 9700); scopes are clamped to the client's
 * allowedScopes ceiling AND the closed API_SCOPES set; approval requires either
 * the self-hosted operator password or a hosted user assertion plus the
 * request-bound consent ticket rendered by the picker. See docs/spec-oauth.md.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { oauthRedirectUriMatches } from '@accrawl/contracts';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../db/client';
import {
  apiKeys,
  auditLog,
  authorizationCodes,
  oauthGrants,
  oauthRefreshTokens,
} from '../db/schema';
import type { Db } from '../db/client';
import {
  API_SCOPES,
  type PublicApiScope,
  createApiKey,
  generateApiKey,
  hashApiKey,
} from '../auth/apiKeys';
import { getOauthClient, verifyClientSecret, type OauthClientRecord } from '../auth/oauthClients';
import {
  generateAuthorizationCode, generateRefreshToken, hashCode, verifyPkceS256, AUTHORIZATION_CODE_TTL_MS,
} from '../auth/oauthCodes';
import { verifyOperatorPassword, mintConsentTicket, verifyConsentTicket, type ConsentTicketBinding } from '../auth/operator';
import { revokeGrant } from '../data/oauth-grants';
import { SELF_HOSTED_OPERATOR_SUBJECT } from '../auth/subjects';
import { hostedCell } from '../tenancy/directory';
import {
  hostedOauthStore,
  usesHostedOauthStore,
} from '../auth/oauth-store';
import { getUserDataStore } from '../storage';

/**
 * Label each connection the way its owner would recognise it.
 *
 * `institutionId` is a lookup slug, not a name. Falling back to it printed
 * strings like `bank-of-scotland-uk` in front of someone deciding whether to
 * hand an application access to their accounts — the one screen where being
 * certain what you are approving matters most. The data API already refuses to
 * do this and resolves the institution's display name instead; the consent
 * screen simply never got the same treatment.
 *
 * Order: the owner's own nickname first, then the institution's official name.
 * The slug survives only when the institution row is genuinely missing. The
 * data API drops such a connection rather than name it dishonestly, and that is
 * right for a listing — but this screen is where access is granted, and
 * dropping a row here would quietly narrow what the user is even able to
 * approve without telling them.
 */
async function labelledConnections(
  ownerSubject: string,
  conns: ReadonlyArray<{ id: string; nickname?: string | null; institutionId: string }>,
): Promise<Array<{ id: string; label: string }>> {
  if (conns.length === 0) return [];
  const store = await getUserDataStore();
  const access = { kind: 'visible' as const, ownerSubject };
  // Resolve each distinct institution once, under the owner's own visibility.
  const names = new Map(
    await Promise.all(
      [...new Set(conns.map((c) => c.institutionId))].map(
        async (id) => [id, (await store.getInstitution(id, access))?.name ?? null] as const,
      ),
    ),
  );
  return conns.map((c) => ({
    id: c.id,
    label: c.nickname || names.get(c.institutionId) || c.institutionId,
  }));
}

/** The 3rd-party grant / access token lifetime — the operator's "~3-month" clock. */
const OAUTH_GRANT_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/** How long the operator has to pick connections + approve after signing in on the consent screen. Short so a
 *  leaked consent ticket has a tiny replay window; long enough to read the connection list unhurried. */
const CONSENT_TICKET_TTL_MS = 10 * 60 * 1000;

const SCOPE_LABELS: Record<PublicApiScope, string> = {
  'read:data': 'Read your accounts, balances, transactions and holdings',
};

// ─── small helpers ──────────────────────────────────────────────────

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

/** Read a body/query field that the urlencoded parser may deliver as string | string[]. */
function one(v: unknown): string | undefined {
  if (Array.isArray(v)) return typeof v[0] === 'string' ? v[0] : undefined;
  return typeof v === 'string' ? v : undefined;
}

function many(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
  return typeof v === 'string' ? [v] : [];
}

/** Build a redirect back to the client with query params appended (preserving any the URI already has). */
function redirectWith(reply: FastifyReply, redirectUri: string, params: Record<string, string | undefined>): FastifyReply {
  const url = new URL(redirectUri);
  for (const [k, val] of Object.entries(params)) if (val != null && val !== '') url.searchParams.set(k, val);
  return reply.redirect(url.toString());
}

function errorPage(reply: FastifyReply, code: number, title: string, detail: string): FastifyReply {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>${STYLE}</head><body><main class="card"><h1>${esc(title)}</h1><p class="muted">${esc(detail)}</p></main></body></html>`;
  return reply.code(code).type('text/html; charset=utf-8').send(html);
}

const STYLE = `<style>
  :root{color-scheme:light dark}
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#0b1020;color:#e6e9f0}
  .card{width:100%;max-width:440px;background:#151b2e;border:1px solid #263049;border-radius:14px;padding:28px}
  h1{font-size:20px;margin:0 0 6px}
  .muted{color:#9aa4bf;font-size:13.5px;margin:0 0 18px}
  .app{font-weight:600;color:#fff}
  ul.scopes{list-style:none;padding:0;margin:0 0 18px}
  ul.scopes li{padding:9px 12px;background:#0f1526;border:1px solid #232c44;border-radius:9px;margin-bottom:8px;font-size:13.5px}
  fieldset{border:1px solid #232c44;border-radius:10px;padding:12px 14px;margin:0 0 16px}
  legend{padding:0 6px;color:#9aa4bf;font-size:12.5px;text-transform:uppercase;letter-spacing:.04em}
  /* A connection's label is whatever its institution is called, and real names
     are longer than slugs were. Without a wrap rule the row pushed past the
     card, and a flex checkbox with nothing stopping it shrinks — which is the
     one control the row exists for. Text wraps, the box keeps its size, and
     both sit against the first line rather than drifting to the middle of a
     wrapped name. */
  label.row{display:flex;gap:10px;align-items:flex-start;padding:6px 2px;font-size:14px;cursor:pointer;overflow-wrap:anywhere}
  label.row input[type=checkbox]{flex:none;margin-top:2px}
  input[type=checkbox]{width:16px;height:16px;accent-color:#4f7cff}
  input[type=password]{width:100%;padding:10px 12px;border-radius:9px;border:1px solid #2a3550;background:#0f1526;color:#e6e9f0;font-size:14px}
  .actions{display:flex;gap:10px;margin-top:18px}
  button{flex:1;padding:11px 14px;border-radius:9px;border:0;font-size:14px;font-weight:600;cursor:pointer}
  button.approve{background:#4f7cff;color:#fff}
  button.deny{background:#232c44;color:#c9d2ea}
  .err{background:#3b1720;border:1px solid #6b2233;color:#ffb4c0;padding:9px 12px;border-radius:9px;margin:0 0 16px;font-size:13.5px}
  .field-label{display:block;font-size:12.5px;color:#9aa4bf;margin:0 0 6px}
</style>`;

interface ConsentView {
  /** 'authenticate' — the sign-in step (password, NO connections); 'picker' — pick connections + approve
   *  (connections + a proof-of-auth ticket, NO password). Authenticate-first keeps the inventory private. */
  mode: 'authenticate' | 'picker';
  client: OauthClientRecord;
  redirectUri: string;
  state: string;
  scopes: PublicApiScope[];
  codeChallenge?: string;
  codeChallengeMethod?: string;
  connections?: Array<{ id: string; label: string }>;
  consentTicket?: string;
  error?: string;
}

function renderConsent(v: ConsentView): string {
  const hidden = (name: string, val: string | undefined) =>
    val == null ? '' : `<input type="hidden" name="${esc(name)}" value="${esc(val)}">`;
  const scopeItems = v.scopes.map((s) => `<li>${esc(SCOPE_LABELS[s] ?? s)}</li>`).join('');
  // Informed-consent cues for a financial-data authorization: how long access lasts (derived from the grant
  // TTL so the copy can't drift from the code) and where the app will send the operator back.
  const grantDays = Math.round(OAUTH_GRANT_TTL_MS / 86_400_000);
  let destHost: string | undefined;
  try { destHost = new URL(v.redirectUri).host; } catch { destHost = undefined; }

  // Every request param needed to complete the flow rides along as hidden fields on both steps.
  const hiddens = `${hidden('client_id', v.client.clientId)}
    ${hidden('redirect_uri', v.redirectUri)}
    ${hidden('scope', v.scopes.join(' '))}
    ${hidden('state', v.state)}
    ${hidden('code_challenge', v.codeChallenge)}
    ${hidden('code_challenge_method', v.codeChallengeMethod)}`;

  let formBody: string;
  if (v.mode === 'authenticate') {
    // Step 1: sign in. No connections are revealed until the password checks out.
    formBody = `${hiddens}
    <div>
      <label class="field-label" for="pw">Sign in with your Accrawl password to continue</label>
      <input id="pw" type="password" name="password" autocomplete="current-password" required autofocus>
    </div>
    <div class="actions">
      <button class="deny" type="submit" name="decision" value="deny">Cancel</button>
      <button class="approve" type="submit" name="decision" value="continue">Continue</button>
    </div>`;
  } else {
    // Step 2: pick connections + approve. The consent ticket (not a password) proves the prior sign-in.
    const connRows = (v.connections ?? [])
      .map((c) => `<label class="row"><input type="checkbox" name="connectionGrants" value="${esc(c.id)}">${esc(c.label)}</label>`)
      .join('');
    formBody = `${hiddens}
    ${hidden('consent_ticket', v.consentTicket)}
    <fieldset>
      <legend>Share which connections</legend>
      <label class="row"><input type="checkbox" name="grantAll" value="on">All current connections</label>
      ${connRows || '<p class="muted" style="margin:6px 0 0">No connections are available to share yet. Add a bank or broker connection to continue.</p>'}
    </fieldset>
    <div class="actions">
      <button class="deny" type="submit" name="decision" value="deny">Deny</button>
      <button class="approve" type="submit" name="decision" value="approve">Approve</button>
    </div>`;
  }

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Authorize ${esc(v.client.name)}</title>${STYLE}</head><body>
<main class="card">
  <h1>Authorize access</h1>
  <p class="muted"><span class="app">${esc(v.client.name)}</span> wants to access your Accrawl data.</p>
  ${v.error ? `<div class="err" role="alert">${esc(v.error)}</div>` : ''}
  <p class="field-label">This will allow it to:</p>
  <ul class="scopes">${scopeItems}</ul>
  <p class="muted">Access lasts about ${grantDays} days — until it expires or you revoke it in Accrawl.${destHost ? ` Approving returns you to <span class="app">${esc(destHost)}</span>.` : ''}</p>
  <form method="post" action="/oauth/authorize/decision">
    ${formBody}
  </form>
</main></body></html>`;
}

/** Parse a space-separated scope string into validated ApiScopes within the client's ceiling. Returns null
 *  (invalid_scope) if any requested scope is unknown or outside the client's allowedScopes. */
function resolveScopes(raw: string | undefined, client: OauthClientRecord): PublicApiScope[] | null {
  const requested = (raw ?? '').split(/\s+/).filter(Boolean);
  if (requested.length === 0) return null;
  const allowed = new Set(client.allowedScopes);
  const out: PublicApiScope[] = [];
  for (const s of requested) {
    if (!(API_SCOPES as readonly string[]).includes(s)) return null;
    if (!allowed.has(s)) return null;
    out.push(s as PublicApiScope);
  }
  return out;
}

type ClientAuthResult = { ok: true; client: OauthClientRecord } | { ok: false; status: number; error: string; description: string };

/** Authenticate the OAuth client at the token/revoke/introspect endpoints: HTTP Basic (client_secret_basic)
 *  OR body params (client_secret_post). A public client presents only its client_id (it is bound to the flow
 *  via PKCE, not a secret), and must NOT present one. */
async function authenticateOauthClient(req: FastifyRequest): Promise<ClientAuthResult> {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const bodyClientId = one(b.client_id);
  const bodyClientSecret = one(b.client_secret);
  let clientId = bodyClientId;
  let clientSecret = bodyClientSecret;
  const authz = req.headers.authorization;
  if (authz != null) {
    // OAuth clients must use exactly one authentication method. Reject an
    // ambiguous Basic+body request rather than letting intermediaries and the
    // application disagree over which credential was authoritative.
    if (bodyClientId !== undefined || bodyClientSecret !== undefined) {
      return {
        ok: false,
        status: 401,
        error: 'invalid_client',
        description: 'client authentication required',
      };
    }
    const match = /^Basic[ \t]+([A-Za-z0-9+/]+={0,2})$/i.exec(authz);
    try {
      if (!match) throw new Error('malformed Basic credentials');
      const encoded = match[1];
      const decodedBytes = Buffer.from(encoded, 'base64');
      if (
        decodedBytes.toString('base64').replace(/=+$/u, '')
        !== encoded.replace(/=+$/u, '')
      ) {
        throw new Error('malformed Basic credentials');
      }
      const decoded = decodedBytes.toString('utf8');
      const sep = decoded.indexOf(':');
      if (sep < 0) throw new Error('malformed Basic credentials');
      clientId = decodeURIComponent(decoded.slice(0, sep));
      clientSecret = decodeURIComponent(decoded.slice(sep + 1));
    } catch {
      return {
        ok: false,
        status: 401,
        error: 'invalid_client',
        description: 'client authentication required',
      };
    }
  }
  if (!clientId) return { ok: false, status: 401, error: 'invalid_client', description: 'client authentication required' };
  const client = await getOauthClient(db, clientId);
  if (!client || client.disabledAt) return { ok: false, status: 401, error: 'invalid_client', description: 'unknown client' };
  if (client.isPublic) {
    if (clientSecret) return { ok: false, status: 401, error: 'invalid_client', description: 'public client must not present a secret' };
  } else if (!verifyClientSecret(clientSecret ?? '', client.hashedSecret)) {
    return { ok: false, status: 401, error: 'invalid_client', description: 'bad client credentials' };
  }
  return { ok: true, client };
}

/** Mint a fresh access token (an api_keys row) + a rotating refresh token for a grant. Both are bounded by
 *  the grant's expiry (the ~90-day consent window) — refresh rotates within that window, it never extends it. */
async function issueTokensForGrant(
  database: Pick<Db, 'insert'>,
  client: OauthClientRecord,
  grant: {
    id: string;
    ownerSubject: string;
    scopes: string[];
    connectionGrants: string[];
    expiresAt: Date;
  },
): Promise<Record<string, unknown>> {
  const { plaintext: accessToken } = await createApiKey(database, {
    name: `oauth:${client.name}`, scopes: grant.scopes, connectionGrants: grant.connectionGrants,
    ownerSubject: grant.ownerSubject, expiresAt: grant.expiresAt, grantId: grant.id,
  });
  const { plaintext: refreshToken, tokenHash } = generateRefreshToken();
  await database.insert(oauthRefreshTokens).values({ tokenHash, grantId: grant.id, expiresAt: grant.expiresAt });
  return oauthTokenResponse(accessToken, refreshToken, grant);
}

function oauthTokenResponse(
  accessToken: string,
  refreshToken: string,
  grant: {
    scopes: string[];
    expiresAt: Date;
  },
): Record<string, unknown> {
  return {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: Math.max(0, Math.floor((grant.expiresAt.getTime() - Date.now()) / 1000)),
    refresh_token: refreshToken,
    scope: grant.scopes.join(' '),
  };
}

// ─── routes ─────────────────────────────────────────────────────────

export async function oauthRoutes(app: FastifyInstance): Promise<void> {
  // 1) Authorization endpoint — renders the consent page (or errors safely).
  app.get('/oauth/authorize', async (req, reply) => {
    const q = req.query as Record<string, unknown>;
    const clientId = one(q.client_id);
    const redirectUri = one(q.redirect_uri);
    const responseType = one(q.response_type);
    const state = one(q.state) ?? '';
    const codeChallenge = one(q.code_challenge);
    const codeChallengeMethod = one(q.code_challenge_method);

    if (!clientId || !redirectUri) {
      return errorPage(reply, 400, 'Invalid request', 'Missing client_id or redirect_uri.');
    }
    const client = await getOauthClient(db, clientId);
    if (!client || client.disabledAt) {
      return errorPage(reply, 400, 'Unknown application', 'This client is not registered or has been disabled.');
    }
    // Match the redirect against the registered allowlist BEFORE trusting it
    // for any redirect. OAuth 2.1 permits only a native loopback port to vary;
    // all other components remain exact to prevent open redirects/code theft.
    if (!client.redirectUris.some(
      (registered) => oauthRedirectUriMatches(registered, redirectUri),
    )) {
      return errorPage(reply, 400, 'Invalid redirect_uri', 'This redirect URI is not registered for this application.');
    }
    // From here redirect_uri is trusted, so protocol errors go back to the client per RFC 6749 §4.1.2.1.
    if (responseType !== 'code') {
      return redirectWith(reply, redirectUri, { error: 'unsupported_response_type', state });
    }
    // PKCE is MANDATORY for EVERY client (OAuth 2.1 / RFC 9700 best practice), not just public ones — it
    // shuts down authorization-code injection regardless of client type; a downgrade to 'plain' is refused.
    if (!codeChallenge) {
      return redirectWith(reply, redirectUri, { error: 'invalid_request', error_description: 'code_challenge (PKCE S256) is required', state });
    }
    if (codeChallengeMethod !== 'S256') {
      return redirectWith(reply, redirectUri, { error: 'invalid_request', error_description: 'only PKCE S256 is supported', state });
    }
    const scopes = resolveScopes(one(q.scope), client);
    if (!scopes) {
      return redirectWith(reply, redirectUri, { error: 'invalid_scope', state });
    }

    // A hosted identity edge has already authenticated this exact tenant+request and set req.operator, so
    // it can go directly to the picker. Self-hosted requests retain the authenticate-first password step.
    reply.header('Cache-Control', 'no-store');
    if (req.operator) {
      const conns = await (await getUserDataStore()).listConnections(
        req.operatorSubject!,
      );
      const consentTicket = await mintConsentTicket({
        clientId: client.clientId,
        redirectUri,
        scope: scopes.join(' '),
        codeChallenge,
      }, CONSENT_TICKET_TTL_MS);
      return reply.type('text/html; charset=utf-8').send(renderConsent({
        mode: 'picker',
        client,
        redirectUri,
        state,
        scopes,
        codeChallenge,
        codeChallengeMethod,
        connections: await labelledConnections(req.operatorSubject!, conns),
        consentTicket,
      }));
    }
    if (hostedCell) {
      return errorPage(reply, 401, 'Sign in required', 'Sign in to Accrawl before reviewing this request.');
    }
    return reply.type('text/html; charset=utf-8').send(renderConsent({
      mode: 'authenticate', client, redirectUri, state, scopes, codeChallenge, codeChallengeMethod,
    }));
  });

  // 2) Consent decision — authenticate-FIRST, in two steps posting to this same endpoint. Step 1 (no ticket):
  //    the operator submits their password → we render the connection picker with a proof-of-auth ticket.
  //    Step 2 (with ticket): the operator picks connections + approves → we mint the code. The rate limit +
  //    300ms friction guard the password step against brute force.
  app.post('/oauth/authorize/decision', { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } }, async (req, reply) => {
    const b = req.body as Record<string, unknown>;
    const clientId = one(b.client_id);
    const redirectUri = one(b.redirect_uri);
    const state = one(b.state) ?? '';
    const codeChallenge = one(b.code_challenge);
    const codeChallengeMethod = one(b.code_challenge_method);
    const decision = one(b.decision);
    const password = one(b.password) ?? '';
    const consentTicket = one(b.consent_ticket);
    const grantAll = one(b.grantAll) === 'on';
    const selectedConnIds = many(b.connectionGrants);
    const ownerSubject = req.operatorSubject
      ?? (!hostedCell ? SELF_HOSTED_OPERATOR_SUBJECT : null);

    if (!clientId || !redirectUri) return errorPage(reply, 400, 'Invalid request', 'Missing client_id or redirect_uri.');
    if (!ownerSubject) {
      return errorPage(reply, 401, 'Sign in required', 'Sign in to Accrawl before reviewing this request.');
    }
    const client = await getOauthClient(db, clientId);
    if (!client || client.disabledAt) return errorPage(reply, 400, 'Unknown application', 'This client is not registered or has been disabled.');
    // Re-validate redirect_uri against the registry — never trust the posted value.
    if (!client.redirectUris.some(
      (registered) => oauthRedirectUriMatches(registered, redirectUri),
    )) {
      return errorPage(reply, 400, 'Invalid redirect_uri', 'This redirect URI is not registered for this application.');
    }
    // Deny is honoured at EITHER step, before any password check, so cancelling never needs a credential.
    if (decision === 'deny') {
      return redirectWith(reply, redirectUri, { error: 'access_denied', state });
    }
    const scopes = resolveScopes(one(b.scope), client);
    if (!scopes) return redirectWith(reply, redirectUri, { error: 'invalid_scope', state });
    // PKCE S256 is mandatory for every client (see /oauth/authorize) — re-enforced here so a decision can't
    // be crafted without it.
    if (!codeChallenge) {
      return redirectWith(reply, redirectUri, { error: 'invalid_request', error_description: 'code_challenge (PKCE S256) is required', state });
    }
    if (codeChallengeMethod !== 'S256') {
      return redirectWith(reply, redirectUri, { error: 'invalid_request', error_description: 'only PKCE S256 is supported', state });
    }

    // The consent ticket binds a completed sign-in to THIS exact authorize request, so a ticket can never be
    // replayed onto a different client/redirect/scope/PKCE challenge.
    const ticketBinding: ConsentTicketBinding = { clientId: client.clientId, redirectUri, scope: scopes.join(' '), codeChallenge };

    const renderAuthenticate = (error: string, code = 400) => {
      reply.header('Cache-Control', 'no-store');
      return reply.code(code).type('text/html; charset=utf-8').send(renderConsent({
        mode: 'authenticate', client, redirectUri, state, scopes, codeChallenge, codeChallengeMethod, error,
      }));
    };
    // Re-render the picker carrying `ticket` verbatim. Callers pass the ticket EXPLICITLY (step 1 mints a fresh
    // one; a step-2 error echoes the SAME already-verified one) — never mint inside here, or the error path
    // would keep extending a held ticket's life and defeat the short TTL that bounds a stolen ticket.
    const renderPicker = async (ticket: string, error?: string, code = 200) => {
      const conns = await (await getUserDataStore()).listConnections(
        ownerSubject,
      );
      reply.header('Cache-Control', 'no-store');
      return reply.code(code).type('text/html; charset=utf-8').send(renderConsent({
        mode: 'picker', client, redirectUri, state, scopes, codeChallenge, codeChallengeMethod,
        connections: await labelledConnections(ownerSubject, conns),
        consentTicket: ticket, error,
      }));
    };

    // ── Step 1: sign in. No ticket yet → verify the password before revealing anything; on success, mint a
    //    FRESH ticket (the ONLY place a ticket's 10-min window starts — it cost a password) and show the picker.
    //    A wrong password re-renders sign-in, never the picker.
    if (!consentTicket && !req.operator) {
      if (!(await verifyOperatorPassword(password))) {
        await new Promise((r) => setTimeout(r, 300)); // brute-force friction, matching the login endpoint
        return renderAuthenticate('Incorrect password.', 401);
      }
      return renderPicker(await mintConsentTicket(ticketBinding, CONSENT_TICKET_TTL_MS));
    }

    // An authenticated edge identity replaces the password step, not the
    // request-bound anti-CSRF proof. The picker GET minted this ticket; a
    // cross-site POST that cannot read it must never create a grant.
    if (!consentTicket) {
      return redirectWith(reply, redirectUri, {
        error: 'invalid_request',
        state,
      });
    }

    // ── Step 2: approve. A ticket is present → it must prove a recent sign-in for THIS request. Invalid/expired
    //    drops back to sign-in — it never reveals connections or mints a code.
    if (!(await verifyConsentTicket(consentTicket, ticketBinding))) {
      return renderAuthenticate('Your session expired. Please sign in again.', 401);
    }

    // Resolve the consented connection grants: ['*'] for grant-all, else the ticked ids that actually exist.
    const conns = await (await getUserDataStore()).listConnections(ownerSubject);
    let connectionGrants: string[];
    if (grantAll) {
      connectionGrants = conns.map((connection) => connection.id);
      if (connectionGrants.length === 0) {
        return renderPicker(
          consentTicket ?? '',
          'Select at least one existing connection to share.',
          400,
        );
      }
    } else {
      const existing = new Set(conns.map((c) => c.id));
      connectionGrants = selectedConnIds.filter((id) => existing.has(id));
      // Re-render with the SAME (already-verified) ticket — its original expiry stands, so this recoverable
      // error can't be looped to renew a ticket past its TTL.
      if (connectionGrants.length === 0) {
        return renderPicker(
          consentTicket ?? '',
          'Select at least one existing connection to share.',
          400,
        );
      }
    }

    const { plaintext: code, codeHash } = generateAuthorizationCode();
    const expiresAt = new Date(Date.now() + AUTHORIZATION_CODE_TTL_MS);
    if (usesHostedOauthStore()) {
      await (await hostedOauthStore()).createAuthorizationCode({
        codeHash,
        ownerSubject,
        clientId: client.id,
        redirectUri,
        scopes,
        connectionGrants,
        codeChallenge,
        codeChallengeMethod: 'S256',
        expiresAt,
      });
    } else {
      await db.insert(authorizationCodes).values({
        codeHash,
        ownerSubject,
        clientId: client.id,
        redirectUri,
        scopes,
        connectionGrants,
        codeChallenge,
        codeChallengeMethod: 'S256',
        expiresAt,
      });
    }
    await (await getUserDataStore()).writeAudit({
      actorType: 'operator',
      actorId: req.operatorSubject,
      action: 'oauth.authorize',
      targetType: 'oauth_client',
      targetId: client.id,
      sourceIp: req.ip,
    });
    return redirectWith(reply, redirectUri, { code, state });
  });

  // 3) Token endpoint — the 3rd-party server exchanges the code for an access token.
  app.post('/oauth/token', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const b = (req.body ?? {}) as Record<string, unknown>;
    const auth = await authenticateOauthClient(req);
    if (!auth.ok) return tokenError(reply, auth.status, auth.error, auth.description);
    const { client } = auth;
    const grantType = one(b.grant_type);

    if (grantType === 'authorization_code') {
      const code = one(b.code);
      const redirectUri = one(b.redirect_uri);
      const codeVerifier = one(b.code_verifier);
      if (!code) return tokenError(reply, 400, 'invalid_request', 'code is required');

      if (usesHostedOauthStore()) {
        const now = new Date();
        const grantExpiresAt =
          new Date(now.getTime() + OAUTH_GRANT_TTL_MS);
        const access = generateApiKey();
        const refresh = generateRefreshToken();
        const result = await (
          await hostedOauthStore()
        ).exchangeAuthorizationCode({
          codeHash: hashCode(code),
          client,
          redirectUri,
          codeVerifier,
          tokenMaterial: {
            accessKeyId: randomUUID(),
            accessKeyHash: access.hashedKey,
            refreshTokenHash: refresh.tokenHash,
          },
          grantExpiresAt,
          now,
          sourceIp: req.ip,
        });
        if (result.kind === 'error') {
          return tokenError(
            reply,
            400,
            'invalid_grant',
            result.description,
          );
        }
        return reply.send(
          oauthTokenResponse(
            access.plaintext,
            refresh.plaintext,
            result.grant,
          ),
        );
      }

      const [ac] = await db.select().from(authorizationCodes).where(eq(authorizationCodes.codeHash, hashCode(code))).limit(1);
      if (!ac || ac.clientId !== client.id) return tokenError(reply, 400, 'invalid_grant', 'invalid authorization code');
      if (ac.consumedAt) return tokenError(reply, 400, 'invalid_grant', 'authorization code already used');
      if (ac.expiresAt.getTime() <= Date.now()) return tokenError(reply, 400, 'invalid_grant', 'authorization code expired');
      if (redirectUri !== ac.redirectUri) return tokenError(reply, 400, 'invalid_grant', 'redirect_uri mismatch');
      // PKCE is mandatory: every code carries an S256 challenge, so require and verify a matching verifier.
      if (!ac.codeChallenge || !codeVerifier || !verifyPkceS256(codeVerifier, ac.codeChallenge)) {
        return tokenError(reply, 400, 'invalid_grant', 'PKCE verification failed');
      }

      // Consuming the one-time code, creating the standing grant, minting both
      // token rows, and recording the security audit are one transaction. A
      // token-insert or audit failure therefore leaves the code unused and safe
      // to retry; it can never produce a consumed code with no usable token.
      const exchange = await db.transaction(async (tx) => {
        const consumed = await tx
          .update(authorizationCodes)
          .set({ consumedAt: new Date() })
          .where(and(eq(authorizationCodes.id, ac.id), isNull(authorizationCodes.consumedAt)))
          .returning({ id: authorizationCodes.id });
        if (consumed.length === 0) return null;

        const expiresAt = new Date(Date.now() + OAUTH_GRANT_TTL_MS);
        const [grant] = await tx.insert(oauthGrants).values({
          ownerSubject: ac.ownerSubject,
          clientId: client.id,
          scopes: ac.scopes,
          connectionGrants: ac.connectionGrants,
          expiresAt,
        }).returning({ id: oauthGrants.id });
        const tokens = await issueTokensForGrant(tx, client, {
          id: grant.id,
          ownerSubject: ac.ownerSubject,
          scopes: ac.scopes,
          connectionGrants: ac.connectionGrants,
          expiresAt,
        });
        await tx.insert(auditLog).values({
          actorType: 'oauth_client',
          actorId: client.id,
          action: 'oauth.token_issued',
          targetType: 'oauth_grant',
          targetId: grant.id,
          sourceIp: req.ip,
        });
        return tokens;
      });
      if (!exchange) return tokenError(reply, 400, 'invalid_grant', 'authorization code already used');
      return reply.send(exchange);
    }

    if (grantType === 'refresh_token') {
      const presented = one(b.refresh_token);
      if (!presented) return tokenError(reply, 400, 'invalid_request', 'refresh_token is required');
      if (usesHostedOauthStore()) {
        const access = generateApiKey();
        const replacement = generateRefreshToken();
        const result = await (
          await hostedOauthStore()
        ).rotateRefreshToken({
          presentedHash: hashCode(presented),
          client,
          tokenMaterial: {
            accessKeyId: randomUUID(),
            accessKeyHash: access.hashedKey,
            refreshTokenHash: replacement.tokenHash,
          },
          sourceIp: req.ip,
        });
        if (result.kind === 'error') {
          return tokenError(
            reply,
            400,
            'invalid_grant',
            result.description,
          );
        }
        return reply.send(
          oauthTokenResponse(
            access.plaintext,
            replacement.plaintext,
            result.grant,
          ),
        );
      }
      const refresh = await db.transaction(async (tx): Promise<
        | { kind: 'tokens'; tokens: Record<string, unknown> }
        | { kind: 'error'; description: string }
      > => {
        const [rt] = await tx
          .select()
          .from(oauthRefreshTokens)
          .where(eq(oauthRefreshTokens.tokenHash, hashCode(presented)))
          .limit(1);
        if (!rt) {
          return {
            kind: 'error',
            description: 'Your sign-in session is invalid. Sign in again.',
          };
        }
        const [grant] = await tx
          .select()
          .from(oauthGrants)
          .where(eq(oauthGrants.id, rt.grantId))
          .limit(1);
        if (!grant || grant.clientId !== client.id || grant.revokedAt) {
          return {
            kind: 'error',
            description: 'Your sign-in session is invalid. Sign in again.',
          };
        }
        if (rt.revokedAt) {
          return {
            kind: 'error',
            description: 'Your sign-in session has been revoked. Sign in again.',
          };
        }
        if ((rt.expiresAt && rt.expiresAt.getTime() <= Date.now())
          || grant.expiresAt.getTime() <= Date.now()) {
          return {
            kind: 'error',
            description: 'Your sign-in session has expired. Sign in again.',
          };
        }

        const revokeForReuse = async (): Promise<void> => {
          const now = new Date();
          await tx.update(oauthGrants)
            .set({ revokedAt: now })
            .where(and(eq(oauthGrants.id, grant.id), isNull(oauthGrants.revokedAt)));
          await tx.update(apiKeys)
            .set({ revokedAt: now })
            .where(and(eq(apiKeys.grantId, grant.id), isNull(apiKeys.revokedAt)));
          await tx.update(oauthRefreshTokens)
            .set({ revokedAt: now })
            .where(and(eq(oauthRefreshTokens.grantId, grant.id), isNull(oauthRefreshTokens.revokedAt)));
          await tx.insert(auditLog).values({
            actorType: 'oauth_client',
            actorId: client.id,
            action: 'oauth.refresh_reuse',
            targetType: 'oauth_grant',
            targetId: grant.id,
            sourceIp: req.ip,
          });
        };

        if (rt.consumedAt) {
          await revokeForReuse();
          return {
            kind: 'error',
            description: 'We detected a security issue with your sign-in session and revoked access. Sign in again.',
          };
        }

        // Rotation is atomic with both replacement token inserts. A concurrent
        // replay that loses this compare-and-set revokes the entire grant in the
        // same transaction, including the winner's newly issued access token.
        const consumed = await tx
          .update(oauthRefreshTokens)
          .set({ consumedAt: new Date() })
          .where(and(eq(oauthRefreshTokens.id, rt.id), isNull(oauthRefreshTokens.consumedAt)))
          .returning({ id: oauthRefreshTokens.id });
        if (consumed.length === 0) {
          await revokeForReuse();
          return {
            kind: 'error',
            description: 'We detected a security issue with your sign-in session and revoked access. Sign in again.',
          };
        }
        const tokens = await issueTokensForGrant(tx, client, {
          id: grant.id,
          ownerSubject: grant.ownerSubject,
          scopes: grant.scopes,
          connectionGrants: grant.connectionGrants,
          expiresAt: grant.expiresAt,
        });
        await tx.insert(auditLog).values({
          actorType: 'oauth_client',
          actorId: client.id,
          action: 'oauth.token_refreshed',
          targetType: 'oauth_grant',
          targetId: grant.id,
          sourceIp: req.ip,
        });
        return { kind: 'tokens', tokens };
      });
      if (refresh.kind === 'error') {
        return tokenError(reply, 400, 'invalid_grant', refresh.description);
      }
      return reply.send(refresh.tokens);
    }

    return tokenError(reply, 400, 'unsupported_grant_type', 'grant_type must be authorization_code or refresh_token');
  });

  // RFC 7009 token revocation. Always 200 (no token-existence oracle). Revoking a refresh token revokes the
  // whole grant (access + refresh); revoking an access token drops just that token.
  app.post('/oauth/revoke', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const auth = await authenticateOauthClient(req);
    if (!auth.ok) return tokenError(reply, auth.status, auth.error, auth.description);
    const { client } = auth;
    const token = one(((req.body ?? {}) as Record<string, unknown>).token);
    if (token) {
      if (usesHostedOauthStore()) {
        await (await hostedOauthStore()).revokeToken(
          client.id,
          hashCode(token),
        );
        return reply.code(200).send({});
      }
      const [ak] = await db.select({ id: apiKeys.id, grantId: apiKeys.grantId }).from(apiKeys).where(eq(apiKeys.hashedKey, hashApiKey(token))).limit(1);
      if (ak?.grantId) {
        const [g] = await db.select({ clientId: oauthGrants.clientId }).from(oauthGrants).where(eq(oauthGrants.id, ak.grantId)).limit(1);
        if (g?.clientId === client.id) await db.update(apiKeys).set({ revokedAt: new Date() }).where(eq(apiKeys.id, ak.id));
      }
      const [rt] = await db.select({ grantId: oauthRefreshTokens.grantId }).from(oauthRefreshTokens).where(eq(oauthRefreshTokens.tokenHash, hashCode(token))).limit(1);
      if (rt) {
        const [g] = await db.select({ clientId: oauthGrants.clientId }).from(oauthGrants).where(eq(oauthGrants.id, rt.grantId)).limit(1);
        if (g?.clientId === client.id) await revokeGrant(db, rt.grantId);
      }
    }
    return reply.code(200).send({});
  });

  // RFC 7662 token introspection. Reveals a token as active ONLY to the client that owns it (via its grant).
  app.post('/oauth/introspect', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const auth = await authenticateOauthClient(req);
    if (!auth.ok) return tokenError(reply, auth.status, auth.error, auth.description);
    const { client } = auth;
    const token = one(((req.body ?? {}) as Record<string, unknown>).token);
    const inactive = { active: false };
    if (!token) return reply.send(inactive);

    if (usesHostedOauthStore()) {
      const result = await (await hostedOauthStore()).introspectToken(
        client.id,
        hashCode(token),
      );
      if (!result) return reply.send(inactive);
      return reply.send({
        active: true,
        scope: result.scopes.join(' '),
        client_id: client.clientId,
        token_type: result.tokenType,
        exp: result.expiresAt
          ? Math.floor(result.expiresAt.getTime() / 1000)
          : undefined,
      });
    }

    const [ak] = await db.select().from(apiKeys).where(eq(apiKeys.hashedKey, hashApiKey(token))).limit(1);
    if (ak?.grantId) {
      const [g] = await db.select().from(oauthGrants).where(eq(oauthGrants.id, ak.grantId)).limit(1);
      const active = !ak.revokedAt && (!ak.expiresAt || ak.expiresAt.getTime() > Date.now())
        && !!g && g.clientId === client.id && !g.revokedAt && g.expiresAt.getTime() > Date.now();
      if (!active) return reply.send(inactive);
      return reply.send({
        active: true, scope: (ak.scopes ?? []).join(' '), client_id: client.clientId,
        token_type: 'Bearer', exp: ak.expiresAt ? Math.floor(ak.expiresAt.getTime() / 1000) : undefined,
      });
    }
    const [rt] = await db.select().from(oauthRefreshTokens).where(eq(oauthRefreshTokens.tokenHash, hashCode(token))).limit(1);
    if (rt) {
      const [g] = await db.select().from(oauthGrants).where(eq(oauthGrants.id, rt.grantId)).limit(1);
      const active = !rt.revokedAt && !rt.consumedAt && (!rt.expiresAt || rt.expiresAt.getTime() > Date.now())
        && !!g && g.clientId === client.id && !g.revokedAt && g.expiresAt.getTime() > Date.now();
      if (active && g) return reply.send({
        active: true, scope: (g.scopes ?? []).join(' '), client_id: client.clientId,
        token_type: 'refresh_token', exp: rt.expiresAt ? Math.floor(rt.expiresAt.getTime() / 1000) : undefined,
      });
    }
    return reply.send(inactive);
  });
}

function tokenError(reply: FastifyReply, code: number, error: string, description: string): FastifyReply {
  if (code === 401) reply.header('WWW-Authenticate', 'Basic realm="oauth"');
  return reply.code(code).type('application/json').send({ error, error_description: description });
}

/** Registers a urlencoded body parser so the consent form and the OAuth token endpoint accept
 *  application/x-www-form-urlencoded (repeated keys → arrays), without adding a dependency. */
export function registerFormBodyParser(app: FastifyInstance): void {
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req: FastifyRequest, body: string | Buffer, done) => {
    try {
      const params = new URLSearchParams(typeof body === 'string' ? body : body.toString('utf8'));
      const obj: Record<string, string | string[]> = {};
      for (const key of new Set(params.keys())) {
        const all = params.getAll(key);
        obj[key] = all.length > 1 ? all : all[0];
      }
      done(null, obj);
    } catch (err) {
      done(err as Error);
    }
  });
}
