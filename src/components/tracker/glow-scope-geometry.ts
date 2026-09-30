/**
 * The CPU half of the glow scope wall: turning a scope trace into the segment
 * instances the shader draws, and reading a theme colour into RGB. Kept free of
 * WebGL so it can be tested.
 */

/** Floats per segment instance: a.xy, b.xy, clip rect x0 y0 x1 y1, brightness. */
export const GLOW_INSTANCE_FLOATS = 9;

export interface GlowCell {
  /** Cell box in device pixels, y down from the canvas top. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** 0..1 multiplier on the trace (a muted channel dims). */
  brightness: number;
}

/**
 * Writes one instance per segment of `polyline` (x,y pairs in the cell's own
 * pixels, as `scopePolyline` produces) into `out` at float offset `offset`,
 * shifted to the cell's place on the canvas and scaled by `scale`. Returns the
 * new float offset. `out` must have room for `(count - 1)` instances.
 */
export function writeSegmentInstances(
  out: Float32Array,
  offset: number,
  polyline: ArrayLike<number>,
  count: number,
  cell: GlowCell,
  scale: number,
): number {
  let o = offset;
  const x1 = cell.x + cell.width;
  const y1 = cell.y + cell.height;
  for (let k = 0; k + 1 < count; k++) {
    out[o++] = cell.x + (polyline[2 * k] ?? 0) * scale;
    out[o++] = cell.y + (polyline[2 * k + 1] ?? 0) * scale;
    out[o++] = cell.x + (polyline[2 * k + 2] ?? 0) * scale;
    out[o++] = cell.y + (polyline[2 * k + 3] ?? 0) * scale;
    out[o++] = cell.x;
    out[o++] = cell.y;
    out[o++] = x1;
    out[o++] = y1;
    out[o++] = cell.brightness;
  }
  return o;
}

/**
 * A flat line across the cell's middle, as a polyline of two points: what a
 * silent or absent channel draws.
 */
export function flatPolyline(width: number, height: number, out: Float32Array): number {
  out[0] = 0;
  out[1] = height / 2;
  out[2] = width;
  out[3] = height / 2;
  return 2;
}

/**
 * Parses `#rgb`, `#rrggbb`, `rgb()` / `rgba()` (comma or space separated) into
 * 0..1 components; `fallback` when it is anything else. The theme variables
 * are one of these.
 */
export function parseCssColor(
  value: string,
  fallback: readonly [number, number, number] = [1, 0.25, 0.45],
): [number, number, number] {
  const text = value.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(text);
  if (hex) {
    let digits = hex[1] as string;
    if (digits.length === 3) digits = digits.replace(/./g, (c) => c + c);
    return [
      parseInt(digits.slice(0, 2), 16) / 255,
      parseInt(digits.slice(2, 4), 16) / 255,
      parseInt(digits.slice(4, 6), 16) / 255,
    ];
  }
  const fn = /^rgba?\(([^)]+)\)$/.exec(text);
  if (fn) {
    const parts = (fn[1] as string)
      .split(/[\s,/]+/)
      .filter(Boolean)
      .slice(0, 3)
      .map((part) => (part.endsWith('%') ? parseFloat(part) * 2.55 : parseFloat(part)));
    if (parts.length === 3 && parts.every((p) => Number.isFinite(p))) {
      const [r, g, b] = parts.map((p) => Math.max(0, Math.min(255, p)) / 255) as [
        number,
        number,
        number,
      ];
      return [r, g, b];
    }
  }
  return [fallback[0], fallback[1], fallback[2]];
}

/**
 * How needle heights are shaped after measuring: `curve` > 1 exaggerates the
 * peaks (most needles short, a few tall); `hold` keeps each needle's last
 * height (normalised 0..1, one slot per needle half) so it falls by `decay`
 * per frame instead of snapping down.
 */
export interface NeedleShape {
  curve?: number;
  hold?: Float32Array;
  decay?: number;
}

/** Applies `curve` and the peak hold to a normalised height, slot `slot` of the hold array. */
function shapeNeedle(norm: number, slot: number, shape: NeedleShape | undefined): number {
  let v = Math.min(1, Math.max(0, norm));
  if (shape?.curve && shape.curve !== 1) v = Math.pow(v, shape.curve);
  const hold = shape?.hold;
  if (hold && slot < hold.length) {
    const held = (hold[slot] ?? 0) * (shape?.decay ?? 0.9);
    if (held > v) v = held;
    hold[slot] = v;
  }
  return v;
}

/**
 * Turns a trace into mirrored needles for the Spikes view: the cell is cut
 * into columns `spacing` pixels apart, and each column becomes a vertical
 * segment about the centre line, as long as the trace strays from it there
 * (never shorter than `minHalf`, so silence is a row of dots). Writes
 * x0,y0,x1,y1 per segment into `out` (room for `4 * columns`) and returns the
 * segment count.
 */
export function needleSegments(
  polyline: ArrayLike<number>,
  count: number,
  width: number,
  height: number,
  spacing: number,
  minHalf: number,
  out: Float32Array,
  shape?: NeedleShape,
): number {
  const columns = Math.max(1, Math.min(needleColumns(width, spacing), Math.floor(out.length / 4)));
  const mid = height / 2;
  for (let c = 0; c < columns; c++) {
    const from = Math.min(count - 1, Math.floor((c * count) / columns));
    const to = Math.max(from + 1, Math.floor(((c + 1) * count) / columns));
    let amp = 0;
    for (let k = from; k < to && k < count; k++) {
      amp = Math.max(amp, Math.abs((polyline[2 * k + 1] ?? mid) - mid));
    }
    const half = Math.max(minHalf, shapeNeedle(amp / mid, c, shape) * mid);
    const x = ((c + 0.5) * width) / columns;
    out[4 * c] = x;
    out[4 * c + 1] = mid - half;
    out[4 * c + 2] = x;
    out[4 * c + 3] = mid + half;
  }
  return columns;
}

/** How many needles fit a cell `width` wide (at most 1024). */
export function needleColumns(width: number, spacing: number): number {
  return Math.max(1, Math.min(1024, Math.floor(width / Math.max(1, spacing))));
}

/** Writes independent segments (x0,y0,x1,y1 each) as instances; see `writeSegmentInstances`. */
export function writeIndependentSegments(
  out: Float32Array,
  offset: number,
  segments: ArrayLike<number>,
  count: number,
  cell: GlowCell,
  scale: number,
  weights?: ArrayLike<number>,
): number {
  let o = offset;
  const x1 = cell.x + cell.width;
  const y1 = cell.y + cell.height;
  for (let k = 0; k < count; k++) {
    out[o++] = cell.x + (segments[4 * k] ?? 0) * scale;
    out[o++] = cell.y + (segments[4 * k + 1] ?? 0) * scale;
    out[o++] = cell.x + (segments[4 * k + 2] ?? 0) * scale;
    out[o++] = cell.y + (segments[4 * k + 3] ?? 0) * scale;
    out[o++] = cell.x;
    out[o++] = cell.y;
    out[o++] = x1;
    out[o++] = y1;
    out[o++] = cell.brightness * (weights ? (weights[k] ?? 1) : 1);
  }
  return o;
}

/** Rotates the hue of an RGB colour (0..1 components) by `degrees`. */
export function shiftHue(
  rgb: readonly [number, number, number],
  degrees: number,
): [number, number, number] {
  const [r, g, b] = rgb;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d < 1e-6) return [r, g, b];
  const s = d / (1 - Math.abs(2 * l - 1));
  let h = 0;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h = (((h * 60 + degrees) % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const sector = Math.floor(h / 60);
  const table: [number, number, number][] = [
    [c, x, 0],
    [x, c, 0],
    [0, c, x],
    [0, x, c],
    [x, 0, c],
    [c, 0, x],
  ];
  const [pr, pg, pb] = table[sector % 6] as [number, number, number];
  return [pr + m, pg + m, pb + m];
}

/**
 * Needles for a stereo signal: the top of each needle is the left channel's
 * swing in that column and the bottom the right's, so a centred sound is
 * symmetric and a panned one leans. Columns are `spacing` pixels apart; a
 * channel's swing is its peak `|sample| / fullScale` there, in half-heights,
 * never shorter than `minHalf` pixels. Writes x0,y0,x1,y1 per column into
 * `out` (room for `4 * columns`) and returns the count. `left` and `right`
 * are read from `start` for `count` samples.
 */
export function stereoNeedleSegments(
  left: ArrayLike<number>,
  right: ArrayLike<number>,
  start: number,
  count: number,
  width: number,
  height: number,
  spacing: number,
  minHalf: number,
  fullScale: number,
  out: Float32Array,
  shape?: NeedleShape,
): number {
  const columns = Math.max(1, Math.min(needleColumns(width, spacing), Math.floor(out.length / 4)));
  const mid = height / 2;
  const inv = 1 / Math.max(fullScale, 1e-6);
  const n = Math.max(1, Math.min(count, left.length - start, right.length - start));
  for (let c = 0; c < columns; c++) {
    const from = start + Math.min(n - 1, Math.floor((c * n) / columns));
    const to = start + Math.max(from - start + 1, Math.floor(((c + 1) * n) / columns));
    let l = 0;
    let r = 0;
    for (let k = from; k < to && k < start + n; k++) {
      l = Math.max(l, Math.abs(left[k] ?? 0));
      r = Math.max(r, Math.abs(right[k] ?? 0));
    }
    const x = ((c + 0.5) * width) / columns;
    out[4 * c] = x;
    out[4 * c + 1] = mid - Math.max(minHalf, shapeNeedle(l * inv, 2 * c, shape) * mid);
    out[4 * c + 2] = x;
    out[4 * c + 3] = mid + Math.max(minHalf, shapeNeedle(r * inv, 2 * c + 1, shape) * mid);
  }
  return columns;
}

/**
 * Folds an analyser's dB spectrum (`getFloatFrequencyData`) into `bands`
 * log-spaced bars from `minHz` to `maxHz`, each 0..1 between `minDb` and
 * `maxDb` (the loudest bin in the band, so a lone tone still shows). Writes
 * `out[0 .. bands)`. `binHz` is the width of one bin. `tiltDb` adds that many
 * dB per octave above 1 kHz (and takes it away below), since music falls
 * roughly 3 dB per octave and would otherwise leave the highs empty; `curve`
 * > 1 keeps quiet bands low.
 */
export function spectrumBands(
  freqDb: ArrayLike<number>,
  binHz: number,
  bands: number,
  minHz: number,
  maxHz: number,
  minDb: number,
  maxDb: number,
  out: Float32Array,
  tiltDb = 0,
  curve = 1,
): void {
  const ratio = Math.pow(maxHz / minHz, 1 / bands);
  const span = Math.max(1e-6, maxDb - minDb);
  for (let b = 0; b < bands; b++) {
    const lo = minHz * Math.pow(ratio, b);
    const hi = lo * ratio;
    const first = Math.min(freqDb.length - 1, Math.max(0, Math.floor(lo / binHz)));
    const last = Math.min(freqDb.length - 1, Math.max(first, Math.ceil(hi / binHz) - 1));
    let peak = -Infinity;
    for (let k = first; k <= last; k++) peak = Math.max(peak, freqDb[k] ?? -Infinity);
    const tilt = tiltDb * Math.log2((lo * Math.sqrt(ratio)) / 1000);
    const norm = Number.isFinite(peak) ? Math.min(1, Math.max(0, (peak + tilt - minDb) / span)) : 0;
    out[b] = curve === 1 ? norm : Math.pow(norm, curve);
  }
}

export interface LedBarLayout {
  /** Cell size in CSS pixels. */
  width: number;
  height: number;
  /** y of the floor the bars stand on. */
  baseline: number;
  /** Height reserved for the bars above the baseline. */
  barsHeight: number;
  /** Pitch of one LED, and the width of a bar as a fraction of its slot. */
  ledHeight: number;
  barWidthFraction: number;
  /** Brightness of unlit LEDs (0 hides them) and of the peak marker. */
  unlitBrightness: number;
  peakBrightness: number;
  /** Peak brightness of the reflection under the baseline (0 hides it). */
  reflection: number;
}

/**
 * Rows of LEDs for a set of bar `levels` (0..1) with `peaks` above them.
 * Writes independent x0,y0,x1,y1 segments into `out` and one brightness per
 * segment into `weights`, and returns the segment count. The reflection is the
 * lit LEDs mirrored under the baseline, fading with depth.
 */
export function ledBarSegments(
  levels: ArrayLike<number>,
  peaks: ArrayLike<number>,
  bands: number,
  layout: LedBarLayout,
  out: Float32Array,
  weights: Float32Array,
): number {
  const rows = Math.max(1, Math.floor(layout.barsHeight / layout.ledHeight));
  const slot = layout.width / bands;
  const half = (slot * layout.barWidthFraction) / 2;
  let n = 0;
  const push = (x: number, y: number, weight: number): void => {
    if (n * 4 + 4 > out.length || n >= weights.length) return;
    out[4 * n] = x - half;
    out[4 * n + 1] = y;
    out[4 * n + 2] = x + half;
    out[4 * n + 3] = y;
    weights[n] = weight;
    n++;
  };
  for (let b = 0; b < bands; b++) {
    const x = (b + 0.5) * slot;
    const lit = Math.round(Math.min(1, Math.max(0, levels[b] ?? 0)) * rows);
    const peakRow = Math.round(Math.min(1, Math.max(0, peaks[b] ?? 0)) * rows);
    for (let row = 0; row < rows; row++) {
      const y = layout.baseline - (row + 0.5) * layout.ledHeight;
      if (row < lit) push(x, y, 1);
      else if (layout.unlitBrightness > 0) push(x, y, layout.unlitBrightness);
    }
    if (peakRow > lit) {
      push(x, layout.baseline - (peakRow - 0.5) * layout.ledHeight, layout.peakBrightness);
    }
    if (layout.reflection > 0) {
      for (let row = 0; row < lit; row++) {
        const y = layout.baseline + (row + 0.5) * layout.ledHeight + 2;
        if (y > layout.height) break;
        const fade = Math.pow(1 - row / rows, 1.6);
        push(x, y, layout.reflection * fade * (1 - (y - layout.baseline) / layout.height));
      }
    }
  }
  return n;
}

/** The most segments `ledBarSegments` can write for these settings. */
export function ledBarCapacity(bands: number, layout: LedBarLayout): number {
  const rows = Math.max(1, Math.floor(layout.barsHeight / layout.ledHeight));
  return bands * (rows * 2 + 1);
}
