/**
 * CrawlSession — Multi-Turn Conversation Session
 *
 * Two-phase inner loop:
 * 1. Info phase: model requests HTML/screenshot context via compact JSON
 * 2. Step phase: model executes a browser action + reports financial data
 *
 * Provider is Gemini (gemini-* models). All provider-specific API logic lives
 * in src/ai/providers/gemini.ts.
 * Prompts, history management, and loop control live here.
 *
 * Uses streaming internally (delegated to each provider) to avoid long timeouts.
 */

import type Anthropic from '@anthropic-ai/sdk' with { 'resolution-mode': 'require' };
import { STEP_TOOL_RESULT_ACK } from './schema';
import type { InfoOutput, StepResponse, ReadHtmlRequest, SearchHtmlRequest, GetScreenshotRequest } from './schema';
import { isGeminiInfoFunctionName, mapGeminiInfoFunctionCallUnchecked, isStepToolName, mapStepToolCallUnchecked } from './schema';
import type { TokenUsage, PageState } from '../types';
import type { ActionErrorType } from '../agent/errors';
import { emptyUsage, addUsage } from './pricing';
import { createProvider, type AIProvider } from './provider';
import { GeminiProvider, USE_INTERACTIONS_API, type InteractionResult, type InteractionsThinkingLevel } from './providers/gemini';
import type { Interactions } from '@google/genai' with { 'resolution-mode': 'require' };
import { DEFAULT_CRAWL_MODEL } from '@accrawl/contracts';
import type { SessionLogger } from '../utils/logger';
import { safeBrowserUrlsInText } from '../utils/safe-browser-url';

const DEFAULT_MODEL_ID = process.env.GEMINI_MODEL || DEFAULT_CRAWL_MODEL;

/** Max readHtml/searchHtml/getScreenshot calls before forcing a step action. */
const MAX_INFO_CALLS_PER_STEP = Number(process.env.MAX_INFO_CALLS_PER_STEP ?? '12');

/** Max characters returned per readHtml call. */
const MAX_HTML_RANGE = 50_000;

/**
 * Regex to match any HTML content included in older turns' context.
 * Matches "Page HTML ..." lines (legacy full-dump or current metadata).
 */
const HTML_DUMP_RE = /Page HTML[^\n]*:\n[\s\S]*/;

/**
 * Strip heavy content (images + HTML) from older messages.
 * Also converts tool_use/tool_result blocks to text summaries so the
 * info phase (output_config.format, no tools) doesn't trip on tool blocks in history.
 */
export function trimHistory(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  const result: Anthropic.MessageParam[] = [];

  for (const msg of messages) {
    if (!Array.isArray(msg.content)) {
      result.push(msg);
      continue;
    }

    const newContent: Anthropic.ContentBlockParam[] = [];

    for (const block of msg.content) {
      if (block.type === 'image') {
        newContent.push({ type: 'text' as const, text: '[previous screenshot omitted]' });
      } else if (block.type === 'text') {
        const stripped = block.text.replace(HTML_DUMP_RE, '[previous HTML omitted]');
        newContent.push({ ...block, text: stripped });
      } else if (block.type === 'tool_use') {
        // Convert tool_use to a text summary of the action taken
        const input = block.input as Record<string, unknown>;
        const action = input.action ?? 'unknown';
        const desc = input.description ?? '';
        newContent.push({ type: 'text' as const, text: `[Action: ${action} — ${desc}]` });
      } else if (block.type === 'tool_result') {
        // Drop tool_result blocks — they only acknowledge dispatch metadata.
        continue;
      } else {
        newContent.push(block);
      }
    }

    // Skip messages that became empty after filtering (e.g., user messages with only tool_result)
    if (newContent.length === 0) continue;

    result.push({ ...msg, content: newContent });
  }

  return result;
}

/**
 * Trim old info-phase messages within the current step.
 * Keeps the last `keepPairs` assistant+user pairs in full.
 * Older user messages are summarized to their first line; images replaced with placeholder.
 * Assistant messages (small JSON) are kept as-is.
 */
/**
 * Trim old info-phase messages within the current step.
 * Keeps the last `keepPairs` assistant+user pairs in full.
 * Older user messages are summarized to their first line; images replaced with placeholder.
 * Assistant messages (small JSON) are kept as-is.
 */
function trimInfoMessages(infoMessages: Anthropic.MessageParam[], keepPairs: number = 3): Anthropic.MessageParam[] {
  const keepCount = keepPairs * 2; // Each pair = 1 assistant + 1 user message
  if (infoMessages.length <= keepCount) return infoMessages;

  const old = infoMessages.slice(0, infoMessages.length - keepCount);
  const recent = infoMessages.slice(infoMessages.length - keepCount);

  const summarized = old.map((msg): Anthropic.MessageParam => {
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      const blocks = msg.content as Anthropic.ContentBlockParam[];
      // Image messages (getScreenshot results)
      if (blocks.some(b => b.type === 'image')) {
        return { role: 'user', content: [{ type: 'text', text: '[previous screenshot omitted]' }] };
      }
      // Text messages (readHtml/searchHtml results)
      const textBlock = blocks.find(b => b.type === 'text') as Anthropic.TextBlockParam | undefined;
      if (textBlock) {
        const firstLine = textBlock.text.split('\n')[0];
        return { role: 'user', content: [{ type: 'text', text: `[${firstLine}]` }] };
      }
    }
    // Assistant messages — keep as-is (small JSON, ~50 tokens)
    return msg;
  });

  return [...summarized, ...recent];
}

/** Result from a single logical step — step response + token usage. */
export interface StepResult {
  response: StepResponse;
  usage: TokenUsage;
}

// ─── Interactions API helpers ──────────────────────────────────────────────────

type InteractionsInput = Interactions.InteractionCreateParams['input'];

/**
 * Build Interactions API input from text content and an optional screenshot.
 */
function buildInteractionsInput(text: string, screenshotBase64: string | null): InteractionsInput {
  const parts: Interactions.InteractionCreateParams['input'] & unknown[] = [];
  if (screenshotBase64) {
    const mimeType = inferImageMediaType(screenshotBase64) as 'image/jpeg' | 'image/png' | 'image/webp';
    parts.push({
      type: 'image' as const,
      data: screenshotBase64,
      mime_type: mimeType,
    } as Interactions.ImageContent);
  }
  parts.push({ type: 'text' as const, text } as Interactions.TextContent);
  return parts;
}

/**
 * Build Interactions API input for a function result (info phase response).
 */
/**
 * Build a brief extraction summary for context resets.
 * When the interaction chain is reset, the model loses history.
 * This provides a compact summary of what was already extracted.
 */
function buildDataContextForInteractions(summary: string): string {
  if (!summary) return 'No data extracted yet.';
  return `Data extracted so far in this crawl session:\n${summary}`;
}

function buildFunctionResultInput(callId: string, functionName: string, result: string | unknown[], isError?: boolean): InteractionsInput {
  return [{
    type: 'function_result' as const,
    call_id: callId,
    name: functionName,
    result,
    ...(isError && { is_error: true }),
  }];
}

/** Hard ceiling on model calls within one agent step. */
export const UNIFIED_LOOP_MAX_CALLS = 25;

/**
 * Withhold inspection tools after this many calls in a single step. This leaves
 * enough budget for the model to report observed data or navigate instead of
 * losing the whole crawl to an unbounded read/search loop.
 */
export const FORCE_STEP_ACTION_AFTER_CALLS = 16;

export function shouldForceStepAction(
  callIndex: number,
  maxCalls: number = UNIFIED_LOOP_MAX_CALLS,
  threshold: number = FORCE_STEP_ACTION_AFTER_CALLS,
): boolean {
  return callIndex >= Math.max(1, Math.min(threshold, maxCalls - 1));
}

export const FORCE_STEP_ACTION_DIRECTIVE =
  'INVESTIGATION_BUDGET_SPENT: You have used up this step\'s page-inspection budget — many ' +
  'readHtml/searchHtml/getScreenshot calls without taking an action. You MUST take a concrete ' +
  'action NOW; you cannot read more on this step. If you have seen ANY financial data (accounts, ' +
  'transactions, or positions) in the HTML or screenshots so far, report it now with reportData. ' +
  'Otherwise take ONE navigation or complete action. A fresh full-page screenshot and the complete ' +
  'HTML are captured automatically for your NEXT step, where you can keep reading — so acting now ' +
  'loses nothing and does not restart your progress.';

export function buildLargePageContinuationContext(extractionSummary: string): string {
  return `Continuing extraction on a large page — do NOT restart reading from the beginning. ` +
    `Report any financial data you have already seen with reportData, then take your next action. ` +
    `${buildDataContextForInteractions(extractionSummary)}`;
}

/**
 * Add the force-step directive while preserving a valid function-result
 * continuation shape after an info-tool call.
 */
export function injectStepDirective(input: InteractionsInput, directive: string): InteractionsInput {
  const parts: unknown[] = Array.isArray(input)
    ? [...(input as unknown[])]
    : [{ type: 'text' as const, text: String(input) }];
  const resultIndex = parts.findIndex(
    part => !!part && typeof part === 'object'
      && (part as { type?: string }).type === 'function_result',
  );

  if (resultIndex >= 0) {
    const functionResult = parts[resultIndex] as { result?: unknown };
    if (typeof functionResult.result === 'string') {
      parts[resultIndex] = {
        ...(functionResult as object),
        result: `${functionResult.result}\n\n${directive}`,
      };
    } else if (Array.isArray(functionResult.result)) {
      parts[resultIndex] = {
        ...(functionResult as object),
        result: [
          ...functionResult.result,
          { type: 'text' as const, text: directive },
        ],
      };
    } else {
      parts[resultIndex] = { ...(functionResult as object), result: directive };
    }
    return parts as InteractionsInput;
  }

  parts.push({ type: 'text' as const, text: directive });
  return parts as InteractionsInput;
}

/**
 * A single crawl conversation session.
 *
 * Two-phase inner loop:
 * 1. Info phase: compact JSON (readHtml/searchHtml/getScreenshot/step-signal)
 * 2. Step phase: strict step-tool call (action + financial data arrays)
 *
 * Provider is selected automatically from the model ID prefix.
 */
export class CrawlSession {
  /** Message history — used by legacy generateContent path, retained as fallback. */
  private messages: Anthropic.MessageParam[] = [];
  private systemPrompt: string;
  private modelId: string;
  private totalUsage: TokenUsage = emptyUsage();
  private provider: AIProvider;
  private log: SessionLogger;
  /** Whether to use Interactions API for server-side history. */
  private readonly useInteractionsApi: boolean;
  /** Last interaction ID for chaining (Interactions API mode only). */
  private lastInteractionId: string | null = null;
  /** Accumulated input tokens across all interactions — used for context window management.
   *  The Interactions API usage reports per-interaction tokens, not accumulated context.
   *  We track the running total manually to know when to reset the chain. */
  private accumulatedInteractionInputTokens: number = 0;
  /** Summary of extracted data for context reset — set by agent loop via setExtractionSummary(). */
  private extractionSummary: string = '';
  /** Pending function result from the previous step — prepended to the next runUnifiedLoop input. */
  private pendingFunctionResult: InteractionsInput | null = null;

  constructor(systemPrompt: string, modelId?: string, logger?: SessionLogger, thinkingLevel?: InteractionsThinkingLevel) {
    this.systemPrompt = systemPrompt;
    this.modelId = modelId || DEFAULT_MODEL_ID;
    this.log = logger ?? { log: console.log, warn: console.warn, error: console.error, getLines: () => [] };
    this.provider = createProvider(this.modelId, logger, thinkingLevel);
    this.useInteractionsApi = USE_INTERACTIONS_API && this.provider instanceof GeminiProvider;
    if (this.useInteractionsApi) {
      this.log.log('[AI] UNIFIED_LOOP_V1: Using Interactions API with unified loop (single-phase, all tools)');
    } else {
      this.log.log('[AI] LEGACY_PATH: Using generateContent with two-phase loop');
    }
  }

  getModelId(): string {
    return this.modelId;
  }

  getUsage(): TokenUsage {
    return { ...this.totalUsage };
  }

  /**
   * Update the extraction summary for context reset.
   * Called by the agent loop after each step to keep the session aware
   * of what data has been extracted (used when resetting the interaction chain).
   */
  setExtractionSummary(summary: string): void {
    this.extractionSummary = summary;
  }

  /**
   * Send a step to the AI with the current page state.
   */
  async sendStep(pageState: PageState, context: string, includeScreenshot: boolean): Promise<StepResult> {
    const safePageState = sanitizePageStateBrowserUrls(pageState);
    const contextText = buildContextText(
      safeBrowserUrlsInText(context),
      safePageState,
    );

    if (this.useInteractionsApi) {
      const input = buildInteractionsInput(
        contextText,
        includeScreenshot ? safePageState.screenshotBase64 : null,
      );
      return this.runUnifiedLoop(safePageState, input);
    }

    // Legacy path: client-managed history via generateContent
    const contentBlocks: Array<Anthropic.ImageBlockParam | Anthropic.TextBlockParam> = [];
    if (includeScreenshot) {
      const mediaType = inferImageMediaType(safePageState.screenshotBase64);
      contentBlocks.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: mediaType,
          data: safePageState.screenshotBase64,
        },
      });
    }
    contentBlocks.push({ type: 'text', text: contextText });

    this.messages.push({ role: 'user', content: contentBlocks });

    return this.runInnerLoop(safePageState);
  }

  /**
   * Send an error/feedback message and get the next action.
   */
  async sendError(
    errorMessage: string,
    pageState: PageState,
    context: string,
    includeScreenshot: boolean,
    visibleElements?: string,
    errorType?: ActionErrorType,
  ): Promise<StepResult> {
    const safePageState = sanitizePageStateBrowserUrls(pageState);
    const safeErrorMessage = safeBrowserUrlsInText(errorMessage);
    const safeVisibleElements = visibleElements
      ? safeBrowserUrlsInText(visibleElements)
      : undefined;
    const failureFeedback = {
      status: 'failure',
      errorMessage: safeErrorMessage,
      ...(errorType && { errorType }),
      visibleElementsAttached: Boolean(safeVisibleElements),
    };

    const feedbackParts = [
      `ACTION_FEEDBACK_JSON: ${JSON.stringify(failureFeedback)}`,
      `Previous action FAILED: ${safeErrorMessage}`,
      buildFailureGuidance(errorType),
      safeVisibleElements
        ? `\nVisible interactive elements:\n${safeVisibleElements}`
        : '',
      `\n${buildContextText(safeBrowserUrlsInText(context), safePageState)}`,
    ];

    const feedbackText = feedbackParts.join('\n');

    if (this.useInteractionsApi) {
      const input = buildInteractionsInput(
        feedbackText,
        includeScreenshot ? safePageState.screenshotBase64 : null,
      );
      return this.runUnifiedLoop(safePageState, input);
    }

    // Legacy path
    const contentBlocks: Array<Anthropic.ImageBlockParam | Anthropic.TextBlockParam> = [];
    if (includeScreenshot) {
      const mediaType = inferImageMediaType(safePageState.screenshotBase64);
      contentBlocks.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: mediaType,
          data: safePageState.screenshotBase64,
        },
      });
    }
    contentBlocks.push({ type: 'text', text: feedbackText });

    this.messages.push({ role: 'user', content: contentBlocks });

    return this.runInnerLoop(safePageState);
  }

  /**
   * Two-phase inner loop:
   * 1. Info phase: readHtml/searchHtml/getScreenshot or "step" signal.
   * 2. Step phase: strict step-tool call with action + financial data.
   */
  private async runInnerLoop(pageState: PageState): Promise<StepResult> {
    let infoCalls = 0;
    const infoSummaryParts: string[] = [];
    let stepTotalUsage = emptyUsage();

    const anchorIdx = this.messages.length - 1;

    // ─── Phase 1: Info gathering ────────────────────────────────────────────
    while (infoCalls < MAX_INFO_CALLS_PER_STEP) {
      const preAnchor = trimHistory(this.messages.slice(0, anchorIdx));
      const anchor = this.messages[anchorIdx];
      const infoMessages = this.messages.slice(anchorIdx + 1);
      const trimmed = [...preAnchor, anchor, ...trimInfoMessages(infoMessages)];
      // Note: Gemini does not use cache breakpoints.

      this.log.log(`[AI] Info call ${infoCalls + 1}/${MAX_INFO_CALLS_PER_STEP} (${trimmed.length} messages)`);

      const infoResult = await this.provider.sendInfoPhase(trimmed, this.systemPrompt);

      const callUsage = infoResult.usage;
      stepTotalUsage = addUsage(stepTotalUsage, callUsage);
      this.totalUsage = addUsage(this.totalUsage, callUsage);

      const output: InfoOutput = infoResult.output;

      // Model signals it's ready for step via JSON → break to phase 2
      if (output.tool === 'step') {
        this.log.log(`[AI] Info phase → step signal received`);
        break;
      }

      // Add assistant response to history (rawJson is the original text from the model)
      this.messages.push({ role: 'assistant', content: [{ type: 'text', text: infoResult.rawJson }] });

      // Handle readHtml
      if (output.tool === 'readHtml') {
        infoCalls++;
        const req = output as ReadHtmlRequest & { tool: 'readHtml' };
        const start = Math.max(0, Math.min(pageState.htmlLength, req.start));
        const end = Math.min(pageState.htmlLength, Math.max(start, req.end));
        const requestedRange = end - start;
        if (requestedRange > MAX_HTML_RANGE) {
          const errorText = `Range too large: you requested ${start}-${end} (${requestedRange} chars) but max is ${MAX_HTML_RANGE} per call. ` +
            `Split into chunks: read ${start}-${start + MAX_HTML_RANGE}, then ${start + MAX_HTML_RANGE}-${Math.min(start + MAX_HTML_RANGE * 2, end)}, etc.`;
          infoSummaryParts.push(`readHtml(${start}-${end}): REJECTED — range too large`);
          this.log.log(`[AI] readHtml(${start}-${end}): REJECTED — range too large (${requestedRange} > ${MAX_HTML_RANGE})`);
          this.messages.push({ role: 'user', content: [{ type: 'text', text: errorText }] });
          continue;
        }
        const htmlSlice = pageState.fullHtml.substring(start, end);

        infoSummaryParts.push(`readHtml(${start}-${end}): ${req.reason}`);
        this.log.log(`[AI] readHtml(${start}-${end}): ${req.reason}`);

        const resultText = start >= pageState.htmlLength
          ? `No HTML content at offset ${start} — total HTML length is ${pageState.htmlLength}.`
          : `HTML chars ${start}-${end} of ${pageState.htmlLength}:\n${htmlSlice}`;

        this.messages.push({ role: 'user', content: [{ type: 'text', text: resultText }] });
        continue;
      }

      // Handle searchHtml — returns ALL matches with adaptive context
      if (output.tool === 'searchHtml') {
        infoCalls++;
        const req = output as SearchHtmlRequest & { tool: 'searchHtml' };

        infoSummaryParts.push(`searchHtml("${req.query}")`);
        this.log.log(`[AI] searchHtml("${req.query}")`);

        const MAX_CONTEXT_TOTAL = 30_000;
        const matchPositions: number[] = [];
        const lowerHtml = pageState.fullHtml.toLowerCase();
        const lowerQuery = req.query.toLowerCase();
        let searchFrom = 0;

        // Find ALL match positions (no cap)
        while (true) {
          const idx = lowerHtml.indexOf(lowerQuery, searchFrom);
          if (idx === -1) break;
          matchPositions.push(idx);
          searchFrom = idx + lowerQuery.length;
        }

        // Adaptive context: divide budget among matches (halfContext = chars on each side)
        const halfContext = Math.min(1500, Math.floor(MAX_CONTEXT_TOTAL / 2 / Math.max(matchPositions.length, 1)));
        const matches: string[] = [];
        for (const idx of matchPositions) {
          const start = Math.max(0, idx - halfContext);
          const end = Math.min(pageState.htmlLength, idx + req.query.length + halfContext);
          matches.push(`[Match ${matches.length + 1} at char ${idx}] (showing ${start}-${end}):\n${pageState.fullHtml.substring(start, end)}`);
        }

        let resultText = matches.length > 0
          ? `Found ${matches.length} match(es) for "${req.query}" in ${pageState.htmlLength} chars of HTML:\n\n${matches.join('\n\n---\n\n')}`
          : `No matches found for "${req.query}" in ${pageState.htmlLength} chars of HTML.`;

        // Safety cap: truncate if result is too large for a single message
        if (resultText.length > 20_000) {
          resultText = resultText.substring(0, 20_000) + `\n\n[Truncated — ${matches.length} total matches. Use readHtml to examine specific char ranges.]`;
        }

        this.messages.push({ role: 'user', content: [{ type: 'text', text: resultText }] });
        continue;
      }

      // Handle getScreenshot
      if (output.tool === 'getScreenshot') {
        infoCalls++;
        const req = output as GetScreenshotRequest & { tool: 'getScreenshot' };

        infoSummaryParts.push(`getScreenshot: ${req.reason}`);
        this.log.log(`[AI] getScreenshot: ${req.reason}`);

        this.messages.push({
          role: 'user',
          content: [{
            type: 'image',
            source: { type: 'base64', media_type: 'image/jpeg', data: pageState.screenshotBase64 },
          }],
        });
        continue;
      }

      // Unknown tool type — log and fall through to step phase
      this.log.error(`[AI] Unexpected info tool: ${(output as { tool: string }).tool}. Forcing step.`);
      break;
    }

    if (infoCalls >= MAX_INFO_CALLS_PER_STEP) {
      this.log.warn(`[AI] Hit max info calls (${MAX_INFO_CALLS_PER_STEP}), forcing step`);
    }

    // ─── Phase 2: Step action ───────────────────────────────────────────────
    this.log.log(`[AI] Step phase (${this.messages.length} messages, ${infoCalls} info calls used)`);
    // Rebuild messages for step call — consolidate info exchanges first.
    const anchorForStep = this.messages[anchorIdx];
    const infoMessagesForStep = trimInfoMessages(this.messages.slice(anchorIdx + 1));
    const trimmedForStep = [
      ...trimHistory(this.messages.slice(0, anchorIdx)),
      anchorForStep,
      ...infoMessagesForStep,
    ];

    const stepResult = await this.provider.sendStepPhase(trimmedForStep, this.systemPrompt);

    const stepUsage = stepResult.usage;
    stepTotalUsage = addUsage(stepTotalUsage, stepUsage);
    this.totalUsage = addUsage(this.totalUsage, stepUsage);

    const response = stepResult.response;

    // Consolidate info messages, keep anchor + step response
    this.consolidateInnerLoop(anchorIdx, infoSummaryParts);
    // Store the assistant's response
    this.messages.push({ role: 'assistant', content: stepResult.assistantContent });
    // The API requires a tool_result after tool_use. We append a typed ack payload;
    // concrete post-action success/failure feedback is injected by the agent loop
    // on the next user turn via ACTION_FEEDBACK.
    this.messages.push({
      role: 'user',
      content: [{ type: 'tool_result' as const, tool_use_id: stepResult.toolUseId, content: JSON.stringify(STEP_TOOL_RESULT_ACK) }],
    });

    return { response, usage: stepTotalUsage };
  }

  /**
   * Consolidate info-gathering messages into a summary on the anchor message.
   */
  private consolidateInnerLoop(anchorIdx: number, infoSummaryParts: string[]): void {
    if (infoSummaryParts.length === 0) return;

    const anchorMsg = this.messages[anchorIdx];

    const summary = `\n\n[Agent gathered context: ${infoSummaryParts.join('; ')}]`;
    if (Array.isArray(anchorMsg.content)) {
      const content = [...anchorMsg.content] as unknown as Array<Record<string, unknown>>;
      for (let i = content.length - 1; i >= 0; i--) {
        if ((content[i] as { type: string }).type === 'text') {
          content[i] = { ...content[i], text: (content[i].text as string) + summary };
          break;
        }
      }
      this.messages[anchorIdx] = { ...anchorMsg, content: content as unknown as Anthropic.MessageParam['content'] };
    }

    // Remove all intermediate info messages (between anchor and end)
    this.messages.splice(anchorIdx + 1, this.messages.length - anchorIdx - 1);
  }

  // ─── Unified loop (Interactions API, single-phase) ──────────────────────────
  // All tools (info + step) available at once. The model picks whatever it needs.
  // No forced info phase — the model can readHtml, reportData, click, or complete freely.

  private async runUnifiedLoop(pageState: PageState, initialInput: InteractionsInput): Promise<StepResult> {
    this.log.log(`[AI] runUnifiedLoop (${pageState.htmlLength} chars HTML, ~${this.accumulatedInteractionInputTokens} accumulated tokens)`);
    const gemini = this.provider as GeminiProvider;
    let totalUsage = emptyUsage();
    const MAX_CALLS = UNIFIED_LOOP_MAX_CALLS;

    // If there's a pending function result from the previous step, prepend it to the input.
    // This acknowledges the previous step's function call in the same interaction as the new page context.
    let currentInput: InteractionsInput;
    if (this.pendingFunctionResult) {
      currentInput = [...this.pendingFunctionResult as any[], ...initialInput as any[]] as InteractionsInput;
      this.pendingFunctionResult = null;
    } else {
      currentInput = initialInput;
    }

    for (let calls = 0; calls < MAX_CALLS; calls++) {
      // Context reset check
      if (this.lastInteractionId && this.accumulatedInteractionInputTokens > 800_000) {
        this.log.log(`[AI] Context approaching limit (${this.accumulatedInteractionInputTokens} tokens). Resetting chain.`);
        this.lastInteractionId = null;
        this.accumulatedInteractionInputTokens = 0;
        if (calls === 0) {
          // Preserve one-shot input such as an OTP, spreadsheet, or action
          // feedback that has not yet been sent to the model.
          currentInput = initialInput;
        } else {
          const contextText = buildContextText(
            buildLargePageContinuationContext(this.extractionSummary),
            pageState,
          );
          currentInput = buildInteractionsInput(contextText, pageState.screenshotBase64);
        }
      }

      const forceStepOnly = shouldForceStepAction(calls, MAX_CALLS);
      if (forceStepOnly) {
        currentInput = injectStepDirective(currentInput, FORCE_STEP_ACTION_DIRECTIVE);
        this.log.warn(`[AI] Unified call ${calls + 1}/${MAX_CALLS} — forcing a step action after the inspection budget was spent`);
      } else {
        this.log.log(`[AI] Unified call ${calls + 1}/${MAX_CALLS}`);
      }

      const result = await gemini.sendUnifiedInteraction(
        currentInput, this.systemPrompt, this.lastInteractionId ?? undefined,
        forceStepOnly ? { stepToolsOnly: true } : undefined,
      );
      totalUsage = addUsage(totalUsage, result.usage);
      this.totalUsage = addUsage(this.totalUsage, result.usage);
      this.lastInteractionId = result.interactionId;
      this.accumulatedInteractionInputTokens += result.usage.inputTokens;

      if (!result.functionCall) {
        this.log.warn('[AI] Unified loop: no function call returned');
        throw new Error('Unified loop: no function call');
      }

      const call = result.functionCall;

      // ─── Info tools: execute inline, continue loop ─────────────────────
      if (call.name === 'info_read_html') {
        const output = mapGeminiInfoFunctionCallUnchecked(call.name, call.args);
        const req = output as ReadHtmlRequest & { tool: 'readHtml' };
        const start = Math.max(0, Math.min(pageState.htmlLength, req.start));
        const end = Math.min(pageState.htmlLength, Math.max(start, req.end));
        const requestedRange = end - start;
        if (requestedRange > MAX_HTML_RANGE) {
          const errorText = `Range too large: you requested ${start}-${end} (${requestedRange} chars) but max is ${MAX_HTML_RANGE} per call. ` +
            `Split into chunks: read ${start}-${start + MAX_HTML_RANGE}, then ${start + MAX_HTML_RANGE}-${Math.min(start + MAX_HTML_RANGE * 2, end)}, etc.`;
          this.log.log(`[AI] readHtml(${start}-${end}): REJECTED — range too large (${requestedRange} > ${MAX_HTML_RANGE})`);
          currentInput = buildFunctionResultInput(call.id, call.name, errorText, true);
          continue;
        }
        const htmlSlice = pageState.fullHtml.substring(start, end);
        const resultText = start >= pageState.htmlLength
          ? `No HTML content at offset ${start} — total HTML length is ${pageState.htmlLength}.`
          : `HTML chars ${start}-${end} of ${pageState.htmlLength}:\n${htmlSlice}`;
        this.log.log(`[AI] readHtml(${start}-${end}): ${req.reason} [call_id=${call.id}, ${resultText.length}ch]`);
        currentInput = buildFunctionResultInput(call.id, call.name, resultText);
        continue;
      }

      if (call.name === 'info_search_html') {
        const output = mapGeminiInfoFunctionCallUnchecked(call.name, call.args);
        const req = output as SearchHtmlRequest & { tool: 'searchHtml' };
        this.log.log(`[AI] searchHtml("${req.query}")`);

        const MAX_CONTEXT_TOTAL = 30_000;
        const matchPositions: number[] = [];
        const lowerHtml = pageState.fullHtml.toLowerCase();
        const lowerQuery = req.query.toLowerCase();
        let searchFrom = 0;
        while (true) {
          const idx = lowerHtml.indexOf(lowerQuery, searchFrom);
          if (idx === -1) break;
          matchPositions.push(idx);
          searchFrom = idx + lowerQuery.length;
        }
        const halfContext = Math.min(1500, Math.floor(MAX_CONTEXT_TOTAL / 2 / Math.max(matchPositions.length, 1)));
        const matches: string[] = [];
        for (const idx of matchPositions) {
          const s = Math.max(0, idx - halfContext);
          const e = Math.min(pageState.htmlLength, idx + req.query.length + halfContext);
          matches.push(`[Match ${matches.length + 1} at char ${idx}] (showing ${s}-${e}):\n${pageState.fullHtml.substring(s, e)}`);
        }
        let resultText = matches.length > 0
          ? `Found ${matches.length} match(es) for "${req.query}" in ${pageState.htmlLength} chars of HTML:\n\n${matches.join('\n\n---\n\n')}`
          : `No matches found for "${req.query}" in ${pageState.htmlLength} chars of HTML.`;
        if (resultText.length > 20_000) {
          resultText = resultText.substring(0, 20_000) + `\n\n[Truncated — ${matches.length} total matches.]`;
        }
        currentInput = buildFunctionResultInput(call.id, call.name, resultText);
        continue;
      }

      if (call.name === 'info_get_screenshot') {
        this.log.log(`[AI] getScreenshot`);
        currentInput = [
          { type: 'function_result' as const, call_id: call.id, name: call.name, result: 'Screenshot provided below.' },
          { type: 'image' as const, data: pageState.screenshotBase64, mime_type: 'image/jpeg' as const },
        ] as InteractionsInput;
        continue;
      }

      // ─── Step tools: return to agent loop ──────────────────────────────
      if (isStepToolName(call.name)) {
        const response: StepResponse = mapStepToolCallUnchecked(call.name, call.args);
        if (!response.action || !response.description) {
          throw new Error('Invalid step response: missing action or description');
        }
        this.log.log(`[AI] Step action: ${response.action} — ${response.description}`);

        // Store the pending function result — it will be sent as part of the next
        // runUnifiedLoop call's input, prepended to the page context.
        // This avoids a separate ack interaction which causes "undefined function" errors.
        this.pendingFunctionResult = buildFunctionResultInput(call.id, call.name, JSON.stringify(STEP_TOOL_RESULT_ACK));

        return { response, usage: totalUsage };
      }

      throw new Error(`Unified loop: unknown function "${call.name}"`);
    }

    throw new Error('Unified loop: hit max calls without a step action');
  }
}

/**
 * Build the context text for a step.
 */
function buildContextText(context: string, pageState: PageState): string {
  return `${context}\n\nPage HTML: ${pageState.htmlLength} chars available via readHtml/searchHtml.`;
}

/**
 * Final model-boundary defense in depth. Page capture already scrubs URL
 * attributes (including relative ones) on its detached DOM clone; this catches
 * any absolute browser URL introduced by a custom capture implementation before
 * readHtml/searchHtml can return it to the model.
 */
function sanitizePageStateBrowserUrls(pageState: PageState): PageState {
  const fullHtml = safeBrowserUrlsInText(pageState.fullHtml);
  return {
    ...pageState,
    fullHtml,
    htmlLength: fullHtml.length,
  };
}

/**
 * Action-failure guidance tailored to the failure type.
 *
 * Report only what happened and what is available — never a strategy. The model
 * decides what to do next (refine the selector, navigate elsewhere, read the
 * HTML, complete — its call). We avoid two opposite mistakes: the generic
 * "pick a different approach" advice misled the model into abandoning a goal it
 * should keep (e.g. substituting a wait for a failed export click), while
 * "re-attempt the SAME action" presumes a goal that may no longer be the
 * model's. State the fact and the available refinement; leave the decision out.
 */
export function buildFailureGuidance(errorType?: ActionErrorType): string {
  switch (errorType) {
    case 'ambiguous_selector':
      return (
        `The action did NOT execute: your selector matched more than one element, so no click was performed. ` +
        `The error above lists each matching element and a unique selector for each.`
      );
    case 'selector_not_found':
      return (
        `The action did NOT execute: your selector matched no element. ` +
        `Use searchHtml to locate the element in the live DOM.`
      );
    default:
      return (
        `The action did NOT execute, so the page did not change — do not proceed as if it had. ` +
        `Use searchHtml/readHtml to inspect the current page before choosing your next action.`
      );
  }
}

function inferImageMediaType(base64: string): 'image/jpeg' | 'image/png' {
  if (base64.startsWith('iVBORw0KGgo')) return 'image/png';
  return 'image/jpeg';
}
