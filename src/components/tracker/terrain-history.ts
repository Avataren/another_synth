/** Row zero is live; the remaining rows retain peaks at the landscape's original speed and extent. */
export const TERRAIN_ROWS = 320;
export const TERRAIN_TEX_WIDTH = 128;
export const TERRAIN_TEXTURE_ROWS = TERRAIN_ROWS + 1;
export const TERRAIN_ROW_HZ = 30;
export const TERRAIN_ROW_STRIDE = TERRAIN_TEX_WIDTH * 2;

const SPREAD_REACH = 3;

function levelAt(levels: ArrayLike<number>, band: number): number {
  const value = levels[band] ?? 0;
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

/**
 * R keeps the feed's band shapes and bar release; G holds the original broad ridges for shoulders and the wave.
 * Both come from the same interval peak, without separate envelopes. A live row follows every frame;
 * the archive retains short hits. The shader uses one fixed shape throughout the landscape's lifetime.
 */
export class TerrainHistory {
  readonly data = new Float32Array(TERRAIN_TEXTURE_ROWS * TERRAIN_ROW_STRIDE);
  phase = 0;
  rowsPushed = 0;

  private readonly pending = new Float32Array(TERRAIN_TEX_WIDTH);
  private readonly spread = new Float32Array(TERRAIN_TEX_WIDTH);
  private readonly rowPeaks = new Float32Array(TERRAIN_TEXTURE_ROWS);
  private previousTime: number | null = null;
  private previousBands = 0;

  get maximumLevel(): number {
    let maximum = 0;
    for (const level of this.rowPeaks) maximum = Math.max(maximum, level);
    return maximum;
  }

  update(levels: ArrayLike<number>, bands: number, timeMs: number): void {
    const count = Math.max(2, Math.min(TERRAIN_TEX_WIDTH, Math.floor(bands)));
    if (count !== this.previousBands) {
      // A band's frequency changes when the count does: old columns cannot be reused at the new spacing.
      this.data.fill(0);
      this.pending.fill(0);
      this.rowPeaks.fill(0);
      this.phase = 0;
      this.rowsPushed = 0;
      this.previousTime = null;
      this.previousBands = count;
    }
    // A background tab must not rush the land forward or bank a backlog.
    const dt =
      this.previousTime === null
        ? 0
        : Math.min(0.1, Math.max(0, (timeMs - this.previousTime) / 1000));
    this.previousTime = timeMs;
    for (let b = 0; b < count; b++) {
      const now = levelAt(levels, b);
      this.pending[b] = Math.max(now, this.pending[b] ?? 0);
    }
    this.writeRow(levels, count, 0);
    this.phase += dt * TERRAIN_ROW_HZ;
    while (this.phase >= 1) {
      this.phase -= 1;
      this.pushRow(count);
      // Consume a peak once, even when a slow frame advances more than one row.
      this.pending.fill(0);
      if (this.phase >= 1) {
        for (let b = 0; b < count; b++) this.pending[b] = levelAt(levels, b);
      }
    }
  }

  private pushRow(bands: number): void {
    this.data.copyWithin(
      TERRAIN_ROW_STRIDE * 2,
      TERRAIN_ROW_STRIDE,
      this.data.length - TERRAIN_ROW_STRIDE,
    );
    this.rowPeaks.copyWithin(2, 1, TERRAIN_ROWS);
    this.writeRow(this.pending, bands, 1);
    this.rowsPushed++;
  }

  private writeRow(
    levels: ArrayLike<number>,
    bands: number,
    row: number,
  ): void {
    let peak = 0;
    const offset = row * TERRAIN_ROW_STRIDE;
    for (let b = 0; b < bands; b++) {
      const value = levelAt(levels, b);
      this.data[offset + b * 2] = value;
      peak = Math.max(peak, value);
      let spread = value;
      for (let k = 1; k <= SPREAD_REACH; k++) {
        const weight = 1 - k / (SPREAD_REACH + 1);
        spread = Math.max(
          spread,
          levelAt(levels, b - k) * weight,
          (b + k < bands ? levelAt(levels, b + k) : 0) * weight,
        );
      }
      this.spread[b] = spread;
    }
    for (let b = 0; b < bands; b++) {
      this.data[offset + b * 2 + 1] =
        0.25 * (this.spread[Math.max(0, b - 1)] ?? 0) +
        0.5 * (this.spread[b] ?? 0) +
        0.25 * (this.spread[Math.min(bands - 1, b + 1)] ?? 0);
    }
    this.rowPeaks[row] = peak;
  }
}

/**
 * A ray bound, never a clamp on height(). Every surface march uses four relief octaves (weights sum to
 * 1.875); higher octaves only shade normals. Include the seabed, detail displacements and R16F rounding.
 * Keep this aligned with the shader if its relief or displacement grows.
 */
export function terrainHeightBound(
  maximumLevel: number,
  heightScale: number,
): number {
  const level = maximumLevel + 1 / 1024;
  const factor = 1 + 0.6 * 1.875 * 1.875;
  return (
    Math.max(heightScale * 0.1, level * heightScale * factor - 0.16) +
    level * (heightScale * 0.06 + 0.22 * 0.4375)
  );
}
