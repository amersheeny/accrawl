import { describe, expect, it } from 'vitest';
import { buildHardenedSystemInstruction } from './reliability';

describe('buildHardenedSystemInstruction', () => {
  it('retains the pinned repeated-balance reporting instruction', () => {
    const prompt = buildHardenedSystemInstruction('BASE');
    expect(prompt).toContain(
      'Do NOT loop on repeated balance-only `step_report_data` when holdings/transactions navigation is available; navigate and extract those pages first.',
    );
    expect(prompt).not.toContain('Do NOT loop on repeated account `step_report_data`');
  });

  it('retains the approved provider-account context addition', () => {
    expect(buildHardenedSystemInstruction('BASE')).toContain(
      "A transaction's providerAccountId MUST be identical (character-for-character) to the providerAccountId of the account it belongs to",
    );
  });
});
