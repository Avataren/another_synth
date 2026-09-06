/**
 * The theme's complementary palette.
 *
 * A theme authors two accents that usually sit a few degrees apart (Amber's
 * are 10° apart, Matrix Green's 0°), so a UI that colors everything from them
 * comes out in a single shade. The analyzers — the spectrum strips flanking
 * the pattern, the tracker waveform, the synth page's scope and frequency
 * display — use the complement of those accents instead: a second hue family
 * derived from the same theme, so the visualizers read as their own thing
 * beside the pattern while still turning over with a theme flip.
 *
 * Saturation is scaled rather than offset, so a theme with gray accents
 * (Monochrome) stays gray: rotating the hue of a color with no saturation
 * changes nothing, which is the right answer there.
 */

import { hslToCss, parseRgb, rgbToHsl } from './color';

/** Hue rotation from an accent to its complement, in degrees. */
export const COMPLEMENT_SHIFT_DEG = 180;

/** Complements are pushed a little more saturated to hold up against the accents. */
const SATURATION_SCALE = 1.15;

export interface ComplementPalette {
  /** Complement of `--tracker-accent-primary`. */
  complement: string;
  /** Complement of `--tracker-accent-secondary`, the ramp's far end. */
  complementAlt: string;
}

/** One accent's complement; unparsable input comes back unchanged. */
export function complementOf(color: string): string {
  const rgb = parseRgb(color);
  if (!rgb) return color;
  const { h, s, l } = rgbToHsl(rgb);
  return hslToCss({ h: h + COMPLEMENT_SHIFT_DEG, s: s * SATURATION_SCALE, l });
}

export function buildComplementPalette(primary: string, secondary: string): ComplementPalette {
  return {
    complement: complementOf(primary),
    complementAlt: complementOf(secondary),
  };
}
