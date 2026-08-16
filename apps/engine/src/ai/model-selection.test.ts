/**
 * Model Selection Integration Test
 *
 * Verifies that the CrawlSession correctly passes the model ID to the
 * Gemini provider API and receives a valid response.
 * Requires GEMINI_API_KEY for live tests.
 *
 * Run: npx vitest run src/ai/model-selection.test.ts
 *
 * CI live contract gate: when REQUIRE_LIVE_GEMINI === '1' (set in the
 * crawler-test CI job's live-contract step), the live test is REQUIRED — a
 * missing GEMINI_API_KEY FAILS the suite instead of silently skipping. This is
 * the guard against the tool_choice incident: the only test that exercises the
 * real Interactions request shape must actually run before any crawler deploy.
 * Locally (flag unset), it still skips without a key so devs aren't blocked.
 */

import { describe, it, expect } from 'vitest';
import { CrawlSession } from './client';

const REQUIRE_LIVE_GEMINI = process.env.REQUIRE_LIVE_GEMINI === '1';

describe('CrawlSession model selection (live API)', () => {
  const hasKey = Boolean(process.env.GEMINI_API_KEY);

  // When REQUIRE_LIVE_GEMINI is set, this guard FAILS (rather than skips) if the
  // key is absent — forcing the GEMINI_API_KEY secret to exist in CI.
  it.runIf(REQUIRE_LIVE_GEMINI)(
    'REQUIRE_LIVE_GEMINI is set: GEMINI_API_KEY must be present',
    () => {
      expect(
        hasKey,
        'REQUIRE_LIVE_GEMINI=1 but GEMINI_API_KEY is not set — the live Gemini ' +
          'contract test cannot run. Add the GEMINI_API_KEY GitHub Actions secret.',
      ).toBe(true);
    },
  );

  // Run the live call whenever a key is present (locally OR in the CI gate).
  // This single live request exercises the real Interactions request shape that
  // drifted in the tool_choice incident: getInteractionsGenerationConfig →
  // tool_choice (allowed_tools.mode/tools), tools, generation_config, and
  // interaction.steps parsing + usage field names (total_input_tokens etc.).
  it.runIf(hasKey)('should call Gemini API with model=gemini-2.5-flash and get a valid step response', async () => {
    const modelId = 'gemini-2.5-flash';
    const session = new CrawlSession(
      'You are a test agent. Respond with action "complete" immediately.',
      modelId,
    );

    expect(session.getModelId()).toBe(modelId);

    // Minimal 1x1 white PNG as a dummy screenshot
    const TINY_PNG =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';

    const pageState = {
      screenshotBase64: TINY_PNG,
      fullHtml: '<html><body>Test page</body></html>',
      htmlLength: '<html><body>Test page</body></html>'.length,
    };

    const { response, usage } = await session.sendStep(
      pageState,
      'Goal: Respond with complete immediately. This is a test.',
      true,
    );

    expect(response).toBeDefined();
    expect(typeof response.action).toBe('string');
    expect(response.action.length).toBeGreaterThan(0);
    expect(usage.inputTokens).toBeGreaterThan(0);
    expect(usage.outputTokens).toBeGreaterThan(0);

    console.log(
      `[Test] model=${modelId} action=${response.action} ` +
      `tokens: in=${usage.inputTokens} out=${usage.outputTokens}`,
    );
  }, 90_000);
});

describe('CrawlSession model selection (unit)', () => {
  it('defaults to gemini-3.5-flash when no model is specified', () => {
    const session = new CrawlSession('test prompt');
    expect(session.getModelId()).toBe(
      process.env.GEMINI_MODEL || 'gemini-3.5-flash',
    );
  });

  it('uses the provided Gemini model ID', () => {
    const session = new CrawlSession('test prompt', 'gemini-2.5-pro');
    expect(session.getModelId()).toBe('gemini-2.5-pro');
  });

  it('throws on non-gemini model IDs at construction', () => {
    expect(() => new CrawlSession('test prompt', 'claude-sonnet-4-6')).toThrow(/Only gemini-\* models are supported/);
    expect(() => new CrawlSession('test prompt', 'unknown-model')).toThrow(/Only gemini-\* models are supported/);
  });
});
