import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { deriveBrightText, parseRgb, rgbToHsl } from 'src/utils/color';
import { useThemeStore } from 'src/stores/theme-store';

/**
 * NOTE-5: the playing row's "brighter" cell-text variant lifts the glyphs off
 * the active-row pill, which is a low-alpha tint over the dark tracker
 * background in every theme (built-in and custom). "Brighter" therefore always
 * means *toward white* — never darker than the base token — while keeping the
 * column's hue so mint effect text stays mint. One helper feeds both the DOM
 * (`--tracker-*-bright` custom props) and the canvas (`pattern-theme`).
 */
const luminance = ([r, g, b]: [number, number, number]) =>
  (0.299 * r + 0.587 * g + 0.114 * b) / 255;

/** Smallest signed distance between two hues, in degrees. */
function hueDelta(a: number, b: number): number {
  return Math.abs(((a - b + 540) % 360) - 180);
}

describe('deriveBrightText', () => {
  // The real effect-text / volume-text tokens the built-in themes ship: light
  // pastels. Every one must come back BRIGHTER and hue-stable.
  for (const base of ['#8ef5c5', '#ffa850', '#dc50ff', '#80ff80', '#85b7ff']) {
    it(`brightens the pastel token ${base} toward white, keeping its hue`, () => {
      const out = parseRgb(deriveBrightText(base))!;
      const src = parseRgb(base)!;
      // Never dimmer on any channel, and strictly brighter overall.
      expect(out[0]).toBeGreaterThanOrEqual(src[0]);
      expect(out[1]).toBeGreaterThanOrEqual(src[1]);
      expect(out[2]).toBeGreaterThanOrEqual(src[2]);
      expect(luminance(out)).toBeGreaterThan(luminance(src));
      // Hue preserved (channel-wise mix toward white, not a flat near-white).
      expect(hueDelta(rgbToHsl(out).h, rgbToHsl(src).h)).toBeLessThan(8);
    });
  }

  it('still lifts a dark token toward white and keeps it green-dominant', () => {
    const out = parseRgb(deriveBrightText('#1e6f52'))!; // dark mint
    const src = parseRgb('#1e6f52')!;
    expect(out[0]).toBeGreaterThan(src[0]);
    expect(out[1]).toBeGreaterThan(src[1]);
    expect(out[2]).toBeGreaterThan(src[2]);
    expect(luminance(out)).toBeGreaterThan(luminance(src));
    // Still green-dominant — not collapsed to a neutral near-white.
    expect(out[1]).toBeGreaterThan(out[0]);
    expect(out[1]).toBeGreaterThan(out[2]);
  });

  it('never returns a channel dimmer than the base, even for a near-white token', () => {
    const out = parseRgb(deriveBrightText('#d8f5e6'))!; // near-white mint
    const src = parseRgb('#d8f5e6')!;
    expect(out[0]).toBeGreaterThanOrEqual(src[0]);
    expect(out[1]).toBeGreaterThanOrEqual(src[1]);
    expect(out[2]).toBeGreaterThanOrEqual(src[2]);
  });

  it('returns unparsable input unchanged', () => {
    expect(deriveBrightText('not-a-color')).toBe('not-a-color');
  });
});

describe('theme store exposes the derived-bright effect-text var', () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
  });

  it('sets --tracker-effect-text-bright as a derive of --tracker-effect-text', () => {
    useThemeStore();
    const root = document.documentElement.style;
    const effectBright = root.getPropertyValue('--tracker-effect-text-bright');
    expect(effectBright).not.toBe('');
    // A derive of its own base token, not a copy of it.
    expect(effectBright).toBe(deriveBrightText(root.getPropertyValue('--tracker-effect-text')));
    // Brighter than the base (NOTE-5): the playing row's effect glyphs lift,
    // never dim.
    const bright = parseRgb(effectBright)!;
    const base = parseRgb(root.getPropertyValue('--tracker-effect-text'))!;
    expect(luminance(bright)).toBeGreaterThan(luminance(base));
  });

  it('does not set a dead --tracker-note-text-bright var (F2)', () => {
    useThemeStore();
    const root = document.documentElement.style;
    // Note/instrument/volume columns brighten via --tracker-note-text as
    // shipped; there is no consumer for a note-text-bright variant.
    expect(root.getPropertyValue('--tracker-note-text-bright')).toBe('');
  });
});
