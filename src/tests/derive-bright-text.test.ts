import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { deriveBrightText, parseRgb } from 'src/utils/color';
import { useThemeStore } from 'src/stores/theme-store';

/**
 * NOTE-5: the playing row's "brighter" cell-text variant is derived in a
 * luminance-aware way — dark base tokens (every built-in theme) mix toward
 * white, a light base (only a custom theme) mixes toward black — so it
 * degrades sensibly instead of washing out. One helper feeds both the DOM
 * (`--tracker-*-bright` custom props) and the canvas (`pattern-theme`).
 */
describe('deriveBrightText', () => {
  it('lightens a dark token toward white, keeping its hue direction', () => {
    const out = deriveBrightText('#1e6f52'); // dark mint
    const [r, g, b] = parseRgb(out)!;
    const [r0, g0, b0] = parseRgb('#1e6f52')!;
    expect(r).toBeGreaterThan(r0);
    expect(g).toBeGreaterThan(g0);
    expect(b).toBeGreaterThan(b0);
    // Still green-dominant — not collapsed to a neutral near-white.
    expect(g).toBeGreaterThan(r);
    expect(g).toBeGreaterThan(b);
  });

  it('darkens a light token toward black instead of brightening past it', () => {
    const out = deriveBrightText('#d8f5e6'); // near-white mint (a light custom theme)
    const [r, g, b] = parseRgb(out)!;
    const [r0, g0, b0] = parseRgb('#d8f5e6')!;
    expect(r).toBeLessThan(r0);
    expect(g).toBeLessThan(g0);
    expect(b).toBeLessThan(b0);
  });

  it('returns unparsable input unchanged', () => {
    expect(deriveBrightText('not-a-color')).toBe('not-a-color');
  });
});

describe('theme store exposes the derived-bright cell-text vars', () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
  });

  it('sets --tracker-effect-text-bright and --tracker-note-text-bright', () => {
    useThemeStore();
    const root = document.documentElement.style;
    const effectBright = root.getPropertyValue('--tracker-effect-text-bright');
    const noteBright = root.getPropertyValue('--tracker-note-text-bright');
    expect(effectBright).not.toBe('');
    expect(noteBright).not.toBe('');
    // Each is a derive of its own base token, not a copy of it.
    expect(effectBright).toBe(deriveBrightText(root.getPropertyValue('--tracker-effect-text')));
    expect(noteBright).toBe(deriveBrightText(root.getPropertyValue('--tracker-note-text')));
  });
});
