/**
 * Helpers for drawing a per-voice AHX/HVL waveform snapshot
 * (`AhxWaveforms`, see `ahx-core.ts`) on a `TrackWaveform` canvas.
 */

/**
 * Where to start drawing so a periodic waveform holds still from one snapshot
 * to the next: the first rising crossing of `level` (default: zero) in the
 * first half of `data`, or 0 when there is none (silence, noise that never
 * crosses, a DC offset). Only the first half is searched, so
 * `data.length / 2` points always remain to draw.
 */
export function scopeTriggerStart(data: ArrayLike<number>, level = 0): number {
  const half = data.length >> 1;
  for (let i = 0; i < half; i++) {
    if ((data[i] ?? 0) <= level && (data[i + 1] ?? 0) > level) return i + 1;
  }
  return 0;
}

/**
 * Halfway between the lowest and highest value in `data` (0 when empty): the
 * centre to draw a DC-blocked signal around. A SID voice's tap passes the
 * chip's output DC blocker, so a narrow pulse sits off-centre and swings up
 * to twice its full scale on one side of zero while its peak-to-peak still
 * fits; drawn around its midrange it fills the scope without clipping.
 */
export function scopeMidrange(data: ArrayLike<number>): number {
  if (data.length === 0) return 0;
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < data.length; i++) {
    const v = data[i] ?? 0;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return (lo + hi) / 2;
}

/** Points `drawScopeTrace` plots from a snapshot of `length` points. */
export function scopeVisiblePoints(length: number): number {
  return length >> 1;
}

/**
 * Maps `data[start .. start + count)` to canvas coordinates, left to right across
 * `width`, `center + fullScale` at the top edge and `center - fullScale` at the
 * bottom (`center` defaults to zero), clamped to the canvas. Writes `out[2k]` = x, `out[2k + 1]` = y and returns the point
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
  center = 0,
): number {
  const n = Math.min(count, data.length - start);
  const step = n > 1 ? width / (n - 1) : 0;
  const mid = height / 2;
  for (let k = 0; k < n; k++) {
    const v = Math.max(-1, Math.min(1, ((data[start + k] ?? 0) - center) / fullScale));
    out[2 * k] = k * step;
    out[2 * k + 1] = mid - v * mid;
  }
  return n;
}

/** Display gains the settings offer; anything else is treated as 1. */
export const SCOPE_GAINS = [1, 2, 4] as const;

/**
 * The full-scale value to hand `scopePolyline` for a fixed display gain: a
 * gain of 2 makes half the signal reach the scope's edge, and `scopePolyline`
 * clamps anything beyond it. A gain that is not one of `SCOPE_GAINS` (a stale
 * or hand-edited setting) means no gain.
 */
export function scopeFullScale(fullScale: number, gain: number | undefined): number {
  const g = (SCOPE_GAINS as readonly number[]).includes(gain ?? 1) ? (gain ?? 1) : 1;
  return fullScale / g;
}
