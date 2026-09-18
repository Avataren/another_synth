/**
 * Helpers for drawing a per-voice AHX/HVL waveform snapshot
 * (`AhxWaveforms`, see `ahx-core.ts`) on a `TrackWaveform` canvas.
 */

/**
 * Where to start drawing so a periodic waveform holds still from one snapshot
 * to the next: the first rising zero crossing in the first half of `data`, or 0
 * when there is none (silence, noise that never crosses, a DC offset). Only the
 * first half is searched, so `data.length / 2` points always remain to draw.
 */
export function scopeTriggerStart(data: ArrayLike<number>): number {
  const half = data.length >> 1;
  for (let i = 0; i < half; i++) {
    if ((data[i] ?? 0) <= 0 && (data[i + 1] ?? 0) > 0) return i + 1;
  }
  return 0;
}

/** Points `drawScopeTrace` plots from a snapshot of `length` points. */
export function scopeVisiblePoints(length: number): number {
  return length >> 1;
}

/**
 * Maps `data[start .. start + count)` to canvas coordinates, left to right across
 * `width`, `+fullScale` at the top edge and `-fullScale` at the bottom, clamped
 * to the canvas. Writes `out[2k]` = x, `out[2k + 1]` = y and returns the point
 * count; `out` must hold `2 * count` entries.
 */
export function scopePolyline(
  data: ArrayLike<number>,
  start: number,
  count: number,
  width: number,
  height: number,
  fullScale: number,
  out: Float32Array,
): number {
  const n = Math.min(count, data.length - start);
  const step = n > 1 ? width / (n - 1) : 0;
  const mid = height / 2;
  for (let k = 0; k < n; k++) {
    const v = Math.max(-1, Math.min(1, (data[start + k] ?? 0) / fullScale));
    out[2 * k] = k * step;
    out[2 * k + 1] = mid - v * mid;
  }
  return n;
}
