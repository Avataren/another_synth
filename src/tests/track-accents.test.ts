import { describe, expect, it } from 'vitest';
import {
  buildTrackAccents,
  TRACK_ACCENT_COUNT,
} from 'src/components/tracker/pattern-canvas/track-accents';
import { trackAccent } from 'src/components/tracker/pattern-canvas/pattern-draw';
import { parseRgb, rgbToHsl } from 'src/utils/color';

/** `rgb(r, g, b)` → the three channels. */
function channels(color: string): [number, number, number] {
  const m = /^rgb\((\d+), (\d+), (\d+)\)$/.exec(color);
  expect(m, color).not.toBeNull();
  return [Number(m![1]), Number(m![2]), Number(m![3])];
}

describe('buildTrackAccents', () => {
  it('ramps from the theme primary to its secondary', () => {
    const accents = buildTrackAccents('rgb(77, 242, 197)', 'rgb(88, 176, 255)');
    expect(accents).toHaveLength(TRACK_ACCENT_COUNT);
    // The ramp stays inside the cyan→blue arc it interpolates: blue climbs
    // monotonically, and the last accent has left the green end behind.
    const greens = accents.map((c) => channels(c)[1]);
    const blues = accents.map((c) => channels(c)[2]);
    for (let i = 1; i < accents.length; i++) {
      expect(blues[i]!).toBeGreaterThan(blues[i - 1]!);
    }
    expect(greens.at(-1)!).toBeLessThan(greens[0]!);
    expect(new Set(accents).size).toBe(accents.length);
  });

  it('stays neutral for a theme whose accents are gray', () => {
    const accents = buildTrackAccents('rgb(255, 255, 255)', 'rgb(220, 220, 220)');
    for (const accent of accents) {
      const [r, g, b] = channels(accent);
      expect(r).toBe(g);
      expect(g).toBe(b);
    }
    // The lightness sweep still separates them, so tracks stay legible apart.
    expect(new Set(accents).size).toBe(accents.length);
  });

  it('accepts hex colors and honours the requested count', () => {
    const accents = buildTrackAccents('#4df2c5', '#58b0ff', 3);
    expect(accents).toHaveLength(3);
    expect(accents.every((c) => /^rgb\(\d+, \d+, \d+\)$/.test(c))).toBe(true);
  });

  it('falls back to the primary, repeated, when a color is unparsable', () => {
    expect(buildTrackAccents('var(--nope)', 'rgb(1, 2, 3)', 2)).toEqual([
      'var(--nope)',
      'var(--nope)',
    ]);
  });
});

/*
 * Beyond the 8-entry ramp (plan-hvl-header-ux-0923.md BUG 2): HVL songs grow
 * to 16 tracks, the consumer used to wrap with modulo, and track 9 jumped
 * from the ramp's lightest end back to its darkest — the abrupt shading
 * change after track 8. trackAccent now ping-pongs past the ramp end.
 */
describe('trackAccent beyond the ramp', () => {
  const accents = buildTrackAccents('rgb(77, 242, 197)', 'rgb(88, 176, 255)');
  const theme = { trackAccents: accents };
  const lightness = (color: string): number => rgbToHsl(parseRgb(color)!).l;

  it('keeps the first ramp exactly as built (AHX renders pixel-identical)', () => {
    for (let i = 0; i < TRACK_ACCENT_COUNT; i++) {
      expect(trackAccent(i, theme)).toBe(accents[i]);
    }
  });

  it('does not restart the ramp at track 9', () => {
    // The old `index % accents.length` landed track 9 back on the darkest
    // entry; the reflection keeps it one step inside the ramp end.
    expect(trackAccent(8, theme)).not.toBe(accents[0]);
    expect(trackAccent(8, theme)).toBe(accents[6]);
  });

  it('walks smoothly across a 12-track song', () => {
    const colors = Array.from({ length: 12 }, (_, i) => trackAccent(i, theme));
    // Adjacent tracks always differ, and never by a jump: a modulo restart
    // would leap the full ramp lightness span, an echo would give a zero
    // step. 8-bit RGB rounding wobbles the HSL readback, so the bound is a
    // generous multiple of one ramp step, not an exact match.
    const rampStep = Math.abs(lightness(accents[1]!) - lightness(accents[0]!));
    const span = Math.abs(lightness(accents[7]!) - lightness(accents[0]!));
    for (let i = 1; i < colors.length; i++) {
      expect(colors[i], `track ${i + 1}`).not.toBe(colors[i - 1]!);
      const step = Math.abs(lightness(colors[i]!) - lightness(colors[i - 1]!));
      expect(step, `tracks ${i} -> ${i + 1}`).toBeLessThan(span / 2);
      expect(step, `tracks ${i} -> ${i + 1}`).toBeGreaterThan(0);
      expect(step, `tracks ${i} -> ${i + 1}`).toBeLessThanOrEqual(rampStep * 1.3 + 1e-9);
    }
    // The walk climbs to the ramp end, turns around there, and heads back —
    // the ping-pong the modulo wrap never had.
    const values = colors.map(lightness);
    for (let i = 1; i <= 7; i++) expect(values[i]!).toBeGreaterThan(values[i - 1]!);
    for (let i = 8; i < values.length; i++) expect(values[i]!).toBeLessThan(values[i - 1]!);
  });

  it('cycles any count without leaving the ramp or repeating a neighbour', () => {
    const colors = Array.from({ length: 16 }, (_, i) => trackAccent(i, theme));
    for (let i = 1; i < colors.length; i++) {
      expect(colors[i]).not.toBe(colors[i - 1]!);
    }
    expect(new Set(colors).size).toBe(accents.length);
  });
});
