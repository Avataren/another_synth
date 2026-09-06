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

import { hslToCss, lerpHue, parseRgb, rgbToHsl } from 'src/utils/color';

/** How many distinct accents a theme yields; track index cycles through them. */
export const TRACK_ACCENT_COUNT = 8;

/** Lightness sweep across the ramp, in percentage points, ± this amount. */
const LIGHTNESS_SWEEP = 9;

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
