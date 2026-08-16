/**
 * Tests for credential placeholder resolution and action validation.
 */

import { describe, it, expect } from 'vitest';
import { resolveValue, CREDENTIAL_PLACEHOLDERS, generateUniqueSelector, idSelector } from './actions';
import { JSDOM } from 'jsdom';

describe('CREDENTIAL_PLACEHOLDERS', () => {
  it('maps USERNAME to username', () => {
    expect(CREDENTIAL_PLACEHOLDERS.USERNAME).toBe('username');
  });

  it('maps PASSWORD to password', () => {
    expect(CREDENTIAL_PLACEHOLDERS.PASSWORD).toBe('password');
  });

  it('maps DOB to dob', () => {
    expect(CREDENTIAL_PLACEHOLDERS.DOB).toBe('dob');
  });

  it('maps PHONE to phone', () => {
    expect(CREDENTIAL_PLACEHOLDERS.PHONE).toBe('phone');
  });

  it('has exactly 4 credential placeholders', () => {
    expect(Object.keys(CREDENTIAL_PLACEHOLDERS)).toHaveLength(4);
  });
});

describe('resolveValue', () => {
  const credentials = {
    username: 'user@example.com',
    password: 's3cr3t!@#',
    dob: '1991-04-27',
  };

  // ─── Placeholder substitution ──────────────────────────

  it('substitutes USERNAME with real username', () => {
    expect(resolveValue('USERNAME', credentials)).toBe('user@example.com');
  });

  it('substitutes PASSWORD with real password', () => {
    expect(resolveValue('PASSWORD', credentials)).toBe('s3cr3t!@#');
  });

  it('substitutes DOB with real date of birth', () => {
    expect(resolveValue('DOB', credentials)).toBe('1991-04-27');
  });

  // ─── Non-placeholder passthrough ───────────────────────

  it('passes through regular text unchanged', () => {
    expect(resolveValue('hello world', credentials)).toBe('hello world');
  });

  it('passes through CSS selectors unchanged', () => {
    expect(resolveValue('#otp-input', credentials)).toBe('#otp-input');
  });

  it('passes through numeric strings unchanged', () => {
    expect(resolveValue('293238', credentials)).toBe('293238');
  });

  it('passes through copied OTP label text unchanged', () => {
    expect(resolveValue('verification code', credentials, '861959')).toBe('verification code');
  });

  it('passes through empty string unchanged', () => {
    expect(resolveValue('', credentials)).toBe('');
  });

  // ─── Case sensitivity ─────────────────────────────────

  it('is case-sensitive — "username" is not a placeholder', () => {
    expect(resolveValue('username', credentials)).toBe('username');
  });

  it('is case-sensitive — "Password" is not a placeholder', () => {
    expect(resolveValue('Password', credentials)).toBe('Password');
  });

  it('is case-sensitive — "dob" is not a placeholder', () => {
    expect(resolveValue('dob', credentials)).toBe('dob');
  });

  // ─── Partial matches are NOT substituted ───────────────

  it('does not substitute USERNAME embedded in longer text', () => {
    expect(resolveValue('my USERNAME here', credentials)).toBe('my USERNAME here');
  });

  it('does not substitute PASSWORD with prefix', () => {
    expect(resolveValue('PASSWORD123', credentials)).toBe('PASSWORD123');
  });

  // ─── Missing credential errors ─────────────────────────

  it('throws when DOB placeholder used but dob not provided', () => {
    const noDob = { username: 'user', password: 'pass', dob: undefined };
    expect(() => resolveValue('DOB', noDob)).toThrow("Credential placeholder 'DOB' has no value");
  });

  it('throws when USERNAME placeholder used but username is empty', () => {
    const noUser = { username: '', password: 'pass', dob: undefined };
    expect(() => resolveValue('USERNAME', noUser)).toThrow("Credential placeholder 'USERNAME' has no value");
  });

  // ─── Special characters in credentials ─────────────────

  it('handles special characters in password', () => {
    const special = { username: 'u', password: '<script>alert("xss")</script>', dob: undefined };
    expect(resolveValue('PASSWORD', special)).toBe('<script>alert("xss")</script>');
  });

  it('handles unicode in username', () => {
    const unicode = { username: 'ユーザー名', password: 'p', dob: undefined };
    expect(resolveValue('USERNAME', unicode)).toBe('ユーザー名');
  });

  it('handles whitespace in credentials', () => {
    const ws = { username: '  user  ', password: 'p', dob: undefined };
    expect(resolveValue('USERNAME', ws)).toBe('  user  ');
  });

  // ─── OTP_CODE placeholder ──────────────────────────────

  it('substitutes OTP_CODE with real OTP value', () => {
    expect(resolveValue('OTP_CODE', credentials, '861959')).toBe('861959');
  });

  it('throws when OTP_CODE used but no OTP value provided', () => {
    expect(() => resolveValue('OTP_CODE', credentials)).toThrow("OTP_CODE placeholder used but no OTP value available");
  });

  it('throws when OTP_CODE used with undefined OTP', () => {
    expect(() => resolveValue('OTP_CODE', credentials, undefined)).toThrow("OTP_CODE placeholder used but no OTP value available");
  });

  it('passes through OTP_CODE as text when embedded in longer string', () => {
    expect(resolveValue('enter OTP_CODE here', credentials, '123456')).toBe('enter OTP_CODE here');
  });

  it('OTP_CODE takes priority over credential lookup', () => {
    expect(resolveValue('OTP_CODE', credentials, '999999')).toBe('999999');
  });
});

describe('generateUniqueSelector', () => {
  function makeDOM(html: string): Document {
    return new JSDOM(html).window.document;
  }

  it('returns id shortcut when element has an id', () => {
    const doc = makeDOM('<body><div id="main"><button id="submit">Go</button></div></body>');
    const btn = doc.querySelector('#submit')!;
    expect(generateUniqueSelector(btn)).toBe('#submit');
  });

  it('generates nth-of-type path for element without id', () => {
    const doc = makeDOM('<body><div><span>A</span><span>B</span></div></body>');
    const secondSpan = doc.querySelectorAll('span')[1];
    const result = generateUniqueSelector(secondSpan);
    expect(result).toContain('span:nth-of-type(2)');
  });

  it('stops at ancestor with id', () => {
    const doc = makeDOM('<body><div id="panel"><ul><li>First</li><li>Second</li></ul></div></body>');
    const secondLi = doc.querySelectorAll('li')[1];
    const result = generateUniqueSelector(secondLi);
    expect(result).toBe('#panel > ul:nth-of-type(1) > li:nth-of-type(2)');
  });

  it('disambiguates identical elements in different parents', () => {
    const doc = makeDOM(`<body>
      <div id="portfolio"><a class="dropdown-toggle">A</a></div>
      <div id="orders"><a class="dropdown-toggle">A</a></div>
    </body>`);
    const links = doc.querySelectorAll('a.dropdown-toggle');
    const sel0 = generateUniqueSelector(links[0]);
    const sel1 = generateUniqueSelector(links[1]);
    expect(sel0).not.toBe(sel1);
    expect(sel0).toBe('#portfolio > a:nth-of-type(1)');
    expect(sel1).toBe('#orders > a:nth-of-type(1)');
  });

  it('disambiguates identical elements without parent ids', () => {
    const doc = makeDOM(`<body>
      <div class="panel"><button type="submit">Go</button></div>
      <div class="panel"><button type="submit">Go</button></div>
    </body>`);
    const buttons = doc.querySelectorAll('button[type="submit"]');
    const sel0 = generateUniqueSelector(buttons[0]);
    const sel1 = generateUniqueSelector(buttons[1]);
    expect(sel0).not.toBe(sel1);
    // First div vs second div should differ
    expect(sel0).toContain('div:nth-of-type(1)');
    expect(sel1).toContain('div:nth-of-type(2)');
  });

  it('handles deeply nested element (anchored at body)', () => {
    const doc = makeDOM('<body><div><ul><li><a href="#">Link</a></li></ul></div></body>');
    const link = doc.querySelector('a')!;
    const result = generateUniqueSelector(link);
    expect(result).toBe('body > div:nth-of-type(1) > ul:nth-of-type(1) > li:nth-of-type(1) > a:nth-of-type(1)');
  });

  it('handles single element (anchored at body)', () => {
    const doc = makeDOM('<body><button>Click</button></body>');
    const btn = doc.querySelector('button')!;
    expect(generateUniqueSelector(btn)).toBe('body > button:nth-of-type(1)');
  });

  it('anchors selectors so they are GLOBALLY unique (regression: relative nth-of-type)', () => {
    // Reproduces a real brokerage's shape: an export <li> in a <ul> that is a 2nd-of-type ul
    // both inside <nav> AND directly under <body>. The OLD generator stopped
    // before <body>, emitting the relative "ul:nth-of-type(2) > li:nth-of-type(1)"
    // — which matches BOTH export items. The anchored form must match exactly one.
    const doc = makeDOM(`<body>
      <nav><ul><li>n</li></ul><ul><li class="export">NAV</li></ul></nav>
      <ul><li>b</li></ul>
      <ul><li class="export">BODY</li></ul>
    </body>`);
    const exports = Array.from(doc.querySelectorAll('li.export'));
    expect(exports.length).toBe(2);
    // Old relative form would have been non-unique — prove that to anchor the regression.
    expect(doc.querySelectorAll('ul:nth-of-type(2) > li:nth-of-type(1)').length).toBeGreaterThan(1);
    for (const li of exports) {
      const sel = generateUniqueSelector(li);
      expect(doc.querySelectorAll(sel).length).toBe(1); // globally unique
      expect(doc.querySelector(sel)).toBe(li);
    }
  });

  it('uses an [id="..."] anchor when an ancestor id is not a valid CSS identifier', () => {
    // Some ui-grid cell ids start with a digit, so "#123-cell" is invalid CSS.
    const doc = makeDOM('<body><div id="123-cell"><a href="#">L</a></div></body>');
    const link = doc.querySelector('a')!;
    const sel = generateUniqueSelector(link);
    expect(sel).toBe('[id="123-cell"] > a:nth-of-type(1)');
    expect(doc.querySelectorAll(sel).length).toBe(1);
  });
});

describe('idSelector', () => {
  it('uses #id for simple identifiers', () => {
    expect(idSelector('submit-btn')).toBe('#submit-btn');
    expect(idSelector('panel')).toBe('#panel');
  });

  it('falls back to [id="..."] for digit-leading or special ids', () => {
    expect(idSelector('1781799904576-0-uiGrid-02BW-cell')).toBe('[id="1781799904576-0-uiGrid-02BW-cell"]');
    expect(idSelector('a.b')).toBe('[id="a.b"]');
  });
});
