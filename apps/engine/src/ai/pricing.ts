/**
 * AI Provider Pricing
 *
 * Per-model token rates in USD per million tokens.
 * Used to calculate crawl session costs from raw token counts.
 *
 * Gemini source: https://ai.google.dev/gemini-api/docs/pricing
 * Last verified: 2026-06-17 (added gemini-3.5-flash)
 */

import type { TokenUsage, CrawlCost } from '../types';

/** Pricing rates in USD per million tokens */
interface ModelPricing {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheCreationPerMTok: number;
  cacheReadPerMTok: number;
}

/** Known model pricing. Keyed by model ID prefix for fuzzy matching.
 *  Gemini has no ephemeral-cache-creation charge; cacheCreation is always 0. */
const MODEL_PRICING: Record<string, ModelPricing> = {
  'gemini-2.5-flash-lite': {
    inputPerMTok: 0.015,
    outputPerMTok: 0.06,
    cacheCreationPerMTok: 0,
    cacheReadPerMTok: 0,
  },
  'gemini-2.5-flash': {
    inputPerMTok: 0.30,
    outputPerMTok: 2.50,
    cacheCreationPerMTok: 0,
    cacheReadPerMTok: 0.075,  // cached input ≈ 25% of input rate
  },
  'gemini-2.0-flash': {
    inputPerMTok: 0.075,
    outputPerMTok: 0.30,
    cacheCreationPerMTok: 0,
    cacheReadPerMTok: 0,
  },
  'gemini-3-flash': {
    inputPerMTok: 0.50,
    outputPerMTok: 3.00,
    cacheCreationPerMTok: 0,
    cacheReadPerMTok: 0,
  },
  'gemini-3.1-flash-lite': {
    inputPerMTok: 0.25,
    outputPerMTok: 1.50,
    cacheCreationPerMTok: 0,
    cacheReadPerMTok: 0,
  },
  // GA 2026-05-19. Cached-input billed at $0.15/MTok (90% off input);
  // no separate cache-creation charge.
  'gemini-3.5-flash': {
    inputPerMTok: 1.50,
    outputPerMTok: 9.00,
    cacheCreationPerMTok: 0,
    cacheReadPerMTok: 0.15,
  },
};

/**
 * Look up pricing for a model ID.
 * Matches by prefix (e.g. "gemini-2.5-flash-preview" matches "gemini-2.5-flash").
 * Falls back to Gemini 2.5 Flash pricing if unknown model — logged as warning.
 */
function getPricing(modelId: string): ModelPricing {
  for (const [prefix, pricing] of Object.entries(MODEL_PRICING)) {
    if (modelId.startsWith(prefix)) {
      return pricing;
    }
  }
  console.warn(`[Pricing] Unknown model "${modelId}", using gemini-2.5-flash pricing as fallback`);
  return MODEL_PRICING['gemini-2.5-flash'];
}

/**
 * Create a zero-value TokenUsage.
 */
export function emptyUsage(): TokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  };
}

/**
 * Add two TokenUsage objects together.
 */
export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheCreationInputTokens: a.cacheCreationInputTokens + b.cacheCreationInputTokens,
    cacheReadInputTokens: a.cacheReadInputTokens + b.cacheReadInputTokens,
  };
}

/**
 * Calculate the cost of a crawl session from accumulated token usage.
 *
 * @param modelId - The model ID used (e.g. "gemini-2.5-flash")
 * @param usage - Total token counts across all API calls in the session
 * @returns CrawlCost with per-category and total USD cost
 */
export function calculateCost(modelId: string, usage: TokenUsage): CrawlCost {
  const pricing = getPricing(modelId);

  const inputCostUsd = (usage.inputTokens / 1_000_000) * pricing.inputPerMTok;
  const outputCostUsd = (usage.outputTokens / 1_000_000) * pricing.outputPerMTok;
  const cacheCreationCostUsd = (usage.cacheCreationInputTokens / 1_000_000) * pricing.cacheCreationPerMTok;
  const cacheReadCostUsd = (usage.cacheReadInputTokens / 1_000_000) * pricing.cacheReadPerMTok;

  // Round to 6 decimal places to avoid floating-point noise
  const round = (n: number) => Math.round(n * 1_000_000) / 1_000_000;

  return {
    modelId,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheCreationInputTokens: usage.cacheCreationInputTokens,
    cacheReadInputTokens: usage.cacheReadInputTokens,
    inputCostUsd: round(inputCostUsd),
    outputCostUsd: round(outputCostUsd),
    cacheCreationCostUsd: round(cacheCreationCostUsd),
    cacheReadCostUsd: round(cacheReadCostUsd),
    totalCostUsd: round(inputCostUsd + outputCostUsd + cacheCreationCostUsd + cacheReadCostUsd),
  };
}
