import { describe, expect, it } from 'vitest';
import {
  TerrainHistory,
  terrainHeightBound,
  TERRAIN_ROWS,
  TERRAIN_ROW_STRIDE,
} from 'src/components/tracker/terrain-history';

const BANDS = 64;
const silence = new Float32Array(BANDS);

function pulse(band: number, level = 1): Float32Array {
  const levels = new Float32Array(BANDS);
  levels[band] = level;
  return levels;
}

describe('TerrainHistory', () => {
  it('shows the feed immediately, without a second release or neighbouring-band spread', () => {
    const history = new TerrainHistory();
    history.update(silence, BANDS, 0);
    history.update(pulse(12, 0.9), BANDS, 8);
    expect(history.rowsPushed).toBe(0);
    expect(history.data[12 * 2]).toBeCloseTo(0.9);
    expect(history.data[11 * 2]).toBe(0);
    expect(history.data[13 * 2]).toBe(0);
    expect(history.data[TERRAIN_ROW_STRIDE + 12 * 2]).toBe(0);
    history.update(pulse(12, 0.3), BANDS, 16);
    expect(history.data[12 * 2]).toBeCloseTo(0.3);
  });

  it('retains a hit between archive ticks and preserves its height and width as it travels', () => {
    const history = new TerrainHistory();
    history.update(silence, BANDS, 0);
    history.update(pulse(12, 0.9), BANDS, 8);
    history.update(silence, BANDS, 16);
    for (let row = 1; row <= TERRAIN_ROWS; row++) {
      history.update(silence, BANDS, (row * 1000) / 30 + 0.01);
      expect(history.rowsPushed).toBe(row);
      expect(history.data[row * TERRAIN_ROW_STRIDE + 12 * 2]).toBeCloseTo(0.9);
      expect(history.data[row * TERRAIN_ROW_STRIDE + 11 * 2]).toBe(0);
      expect(history.data[row * TERRAIN_ROW_STRIDE + 13 * 2]).toBe(0);
      expect(history.data[12 * 2]).toBe(0);
    }
    history.update(silence, BANDS, ((TERRAIN_ROWS + 1) * 1000) / 30 + 0.01);
    expect(history.maximumLevel).toBe(0);
  });

  it('supplies the wave and cooled scenery with broad ridges from the same captured peak', () => {
    const history = new TerrainHistory();
    history.update(pulse(12, 0.9), BANDS, 0);
    expect(history.data[12 * 2]).toBeCloseTo(0.9);
    expect(history.data[11 * 2]).toBe(0);
    expect(history.data[12 * 2 + 1]).toBeCloseTo(0.9 * 0.875);
    expect(history.data[11 * 2 + 1]).toBeGreaterThan(0.6);
    history.update(silence, BANDS, 34);
    expect(history.data[12 * 2 + 1]).toBe(0);
    expect(history.data[TERRAIN_ROW_STRIDE + 12 * 2]).toBeCloseTo(0.9);
    expect(history.data[TERRAIN_ROW_STRIDE + 12 * 2 + 1]).toBeCloseTo(
      0.9 * 0.875,
    );
  });

  it('consumes an archived peak once and separates successive hits', () => {
    const history = new TerrainHistory();
    history.update(silence, BANDS, 0);
    history.update(pulse(12), BANDS, 34);
    history.update(silence, BANDS, 68);
    expect(history.data[TERRAIN_ROW_STRIDE + 12 * 2]).toBe(0);
    expect(history.data[TERRAIN_ROW_STRIDE * 2 + 12 * 2]).toBe(1);
    history.update(pulse(12, 0.5), BANDS, 102);
    expect(history.data[TERRAIN_ROW_STRIDE + 12 * 2]).toBe(0.5);
    expect(history.data[TERRAIN_ROW_STRIDE * 2 + 12 * 2]).toBe(0);
    expect(history.data[TERRAIN_ROW_STRIDE * 3 + 12 * 2]).toBe(1);
  });

  it('does not duplicate a short hit when a slow frame pushes several rows', () => {
    const history = new TerrainHistory();
    history.update(pulse(12), BANDS, 0);
    history.update(silence, BANDS, 100);
    expect(history.rowsPushed).toBe(3);
    expect(history.data[TERRAIN_ROW_STRIDE + 12 * 2]).toBe(0);
    expect(history.data[TERRAIN_ROW_STRIDE * 2 + 12 * 2]).toBe(0);
    expect(history.data[TERRAIN_ROW_STRIDE * 3 + 12 * 2]).toBe(1);
  });

  it('keeps 30 archive rows per second and bounds background-tab stalls', () => {
    const history = new TerrainHistory();
    history.update(pulse(12), BANDS, 0);
    for (let step = 1; step <= 60; step++)
      history.update(pulse(12), BANDS, (step * 1000) / 60);
    expect(history.rowsPushed).toBe(30);
    history.update(pulse(12, 0.8), BANDS, 10000);
    expect(history.rowsPushed).toBe(33);
    expect(history.phase).toBeGreaterThanOrEqual(0);
    expect(history.phase).toBeLessThan(1);
    expect(history.data[12 * 2]).toBeCloseTo(0.8);
  });

  it('clears obsolete columns and history when band spacing changes', () => {
    const history = new TerrainHistory();
    history.update(pulse(60), BANDS, 0);
    history.update(pulse(60), BANDS, 34);
    history.update([0.5, 0], 2, 40);
    expect(history.rowsPushed).toBe(0);
    expect(history.data[0]).toBe(0.5);
    expect(history.data[60 * 2]).toBe(0);
    expect(history.data[TERRAIN_ROW_STRIDE + 60 * 2]).toBe(0);
  });

  it('keeps invalid or missing levels from poisoning the texture', () => {
    const history = new TerrainHistory();
    history.update([NaN, Infinity, -1, 2], BANDS, 0);
    expect(history.data[0]).toBe(0);
    expect(history.data[1 * 2]).toBe(0);
    expect(history.data[2 * 2]).toBe(0);
    expect(history.data[3 * 2]).toBe(1);
    expect(history.data.every(Number.isFinite)).toBe(true);
  });

  it('bounds all rows, including the live sample, as the loudest peak ages out', () => {
    const history = new TerrainHistory();
    history.update(pulse(12), BANDS, 0);
    expect(history.maximumLevel).toBe(1);
    history.update(silence, BANDS, 34);
    expect(history.maximumLevel).toBe(1);
    for (let row = 2; row <= TERRAIN_ROWS + 1; row++) {
      history.update(silence, BANDS, (row * 1000) / 30 + 1);
      const maximum = history.maximumLevel;
      expect(history.data.every((level) => level <= maximum)).toBe(true);
    }
    expect(history.maximumLevel).toBe(0);
  });
});

describe('terrainHeightBound', () => {
  it('contains the full height and detail without clipping louder peaks', () => {
    const scale = 3.4;
    for (const level of [0, 0.1, 0.3, 0.6, 1, 2]) {
      const bound = terrainHeightBound(level, scale);
      const mountain = -0.16 + level * scale * (1 + 0.6 * 1.875 * 1.875);
      const seabed = scale * 0.1;
      const highestSurface =
        Math.max(mountain, seabed) + level * (scale * 0.06 + 0.22 * 0.4375);
      expect(bound).toBeGreaterThan(highestSurface);
    }
    expect(terrainHeightBound(2, scale)).toBeGreaterThan(
      terrainHeightBound(1, scale),
    );
  });
});
