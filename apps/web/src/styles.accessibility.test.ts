import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function channel(value: number): number {
  const normalized = value / 255;
  return normalized <= 0.04045
    ? normalized / 12.92
    : ((normalized + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const channels = hex.slice(1).match(/../g)?.map((value) =>
    channel(Number.parseInt(value, 16)));
  if (!channels || channels.length !== 3) throw new Error(`Invalid colour: ${hex}`);
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(foreground: string, background: string): number {
  const values = [luminance(foreground), luminance(background)].sort(
    (a, b) => b - a,
  );
  return (values[0] + 0.05) / (values[1] + 0.05);
}

describe('console design tokens', () => {
  it('keeps faint normal-sized text readable on the lightest dark surface', () => {
    const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
    const token = (name: string): string => {
      const value = css.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`))?.[1];
      if (!value) throw new Error(`Missing colour token: ${name}`);
      return value;
    };

    expect(contrast(token('text-faint'), token('panel-hover'))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(token('accent'), token('panel-hover'))).toBeGreaterThanOrEqual(4.5);
    expect(contrast('#ffffff', token('accent-surface'))).toBeGreaterThanOrEqual(4.5);
    expect(contrast('#ffffff', token('accent-surface-hover'))).toBeGreaterThanOrEqual(4.5);
    expect(contrast('#ffffff', token('accent-gradient-end'))).toBeGreaterThanOrEqual(4.5);
  });
});
