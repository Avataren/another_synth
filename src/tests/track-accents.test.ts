import { describe, expect, it } from 'vitest';
import {
  buildTrackAccents,
  TRACK_ACCENT_COUNT,
} from 'src/components/tracker/pattern-canvas/track-accents';

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
