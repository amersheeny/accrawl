/**
 * Gemini models the crawl engine can run — the one canonical list, shared by the engine (default
 * model selection) and the operator console (the per-institution model picker). Keep in sync with
 * the engine's pricing table when adding a model.
 */
export interface CrawlModelOption {
  /** Model id as sent to the Gemini API. */
  id: string;
  /** Human-readable label for pickers. */
  label: string;
}

/** The model used when an institution has no override and GEMINI_MODEL is unset. */
export const DEFAULT_CRAWL_MODEL = 'gemini-3.5-flash';

export const CRAWL_MODELS: readonly CrawlModelOption[] = [
  { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash' },
  { id: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash Lite' },
  { id: 'gemini-3-flash', label: 'Gemini 3 Flash' },
  { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
  { id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash Lite' },
  { id: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash' },
] as const;
