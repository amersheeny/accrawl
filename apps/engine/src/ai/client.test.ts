/**
 * Tests for trimHistory — the function that strips heavy content
 * (screenshots and HTML) from older conversation turns.
 */

import { describe, it, expect } from 'vitest';
import {
  trimHistory,
  buildLargePageContinuationContext,
  buildFailureGuidance,
  FORCE_STEP_ACTION_DIRECTIVE,
  injectStepDirective,
  shouldForceStepAction,
} from './client';
import type Anthropic from '@anthropic-ai/sdk' with { 'resolution-mode': 'require' };

describe('trimHistory', () => {
  it('replaces image blocks with placeholder text', () => {
    const messages: Anthropic.MessageParam[] = [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
          { type: 'text', text: 'Some context' },
        ],
      },
    ];

    const result = trimHistory(messages);
    const content = result[0].content as Anthropic.ContentBlockParam[];
    expect(content[0]).toEqual({ type: 'text', text: '[previous screenshot omitted]' });
    expect((content[1] as Anthropic.TextBlockParam).text).toBe('Some context');
  });

  it('strips HTML dumps from text blocks', () => {
    const messages: Anthropic.MessageParam[] = [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'Current URL: /dashboard\n\nPage HTML (primary data source for extraction):\n<html><body>Big HTML here</body></html>',
          },
        ],
      },
    ];

    const result = trimHistory(messages);
    const content = result[0].content as Anthropic.ContentBlockParam[];
    const text = (content[0] as Anthropic.TextBlockParam).text;
    expect(text).toContain('Current URL: /dashboard');
    expect(text).toContain('[previous HTML omitted]');
    expect(text).not.toContain('<html>');
  });

  it('strips images and HTML from user messages with mixed content', () => {
    const messages: Anthropic.MessageParam[] = [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'BBBB' } },
          {
            type: 'text',
            text: 'Context\n\nPage HTML:\n<div>content</div>',
          },
        ],
      },
    ];

    const result = trimHistory(messages);
    const content = result[0].content as Anthropic.ContentBlockParam[];
    expect(content[0]).toEqual({ type: 'text', text: '[previous screenshot omitted]' });
    expect((content[1] as Anthropic.TextBlockParam).text).toContain('[previous HTML omitted]');
    expect((content[1] as Anthropic.TextBlockParam).text).not.toContain('<div>');
  });

  it('passes through string content messages unchanged', () => {
    const messages: Anthropic.MessageParam[] = [
      { role: 'user', content: 'Simple text message' },
    ];

    const result = trimHistory(messages);
    expect(result[0].content).toBe('Simple text message');
  });

  it('preserves text that does not contain HTML dump', () => {
    const messages: Anthropic.MessageParam[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Just some context without HTML' },
        ],
      },
    ];

    const result = trimHistory(messages);
    const content = result[0].content as Anthropic.ContentBlockParam[];
    expect((content[0] as Anthropic.TextBlockParam).text).toBe('Just some context without HTML');
  });

  it('handles empty messages array', () => {
    expect(trimHistory([])).toEqual([]);
  });

  it('preserves assistant messages with JSON text', () => {
    const messages: Anthropic.MessageParam[] = [
      {
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: '{"tool":"step","action":"click","selector":"#btn","description":"test","accounts":[],"transactions":[],"positions":[],"memoryNotes":[]}',
          },
        ],
      },
    ];

    const result = trimHistory(messages);
    const content = result[0].content as Anthropic.ContentBlockParam[];
    expect((content[0] as Anthropic.TextBlockParam).text).toContain('"tool":"step"');
  });

  it('handles "Page HTML:" variant (without parenthetical)', () => {
    const messages: Anthropic.MessageParam[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Context\n\nPage HTML:\n<html>stuff</html>' },
        ],
      },
    ];

    const result = trimHistory(messages);
    const content = result[0].content as Anthropic.ContentBlockParam[];
    const text = (content[0] as Anthropic.TextBlockParam).text;
    expect(text).toContain('[previous HTML omitted]');
    expect(text).not.toContain('<html>');
  });
});

describe('unified-loop inspection budget', () => {
  it('uses the pinned force-step instruction word-for-word', () => {
    expect(FORCE_STEP_ACTION_DIRECTIVE).toBe(
      'INVESTIGATION_BUDGET_SPENT: You have used up this step\'s page-inspection budget — many ' +
      'readHtml/searchHtml/getScreenshot calls without taking an action. You MUST take a concrete ' +
      'action NOW; you cannot read more on this step. If you have seen ANY financial data (accounts, ' +
      'transactions, or positions) in the HTML or screenshots so far, report it now with reportData. ' +
      'Otherwise take ONE navigation or complete action. A fresh full-page screenshot and the complete ' +
      'HTML are captured automatically for your NEXT step, where you can keep reading — so acting now ' +
      'loses nothing and does not restart your progress.',
    );
  });

  it('uses the pinned large-page continuation instruction word-for-word', () => {
    expect(buildLargePageContinuationContext('Account account-a')).toBe(
      'Continuing extraction on a large page — do NOT restart reading from the beginning. ' +
      'Report any financial data you have already seen with reportData, then take your next action. ' +
      'Data extracted so far in this crawl session:\nAccount account-a',
    );
  });

  it('allows normal inspection through call 16 and forces the remaining tail', () => {
    expect(shouldForceStepAction(0)).toBe(false);
    expect(shouldForceStepAction(15)).toBe(false);
    expect(shouldForceStepAction(16)).toBe(true);
    expect(shouldForceStepAction(24)).toBe(true);
  });

  it('always leaves the first call available when configured with a tiny budget', () => {
    expect(shouldForceStepAction(0, 1, 0)).toBe(false);
  });

  it('folds the directive into a pending function result', () => {
    const input = [{
      type: 'function_result',
      call_id: 'call-1',
      name: 'info_read_html',
      result: 'HTML slice',
    }] as never;
    const result = injectStepDirective(input, 'TAKE_A_STEP') as unknown as Array<{ result: string }>;
    expect(result).toHaveLength(1);
    expect(result[0].result).toContain('HTML slice');
    expect(result[0].result).toContain('TAKE_A_STEP');
  });

  it('adds a text directive to fresh input without discarding the original payload', () => {
    const input = [{ type: 'text', text: 'ONE_SHOT_SPREADSHEET' }] as never;
    const result = injectStepDirective(input, 'TAKE_A_STEP') as unknown as Array<{ text: string }>;
    expect(result.map(part => part.text)).toEqual(['ONE_SHOT_SPREADSHEET', 'TAKE_A_STEP']);
  });
});

// ─── Regression: INFRA-2 — failure guidance must match the ActionError type ───

describe('buildFailureGuidance', () => {
  it('states an ambiguous match factually and points to the unique selectors, without injecting a strategy', () => {
    const guidance = buildFailureGuidance('ambiguous_selector');
    expect(guidance).toContain('The action did NOT execute');
    expect(guidance).toContain('matched more than one element');
    expect(guidance).toContain('unique selector');
    // No strategy is decided for the model: neither the misleading generic
    // "different approach" nor the presumptuous "re-attempt the SAME action".
    expect(guidance).not.toContain('DIFFERENT approach');
    expect(guidance).not.toContain('SAME action');
  });

  it('points to searchHtml for a not-found selector, factually, without presuming the goal', () => {
    const guidance = buildFailureGuidance('selector_not_found');
    expect(guidance).toContain('The action did NOT execute');
    expect(guidance).toContain('searchHtml');
    expect(guidance).not.toContain('DIFFERENT approach');
    expect(guidance).not.toContain('re-attempt the same goal');
  });

  it('for other failures, states the action did not execute and suggests inspecting the page', () => {
    for (const errorType of ['click_failed', 'missing_field', undefined] as const) {
      const guidance = buildFailureGuidance(errorType);
      expect(guidance).toContain('The action did NOT execute');
      expect(guidance).toContain('do not proceed as if it had');
      expect(guidance).not.toContain('DIFFERENT approach');
    }
  });
});
