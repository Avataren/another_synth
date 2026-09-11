/**
 * Color math shared by the theme-derived palettes.
 *
 * The themes (theme-store.ts) author two accents; everything else that wants
 * a color family — the pattern's per-track accents (track-accents.ts) and the
 * analyzers' complementary palette — derives it from those, in HSL, so a
 * theme stays one coherent set of colors instead of a list of hard-coded
 * hues that no theme flip ever reaches.
 *
 * Colors are parsed from the forms the themes and stylesheets actually use
 * (`rgb()`, `rgba()`, `#rgb`, `#rrggbb`) and emitted as `rgb(r, g, b)`.
 */

export interface Hsl {
  /** Hue in degrees, 0–360. */
  h: number;
  /** Saturation, 0–100. */
  s: number;
  /** Lightness, 0–100. */
  l: number;
}

export type Rgb = [number, number, number];

/** Parse `#rgb`, `#rrggbb`, `rgb(...)` and `rgba(...)`; null when unparsable. */
export function parseRgb(color: string): Rgb | null {
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

export function rgbToHsl([r, g, b]: Rgb): Hsl {
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

/** HSL → the `rgb(r, g, b)` string the canvas and CSS custom props take. */
export function hslToCss({ h, s, l }: Hsl): string {
  const sn = clamp(s, 0, 100) / 100;
  const ln = clamp(l, 0, 100) / 100;
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
  const to255 = (v: number) => Math.round(clamp(v + m, 0, 1) * 255);
  return `rgb(${to255(r1)}, ${to255(g1)}, ${to255(b1)})`;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Re-express a color at a given alpha, e.g. for a translucent fill that must
 * track a solid accent (the playing-row pill: a saturated border plus a
 * low-alpha tint of that same color). Unparsable input is returned
 * unchanged, so a caller can always use the result as a color.
 */
export function withAlpha(color: string, alpha: number): string {
  const rgb = parseRgb(color);
  if (!rgb) return color;
  const [r, g, b] = rgb;
  return `rgba(${r}, ${g}, ${b}, ${clamp(alpha, 0, 1)})`;
}

/** Interpolate hue along the shorter arc, so cyan→blue never sweeps the wheel. */
export function lerpHue(from: number, to: number, t: number): number {
  const delta = ((to - from + 540) % 360) - 180;
  return from + delta * t;
}

/**
 * A brighter, hue-preserving variant of a cell-text token, for the playing
 * row's text highlight (the tracker's bright-row-text feature).
 *
 * The glyphs sit on the active-row pill — a low-alpha tint over the tracker
 * background, which is dark in every built-in theme and every custom theme the
 * editor allows. "Brighter" here therefore always means *toward white*: the
 * text lifts clear of that dark pill. Both DOM (`--tracker-*-bright` custom
 * props) and canvas (`ensureBrightRowText`) call this, so the two paths agree.
 *
 * Mixed channel-wise toward white rather than swapping in a fixed near-white:
 * mint effect text stays mint, blue volume text stays blue — the column keeps
 * its hue identity, which is the point (MINOR-4). Belt-and-braces: each
 * channel is clamped so the result is never dimmer than the base token — a
 * "brighter variant" that can darken is wrong by construction. Unparsable
 * input is returned unchanged so a caller can always use the result.
 */
export function deriveBrightText(base: string, amount = 0.45): string {
  const rgb = parseRgb(base);
  if (!rgb) return base;
  const [r, g, b] = rgb;
  const t = clamp(amount, 0, 1);
  const mix = (channel: number) =>
    Math.max(channel, Math.round(channel + (255 - channel) * t));
  return `rgb(${mix(r)}, ${mix(g)}, ${mix(b)})`;
}

/**
 * Rotate a color's hue, keeping its saturation and lightness, with optional
 * saturation and lightness deltas (percentage points). Unparsable input is
 * returned unchanged, so a caller can always use the result as a color.
 */
export function shiftHue(
  color: string,
  degrees: number,
  adjust: { saturation?: number; lightness?: number } = {},
): string {
  const rgb = parseRgb(color);
  if (!rgb) return color;
  const hsl = rgbToHsl(rgb);
  return hslToCss({
    h: hsl.h + degrees,
    s: hsl.s + (adjust.saturation ?? 0),
    l: hsl.l + (adjust.lightness ?? 0),
  });
}
