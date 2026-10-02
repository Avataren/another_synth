import { describe, expect, it } from 'vitest';
import { TerrainQuality } from 'src/components/tracker/terrain-quality';

describe('landscape rendering budget', () => {
  it('reduces resolution for sustained frames slower than 120 ms', () => {
    const quality = new TerrainQuality();
    for (let time = 0; time <= 2400; time += 200) quality.update(time, 420000);
    expect(quality.scale).toBe(0.3);
  });

  it('ignores a background-tab pause and a duplicate timestamp', () => {
    const quality = new TerrainQuality();
    quality.update(0, 420000);
    quality.update(30000, 420000);
    quality.update(30000, 420000);
    expect(quality.scale).toBe(0.75);
    quality.update(30016.7, 420000);
    expect(quality.scale).toBeGreaterThanOrEqual(0.75);
  });

  it('uses GPU cost when a busy UI produces a slow frame cadence', () => {
    const quality = new TerrainQuality();
    for (let time = 0; time <= 2000; time += 50) {
      quality.recordGpu(8, time);
      quality.update(time, 420000);
    }
    expect(quality.scale).toBeGreaterThan(0.75);
  });

  it('reduces resolution when the GPU exceeds its budget even at a fast frame cadence', () => {
    const quality = new TerrainQuality();
    for (let time = 0; time <= 800; time += 8.3) {
      quality.recordGpu(30, time);
      quality.update(time, 420000);
    }
    expect(quality.scale).toBeLessThan(0.6);
  });

  it('caps pixel cost on a 4K canvas', () => {
    const quality = new TerrainQuality();
    quality.update(0, 3840 * 2160);
    expect(3840 * 2160 * quality.scale ** 2).toBeLessThanOrEqual(1200001);
  });

  it('does not raise resolution during the cooldown after a slow frame', () => {
    const quality = new TerrainQuality();
    quality.update(0, 420000);
    quality.recordGpu(30, 16.7);
    quality.update(16.7, 420000);
    const reduced = quality.scale;
    for (let time = 33.4; time <= 3000; time += 16.7) {
      quality.recordGpu(5, time);
      quality.update(time, 420000);
    }
    expect(quality.scale).toBe(reduced);
    quality.recordGpu(5, 5000);
    quality.update(5000, 420000);
    quality.recordGpu(5, 5016.7);
    quality.update(5016.7, 420000);
    expect(quality.scale).toBeGreaterThan(reduced);
  });

  it('falls back to frame cadence when GPU results stop arriving', () => {
    const quality = new TerrainQuality();
    quality.recordGpu(8, 0);
    for (let time = 0; time <= 2500; time += 100) quality.update(time, 420000);
    expect(quality.scale).toBeLessThan(0.75);
  });

  it('rejects invalid timing samples', () => {
    const quality = new TerrainQuality();
    for (const cost of [NaN, Infinity, -1, 0]) quality.recordGpu(cost, 10);
    quality.update(0, 420000);
    quality.update(16.7, 420000);
    expect(quality.scale).toBeGreaterThanOrEqual(0.75);
  });
});
