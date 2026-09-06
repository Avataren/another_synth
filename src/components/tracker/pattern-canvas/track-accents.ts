/**
 * Per-track accent colors, derived from the active theme.
 *
 * Tracks carry a decorative `color` from tracker-store's default palette
 * (a fixed neon rainbow, no UI to change it), which stayed the same in every
 * theme — a Monochrome or Amber pattern still got cyan/pink/yellow track
 * chips. The accents are built from the theme's own accents instead: a ramp
 * from `--tracker-accent-primary` to `--tracker-accent-secondary`, so a
 * track keeps a distinct hue while the whole set belongs to the theme.
 *
 * The ramp interpolates in HSL along the shorter hue arc, and sweeps
 * lightness a little across the set so tracks stay distinguishable in themes
 * whose two accents are nearly the same color (Matrix Green, Monochrome).
 */

/** How many distinct accents a theme yields; track index cycles through them. */
export const TRACK_ACCENT_COUNT = 8;

/** Lightness sweep across the ramp, in percentage points, ± this amount. */
const LIGHTNESS_SWEEP = 9;

interface Hsl {
  h: number;
  s: number;
  l: number;
}

/** Parse `#rgb`, `#rrggbb`, `rgb(...)` and `rgba(...)`; null when unparsable. */
function parseRgb(color: string): [number, number, number] | null {
  const value = color.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value);
  if (hex) {
    const digits = hex[1]!;
    const full =
      digits.length === 3
        ? digits
            .split('')
            .map((d) => d + d)
            .join('')
        : digits;
    return [
      parseInt(full.slice(0, 2), 16),
      parseInt(full.slice(2, 4), 16),
      parseInt(full.slice(4, 6), 16),
    ];
  }
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(value);
  if (rgb) {
    return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  }
  return null;
}

function rgbToHsl([r, g, b]: [number, number, number]): Hsl {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const delta = max - min;
  if (delta === 0) return { h: 0, s: 0, l: l * 100 };
  const s = delta / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === rn) h = ((gn - bn) / delta) % 6;
  else if (max === gn) h = (bn - rn) / delta + 2;
  else h = (rn - gn) / delta + 4;
  h *= 60;
  if (h < 0) h += 360;
  return { h, s: s * 100, l: l * 100 };
}

function hslToCss({ h, s, l }: Hsl): string {
  const sn = Math.min(100, Math.max(0, s)) / 100;
  const ln = Math.min(100, Math.max(0, l)) / 100;
  const c = (1 - Math.abs(2 * ln - 1)) * sn;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r1, g1, b1] =
    hp < 1
      ? [c, x, 0]
      : hp < 2
        ? [x, c, 0]
        : hp < 3
          ? [0, c, x]
          : hp < 4
            ? [0, x, c]
            : hp < 5
              ? [x, 0, c]
              : [c, 0, x];
  const m = ln - c / 2;
  const to255 = (v: number) => Math.round(Math.min(1, Math.max(0, v + m)) * 255);
  return `rgb(${to255(r1)}, ${to255(g1)}, ${to255(b1)})`;
}

/** Interpolate hue along the shorter arc, so cyan→blue never sweeps the wheel. */
function lerpHue(from: number, to: number, t: number): number {
  const delta = ((to - from + 540) % 360) - 180;
  return from + delta * t;
}

/**
 * Build `count` accents ramping from `primary` to `secondary`. Unparsable
 * inputs fall back to the color as given, repeated — never an empty set, so
 * callers can index without a guard.
 */
export function buildTrackAccents(
  primary: string,
  secondary: string,
  count: number = TRACK_ACCENT_COUNT,
): string[] {
  const total = Math.max(1, count);
  const from = parseRgb(primary);
  const to = parseRgb(secondary);
  if (!from || !to) {
    return Array.from({ length: total }, () => primary);
  }
  const a = rgbToHsl(from);
  const b = rgbToHsl(to);
  return Array.from({ length: total }, (_, i) => {
    const t = total === 1 ? 0 : i / (total - 1);
    // -1 … +1 across the set, so the ends sit at ±LIGHTNESS_SWEEP.
    const sweep = (t * 2 - 1) * LIGHTNESS_SWEEP;
    return hslToCss({
      h: lerpHue(a.h, b.h, t),
      s: a.s + (b.s - a.s) * t,
      l: a.l + (b.l - a.l) * t + sweep,
    });
  });
}
