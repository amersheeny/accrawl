import { describe, it, expect } from 'vitest';
import { Type } from '@google/genai';
import {
  SELECTOR_ACTIONS,
  NO_SELECTOR_ACTIONS,
  ALL_ACTIONS,
  EXECUTABLE_ACTIONS,
  STEP_TOOL_NAMES_BY_ACTION,
  STEP_INPUT_SCHEMA_BY_TOOL_NAME,
  STEP_ACTION_BY_TOOL_NAME,
  GEMINI_STEP_FUNCTION_DECLARATIONS,
  GEMINI_STEP_FUNCTION_NAMES,
  GEMINI_INFO_FUNCTION_DECLARATIONS,
  GEMINI_INFO_FUNCTION_NAMES,
  STEP_TOOL_RESULT_ACK,
  SUPPORTED_CURRENCY_CODES,
  parseGeminiInfoFunctionCall,
  mapStepToolCallUnchecked,
  isStepToolName,
} from './schema';

interface NativeSchemaField { type?: Type; format?: string; enum?: string[]; pattern?: string; description?: string }
function reportItemSchema(arrayProp: 'accounts' | 'transactions' | 'positions') {
  const decl = GEMINI_STEP_FUNCTION_DECLARATIONS.find(d => d.name === 'step_report_data')!;
  const props = (decl.parameters as { properties: Record<string, { items: { properties: Record<string, NativeSchemaField> } }> }).properties;
  return props[arrayProp].items.properties;
}

describe('action constants', () => {
  it('selector and non-selector action groups are stable', () => {
    expect(SELECTOR_ACTIONS).toEqual(['click', 'fill', 'select']);
    expect(NO_SELECTOR_ACTIONS).toEqual([
      'wait',
      'scroll',
      'navigate',
      'loginFlowRestarted',
      'waitForOtp',
      'loginComplete',
      'complete',
      'error',
      'reportData',
    ]);
  });

  it('ALL_ACTIONS and EXECUTABLE_ACTIONS contain expected action names', () => {
    expect(ALL_ACTIONS).toHaveLength(12);
    expect(EXECUTABLE_ACTIONS).toEqual(['click', 'fill', 'select', 'wait', 'scroll', 'navigate']);
  });
});

describe('provider-specific step tool registries', () => {
  it('defines a tool/function name per action and invertible mapping', () => {
    expect(Object.keys(STEP_TOOL_NAMES_BY_ACTION)).toEqual([...ALL_ACTIONS]);

    for (const action of ALL_ACTIONS) {
      const toolNames = STEP_TOOL_NAMES_BY_ACTION[action];
      expect(toolNames.length).toBeGreaterThan(0);
      for (const toolName of toolNames) {
        expect(typeof toolName).toBe('string');
        expect(STEP_ACTION_BY_TOOL_NAME[toolName]).toBe(action);
        expect(isStepToolName(toolName)).toBe(true);
      }
    }

    expect(isStepToolName('execute_step')).toBe(false);
  });

  it('exposes per-action parameter schemas (step_click requires selector)', () => {
    const clickSchema = STEP_INPUT_SCHEMA_BY_TOOL_NAME.step_click as Record<string, unknown>;
    const clickRequired = clickSchema.required as string[];
    expect(clickSchema.type).toBe('object');
    expect(clickSchema.additionalProperties).toBe(false);
    expect(clickRequired).toContain('selector');
    expect(clickRequired).toContain('description');
    expect(clickRequired).not.toContain('accounts');
  });

  it('report data tool schema allows supported financial arrays to be reported together', () => {
    const reportSchema = STEP_INPUT_SCHEMA_BY_TOOL_NAME.step_report_data as Record<string, unknown>;
    const props = reportSchema.properties as Record<string, unknown>;

    expect(reportSchema.required as string[]).toEqual(['description']);
    expect(props.accounts).toBeDefined();
    expect(props.transactions).toBeDefined();
    expect(props.positions).toBeDefined();
    expect(props.memoryNotes).toBeDefined();
  });

  it('Gemini step declarations use native Schema (parameters) with no additionalProperties', () => {
    const expectedToolNames = Object.values(STEP_TOOL_NAMES_BY_ACTION).flat();
    expect(GEMINI_STEP_FUNCTION_DECLARATIONS).toHaveLength(expectedToolNames.length);
    expect(GEMINI_STEP_FUNCTION_NAMES).toEqual(expectedToolNames);

    for (const decl of GEMINI_STEP_FUNCTION_DECLARATIONS) {
      // Uses parameters (native Schema), NOT parametersJsonSchema
      expect('parameters' in decl).toBe(true);
      expect('parametersJsonSchema' in decl).toBe(false);
      const schema = decl.parameters as Record<string, unknown>;
      expect(schema.type).toBe(Type.OBJECT);
      expect(schema.additionalProperties).toBeUndefined();
      expect(decl.description.length).toBeGreaterThan(20);
    }
  });

  it('report data native schema supports mixed financial pages', () => {
    const reportDecl = GEMINI_STEP_FUNCTION_DECLARATIONS.find(d => d.name === 'step_report_data')!;
    const reportSchema = reportDecl.parameters as { properties: Record<string, { type: Type }>; required: string[] };

    expect(reportSchema.required).toEqual(['description']);
    expect(reportSchema.properties.accounts.type).toBe(Type.ARRAY);
    expect(reportSchema.properties.transactions.type).toBe(Type.ARRAY);
    expect(reportSchema.properties.positions.type).toBe(Type.ARRAY);
    expect(reportSchema.properties.memoryNotes.type).toBe(Type.ARRAY);
  });

  it('Gemini info-phase declarations use native Schema with no additionalProperties', () => {
    expect(GEMINI_INFO_FUNCTION_DECLARATIONS).toHaveLength(4);
    expect(GEMINI_INFO_FUNCTION_NAMES).toEqual([
      'info_read_html',
      'info_search_html',
      'info_get_screenshot',
      'info_step',
    ]);

    for (const decl of GEMINI_INFO_FUNCTION_DECLARATIONS) {
      expect('parameters' in decl).toBe(true);
      expect('parametersJsonSchema' in decl).toBe(false);
      const schema = decl.parameters as Record<string, unknown>;
      expect(schema.type).toBe(Type.OBJECT);
      expect(schema.additionalProperties).toBeUndefined();
    }
  });
});

describe('extraction schema field constraints (model-boundary enforcement)', () => {
  it('transaction bookingDate is constrained to format:date so the model cannot emit free-form text', () => {
    const tx = reportItemSchema('transactions');
    expect(tx.bookingDate.type).toBe(Type.STRING);
    expect(tx.bookingDate.format).toBe('date');
  });

  it('does NOT add an unenforced pattern to bookingDate (Gemini ignores pattern — false sense of enforcement)', () => {
    const tx = reportItemSchema('transactions');
    expect(tx.bookingDate.pattern).toBeUndefined();
  });

  it('transaction currency is an enum over the supported ISO-4217 codes', () => {
    const tx = reportItemSchema('transactions');
    expect(tx.currency.type).toBe(Type.STRING);
    expect(tx.currency.enum).toEqual([...SUPPORTED_CURRENCY_CODES]);
  });

  it('transaction multiplicity is an optional integer count claim', () => {
    const tx = reportItemSchema('transactions');
    expect(tx.count.type).toBe(Type.INTEGER);
  });

  it('account currency is an enum over the supported ISO-4217 codes', () => {
    const acc = reportItemSchema('accounts');
    expect(acc.currency.enum).toEqual([...SUPPORTED_CURRENCY_CODES]);
  });

  // Institutions write a card debt either way — "-1,234" here, "1,234 to pay" there. Whichever the site
  // chose, extraction must land on one convention, or the same debt reaches consumers with two meanings.
  // The published contract says a credit balance is the amount owed, positive; the schema has to say so too.
  it('pins the credit-balance sign at extraction (owed is positive)', () => {
    const acc = reportItemSchema('accounts');
    const description = (acc.balance as { description?: string }).description ?? '';
    expect(description).toMatch(/CREDIT/);
    expect(description).toMatch(/OWED as a POSITIVE number/);
  });

  it('position currency is an enum over the supported ISO-4217 codes', () => {
    const pos = reportItemSchema('positions');
    expect(pos.currency.enum).toEqual([...SUPPORTED_CURRENCY_CODES]);
  });

  it('requires every reported position to identify its owning account', () => {
    const decl = GEMINI_STEP_FUNCTION_DECLARATIONS.find(d => d.name === 'step_report_data')!;
    const params = decl.parameters as {
      properties: { positions: { items: { required?: string[] } } };
    };
    expect(params.properties.positions.items.required).toContain('providerAccountId');
    expect(params.properties.positions.items.required).not.toContain('providerPositionId');
  });

  it('rejects an empty position account id at the provider-independent boundary', () => {
    const schema = STEP_INPUT_SCHEMA_BY_TOOL_NAME.step_report_data as {
      properties: { positions: { items: { properties: { providerAccountId: { minLength?: number } } } } };
    };
    expect(schema.properties.positions.items.properties.providerAccountId.minLength).toBe(1);
  });

  it('supported currency set covers the currencies institutions produce plus the FX-convertible set', () => {
    // Sanity: the codes the audit explicitly called out must be present.
    for (const code of ['SEK', 'USD', 'EUR', 'GBP', 'CHF', 'JPY', 'CAD', 'AUD']) {
      expect(SUPPORTED_CURRENCY_CODES).toContain(code);
    }
    // All codes are unique, 3-letter, uppercase ISO-4217 shapes.
    expect(new Set(SUPPORTED_CURRENCY_CODES).size).toBe(SUPPORTED_CURRENCY_CODES.length);
    for (const code of SUPPORTED_CURRENCY_CODES) {
      expect(code).toMatch(/^[A-Z]{3}$/);
    }
  });
});

describe('runtime parsing', () => {
  it('parses Gemini info function calls into canonical info output', () => {
    expect(parseGeminiInfoFunctionCall('info_read_html', {
      start: 10,
      end: 50,
      reason: 'inspect login section',
    })).toEqual({
      tool: 'readHtml',
      start: 10,
      end: 50,
      reason: 'inspect login section',
    });

    expect(parseGeminiInfoFunctionCall('info_step', {})).toEqual({ tool: 'step' });
  });

  it('rejects unknown Gemini info function names', () => {
    expect(() => parseGeminiInfoFunctionCall('info_unknown', {})).toThrow(/Unknown Gemini info function/);
  });

  it('rejects malformed Gemini info payloads with actionable errors', () => {
    expect(() => parseGeminiInfoFunctionCall('info_read_html', { start: 10 }))
      .toThrow(/Invalid info_read_html payload/);
  });

  it('step tool result ack has correct fields', () => {
    expect(STEP_TOOL_RESULT_ACK.status).toBe('accepted');
    expect(STEP_TOOL_RESULT_ACK.feedbackChannel).toBe('ACTION_FEEDBACK');
    expect(STEP_TOOL_RESULT_ACK.execution).toBe('async');
  });
});

describe('mapStepToolCallUnchecked — Gemini response path', () => {
  it('maps click args to StepResponse with empty data arrays', () => {
    const r = mapStepToolCallUnchecked('step_click', { description: 'Click login', selector: '#login' });
    expect(r.action).toBe('click');
    expect(r.description).toBe('Click login');
    expect(r.selector).toBe('#login');
    expect(r.accounts).toEqual([]);
    expect(r.transactions).toEqual([]);
    expect(r.positions).toEqual([]);
    expect(r.memoryNotes).toEqual([]);
  });

  it('extracts memoryNotes from non-reportData steps when provided', () => {
    const notes = [{ key: 'login_btn', value: '#login-button' }, { key: 'form_type', value: 'Auth0 SMS' }];

    const click = mapStepToolCallUnchecked('step_click', { description: 'Click login', selector: '#login', memoryNotes: notes });
    expect(click.memoryNotes).toEqual(notes);
    expect(click.accounts).toEqual([]);

    const fill = mapStepToolCallUnchecked('step_fill', { description: 'Enter user', selector: '#user', value: 'USERNAME', memoryNotes: [notes[0]] });
    expect(fill.memoryNotes).toEqual([notes[0]]);

    const wait = mapStepToolCallUnchecked('step_wait', { description: 'Wait', ms: 1000, memoryNotes: notes });
    expect(wait.memoryNotes).toEqual(notes);

    const scroll = mapStepToolCallUnchecked('step_scroll', { description: 'Scroll', memoryNotes: notes });
    expect(scroll.memoryNotes).toEqual(notes);

    const nav = mapStepToolCallUnchecked('step_navigate', { description: 'Go', url: 'https://bank.com', memoryNotes: notes });
    expect(nav.memoryNotes).toEqual(notes);

    const login = mapStepToolCallUnchecked('step_login_complete', { description: 'Done', memoryNotes: notes });
    expect(login.memoryNotes).toEqual(notes);

    const otp = mapStepToolCallUnchecked('step_wait_for_otp', { description: 'OTP', memoryNotes: notes });
    expect(otp.memoryNotes).toEqual(notes);

    const err = mapStepToolCallUnchecked('step_error', { description: 'Err', message: 'fail', memoryNotes: notes });
    expect(err.memoryNotes).toEqual(notes);

    const complete = mapStepToolCallUnchecked('step_complete', { description: 'Done', memoryNotes: notes });
    expect(complete.memoryNotes).toEqual(notes);

    const restart = mapStepToolCallUnchecked('step_login_flow_restarted', { description: 'Restart', memoryNotes: notes });
    expect(restart.memoryNotes).toEqual(notes);

    const sel = mapStepToolCallUnchecked('step_select', { description: 'Select', selector: '#opt', value: 'a', memoryNotes: notes });
    expect(sel.memoryNotes).toEqual(notes);
  });

  it('maps fill args including value', () => {
    const r = mapStepToolCallUnchecked('step_fill', { description: 'Enter password', selector: '#pass', value: 'secret' });
    expect(r.action).toBe('fill');
    expect(r.value).toBe('secret');
    expect(r.selector).toBe('#pass');
  });

  it('maps wait args with optional ms', () => {
    const withMs = mapStepToolCallUnchecked('step_wait', { description: 'Wait 2s', ms: 2000 });
    expect(withMs.action).toBe('wait');
    expect(withMs.ms).toBe(2000);

    const withoutMs = mapStepToolCallUnchecked('step_wait', { description: 'Wait' });
    expect(withoutMs.ms).toBeUndefined();
  });

  it('maps scroll args with optional direction and amount', () => {
    const r = mapStepToolCallUnchecked('step_scroll', { description: 'Scroll down', direction: 'down', amount: 300 });
    expect(r.action).toBe('scroll');
    expect(r.direction).toBe('down');
    expect(r.amount).toBe(300);

    const bare = mapStepToolCallUnchecked('step_scroll', { description: 'Scroll' });
    expect(bare.direction).toBeUndefined();
    expect(bare.amount).toBeUndefined();
  });

  it('maps navigate args with url', () => {
    const r = mapStepToolCallUnchecked('step_navigate', { description: 'Go to login', url: 'https://bank.example.com/login' });
    expect(r.action).toBe('navigate');
    expect(r.url).toBe('https://bank.example.com/login');
  });

  it('maps terminal actions (complete, error, loginFlowRestarted, loginComplete, waitForOtp)', () => {
    expect(mapStepToolCallUnchecked('step_complete', { description: 'Done' }).action).toBe('complete');
    expect(mapStepToolCallUnchecked('step_login_flow_restarted', { description: 'Auth restarted after earlier successful login' }).action).toBe('loginFlowRestarted');
    expect(mapStepToolCallUnchecked('step_login_complete', { description: 'Logged in' }).action).toBe('loginComplete');
    expect(mapStepToolCallUnchecked('step_wait_for_otp', { description: 'Waiting' }).action).toBe('waitForOtp');

    const err = mapStepToolCallUnchecked('step_error', { description: 'Failed', message: 'CAPTCHA detected' });
    expect(err.action).toBe('error');
    expect(err.message).toBe('CAPTCHA detected');
  });

  it('maps report data args with mixed financial classes into a reportData step response', () => {
    const r = mapStepToolCallUnchecked('step_report_data', {
      description: 'Report dashboard balances and positions',
      accounts: [{
        providerAccountId: 'acc-1',
        name: 'Main',
        description: 'Checking',
        currency: 'EUR',
        type: 'current',
        balance: 5000,
      }],
      positions: [{
        providerPositionId: 'pos-1',
        providerAccountId: 'acc-1',
        identifier: '103788',
        ticker: 'META',
        name: 'Meta Platforms',
        quantity: 10,
        currency: 'USD',
        valueNative: 1000,
      }],
      memoryNotes: [{ key: 'portfolio_page', value: '/portfolio' }],
    });
    expect(r.action).toBe('reportData');
    expect(r.accounts).toHaveLength(1);
    expect(r.transactions).toEqual([]);
    expect(r.positions).toHaveLength(1);
    // symbol = the real market ticker (from `ticker`), NOT the broker's
    // internal code (`identifier`), which is preserved in providerPositionId.
    expect(r.positions[0].symbol).toBe('META');
    expect(r.positions[0].providerPositionId).toBe('pos-1');
    expect(r.positions[0].providerAccountId).toBe('acc-1');
    expect(r.memoryNotes).toHaveLength(1);
  });

  it('normalizes placeholder tickers (NONE / N/A / -) to an absent symbol', () => {
    const r = mapStepToolCallUnchecked('step_report_data', {
      description: 'Report positions including tickerless securities',
      positions: [
        // Cash balance — model emitted the "NONE" sentinel instead of omitting.
        { providerPositionId: '40011', providerAccountId: 'acc-1', identifier: '40011', ticker: 'NONE', name: 'Cash Balance USD', quantity: 349.81, currency: 'EUR', valueNative: 1020.75 },
        // Local tracking fund — no public ticker; model left it off entirely.
        { providerPositionId: '40022', providerAccountId: 'acc-1', identifier: '40022', name: 'Index Tracker MTF', quantity: 20164, currency: 'EUR', valueNative: 45935.61 },
        // Real US holding — ticker preserved, internal code in providerPositionId.
        { providerPositionId: '103788', providerAccountId: 'acc-1', identifier: '103788', ticker: 'aapl ', name: 'AAPLE COM(AAPL)', quantity: 95, currency: 'USD', valueNative: 82040.3 },
      ],
    });
    expect(r.action).toBe('reportData');
    expect(r.positions).toHaveLength(3);
    // "NONE" placeholder → no symbol (must not reach storage / Yahoo).
    expect(r.positions[0].symbol).toBeUndefined();
    expect(r.positions[0].providerPositionId).toBe('40011');
    // Genuinely tickerless → no symbol.
    expect(r.positions[1].symbol).toBeUndefined();
    // Real ticker → trimmed and kept; internal code stays in providerPositionId.
    expect(r.positions[2].symbol).toBe('aapl');
    expect(r.positions[2].providerPositionId).toBe('103788');
  });

  it('defaults omitted report arrays to empty arrays', () => {
    const r = mapStepToolCallUnchecked('step_report_data', {
      description: 'Record structure',
      memoryNotes: [{ key: 'accounts_page', value: '/accounts' }],
    });
    expect(r.action).toBe('reportData');
    expect(r.accounts).toEqual([]);
    expect(r.transactions).toEqual([]);
    expect(r.positions).toEqual([]);
    expect(r.memoryNotes).toHaveLength(1);
  });

  it('throws on unknown tool name', () => {
    expect(() => mapStepToolCallUnchecked('step_unknown', {})).toThrow(/Unknown step tool/);
  });
});

describe('Gemini native schema consistency with Zod schemas', () => {
  // Verify that the required fields in each native Gemini Schema match the
  // required fields in the corresponding Zod-generated JSON Schema.
  // This catches drift when one is updated but the other is not.

  for (const toolName of GEMINI_STEP_FUNCTION_NAMES) {
    it(`native Gemini schema required fields match Zod schema for tool: ${toolName}`, () => {
      const geminiDecl = GEMINI_STEP_FUNCTION_DECLARATIONS.find(d => d.name === toolName)!;
      expect(geminiDecl).toBeDefined();

      const geminiRequired: string[] = (geminiDecl.parameters as { required?: string[] }).required ?? [];
      const zodRequired: string[] = (STEP_INPUT_SCHEMA_BY_TOOL_NAME[toolName] as { required?: string[] }).required ?? [];

      // Every required field in the Zod schema must be required in the Gemini schema
      for (const field of zodRequired) {
        expect(geminiRequired).toContain(field);
      }
    });

    it(`native Gemini schema properties match Zod schema for tool: ${toolName}`, () => {
      const geminiDecl = GEMINI_STEP_FUNCTION_DECLARATIONS.find(d => d.name === toolName)!;
      const geminiProps = Object.keys((geminiDecl.parameters as { properties?: Record<string, unknown> }).properties ?? {});
      const zodProps = Object.keys((STEP_INPUT_SCHEMA_BY_TOOL_NAME[toolName] as { properties?: Record<string, unknown> }).properties ?? {});

      // Every property in the Zod schema must exist in the native Gemini schema
      for (const prop of zodProps) {
        expect(geminiProps).toContain(prop);
      }
    });
  }
});
