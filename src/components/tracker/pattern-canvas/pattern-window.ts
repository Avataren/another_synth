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
  /** Source rectangle in offscreen-bitmap device pixels. */
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  /** Destination offset in on-screen-canvas device pixels. */
  dx: number;
  dy: number;
}

/**
 * Rectangle of the pattern visible through the viewport, in both spaces.
 *
 * `bitmapW`/`bitmapH` are the pattern's size in CSS pixels (the bitmap itself
 * is `bitmapW*dpr` × `bitmapH*dpr` device pixels); `viewportW`/`viewportH`
 * are the on-screen canvas's CSS size. All six results are device pixels.
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
): BlitWindow {
  const sx = Math.max(0, Math.min(scrollLeft, bitmapW)) * dpr;
  const sy = Math.max(0, Math.min(scrollTop, bitmapH)) * dpr;

  // Negative scroll means the content's edge sits inside the viewport: shift
  // the destination right/down by the over-scroll amount.
  const dx = Math.max(0, -scrollLeft) * dpr;
  const dy = Math.max(0, -scrollTop) * dpr;

  const visibleCssW = Math.min(
    viewportW - dx / dpr, // viewport space left of the pinned edge
    bitmapW - sx / dpr, // bitmap content left of the source origin
  );
  const visibleCssH = Math.min(
    viewportH - dy / dpr,
    bitmapH - sy / dpr,
  );

  return {
    sx,
    sy,
    sw: Math.max(0, visibleCssW) * dpr,
    sh: Math.max(0, visibleCssH) * dpr,
    dx,
    dy,
  };
}
