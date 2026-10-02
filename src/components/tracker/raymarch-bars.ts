export const RAYMARCH_MAX_BARS = 128;

function unit(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : 0;
}

/** Float texture: first row holds height/peak, second holds the authored linear-light rainbow. */
export class RaymarchBarData {
  readonly data = new Float32Array(RAYMARCH_MAX_BARS * 2 * 4);
  private previousBands = 0;

  update(
    levels: ArrayLike<number>,
    peaks: ArrayLike<number>,
    bands: number,
    height: number,
  ): number {
    if (bands !== this.previousBands) {
      this.data.fill(0);
      for (let b = 0; b < bands; b++) {
        const t = bands > 1 ? b / (bands - 1) : 0;
        const rgb = [0.02, 0.36, 0.68].map(
          (offset) => 0.5 + 0.5 * Math.cos(2 * Math.PI * (t * 0.9 + offset)),
        );
        const mean = rgb.reduce((sum, c) => sum + c, 0) / 3;
        for (const [channel, c] of rgb.entries()) {
          this.data[(RAYMARCH_MAX_BARS + b) * 4 + channel] =
            Math.min(1, Math.max(0, mean + (c - mean) * 1.25)) ** 2.2;
        }
      }
      this.previousBands = bands;
    }
    let loud = 0;
    for (let b = 0; b < bands; b++) {
      const level = unit(levels[b]);
      loud += level;
      this.data[b * 4] = Math.max(0.02, level * height);
      this.data[b * 4 + 1] = unit(peaks[b]) * height + 0.04;
    }
    return Math.min(1, loud / bands / 0.4);
  }
}
