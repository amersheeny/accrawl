/**
 * The supported-currency list is what the model is CONSTRAINED to emit, so a code missing from it is
 * not a rejected account — it is an account reported under the wrong currency, with every derived
 * figure wrong and nothing to show it happened. These tests exist to make that failure impossible to
 * reintroduce quietly.
 */
import { describe, it, expect } from 'vitest';
import { SUPPORTED_CURRENCY_CODES } from './schema';

/** Current ISO-4217 codes according to the runtime's own ICU data. */
const RUNTIME_CURRENCIES = Intl.supportedValuesOf('currency');

describe('SUPPORTED_CURRENCY_CODES', () => {
  it('covers every currency the runtime knows about', () => {
    const supported = new Set<string>(SUPPORTED_CURRENCY_CODES);
    const missing = RUNTIME_CURRENCIES.filter((code) => !supported.has(code));
    expect(
      missing,
      missing.length === 0 ? '' : `Regenerate SUPPORTED_CURRENCY_CODES from Intl.supportedValuesOf('currency') — `
        + `the runtime knows ${missing.length} code(s) this list would force the model to mis-report: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('holds the world, not one provider\'s reference set', () => {
    // The regression this replaces shipped 31 codes. Any similar narrowing trips this.
    expect(SUPPORTED_CURRENCY_CODES.length).toBeGreaterThan(150);
  });

  it('covers the widely-used currencies a 31-code list omitted', () => {
    // Each of these is a currency a real user holds an account in, and each was previously impossible
    // for the model to report: Gulf, African, South Asian, South-East Asian, Latin American, East Asian.
    for (const code of [
      'AED', 'SAR', 'QAR', 'KWD', 'BHD', 'OMR', 'JOD', 'EGP',
      'NGN', 'KES', 'GHS', 'TZS', 'UGX', 'MAD', 'XOF', 'XAF',
      'PKR', 'BDT', 'LKR', 'NPR', 'VND', 'TWD',
      'CLP', 'COP', 'ARS', 'PEN', 'UAH', 'KZT',
    ]) {
      expect(SUPPORTED_CURRENCY_CODES, `${code} must be reportable`).toContain(code);
    }
  });

  it('contains only well-formed, unique ISO-4217 codes', () => {
    for (const code of SUPPORTED_CURRENCY_CODES) {
      expect(code, `${code} is not a 3-letter uppercase code`).toMatch(/^[A-Z]{3}$/);
    }
    expect(new Set<string>(SUPPORTED_CURRENCY_CODES).size).toBe(SUPPORTED_CURRENCY_CODES.length);
  });

  it('agrees with the shape the storage layer already enforces', () => {
    // store-crawl.ts validates /^[A-Z]{3}$/ and nothing more, so nothing in this list can be rejected
    // downstream — the enum was always the narrower of the two, which is why the loss was silent.
    const storageShape = /^[A-Z]{3}$/;
    expect(SUPPORTED_CURRENCY_CODES.every((code) => storageShape.test(code))).toBe(true);
  });
});
