import { describe, expect, it } from 'vitest';
import {
  FLOOR_WINDOW_ROWS,
  floorPatternLayout,
  windowBase,
} from 'src/components/tracker/fractal-pattern-floor';

describe('floorPatternLayout', () => {
  it('fits the texture and keeps glyphs twice as tall as wide', () => {
    for (const tracks of [1, 4, 8, 16, 32, 64]) {
      const l = floorPatternLayout(tracks);
      expect(l.textureWidth).toBeLessThanOrEqual(4096);
      expect(l.glyphHeight).toBe(l.glyphWidth * 2);
      expect(l.textureHeight).toBe(FLOOR_WINDOW_ROWS * l.glyphHeight);
      expect(l.tracks).toBeLessThanOrEqual(tracks);
    }
  });

  it('draws every channel of an ordinary song, and clips only a huge one', () => {
    expect(floorPatternLayout(8).tracks).toBe(8);
    expect(floorPatternLayout(64).tracks).toBeLessThan(64);
  });

  it('keeps the pattern within about twenty world units', () => {
    expect(floorPatternLayout(4).halfWidth * 2).toBeLessThanOrEqual(20.01);
    expect(floorPatternLayout(32).halfWidth * 2).toBeLessThanOrEqual(20.01);
  });
});

describe('windowBase', () => {
  it('centres the window on the playing row', () => {
    expect(windowBase(30)).toBe(30 - FLOOR_WINDOW_ROWS / 2);
    expect(windowBase(30.7)).toBe(windowBase(30));
  });
});
