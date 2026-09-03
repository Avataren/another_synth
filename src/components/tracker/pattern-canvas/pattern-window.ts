/**
 * Blit-window math for the canvas pattern renderer.
 *
 * The renderer pre-draws the pattern into an offscreen bitmap and paints the
 * visible slice of it onto the on-screen canvas each frame. The two canvases
 * scale differently (the bitmap covers the whole pattern; the screen canvas
 * covers the viewport; both at devicePixelRatio), so every frame needs the
 * same rectangle expressed in both spaces plus the destination offset that
 * over-scroll produces. Getting that wrong shows up as the pattern jittering
 * one device pixel per scroll tick or smearing at fractional dpr.
 */

export interface BlitWindow {
  /** Source rectangle in offscreen-bitmap pixels (at the bitmap's scale). */
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  /** Destination offset in on-screen-canvas device pixels. */
  dx: number;
  dy: number;
  /**
   * Destination size in on-screen-canvas device pixels.
   *
   * Equal to sw/sh while the bitmap is painted at the screen's own scale.
   * They part company when a pattern too big for a full-resolution bitmap is
   * painted at a lower one (see pattern-bitmap): the same CSS extent is then
   * fewer source pixels than destination pixels, and drawImage stretches it.
   */
  dw: number;
  dh: number;
}

/**
 * Rectangle of the pattern visible through the viewport, in both spaces.
 *
 * `bitmapW`/`bitmapH` are the pattern's size in CSS pixels; the bitmap
 * itself is `bitmapW*bitmapScale` × `bitmapH*bitmapScale` pixels, where
 * `bitmapScale` defaults to `dpr` and is lower for a pattern too big to
 * paint at full resolution. `viewportW`/`viewportH` are the on-screen
 * canvas's CSS size. Source results are in bitmap pixels, destination
 * results in on-screen device pixels.
 *
 * Clamps:
 * - scroll beyond the content edges reads no source pixels (`sx`/`sy` clamp
 *   into the bitmap) and pins the content to the viewport edge it over-scrolled
 *   past (`dx`/`dy` ≥ 0) instead of leaving a growing blank margin on-screen;
 * - content smaller than the viewport copies the whole bitmap and leaves the
 *   remainder of the viewport untouched.
 */
export function blitWindow(
  scrollTop: number,
  scrollLeft: number,
  viewportW: number,
  viewportH: number,
  bitmapW: number,
  bitmapH: number,
  dpr: number,
  bitmapScale: number = dpr,
): BlitWindow {
  // Work the geometry out once in CSS pixels, then convert into each space:
  // the source and the destination no longer share a scale.
  const cssSx = Math.max(0, Math.min(scrollLeft, bitmapW));
  const cssSy = Math.max(0, Math.min(scrollTop, bitmapH));

  // Negative scroll means the content's edge sits inside the viewport: shift
  // the destination right/down by the over-scroll amount.
  const cssDx = Math.max(0, -scrollLeft);
  const cssDy = Math.max(0, -scrollTop);

  const visibleCssW = Math.max(
    0,
    Math.min(
      viewportW - cssDx, // viewport space left of the pinned edge
      bitmapW - cssSx, // bitmap content left of the source origin
    ),
  );
  const visibleCssH = Math.max(
    0,
    Math.min(viewportH - cssDy, bitmapH - cssSy),
  );

  return {
    sx: cssSx * bitmapScale,
    sy: cssSy * bitmapScale,
    sw: visibleCssW * bitmapScale,
    sh: visibleCssH * bitmapScale,
    dx: cssDx * dpr,
    dy: cssDy * dpr,
    dw: visibleCssW * dpr,
    dh: visibleCssH * dpr,
  };
}
