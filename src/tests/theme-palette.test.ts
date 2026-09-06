import { describe, expect, it } from 'vitest';
import {
  buildComplementPalette,
  complementOf,
  COMPLEMENT_SHIFT_DEG,
} from 'src/utils/theme-palette';
import { parseRgb, rgbToHsl } from 'src/utils/color';

/** Hue of a color, for comparing against the accent it was rotated from. */
function hue(color: string): number {
  return rgbToHsl(parseRgb(color)!).h;
}

/** Circular distance between two hues, in degrees. */
function hueDistance(a: number, b: number): number {
  return Math.abs(((a - b + 540) % 360) - 180);
}

describe('complementOf', () => {
  it('rotates the accent onto the opposite side of the wheel', () => {
    const accent = 'rgb(77, 242, 197)';
    const complement = complementOf(accent);
    expect(hueDistance(hue(complement), hue(accent))).toBeCloseTo(COMPLEMENT_SHIFT_DEG, 0);
  });

  it('leaves a gray accent gray, so Monochrome stays monochrome', () => {
    expect(complementOf('rgb(255, 255, 255)')).toBe('rgb(255, 255, 255)');
    const [r, g, b] = parseRgb(complementOf('rgb(128, 128, 128)'))!;
    expect(r).toBe(g);
    expect(g).toBe(b);
  });

  it('keeps the accent lightness, so a dark theme keeps its register', () => {
    const accent = 'rgb(130, 150, 220)';
    expect(rgbToHsl(parseRgb(complementOf(accent))!).l).toBeCloseTo(
      rgbToHsl(parseRgb(accent)!).l,
      0,
    );
  });

  it('returns an unparsable color unchanged', () => {
    expect(complementOf('var(--nope)')).toBe('var(--nope)');
  });
});

describe('buildComplementPalette', () => {
  it('complements both theme accents', () => {
    const palette = buildComplementPalette('rgb(77, 242, 197)', 'rgb(88, 176, 255)');
    expect(palette.complement).toBe(complementOf('rgb(77, 242, 197)'));
    expect(palette.complementAlt).toBe(complementOf('rgb(88, 176, 255)'));
    // The point of the palette: the analyzers land far from the accents the
    // rest of the UI is painted in.
    expect(hueDistance(hue(palette.complement), hue('rgb(77, 242, 197)'))).toBeGreaterThan(120);
  });
});
