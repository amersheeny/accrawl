/**
 * Reduce a browser URL to the non-secret location needed for diagnostics and
 * crawl context. Authentication redirects routinely carry codes, state, and
 * tokens in credentials, query strings, or fragments; none of those values may
 * cross the browser boundary into model context, logs, or durable step data.
 */
export function safeBrowserUrl(raw: string, baseUrl?: string): string {
  if (typeof raw !== 'string' || raw.length === 0) return '';
  try {
    const parsed = baseUrl === undefined ? new URL(raw) : new URL(raw, baseUrl);
    if (
      parsed.protocol === 'http:'
      || parsed.protocol === 'https:'
      || parsed.protocol === 'ws:'
      || parsed.protocol === 'wss:'
    ) {
      return `${parsed.origin}${parsed.pathname}`;
    }
    if (parsed.protocol === 'about:') {
      return `about:${parsed.pathname}`;
    }
    if (
      parsed.protocol === 'chrome:'
      || parsed.protocol === 'chrome-error:'
      || parsed.protocol === 'devtools:'
    ) {
      return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
    }
    // Opaque URLs can place their entire payload in pathname (for example
    // data: and blob:), so retaining only the scheme is the safe diagnostic.
    return parsed.protocol;
  } catch {
    // Never echo malformed, attacker-controlled input on the failure path.
    return '';
  }
}

/**
 * Scrub absolute browser/network URLs embedded inside free-form diagnostics.
 * Dedicated URL fields should call safeBrowserUrl directly; this is the
 * defense-in-depth boundary for browser/library error messages and
 * model-authored notes.
 */
export function safeBrowserUrlsInText(text: string, baseUrl?: string): string {
  const absoluteSafe = text.replace(
    /(?:https?|wss?|ftp|file|blob|data|mailto|tel):[^\s<>"'`]+|(?<!:)\/\/[^\s<>"'`]+/giu,
    (candidate) => {
      if (candidate.startsWith('//') && baseUrl === undefined) {
        const parsed = safeBrowserUrl(`https:${candidate}`);
        return parsed.startsWith('https:') ? parsed.slice('https:'.length) : '';
      }
      return safeBrowserUrl(candidate, baseUrl);
    },
  );
  return absoluteSafe.replace(
    /(^|[\s([{:;,="' ])((?:(?:\/|\.{1,2}\/)[^\s<>"'`?#]*)?[?#][^\s<>"'`]+)/giu,
    (_whole, prefix: string, candidate: string) => {
      if (baseUrl !== undefined) {
        return `${prefix}${safeBrowserUrl(candidate, baseUrl)}`;
      }
      // Without a page base we cannot reconstruct an origin. Retain a
      // relative path when one exists, but never the query/fragment payload.
      const path = candidate.search(/[?#]/);
      return `${prefix}${path > 0 ? candidate.slice(0, path) : ''}`;
    },
  );
}
