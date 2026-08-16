/**
 * Gemini AI Provider (sole crawling provider)
 *
 * Implements the two-phase architecture using Gemini function calling:
 * - Info phase: functionDeclarations for read/search/screenshot/step
 * - Step phase: per-action functionDeclarations
 *
 * Schema enforcement uses native Gemini Schema objects (parameters field)
 * so the grammar engine compiles grammars without unsupported JSON Schema
 * features (additionalProperties: false from Zod .strict()).
 *
 * Contract enforcement delegated to Gemini via:
 * - per-function `parameters` (native Schema type, not parametersJsonSchema)
 * - `FunctionCallingConfigMode.ANY` with explicit allowed function names
 */

import { GoogleGenAI, FunctionCallingConfigMode } from '@google/genai';
import type {
  Candidate, Content, FunctionCall, GenerateContentResponse, Part,
} from '@google/genai';
// Interactions API types — imported as namespace to avoid collisions with generateContent types
import type { Interactions } from '@google/genai';
import type Anthropic from '@anthropic-ai/sdk';
import {
  GEMINI_INFO_FUNCTION_DECLARATIONS,
  GEMINI_INFO_FUNCTION_NAMES,
  GEMINI_STEP_FUNCTION_DECLARATIONS,
  GEMINI_STEP_FUNCTION_NAMES,
  GEMINI_ALL_FUNCTION_DECLARATIONS,
  GEMINI_ALL_FUNCTION_NAMES,
  isGeminiInfoFunctionName,
  isStepToolName,
  mapGeminiInfoFunctionCallUnchecked,
  mapStepToolCallUnchecked,
  type InfoOutput,
  type StepResponse,
} from '../schema';
import type { TokenUsage } from '../../types';
import type { AIProvider, InfoPhaseResult, StepPhaseResult } from '../provider';
import { buildHardenedSystemInstruction } from '../reliability';
import { addUsage, emptyUsage } from '../pricing';
import type { SessionLogger } from '../../utils/logger';
import { ApiContractError, isApiContractDriftMessage } from './errors';

/**
 * If an LLM error looks like a request/response CONTRACT drift (unknown/renamed
 * parameter, invalid_request, unexpected shape), surface it as a typed
 * ApiContractError. This makes a schema-drift outage classified and alertable
 * immediately (failureReason: 'api_contract_drift') rather than an opaque 400 —
 * and the caller fails fast instead of retrying a request that can never succeed.
 *
 * Limited to 4xx-shaped errors: a transient 5xx/timeout/network blip can also
 * carry words like "unexpected", and those SHOULD still be retried.
 */
function maybeThrowApiContractError(err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  const looks4xx = /\b4\d{2}\b|invalid_request|unknown parameter|not supported/i.test(msg);
  if (looks4xx && isApiContractDriftMessage(msg)) {
    throw new ApiContractError(`LLM request rejected — API contract drift: ${msg}`);
  }
}

// ─── Client ──────────────────────────────────────────────────────────────────

const GEMINI_REQUEST_TIMEOUT_MS = Number(process.env.GEMINI_REQUEST_TIMEOUT_MS ?? '90000');
const GEMINI_INFO_MAX_OUTPUT_TOKENS = Number(process.env.GEMINI_INFO_MAX_OUTPUT_TOKENS ?? '1024');
const GEMINI_STEP_MAX_OUTPUT_TOKENS = Number(process.env.GEMINI_STEP_MAX_OUTPUT_TOKENS ?? '16384');
const GEMINI_STEP_PHASE_MAX_RETRIES = Number(process.env.GEMINI_STEP_PHASE_MAX_RETRIES ?? '4');
const GEMINI_STEP_RETRY_MAX_OUTPUT_TOKENS = Number(process.env.GEMINI_STEP_RETRY_MAX_OUTPUT_TOKENS ?? '8192');

/**
 * Returns generation_config parameters for the Interactions API.
 *
 * The Interactions API exposes thinking ONLY via `thinking_level` (a lowercase
 * enum: 'minimal' | 'low' | 'medium' | 'high') — it has no numeric
 * `thinking_budget` field (verified against the @google/genai Interactions
 * GenerationConfig type and the Interactions API reference). This is true even
 * for Gemini 2.x models on this API: the Interactions surface normalizes 2.5's
 * generateContent-style numeric thinkingBudget onto the level enum.
 *
 * Previously this function set NO thinking config for 2.x models on the active
 * Interactions path, diverging from the legacy generateContent path which set
 * thinkingBudget: 5000 (getModelConfig). We now set the equivalent thinking_level
 * for 2.x too so the active path matches the intended budget (see
 * GEMINI2_INTERACTIONS_THINKING_LEVEL).
 */
export function getInteractionsGenerationConfig(
  modelId: string,
  maxOutputTokens: number,
  allowedToolNames?: string[],
  thinkingLevel?: InteractionsThinkingLevel,
): Record<string, unknown> {
  const base: Record<string, unknown> = { max_output_tokens: maxOutputTokens };
  if (isGemini3Model(modelId)) {
    base.temperature = 0;
    base.thinking_level = thinkingLevel ?? toInteractionsThinkingLevel(GEMINI_THINKING_LEVEL);
  } else {
    base.temperature = 0;
    // thinking_level is the API-native knob on this path, so an explicit per-crawl level
    // applies to 2.x models too; only the fallback differs by model generation.
    base.thinking_level = thinkingLevel ?? GEMINI2_INTERACTIONS_THINKING_LEVEL;
  }
  // Restrict which tools the model may call. The server-side history remembers
  // tools from all previous interactions — without tool_choice, the model may
  // call step-phase tools during the info phase (and vice versa).
  // Force function calls with 'any' mode — the model must call a function on every interaction.
  // The 'tools' list restricts WHICH functions are available (prevents step tools during info phase).
  // The Interactions API nests mode/tools under `allowed_tools` (a ToolChoiceConfig);
  // `mode`/`tools` directly on `tool_choice` is rejected with 400 "Unknown parameter 'mode'".
  if (allowedToolNames && allowedToolNames.length > 0) {
    base.tool_choice = { allowed_tools: { mode: 'any', tools: allowedToolNames } };
  }
  return base;
}

/**
 * Feature flag: use Gemini Interactions API for server-side conversation history.
 * When enabled, the server maintains conversation state and we only send new content
 * per turn. When disabled, falls back to client-managed history via generateContent.
 *
 * The Interactions API is in public Beta (as of March 2026). If it proves unreliable,
 * set USE_INTERACTIONS_API=false to revert to the legacy path. All legacy history
 * management code (trimHistory, consolidateInnerLoop, toGeminiContents) is retained
 * as a fallback.
 */
export const USE_INTERACTIONS_API = process.env.USE_INTERACTIONS_API !== 'false';

// ─── Model-generation-aware config ──────────────────────────────────────────

/** Returns true for Gemini 3.x family models (3-flash, 3.1-flash-lite, etc.). */
export function isGemini3Model(modelId: string): boolean {
  return /^gemini-3/.test(modelId);
}

type Gemini3ThinkingLevel = 'LOW' | 'MEDIUM';
const GEMINI_THINKING_LEVEL: Gemini3ThinkingLevel =
  (process.env.GEMINI_THINKING_LEVEL as Gemini3ThinkingLevel) || 'MEDIUM';

/** Lowercase thinking_level enum accepted by the Interactions API generation_config. */
export type InteractionsThinkingLevel = 'minimal' | 'low' | 'medium' | 'high';

/**
 * Interactions-API thinking level for Gemini 2.x models. The 'low' level maps to
 * a modest generateContent thinkingBudget of ~5000 tokens. Gemini 2.5 Flash's
 * thinking budget range is roughly 0–24576 tokens, so 5000 (~20% of max) is a
 * modest budget that corresponds to the 'low' level on the enum-based Interactions API.
 */
export const GEMINI2_INTERACTIONS_THINKING_LEVEL: InteractionsThinkingLevel = 'low';

/**
 * The generateContent ThinkingLevel enum is UPPERCASE (LOW/MEDIUM), but the
 * Interactions API thinking_level enum is lowercase. Map between them so the
 * Interactions path always sends a valid value.
 */
export function toInteractionsThinkingLevel(level: Gemini3ThinkingLevel): InteractionsThinkingLevel {
  return level.toLowerCase() as InteractionsThinkingLevel;
}

/**
 * Map the four-level Interactions enum onto the generateContent ThinkingLevel enum used here
 * (LOW/MEDIUM): the levels below 'medium' clamp to LOW, the rest to MEDIUM.
 */
export function toGenerateContentThinkingLevel(level: InteractionsThinkingLevel): Gemini3ThinkingLevel {
  return level === 'minimal' || level === 'low' ? 'LOW' : 'MEDIUM';
}

/**
 * Returns temperature and thinkingConfig appropriate for the model generation
 * (legacy generateContent path).
 * - Gemini 2.x: temperature 0, thinkingBudget 5000. The numeric budget is this path's only
 *   thinking knob for 2.x, so a per-crawl level does not apply here (it does on the active
 *   Interactions path, which normalizes everything onto the level enum).
 * - Gemini 3.x: temperature 0, thinkingLevel enum (per-crawl level, else LOW/MEDIUM via env)
 */
export function getModelConfig(
  modelId: string,
  thinkingLevel?: InteractionsThinkingLevel,
): { temperature: number; thinkingConfig: Record<string, unknown> } {
  if (isGemini3Model(modelId)) {
    return {
      temperature: 0,
      thinkingConfig: { thinkingLevel: thinkingLevel ? toGenerateContentThinkingLevel(thinkingLevel) : GEMINI_THINKING_LEVEL },
    };
  }
  return {
    temperature: 0,
    thinkingConfig: { thinkingBudget: 5000 },
  };
}

let geminiClient: GoogleGenAI | null = null;

/**
 * The single place the model API key is read. Exported so other engine call sites (the §2 request
 * vet) reuse this client instead of duplicating key handling — two modules reading the key would be
 * two places to get its absence, rotation, or scoping wrong.
 */
export function getClient(): GoogleGenAI {
  if (!geminiClient) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('[GeminiProvider] GEMINI_API_KEY environment variable is not set');
    geminiClient = new GoogleGenAI({ apiKey });
  }
  return geminiClient;
}

// ─── Message conversion ───────────────────────────────────────────────────────

/**
 * Convert Anthropic.MessageParam[] to Gemini Content[].
 *
 * Role mapping:    'assistant' → 'model',  'user' → 'user'
 * Content mapping: text, image (base64), tool_use (functionCall), tool_result (functionResponse)
 *
 * Unknown block types produce a warning text part — never silently dropped.
 * Empty parts array after mapping throws — never produce an invalid Gemini turn.
 */
function toGeminiContents(messages: Anthropic.MessageParam[], log: SessionLogger): Content[] {
  const contents: Content[] = [];
  const toolNameByToolUseId = new Map<string, string>();

  for (const msg of messages) {
    const role = msg.role === 'assistant' ? 'model' : 'user';

    if (typeof msg.content === 'string') {
      contents.push({ role, parts: [{ text: msg.content }] });
      continue;
    }

    const parts: Part[] = [];

    for (const block of msg.content) {
      if (block.type === 'text') {
        parts.push({ text: block.text });
      } else if (block.type === 'image') {
        const src = block.source;
        if (src.type === 'base64') {
          parts.push({ inlineData: { mimeType: src.media_type, data: src.data } });
        } else {
          log.warn(`[GeminiProvider] Unsupported image source type "${src.type}", substituting placeholder`);
          parts.push({ text: '[image omitted — unsupported source type]' });
        }
      } else if (block.type === 'tool_use') {
        toolNameByToolUseId.set(block.id, block.name);
        parts.push({
          functionCall: {
            name: block.name,
            args: block.input as Record<string, unknown>,
          },
        });
      } else if (block.type === 'tool_result') {
        const toolResultBlock = block as Anthropic.ToolResultBlockParam;
        const content = typeof toolResultBlock.content === 'string' ? toolResultBlock.content : JSON.stringify(toolResultBlock.content);
        const functionName = toolNameByToolUseId.get(toolResultBlock.tool_use_id) ?? 'step_complete';
        parts.push({
          functionResponse: {
            name: functionName,
            response: { content },
          },
        });
      } else {
        const unknownType = (block as { type: string }).type;
        log.warn(`[GeminiProvider] Unsupported content block type "${unknownType}", substituting placeholder`);
        parts.push({ text: `[unsupported block type: ${unknownType}]` });
      }
    }

    if (parts.length === 0) {
      throw new Error(`[GeminiProvider] Message for role "${role}" produced no parts after conversion`);
    }

    contents.push({ role, parts });
  }

  return contents;
}

// ─── Request helper ───────────────────────────────────────────────────────────

async function generateGeminiRequest(
  ai: GoogleGenAI,
  params: Parameters<GoogleGenAI['models']['generateContent']>[0],
  log: SessionLogger
): Promise<GenerateContentResponse> {
  const maxRetries = 1;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await Promise.race([
        ai.models.generateContent(params),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Gemini request timeout after ${GEMINI_REQUEST_TIMEOUT_MS}ms`)), GEMINI_REQUEST_TIMEOUT_MS),
        ),
      ]);
    } catch (err) {
      // Fail fast on contract drift — never retry a malformed request.
      maybeThrowApiContractError(err);
      const msg = err instanceof Error ? err.message : String(err);
      const isTransient = /overloaded|rate.?limit|429|503|502|500|timeout|ECONNRESET|ETIMEDOUT|ENOTFOUND|socket hang up/i.test(msg);
      if (!isTransient || attempt === maxRetries) throw err;
      const delayMs = 1000 * Math.pow(2, attempt) + Math.random() * 1000;
      log.warn(`[AI] Gemini transient error (attempt ${attempt + 1}/${maxRetries + 1}): ${msg.substring(0, 200)}. Retrying in ${Math.round(delayMs / 1000)}s...`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  throw new Error('unreachable');
}

function extractFirstFunctionCall(response: GenerateContentResponse, log: SessionLogger): FunctionCall | null {
  const directCalls = response.functionCalls ?? [];
  const candidateCalls: FunctionCall[] = (response.candidates ?? [])
    .flatMap((candidate: Candidate) => candidate.content?.parts ?? [])
    .flatMap((part) => (part.functionCall ? [part.functionCall] : []));
  const calls = directCalls.length > 0 ? directCalls : candidateCalls;

  if (calls.length === 0) {
    return null;
  }
  if (calls.length > 1) {
    log.warn(`[GeminiProvider] Received ${calls.length} function calls; using the first one.`);
  }
  return calls[0] ?? null;
}

function summarizeGeminiNonToolResponse(response: GenerateContentResponse): string {
  const finishReasons = extractGeminiFinishReasons(response);
  const text = (response.candidates ?? [])
    .flatMap((candidate: Candidate) => candidate.content?.parts ?? [])
    .map(part => part.text)
    .find((t): t is string => typeof t === 'string' && t.trim().length > 0);

  return JSON.stringify({
    finishReasons,
    textPreview: text ? text.substring(0, 500) : null,
  });
}

function extractGeminiFinishReasons(response: GenerateContentResponse): string[] {
  return (response.candidates ?? [])
    .map(c => c.finishReason)
    .filter((r): r is NonNullable<typeof r> => r !== undefined && r !== null)
    .map(r => String(r));
}

function buildStepPhaseRetryPrompt(response: GenerateContentResponse): string {
  const finishReasons = extractGeminiFinishReasons(response);
  if (finishReasons.includes('MALFORMED_FUNCTION_CALL')) {
    return (
      'Your previous function call was malformed and could not be parsed. ' +
      'Return exactly one function call. Use simple string values — avoid special characters, ' +
      'nested quotes, or long inline data in arguments. If reporting financial data, reduce each array ' +
      'to at most 5 items in this call. Report the remaining items in subsequent calls.'
    );
  }
  return 'Return exactly one function call from the provided tools now. Do not return prose, markdown, JSON, or explanations.';
}

function getStepPhaseMaxOutputTokensForAttempt(attempt: number): number {
  if (attempt === 0) {
    return GEMINI_STEP_MAX_OUTPUT_TOKENS;
  }
  return GEMINI_STEP_RETRY_MAX_OUTPUT_TOKENS;
}

/**
 * Trim messages for retry: keep only the last few messages to reduce context
 * that causes Gemini's grammar engine to fail on function call generation.
 * Ensures the first message has role 'user' (Gemini requirement).
 */
const RETRY_KEEP_MESSAGES = 6;

function trimMessagesForRetry(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  if (messages.length <= RETRY_KEEP_MESSAGES) return messages;

  let trimmed = messages.slice(-RETRY_KEEP_MESSAGES);

  // Gemini requires the first message to be role 'user'
  while (trimmed.length > 1 && trimmed[0].role !== 'user') {
    trimmed = trimmed.slice(1);
  }

  return trimmed;
}

// ─── Interactions API helpers ──────────────────────────────────────────────────

/** Result from a single Interactions API call. */
export interface InteractionResult {
  interactionId: string;
  /** Function call from the model, if any. */
  functionCall: { id: string; name: string; args: Record<string, unknown> } | null;
  /** Text output from the model, if any. */
  text: string | null;
  usage: TokenUsage;
}

type InteractionsInput = Interactions.InteractionCreateParams['input'];

/**
 * Convert generateContent FunctionDeclaration[] to Interactions API Tool[] format.
 * generateContent: { name, description, parameters }
 * Interactions:    { type: 'function', name, description, parameters }
 *
 * Tool restriction (forcing a call from an allowlist) is NOT expressed here —
 * on the Interactions schema it lives in `generation_config.tool_choice.allowed_tools`
 * (see getInteractionsGenerationConfig). The legacy `toolConfig.functionCallingConfig`
 * shape is wrong for this API and is deliberately not produced.
 */
function toInteractionsTools(
  functionDeclarations: Array<{ name: string; description: string; parameters?: unknown }>,
): Interactions.Tool[] {
  return functionDeclarations.map(fd => ({
    type: 'function' as const,
    name: fd.name,
    description: fd.description,
    parameters: fd.parameters,
  }));
}

/**
 * Extract the first function call from an Interaction response's steps.
 *
 * May-2026 Interactions schema: the response is a `steps` array (the legacy
 * `outputs` array was removed — requests against it now 400 with
 * "legacy Interactions API schema is no longer supported"). Function calls are
 * steps with `type: 'function_call'`; model text lives in `model_output`
 * steps' content arrays.
 */
function extractInteractionFunctionCall(
  interaction: Interactions.Interaction,
  log: SessionLogger,
): { id: string; name: string; args: Record<string, unknown> } | null {
  for (const step of interaction.steps ?? []) {
    if (step.type === 'function_call' && step.name) {
      if (!step.id) {
        log.error(`[GeminiProvider] function_call "${step.name}" has no id — function_result cannot be linked. This will break the interaction chain.`);
        throw new Error(`Interactions API: function_call "${step.name}" missing required id field`);
      }
      return {
        id: step.id,
        name: step.name,
        args: (step.arguments ?? {}) as Record<string, unknown>,
      };
    }
  }
  log.warn('[GeminiProvider] No function call found in interaction steps');
  return null;
}

/**
 * Extract text output from an Interaction response (first text content of the
 * first model_output step; falls back to the SDK's output_text convenience).
 */
function extractInteractionText(interaction: Interactions.Interaction): string | null {
  for (const step of interaction.steps ?? []) {
    if (step.type === 'model_output') {
      for (const item of step.content ?? []) {
        if (item.type === 'text' && item.text) return item.text;
      }
    }
  }
  return interaction.output_text || null;
}

/** Compact one-line summary of an interaction's steps for logs. */
function summarizeInteractionSteps(interaction: Interactions.Interaction): string {
  return (interaction.steps ?? [])
    .map(s => {
      if (s.type === 'function_call') return `function_call:${s.name}(${JSON.stringify(s.arguments)})`;
      return s.type;
    })
    .join(', ');
}

/**
 * Execute an Interactions API call with timeout and retry (same policy as generateContent).
 */
async function createInteraction(
  ai: GoogleGenAI,
  params: Interactions.InteractionCreateParams,
  log: SessionLogger,
): Promise<Interactions.Interaction> {
  const maxRetries = 2; // 3 total attempts — malformed_tool_call is more common in Interactions API
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await Promise.race([
        ai.interactions.create(params),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Interactions API timeout after ${GEMINI_REQUEST_TIMEOUT_MS}ms`)), GEMINI_REQUEST_TIMEOUT_MS),
        ),
      ]);
      return result as Interactions.Interaction;
    } catch (err) {
      // Fail fast on contract drift — never retry a malformed request. This is
      // the tool_choice-incident guard: a silently-renamed parameter surfaces as
      // a typed ApiContractError immediately instead of burning all retries.
      maybeThrowApiContractError(err);
      const msg = err instanceof Error ? err.message : String(err);
      const isRetryable = /overloaded|rate.?limit|429|503|502|500|timeout|ECONNRESET|ETIMEDOUT|ENOTFOUND|socket hang up|malformed_tool_call|invalid JSON/i.test(msg);
      if (!isRetryable || attempt === maxRetries) throw err;
      const delayMs = 1000 * Math.pow(2, attempt) + Math.random() * 1000;
      log.warn(`[AI] Interactions API retryable error (attempt ${attempt + 1}/${maxRetries + 1}): ${msg.substring(0, 200)}. Retrying in ${Math.round(delayMs / 1000)}s...`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  throw new Error('unreachable');
}

function makeInteractionUsage(usage: Interactions.Usage | undefined): TokenUsage {
  return {
    inputTokens: usage?.total_input_tokens ?? 0,
    outputTokens: usage?.total_output_tokens ?? 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: usage?.total_cached_tokens ?? 0,
  };
}

// ─── Provider ─────────────────────────────────────────────────────────────────

export class GeminiProvider implements AIProvider {
  private modelId: string;
  private thinkingLevel?: InteractionsThinkingLevel;
  private log: SessionLogger = { log: console.log, warn: console.warn, error: console.error, getLines: () => [] };

  constructor(modelId: string, thinkingLevel?: InteractionsThinkingLevel) {
    this.modelId = modelId;
    this.thinkingLevel = thinkingLevel;
  }

  setLogger(logger: SessionLogger): void {
    this.log = logger;
  }

  private makeUsage(promptTokens: number, candidateTokens: number): TokenUsage {
    return {
      inputTokens: promptTokens,
      outputTokens: candidateTokens,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    };
  }

  async sendInfoPhase(
    messages: Anthropic.MessageParam[],
    systemPrompt: string,
  ): Promise<InfoPhaseResult> {
    const ai = getClient();
    const contents = toGeminiContents(messages, this.log);
    const hardenedSystemPrompt = buildHardenedSystemInstruction(systemPrompt);

    const modelConfig = getModelConfig(this.modelId, this.thinkingLevel);
    const response = await generateGeminiRequest(ai, {
      model: this.modelId,
      contents,
      config: {
        systemInstruction: hardenedSystemPrompt,
        ...modelConfig,
        maxOutputTokens: GEMINI_INFO_MAX_OUTPUT_TOKENS,
        tools: [{ functionDeclarations: [...GEMINI_INFO_FUNCTION_DECLARATIONS] }],
        toolConfig: {
          functionCallingConfig: {
            mode: FunctionCallingConfigMode.ANY,
            allowedFunctionNames: [...GEMINI_INFO_FUNCTION_NAMES],
          },
        },
      },
    }, this.log);

    const usage = this.makeUsage(
      response.usageMetadata?.promptTokenCount ?? 0,
      response.usageMetadata?.candidatesTokenCount ?? 0,
    );
    const call = extractFirstFunctionCall(response, this.log);

    if (!call?.name) {
      this.log.error('[AI] Gemini info phase: no function call, forcing step');
      return { output: { tool: 'step' }, rawJson: '{"tool":"step"}', usage };
    }

    if (!isGeminiInfoFunctionName(call.name)) {
      this.log.error(`[AI] Gemini info phase: unexpected function "${call.name}", forcing step`);
      return { output: { tool: 'step' }, rawJson: '{"tool":"step"}', usage };
    }

    const output: InfoOutput = mapGeminiInfoFunctionCallUnchecked(call.name, (call.args ?? {}) as Record<string, unknown>);
    return { output, rawJson: JSON.stringify(output), usage };
  }

  async sendStepPhase(
    messages: Anthropic.MessageParam[],
    systemPrompt: string,
  ): Promise<StepPhaseResult> {
    const ai = getClient();
    const hardenedSystemPrompt = buildHardenedSystemInstruction(systemPrompt);
    let attemptMessages = messages;
    let accumulatedUsage = emptyUsage();

    for (let attempt = 0; attempt <= GEMINI_STEP_PHASE_MAX_RETRIES; attempt++) {
      const contents = toGeminiContents(attemptMessages, this.log);
      const modelConfig = getModelConfig(this.modelId, this.thinkingLevel);

      const response = await generateGeminiRequest(ai, {
        model: this.modelId,
        contents,
        config: {
          systemInstruction: hardenedSystemPrompt,
          ...modelConfig,
          maxOutputTokens: getStepPhaseMaxOutputTokensForAttempt(attempt),
          tools: [{ functionDeclarations: [...GEMINI_STEP_FUNCTION_DECLARATIONS] }],
          toolConfig: {
            functionCallingConfig: {
              mode: FunctionCallingConfigMode.ANY,
              allowedFunctionNames: [...GEMINI_STEP_FUNCTION_NAMES],
            },
          },
        },
      }, this.log);

      const usage = this.makeUsage(
        response.usageMetadata?.promptTokenCount ?? 0,
        response.usageMetadata?.candidatesTokenCount ?? 0,
      );
      accumulatedUsage = addUsage(accumulatedUsage, usage);
      const call = extractFirstFunctionCall(response, this.log);

      if (call?.name && isStepToolName(call.name)) {
        const args = (call.args ?? {}) as Record<string, unknown>;
        const stepResponse: StepResponse = mapStepToolCallUnchecked(call.name, args);
        if (!stepResponse.action || !stepResponse.description) {
          throw new Error('Invalid step response: missing action or description');
        }

        const toolUseId = crypto.randomUUID();
        const assistantContent: Anthropic.ContentBlockParam[] = [
          {
            type: 'tool_use' as const,
            id: toolUseId,
            name: call.name,
            input: args,
          },
        ];

        return { response: stepResponse, assistantContent, toolUseId, usage: accumulatedUsage };
      }

      const diagnostic = summarizeGeminiNonToolResponse(response);
      if (call?.name && !isStepToolName(call.name)) {
        if (attempt === GEMINI_STEP_PHASE_MAX_RETRIES) {
          throw new Error(`Step phase: Gemini called unexpected function "${call.name}". ${diagnostic}`);
        }
      } else if (attempt === GEMINI_STEP_PHASE_MAX_RETRIES) {
        throw new Error(`Step phase: Gemini did not return a function call. ${diagnostic}`);
      }

      this.log.warn(
        `[GeminiProvider] Step phase returned non-tool response ` +
        `(attempt ${attempt + 1}/${GEMINI_STEP_PHASE_MAX_RETRIES + 1}, finishReasons=${extractGeminiFinishReasons(response).join(',') || 'none'}). ` +
        `Retrying with strict reminder.`,
      );
      const trimmedForRetry = trimMessagesForRetry(messages);
      attemptMessages = [
        ...trimmedForRetry,
        {
          role: 'user',
          content: buildStepPhaseRetryPrompt(response),
        },
      ];
    }

    throw new Error('Step phase: Gemini tool selection loop terminated unexpectedly');
  }

  // ─── Interactions API methods ───────────────────────────────────────────────
  // These use server-side conversation state instead of client-managed history.
  // Each call sends only NEW content + previous_interaction_id for chaining.

  /**
   * Send a unified interaction with ALL tools (info + step) available.
   * Used by the single-phase unified loop — the model picks whatever tool it needs.
   */
  async sendUnifiedInteraction(
    input: InteractionsInput,
    systemPrompt: string,
    previousInteractionId?: string,
    opts?: { stepToolsOnly?: boolean },
  ): Promise<InteractionResult> {
    const ai = getClient();
    const hardenedSystemPrompt = buildHardenedSystemInstruction(systemPrompt);
    const stepToolsOnly = opts?.stepToolsOnly === true;
    // Keep all declarations available so a pending info-tool result is valid,
    // while restricting which functions the model may call next.
    const allowedNames = stepToolsOnly
      ? [...GEMINI_STEP_FUNCTION_NAMES]
      : [...GEMINI_ALL_FUNCTION_NAMES];
    const tools = toInteractionsTools([...GEMINI_ALL_FUNCTION_DECLARATIONS]);

    const inputSummary = Array.isArray(input)
      ? (input as any[]).map((i: any) => `${i.type}${i.type === 'function_result' ? ':' + i.name : ''}${i.type === 'text' ? '(' + (i.text?.length ?? 0) + 'ch)' : ''}`).join(', ')
      : typeof input === 'string' ? `text(${input.length}ch)` : String(typeof input);
    this.log.log(`[GeminiProvider] sendUnifiedInteraction: prev_id=${previousInteractionId?.substring(0, 20) ?? 'none'}${stepToolsOnly ? ' STEP_ONLY' : ''} input=[${inputSummary}]`);

    const interaction = await createInteraction(ai, {
      model: this.modelId,
      input,
      system_instruction: hardenedSystemPrompt,
      tools,
      ...(previousInteractionId && { previous_interaction_id: previousInteractionId }),
      generation_config: getInteractionsGenerationConfig(
        this.modelId,
        GEMINI_STEP_MAX_OUTPUT_TOKENS,
        allowedNames,
        this.thinkingLevel,
      ),
    } as Interactions.InteractionCreateParams, this.log);

    this.log.log(`[GeminiProvider] sendUnifiedInteraction: got id=${interaction.id.substring(0, 20)}... status=${interaction.status} steps=[${summarizeInteractionSteps(interaction)}]`);

    const usage = makeInteractionUsage(interaction.usage);
    const functionCall = extractInteractionFunctionCall(interaction, this.log);
    const text = extractInteractionText(interaction);

    return { interactionId: interaction.id, functionCall, text, usage };
  }
}
