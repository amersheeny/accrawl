/**
 * Write gate (§2 — capability default-deny for state-changing requests).
 *
 * The agent is READ-ONLY: log in, navigate, extract. The previous guard tried to enforce that by
 * reading the clicked element's visible LABEL against a phrase list, which cannot work at any list
 * size for three reasons: an icon-only control resolves to an empty name and matches nothing; a
 * wizard's final button commonly reads "Confirm"/"OK"/"Yes"/"Continue", words that must be clicked on
 * benign dialogs and refused on a transfer, so no list can decide them; and the label is a localized
 * presentation string in a product that supports institutions in every language.
 *
 * This gate reads the EFFECT instead. Money cannot move without a non-idempotent HTTP request, and
 * that request is observed after all JavaScript, frameworks and shadow DOM have had their say — so it
 * is identical whether the button was an icon, blank, or written in any script on earth.
 *
 * The rule is temporal, not a list. There is no allowlist of paths, no per-institution
 * configuration, and nothing an operator authors:
 *
 *   phase 'login'    — non-idempotent requests are permitted. Authentication genuinely needs to POST
 *                      credentials and an OTP, and the loop is following a fixed procedure here.
 *   phase 'extract'  — non-idempotent requests are DENIED unless a vet classifies the request itself
 *                      as a read. This is the phase where the agent explores and where a hostile
 *                      config or injected page content would try to move money.
 *
 * The vet exists because a data-fetch POST and a transfer POST are indistinguishable at the HTTP
 * layer — same method, same origin, same content-type — and denying every POST during extraction
 * would break the large class of portals that post back on every interaction (pagination, tab
 * switches, date filters). It is shown request METADATA only: method, origin+path, parameter NAMES,
 * and OPERATION HINTS. Never page content, never a free-form value.
 *
 * Operation hints exist because parameter names alone are not sufficient on the very sites the vet
 * is there to support: a postback portal sends the same names on every interaction and carries the
 * operation in a value (`__EVENTTARGET=ctl00$btnTransfer`). A hint is therefore admitted only when a
 * value is IDENTIFIER-SHAPED — begins with a letter, then letters/digits/`_$.:-`, at most 64
 * characters. That admits `transfer`, `btnConfirm`, `ctl00$btnTransfer`, and excludes view-state
 * blobs, tokens, JWTs, and every all-numeric value, so account numbers, PINs and OTPs cannot be
 * carried into the call.
 *
 * Every path that is not an explicit allow is a deny: no vet configured, a vet that throws, a vet
 * that times out, an unrecognised verdict, and an unparseable body all deny.
 *
 * Residual, stated rather than hidden: a GET that mutates is not covered, since GET is the read
 * path. And because hints and names originate in the page, a crafted control name could argue for a
 * `read` verdict — the vet's response schema is a closed enum so injection cannot change the SHAPE
 * of the answer, and the phase gate means an attacker must already be past authentication, but this
 * is a bounded mitigation and not a proof.
 */
import type { SessionLogger } from '../utils/logger';

/** The crawl's capability phase. Mirrors the agent loop's own `login` → `extract` transition. */
export type CrawlPhase = 'login' | 'extract';

/** What the vet decides about a single request. */
export type RequestVerdict = 'read' | 'write';

/** Request metadata the vet is allowed to see. Page content is deliberately absent. */
export interface VettableRequest {
  method: string;
  /** Origin + path only; query, fragment and credentials already stripped by safeBrowserUrl. */
  safeUrl: string;
  /** Parameter names from the body and query string — names ONLY. */
  parameterNames: string[];
  /** Identifier-shaped parameter values only (see the module doc); never free-form user data. */
  operationHints: string[];
}

export type RequestVet = (request: VettableRequest) => Promise<RequestVerdict>;

export interface WriteGateDecision {
  allowed: boolean;
  /** Short machine-stable reason, used in logs and in the feedback returned to the model. */
  reason: string;
}

/**
 * Methods that may change server state. GET/HEAD/OPTIONS are the read path and are always allowed;
 * a GET that mutates is a residual this gate does not close (see the module doc).
 */
export const NON_IDEMPOTENT_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function isNonIdempotent(method: string): boolean {
  return NON_IDEMPOTENT_METHODS.has(method.toUpperCase());
}

/** Bound the metadata handed to the vet so a hostile body cannot inflate the call. */
const MAX_PARAMETER_NAMES = 40;
const MAX_PARAMETER_NAME_LENGTH = 60;
const MAX_JSON_DEPTH = 3;

/**
 * A value may become an operation hint only if it is identifier-shaped: a leading letter, then
 * letters/digits/`_$.:-`, at most 64 characters. The leading-letter rule is what keeps every
 * all-numeric value out, so account numbers, PINs and OTPs are structurally excluded.
 */
const OPERATION_HINT = /^[A-Za-z][A-Za-z0-9_$.:-]{0,63}$/;

export function isOperationHint(value: unknown): value is string {
  return typeof value === 'string' && OPERATION_HINT.test(value);
}

/** Parameter names and operation hints extracted from one request. */
export interface RequestParameters {
  names: string[];
  hints: string[];
}

export const EMPTY_PARAMETERS: RequestParameters = { names: [], hints: [] };

function capped(values: Iterable<string>, maxLength: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    if (typeof raw !== 'string' || raw.length === 0) continue;
    const value = raw.slice(0, maxLength);
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
    if (out.length >= MAX_PARAMETER_NAMES) break;
  }
  return out;
}

function collect(pairs: Iterable<[string, string]>): RequestParameters {
  const names: string[] = [];
  const hints: string[] = [];
  for (const [name, value] of pairs) {
    names.push(name);
    if (isOperationHint(value)) hints.push(value);
  }
  return { names: capped(names, MAX_PARAMETER_NAME_LENGTH), hints: capped(hints, MAX_PARAMETER_NAME_LENGTH) };
}

function walkJson(value: unknown, depth: number, names: string[], hints: string[]): void {
  if (depth > MAX_JSON_DEPTH || names.length >= MAX_PARAMETER_NAMES) return;
  if (Array.isArray(value)) {
    for (const entry of value) walkJson(entry, depth + 1, names, hints);
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      names.push(key);
      if (isOperationHint(entry)) hints.push(entry);
      if (names.length >= MAX_PARAMETER_NAMES) return;
      walkJson(entry, depth + 1, names, hints);
    }
  }
}

/**
 * Parameters carried by a request body. An unparseable body yields nothing — which costs the vet
 * signal but never leaks a value, and never turns a deny into an allow.
 */
export function bodyParameters(contentType: string | undefined, body: string | null): RequestParameters {
  if (!body) return EMPTY_PARAMETERS;
  const type = (contentType ?? '').toLowerCase();
  try {
    if (type.includes('application/json')) {
      const names: string[] = [];
      const hints: string[] = [];
      walkJson(JSON.parse(body), 0, names, hints);
      return { names: capped(names, MAX_PARAMETER_NAME_LENGTH), hints: capped(hints, MAX_PARAMETER_NAME_LENGTH) };
    }
    if (type.includes('multipart/form-data')) {
      const names: string[] = [];
      for (const match of body.matchAll(/\bname="([^"]{1,200})"/g)) names.push(match[1]);
      return { names: capped(names, MAX_PARAMETER_NAME_LENGTH), hints: [] };
    }
    // Default to form-urlencoded: it is the overwhelmingly common form post, and sites routinely omit
    // or mislabel the header. URLSearchParams never throws, so a non-form body simply yields nothing.
    return collect(new URLSearchParams(body).entries());
  } catch {
    return EMPTY_PARAMETERS;
  }
}

/** Parameters carried by a URL's query string. */
export function queryParameters(url: string): RequestParameters {
  try {
    return collect(new URL(url).searchParams.entries());
  } catch {
    return EMPTY_PARAMETERS;
  }
}

/** Union of several parameter sets, deduplicated and capped. */
export function mergeParameters(...parts: RequestParameters[]): RequestParameters {
  return {
    names: capped(parts.flatMap((p) => p.names), MAX_PARAMETER_NAME_LENGTH),
    hints: capped(parts.flatMap((p) => p.hints), MAX_PARAMETER_NAME_LENGTH),
  };
}

export interface WriteGateOptions {
  /**
   * Classifier for a non-idempotent request during extraction. Omitted means every such request is
   * denied — the gate is useful without a model, just stricter.
   */
  vet?: RequestVet;
  /** A vet that has not answered in this long is treated as a denial. */
  vetTimeoutMs?: number;
  logger?: SessionLogger;
}

const DEFAULT_VET_TIMEOUT_MS = 15_000;

export class WriteGate {
  private currentPhase: CrawlPhase = 'login';
  private readonly verdicts = new Map<string, RequestVerdict>();
  private readonly blocked: string[] = [];
  private readonly vet?: RequestVet;
  private readonly vetTimeoutMs: number;
  private readonly log: SessionLogger | Console;

  constructor(options: WriteGateOptions = {}) {
    this.vet = options.vet;
    this.vetTimeoutMs = options.vetTimeoutMs ?? DEFAULT_VET_TIMEOUT_MS;
    this.log = options.logger ?? console;
  }

  get phase(): CrawlPhase {
    return this.currentPhase;
  }

  /**
   * Follow the agent loop's own phase. `loginComplete` closes the write window for the rest of the
   * crawl; `loginFlowRestarted` reopens it for a genuine re-authentication.
   */
  setPhase(phase: CrawlPhase): void {
    if (phase === this.currentPhase) return;
    this.currentPhase = phase;
    this.log.log(
      phase === 'extract'
        ? '[WriteGate] Login complete — state-changing requests are now denied for the rest of the crawl.'
        : '[WriteGate] Re-authentication started — state-changing requests permitted until login completes.',
    );
  }

  /**
   * The key is EXACTLY what the vet was shown, so a cache hit is by construction the same question
   * the vet already answered. Keying on the endpoint alone would be a bypass: a portal that carries
   * its operation in a value (`do=list` then `do=transfer`, or two different `__EVENTTARGET`s on one
   * page) would let a transfer inherit the read verdict earned by a listing.
   */
  private cacheKey(request: VettableRequest): string {
    const names = [...request.parameterNames].sort().join(',');
    const hints = [...request.operationHints].sort().join(',');
    return `${request.method.toUpperCase()} ${request.safeUrl} n=[${names}] h=[${hints}]`;
  }

  /**
   * Blocked attempts since the last drain. The agent loop turns these into feedback so the model
   * learns its action was refused and continues read-only — without a denial the page would simply
   * appear broken and the model would retry it.
   */
  drainBlocked(): string[] {
    return this.blocked.splice(0, this.blocked.length);
  }

  private deny(request: VettableRequest, reason: string): WriteGateDecision {
    this.blocked.push(`${request.method.toUpperCase()} ${request.safeUrl} (${reason})`);
    return { allowed: false, reason };
  }

  async evaluate(request: VettableRequest): Promise<WriteGateDecision> {
    if (!isNonIdempotent(request.method)) {
      return { allowed: true, reason: 'idempotent method' };
    }
    if (this.currentPhase === 'login') {
      return { allowed: true, reason: 'authentication phase' };
    }

    const key = this.cacheKey(request);
    const cached = this.verdicts.get(key);
    if (cached) {
      return cached === 'read'
        ? { allowed: true, reason: 'vetted as a data read (cached)' }
        : this.deny(request, 'vetted as a state change (cached)');
    }

    if (!this.vet) {
      return this.deny(request, 'state-changing method after login, and no request vet is configured');
    }

    let verdict: RequestVerdict;
    try {
      verdict = await this.withTimeout(this.vet(request));
    } catch (error) {
      // Deny-biased: a vet that fails tells us nothing, and nothing is not permission. The verdict is
      // deliberately NOT cached, so a transient model failure does not blacklist a real read endpoint
      // for the rest of the crawl.
      this.log.warn(
        `[WriteGate] Vet failed for ${key} (${error instanceof Error ? error.message : String(error)}) — denying.`,
      );
      return this.deny(request, 'request vet did not return a verdict');
    }

    this.verdicts.set(key, verdict);
    return verdict === 'read'
      ? { allowed: true, reason: 'vetted as a data read' }
      : this.deny(request, 'vetted as a state change');
  }

  private withTimeout(promise: Promise<RequestVerdict>): Promise<RequestVerdict> {
    return new Promise<RequestVerdict>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`vet timed out after ${this.vetTimeoutMs}ms`)), this.vetTimeoutMs);
      promise.then(
        (value) => { clearTimeout(timer); resolve(value); },
        (error) => { clearTimeout(timer); reject(error instanceof Error ? error : new Error(String(error))); },
      );
    });
  }
}
