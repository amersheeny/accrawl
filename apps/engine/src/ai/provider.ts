/**
 * AI Provider Interface
 *
 * Abstracts the two AI call sites in CrawlSession.runInnerLoop behind a
 * provider interface. Gemini is the sole crawling provider.
 *
 * The provider interface uses Anthropic.MessageParam[] as the shared message
 * format — it's already installed and is a complete multi-turn representation.
 * Gemini handles its own conversion internally.
 */

import type Anthropic from '@anthropic-ai/sdk' with { 'resolution-mode': 'require' };
import type { InfoOutput, StepResponse } from './schema';
import type { TokenUsage } from '../types';
import type { SessionLogger } from '../utils/logger';
import { GeminiProvider, type InteractionsThinkingLevel } from './providers/gemini';

// ─── Result types ─────────────────────────────────────────────────────────────

export interface InfoPhaseResult {
  /** Parsed discriminated union from the model's JSON response. */
  output: InfoOutput;
  /** Original JSON text from the model — stored as assistant turn in history. */
  rawJson: string;
  usage: TokenUsage;
}

export interface StepPhaseResult {
  /** Validated step response from the model. */
  response: StepResponse;
  /**
   * The assistant turn to push to message history.
   * Synthetic [{ type:'tool_use', id, name, input }] built from Gemini function call.
   * trimHistory() knows how to handle tool_use blocks.
   */
  assistantContent: Anthropic.ContentBlockParam[];
  /**
   * ID for the tool_result acknowledgment message (crypto.randomUUID()).
   */
  toolUseId: string;
  usage: TokenUsage;
}

// ─── Provider interface ────────────────────────────────────────────────────────

export interface AIProvider {
  setLogger?(logger: SessionLogger): void;

  sendInfoPhase(
    messages: Anthropic.MessageParam[],
    systemPrompt: string,
  ): Promise<InfoPhaseResult>;

  sendStepPhase(
    messages: Anthropic.MessageParam[],
    systemPrompt: string,
  ): Promise<StepPhaseResult>;
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create the appropriate AIProvider for a given model ID.
 * Only gemini-* models are supported for crawling.
 * Throws on unknown prefix — no silent fallback.
 */
export function createProvider(modelId: string, logger?: SessionLogger, thinkingLevel?: InteractionsThinkingLevel): AIProvider {
  if (modelId.startsWith('gemini-')) {
    const provider = new GeminiProvider(modelId, thinkingLevel);
    if (logger) provider.setLogger(logger);
    return provider;
  }
  throw new Error(`[createProvider] Unknown model prefix for "${modelId}". Only gemini-* models are supported.`);
}
