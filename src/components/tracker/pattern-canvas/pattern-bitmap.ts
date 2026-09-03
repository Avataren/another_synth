/**
 * How big the full-pattern bitmap is allowed to be, and what to do about it.
 *
 * The renderer paints the whole pattern into one offscreen bitmap and blits
 * the visible window out of it. That bitmap is sized in *device* pixels, so
 * its cost is the pattern's area times the square of the device pixel ratio
 * -- and a phone is the worst of both worlds: three device pixels per CSS
 * pixel over a pattern that is wider than any laptop's screen. jt_letgo's 26
 * channels at DPR 3 come to 13164 x 6912, which is 91M pixels, ~364MB of
 * RGBA, and past what browsers will allocate.
 *
 * The renderer used to give up there and fall back to the DOM grid for the
 * rest of the page's life, which on a phone meant most modules. It does not
 * have to: the bitmap's scale is a free variable. Painting at a lower scale
 * and letting the blit stretch it costs sharpness in the text and nothing
 * else -- a pattern painted at scale 1 on a 3x screen looks the way it does
 * on a non-retina monitor, which is to say fine.
 *
 * The budget is the device's, not one number: a desktop keeps exactly what
 * it always allocated (so nothing that worked is made softer), while a phone
 * gets a far smaller one, because that is where the allocation genuinely
 * fails and where the memory is scarce.
 *
 * Deliberately NOT tiling the bitmap. Tiles would keep full resolution, but
 * every part of the pipeline that treats the bitmap as one surface -- the
 * blit, the cell-level repair, the ping-pong pre-render and its adoption
 * check -- would become an N-way loop, and the scale clamp already covers
 * the patterns that exist. On a desktop it covers all of them: the largest
 * legal XM (32 channels, 256 rows, dual effect columns) is 67.3M CSS
 * pixels, which fits at 0.97, and everything smaller fits at 1 or better.
 * On a phone's much smaller budget that one extreme -- 7304 x 9216 CSS
 * pixels, on a 390px screen -- is the single case that still hands over to
 * the DOM grid, which for a pattern that size on that screen is the right
 * answer anyway. Tiles would buy sharpness on patterns nobody writes, for a
 * rewrite of the part of the renderer most likely to go subtly wrong.
 */

/** What a device will let the renderer allocate. */
export interface BitmapBudget {
  /** Area ceiling, in device pixels. */
  maxArea: number;
  /**
   * Per-axis ceiling, in device pixels. Separate from the area because
   * browsers enforce both, and the axis limit is the one a tall pattern
   * hits first: 256 rows at DPR 3 is 27648 pixels of height on a bitmap
   * whose area would still pass.
   */
  maxDimension: number;
}

/**
 * Desktop: what the renderer has always allocated.
 *
 * 64M device px ≈ 256MB RGBA, and 16384 per axis is Safari's documented
 * limit (Chrome and Firefox go further). This deliberately changes nothing
 * that used to work -- a desktop pattern that fit before is still painted at
 * the screen's full DPR, and the scale only comes down where the old code
 * refused the pattern outright and dropped to the DOM grid.
 */
export const DESKTOP_BITMAP_BUDGET: BitmapBudget = {
  maxArea: 64 * 1024 * 1024,
  maxDimension: 16384,
};

/**
 * Phones and tablets, where the allocation actually fails.
 *
 * Far below the desktop budget on purpose: iOS caps canvas memory hard (the
 * often-quoted 16.7M px ≈ 4096²), a phone has a fraction of the RAM to lose
 * to one bitmap, and it is also the device most likely to ask for the
 * biggest one -- three device pixels per CSS pixel over a pattern wider than
 * any laptop screen. 16M px is ~64MB, which a phone can hold.
 */
export const MOBILE_BITMAP_BUDGET: BitmapBudget = {
  maxArea: 16 * 1024 * 1024,
  maxDimension: 8192,
};

/**
 * The lowest scale worth painting at.
 *
 * Below half a CSS pixel per pixel the text stops being readable, so a
 * pattern that still does not fit is genuinely beyond this renderer and the
 * DOM grid should take it. Nothing the tracker formats allow gets near this.
 */
export const MIN_BITMAP_SCALE = 0.5;

/**
 * The scale to paint the full-pattern bitmap at, or null when even
 * `MIN_BITMAP_SCALE` will not fit.
 *
 * Never above `dpr`: painting past the screen's own resolution is waste, and
 * the point of the clamp is to come down, not up.
 */
export function bitmapScaleFor(
  cssWidth: number,
  cssHeight: number,
  dpr: number,
  budget: BitmapBudget = DESKTOP_BITMAP_BUDGET,
): number | null {
  if (!(cssWidth > 0) || !(cssHeight > 0) || !(dpr > 0)) return null;
  if (!Number.isFinite(cssWidth) || !Number.isFinite(cssHeight) || !Number.isFinite(dpr)) {
    return null;
  }

  const byArea = Math.sqrt(budget.maxArea / (cssWidth * cssHeight));
  const byWidth = budget.maxDimension / cssWidth;
  const byHeight = budget.maxDimension / cssHeight;
  const scale = Math.min(dpr, byArea, byWidth, byHeight);

  // Floor rather than round: rounding up could re-cross the cap the scale
  // was computed to respect.
  if (scale < MIN_BITMAP_SCALE) return null;
  return scale;
}
