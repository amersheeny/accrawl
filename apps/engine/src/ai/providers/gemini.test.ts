import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isGemini3Model,
  getModelConfig,
  getInteractionsGenerationConfig,
  toInteractionsThinkingLevel,
  GEMINI2_INTERACTIONS_THINKING_LEVEL,
} from './gemini';

const INTERACTIONS_THINKING_LEVELS = ['minimal', 'low', 'medium', 'high'];

const generateContentMock = vi.fn();
const interactionsCreateMock = vi.fn();

vi.mock('@google/genai', async () => {
  const actual = await vi.importActual<typeof import('@google/genai')>('@google/genai');
  class MockGoogleGenAI {
    models = {
      generateContent: generateContentMock,
    };
    interactions = {
      create: interactionsCreateMock,
    };
  }
  return {
    ...actual,
    GoogleGenAI: MockGoogleGenAI,
    FunctionCallingConfigMode: {
      ...actual.FunctionCallingConfigMode,
      ANY: 'ANY',
    },
  };
});

describe('GeminiProvider sendStepPhase', () => {
  beforeEach(() => {
    vi.resetModules();
    generateContentMock.mockReset();
    process.env.GEMINI_API_KEY = 'test-key';
    delete process.env.GEMINI_STEP_PHASE_MAX_RETRIES;
    delete process.env.GEMINI_STEP_RETRY_MAX_OUTPUT_TOKENS;
  });

  it('retries MALFORMED_FUNCTION_CALL responses and accumulates usage across attempts', async () => {
    generateContentMock
      .mockResolvedValueOnce({
        usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 2 },
        candidates: [{ finishReason: 'MALFORMED_FUNCTION_CALL', content: { parts: [] } }],
      })
      .mockResolvedValueOnce({
        usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3 },
        functionCalls: [{
          name: 'step_wait',
          args: { description: 'Waiting for the account table to load.' },
        }],
        candidates: [],
      });

    const { GeminiProvider } = await import('./gemini');
    const provider = new GeminiProvider('gemini-2.5-flash');

    const result = await provider.sendStepPhase(
      [{ role: 'user', content: 'Take the next browser step.' }],
      'SYSTEM_PROMPT',
    );

    expect(generateContentMock).toHaveBeenCalledTimes(2);
    expect(generateContentMock.mock.calls[1][0].config.maxOutputTokens).toBe(8192);
    expect(generateContentMock.mock.calls[1][0].contents.at(-1)?.parts?.[0]?.text).toBeTruthy();
    expect(result.response.action).toBe('wait');
    expect(result.usage).toEqual({
      inputTokens: 18,
      outputTokens: 5,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    });
  });

  it('stops after the configured number of retries', async () => {
    process.env.GEMINI_STEP_PHASE_MAX_RETRIES = '1';
    generateContentMock.mockResolvedValue({
      usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 1 },
      candidates: [{ finishReason: 'MALFORMED_FUNCTION_CALL', content: { parts: [] } }],
    });

    const { GeminiProvider } = await import('./gemini');
    const provider = new GeminiProvider('gemini-2.5-flash');

    await expect(provider.sendStepPhase(
      [{ role: 'user', content: 'Take the next browser step.' }],
      'SYSTEM_PROMPT',
    )).rejects.toThrow('Step phase: Gemini did not return a function call.');

    expect(generateContentMock).toHaveBeenCalledTimes(2);
  });

  it('defaults to five total attempts for malformed tool calls', async () => {
    generateContentMock.mockResolvedValue({
      usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 1 },
      candidates: [{ finishReason: 'MALFORMED_FUNCTION_CALL', content: { parts: [] } }],
    });

    const { GeminiProvider } = await import('./gemini');
    const provider = new GeminiProvider('gemini-2.5-flash');

    await expect(provider.sendStepPhase(
      [{ role: 'user', content: 'Take the next browser step.' }],
      'SYSTEM_PROMPT',
    )).rejects.toThrow('Step phase: Gemini did not return a function call.');

    expect(generateContentMock).toHaveBeenCalledTimes(5);
  });

  it('retry prompt mentions malformed when finishReason is MALFORMED_FUNCTION_CALL', async () => {
    generateContentMock
      .mockResolvedValueOnce({
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1 },
        candidates: [{ finishReason: 'MALFORMED_FUNCTION_CALL', content: { parts: [] } }],
      })
      .mockResolvedValueOnce({
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 },
        functionCalls: [{
          name: 'step_wait',
          args: { description: 'Waiting.' },
        }],
        candidates: [],
      });

    const { GeminiProvider } = await import('./gemini');
    const provider = new GeminiProvider('gemini-2.5-flash');

    await provider.sendStepPhase(
      [{ role: 'user', content: 'Take the next browser step.' }],
      'SYSTEM_PROMPT',
    );

    const retryContents = generateContentMock.mock.calls[1][0].contents;
    const lastPart = retryContents.at(-1)?.parts?.[0]?.text ?? '';
    expect(lastPart).toContain('malformed');
  });

  it('retry uses trimmed context when conversation is long', async () => {
    // Build a long conversation (20 messages alternating user/assistant)
    const longMessages: Array<{ role: string; content: string }> = [];
    for (let i = 0; i < 20; i++) {
      longMessages.push({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `Message ${i}`,
      });
    }

    generateContentMock
      .mockResolvedValueOnce({
        usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 1 },
        candidates: [{ finishReason: 'MALFORMED_FUNCTION_CALL', content: { parts: [] } }],
      })
      .mockResolvedValueOnce({
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 },
        functionCalls: [{
          name: 'step_wait',
          args: { description: 'Waiting.' },
        }],
        candidates: [],
      });

    const { GeminiProvider } = await import('./gemini');
    const provider = new GeminiProvider('gemini-2.5-flash');

    await provider.sendStepPhase(longMessages as any, 'SYSTEM_PROMPT');

    // First call uses all 20 messages
    const firstCallContents = generateContentMock.mock.calls[0][0].contents;
    expect(firstCallContents.length).toBe(20);

    // Retry call uses trimmed messages (6 kept + 1 retry prompt = 7)
    const retryContents = generateContentMock.mock.calls[1][0].contents;
    expect(retryContents.length).toBeLessThan(firstCallContents.length);
    expect(retryContents.length).toBe(7); // 6 trimmed + 1 retry prompt
  });

  it('uses Gemini 2.x config (temperature 0, thinkingBudget) for gemini-2.5-flash', async () => {
    generateContentMock.mockResolvedValueOnce({
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 },
      functionCalls: [{ name: 'step_wait', args: { description: 'Waiting.' } }],
      candidates: [],
    });

    const { GeminiProvider } = await import('./gemini');
    const provider = new GeminiProvider('gemini-2.5-flash');
    await provider.sendStepPhase(
      [{ role: 'user', content: 'Take the next browser step.' }],
      'SYSTEM_PROMPT',
    );

    const config = generateContentMock.mock.calls[0][0].config;
    expect(config.temperature).toBe(0);
    expect(config.thinkingConfig).toEqual({ thinkingBudget: 5000 });
  });

  it('uses Gemini 3.x config (temperature 0, thinkingLevel) for gemini-3-flash-preview', async () => {
    generateContentMock.mockResolvedValueOnce({
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 },
      functionCalls: [{ name: 'step_wait', args: { description: 'Waiting.' } }],
      candidates: [],
    });

    const { GeminiProvider } = await import('./gemini');
    const provider = new GeminiProvider('gemini-3-flash-preview');
    await provider.sendStepPhase(
      [{ role: 'user', content: 'Take the next browser step.' }],
      'SYSTEM_PROMPT',
    );

    const config = generateContentMock.mock.calls[0][0].config;
    expect(config.temperature).toBe(0);
    expect(config.thinkingConfig).toHaveProperty('thinkingLevel');
    expect(config.thinkingConfig.thinkingBudget).toBeUndefined();
  });
});

describe('isGemini3Model', () => {
  it('returns true for gemini-3-flash-preview', () => {
    expect(isGemini3Model('gemini-3-flash-preview')).toBe(true);
  });

  it('returns true for gemini-3.1-flash-lite-preview', () => {
    expect(isGemini3Model('gemini-3.1-flash-lite-preview')).toBe(true);
  });

  it('returns false for gemini-2.5-flash', () => {
    expect(isGemini3Model('gemini-2.5-flash')).toBe(false);
  });

  it('returns false for gemini-2.5-flash-lite', () => {
    expect(isGemini3Model('gemini-2.5-flash-lite')).toBe(false);
  });

  it('returns false for gemini-2.0-flash', () => {
    expect(isGemini3Model('gemini-2.0-flash')).toBe(false);
  });
});

describe('getModelConfig', () => {
  it('returns temperature 0 and thinkingBudget for Gemini 2.x', () => {
    const config = getModelConfig('gemini-2.5-flash');
    expect(config.temperature).toBe(0);
    expect(config.thinkingConfig).toEqual({ thinkingBudget: 5000 });
  });

  it('returns temperature 0 and thinkingLevel for Gemini 3.x', () => {
    const config = getModelConfig('gemini-3-flash-preview');
    expect(config.temperature).toBe(0);
    expect(config.thinkingConfig).toHaveProperty('thinkingLevel');
    expect(config.thinkingConfig).not.toHaveProperty('thinkingBudget');
  });

  it('returns same config for gemini-3.1-flash-lite-preview', () => {
    const config = getModelConfig('gemini-3.1-flash-lite-preview');
    expect(config.temperature).toBe(0);
    expect(config.thinkingConfig).toHaveProperty('thinkingLevel');
  });
});

describe('per-crawl thinking level override', () => {
  it('getModelConfig maps an explicit level onto the generateContent enum for 3.x', () => {
    expect(getModelConfig('gemini-3-flash-preview', 'low').thinkingConfig).toEqual({ thinkingLevel: 'LOW' });
    expect(getModelConfig('gemini-3-flash-preview', 'minimal').thinkingConfig).toEqual({ thinkingLevel: 'LOW' });
    expect(getModelConfig('gemini-3-flash-preview', 'medium').thinkingConfig).toEqual({ thinkingLevel: 'MEDIUM' });
    expect(getModelConfig('gemini-3-flash-preview', 'high').thinkingConfig).toEqual({ thinkingLevel: 'MEDIUM' });
  });

  it('getModelConfig keeps the numeric budget for 2.x — the level enum is not a generateContent knob there', () => {
    expect(getModelConfig('gemini-2.5-flash', 'high').thinkingConfig).toEqual({ thinkingBudget: 5000 });
  });

  it('getInteractionsGenerationConfig sends the explicit level verbatim (3.x and 2.x)', () => {
    expect(getInteractionsGenerationConfig('gemini-3-flash-preview', 8192, undefined, 'high').thinking_level).toBe('high');
    expect(getInteractionsGenerationConfig('gemini-2.5-flash', 8192, undefined, 'medium').thinking_level).toBe('medium');
  });

  it('falls back to the env/default level when no override is given', () => {
    expect(getInteractionsGenerationConfig('gemini-3-flash-preview', 8192).thinking_level).toBe('medium');
    expect(getInteractionsGenerationConfig('gemini-2.5-flash', 8192).thinking_level).toBe(GEMINI2_INTERACTIONS_THINKING_LEVEL);
  });

  it('a provider constructed with a thinking level applies it to generateContent calls', async () => {
    generateContentMock.mockClear();
    generateContentMock.mockResolvedValueOnce({
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 },
      functionCalls: [{ name: 'step_wait', args: { description: 'Waiting.' } }],
      candidates: [],
    });
    const { GeminiProvider } = await import('./gemini');
    const provider = new GeminiProvider('gemini-3-flash-preview', 'low');
    await provider.sendStepPhase([{ role: 'user', content: 'Take the next browser step.' }], 'SYSTEM_PROMPT');
    expect(generateContentMock.mock.calls[0][0].config.thinkingConfig).toEqual({ thinkingLevel: 'LOW' });
  });
});

describe('getInteractionsGenerationConfig — thinking config alignment (CR-7)', () => {
  it('sets a thinking_level for Gemini 2.x on the active Interactions path (was previously absent)', () => {
    const config = getInteractionsGenerationConfig('gemini-2.5-flash', 8192);
    // The Interactions API has no numeric thinking_budget — only the enum level.
    expect(config).not.toHaveProperty('thinking_budget');
    expect(config.thinking_level).toBe(GEMINI2_INTERACTIONS_THINKING_LEVEL);
    expect(config.temperature).toBe(0);
    expect(config.max_output_tokens).toBe(8192);
  });

  it('uses a valid lowercase Interactions thinking_level for Gemini 2.x (mirrors legacy budget intent)', () => {
    const config = getInteractionsGenerationConfig('gemini-2.5-flash', 1024);
    expect(INTERACTIONS_THINKING_LEVELS).toContain(config.thinking_level);
    // The legacy thinkingBudget:5000 (~20% of 2.5 Flash's max) maps to 'low'.
    expect(config.thinking_level).toBe('low');
  });

  it('sets a valid lowercase thinking_level for Gemini 3.x (not the uppercase generateContent enum)', () => {
    const config = getInteractionsGenerationConfig('gemini-3-flash-preview', 8192);
    expect(INTERACTIONS_THINKING_LEVELS).toContain(config.thinking_level);
    expect(config.temperature).toBe(0);
  });

  it('nests mode/tools under allowed_tools (Interactions API ToolChoiceConfig)', () => {
    const config = getInteractionsGenerationConfig('gemini-2.5-flash', 1024, ['step_click', 'step_complete']);
    // The Interactions API rejects mode/tools directly on tool_choice with a 400
    // "Unknown parameter 'mode' at 'generation_config.tool_choice'"; they must be
    // nested under `allowed_tools`.
    expect(config.tool_choice).toEqual({
      allowed_tools: { mode: 'any', tools: ['step_click', 'step_complete'] },
    });
    expect((config.tool_choice as Record<string, unknown>).mode).toBeUndefined();
  });
});

describe('toInteractionsThinkingLevel', () => {
  it('maps the uppercase generateContent levels to lowercase Interactions levels', () => {
    expect(toInteractionsThinkingLevel('LOW')).toBe('low');
    expect(toInteractionsThinkingLevel('MEDIUM')).toBe('medium');
  });
});

describe('Contract-drift circuit breaker (ApiContractError)', () => {
  beforeEach(() => {
    vi.resetModules();
    generateContentMock.mockReset();
    interactionsCreateMock.mockReset();
    process.env.GEMINI_API_KEY = 'test-key';
  });

  it('restricts a forced continuation to step tools while retaining the requested thinking level', async () => {
    interactionsCreateMock.mockResolvedValue({
      id: 'int-step-only',
      status: 'completed',
      steps: [
        { type: 'function_call', id: 'fc-1', name: 'step_complete', arguments: { description: 'done' } },
      ],
      usage: { total_input_tokens: 1, total_output_tokens: 1, total_cached_tokens: 0 },
    });

    const { GeminiProvider } = await import('./gemini');
    const { GEMINI_STEP_FUNCTION_NAMES, GEMINI_ALL_FUNCTION_NAMES } = await import('../schema');
    const provider = new GeminiProvider('gemini-3-flash-preview', 'high');
    await provider.sendUnifiedInteraction(
      [{ type: 'text', text: 'act now' }] as never,
      'SYSTEM_PROMPT',
      undefined,
      { stepToolsOnly: true },
    );

    const request = interactionsCreateMock.mock.calls[0][0];
    const allowed = request.generation_config.tool_choice.allowed_tools.tools;
    expect(allowed).toEqual([...GEMINI_STEP_FUNCTION_NAMES]);
    expect(allowed).not.toEqual([...GEMINI_ALL_FUNCTION_NAMES]);
    expect(request.generation_config.thinking_level).toBe('high');
  });

  it('throws a typed ApiContractError on an Interactions 4xx with a contract-drift signature — and does NOT retry', async () => {
    // The exact tool_choice-incident shape: a 400 complaining about an unknown
    // parameter. Retrying a malformed request is wasteful — fail fast and typed.
    interactionsCreateMock.mockRejectedValue(
      new Error('400 Unknown parameter: generation_config.tool_choice.mode'),
    );

    const { GeminiProvider } = await import('./gemini');
    const { ApiContractError } = await import('./errors');
    const provider = new GeminiProvider('gemini-2.5-flash');

    await expect(
      provider.sendUnifiedInteraction(
        [{ type: 'text', text: 'go' }] as never,
        'SYSTEM_PROMPT',
      ),
    ).rejects.toBeInstanceOf(ApiContractError);

    // Fail-fast: the malformed request must NOT be retried.
    expect(interactionsCreateMock).toHaveBeenCalledTimes(1);
  });

  it('still retries a transient Interactions error (503) — contract breaker does not swallow transients', async () => {
    interactionsCreateMock
      .mockRejectedValueOnce(new Error('503 Service Unavailable'))
      .mockResolvedValueOnce({
        id: 'int-1',
        status: 'completed',
        steps: [
          { type: 'function_call', id: 'fc-1', name: 'step_complete', arguments: { description: 'done' } },
        ],
        usage: { total_input_tokens: 1, total_output_tokens: 1, total_cached_tokens: 0 },
      });

    const { GeminiProvider } = await import('./gemini');
    const provider = new GeminiProvider('gemini-2.5-flash');

    await provider.sendUnifiedInteraction(
      [{ type: 'text', text: 'go' }] as never,
      'SYSTEM_PROMPT',
    );

    expect(interactionsCreateMock).toHaveBeenCalledTimes(2);
  });

  it('throws a typed ApiContractError on a generateContent 4xx with a contract-drift signature — and does NOT retry', async () => {
    generateContentMock.mockRejectedValue(
      new Error('invalid_request: tools[0].parameters has an unexpected field'),
    );

    const { GeminiProvider } = await import('./gemini');
    const { ApiContractError } = await import('./errors');
    const provider = new GeminiProvider('gemini-2.5-flash');

    await expect(
      provider.sendStepPhase(
        [{ role: 'user', content: 'Take the next browser step.' }],
        'SYSTEM_PROMPT',
      ),
    ).rejects.toBeInstanceOf(ApiContractError);

    expect(generateContentMock).toHaveBeenCalledTimes(1);
  });
});
