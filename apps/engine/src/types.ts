/**
 * Engine type surface.
 *
 * The shared CONTRACT (crawl request/response + normalized domain types) lives in
 * `@accrawl/contracts` and is re-exported here so existing `import { ... } from
 * './types'` call sites keep working. Only engine-internal types that never cross
 * the API boundary are defined locally below.
 */

export * from '@accrawl/contracts';

// ─── Engine-internal types (not part of the shared contract) ─────────

/** Current page state captured for a step — stored in session, served via tools. */
export interface PageState {
  /** Full-page JPEG screenshot as base64 (compressed: resized + lower quality) */
  screenshotBase64: string;
  /** Full sanitized HTML — model reads via readHtml tool */
  fullHtml: string;
  /** Total HTML length in characters */
  htmlLength: number;
}

/** Agent goal — simplified to login then extract. */
export type AgentGoal = 'login' | 'extract';
