import { describe, it, expect } from 'vitest';
import { blitWindow } from 'src/components/tracker/pattern-canvas/pattern-window';

/**
 * The renderer copies one slice of a pre-rendered pattern bitmap onto the
 * screen canvas every frame. Both spaces are in device pixels (dpr-scaled),
 * so an error scales with the display and shows as jitter or smearing. The
 * clamps matter most at the edges: over-scrolled content pins to the viewport
 * edge, and content smaller than the viewport copies once without ever
 * producing a negative or degenerate rectangle.
 */

describe('plain interior blits', () => {
  it('maps the visible slice into both spaces at dpr 1', () => {
    const w = blitWindow(100, 50, 800, 600, 2000, 1500, 1);
    expect(w).toEqual({ sx: 50, sy: 100, sw: 800, sh: 600, dx: 0, dy: 0, dw: 800, dh: 600 });
  });

  it('scales source and destination by dpr', () => {
    const w = blitWindow(100, 50, 800, 600, 2000, 1500, 2);
    expect(w).toEqual({
      sx: 100,
      sy: 200,
      sw: 1600,
      sh: 1200,
      dx: 0,
      dy: 0,
      dw: 1600,
      dh: 1200,
    });
  });

  it('clips the source at the bitmap edges', () => {
    // Viewport hangs off the right and bottom of the content.
    const w = blitWindow(1400, 1800, 800, 600, 2000, 1500, 1);
    expect(w.sx).toBe(1800);
    expect(w.sy).toBe(1400);
    expect(w.sw).toBe(200); // only 2000-1800 left
    expect(w.sh).toBe(100); // only 1500-1400 left
  });

  it('never returns a negative or zero-sized rect for interior views', () => {
    for (const [top, left] of [[0, 0], [10, 10], [1499, 1999]] as const) {
      const w = blitWindow(top, left, 800, 600, 2000, 1500, 2);
      expect(w.sw).toBeGreaterThan(0);
      expect(w.sh).toBeGreaterThan(0);
    }
  });
});

describe('over-scroll', () => {
  it('pins content to the top-left edge when scrolled past it', () => {
    // Scrolled up past the content start: no source shift, but the content
    // must be pushed down/right by the over-scroll amount.
    const w = blitWindow(-100, -60, 800, 600, 2000, 1500, 1);
    expect(w.sy).toBe(0);
    expect(w.sx).toBe(0);
    expect(w.dy).toBe(100);
    expect(w.dx).toBe(60);
  });

  it('combines over-scroll with dpr scaling', () => {
    const w = blitWindow(-40, 0, 400, 300, 800, 600, 2);
    expect(w.dy).toBe(80);
    expect(w.sy).toBe(0);
    expect(w.sh).toBe((300 - 40) * 2);
  });

  it('clamps source origin when scrolled past both edges differently', () => {
    // Horizontal over-scroll plus deep vertical scroll.
    const w = blitWindow(5000, -30, 400, 300, 800, 600, 1);
    expect(w.sy).toBe(600); // clamped to bitmap height
    expect(w.sh).toBe(0); // nothing left to show
    expect(w.dx).toBe(30);
    expect(w.dy).toBe(0);
  });
});

describe('content smaller than the viewport', () => {
  it('copies the whole bitmap and centers nothing (no stretching)', () => {
    const w = blitWindow(0, 0, 800, 600, 400, 200, 1);
    expect(w).toEqual({ sx: 0, sy: 0, sw: 400, sh: 200, dx: 0, dy: 0, dw: 400, dh: 200 });
  });

  it('still applies dpr to the small content', () => {
    const w = blitWindow(0, 0, 800, 600, 400, 200, 2);
    expect(w.sw).toBe(800);
    expect(w.sh).toBe(400);
  });

  it('with over-scroll, shifts the small content into view', () => {
    const w = blitWindow(-150, -100, 800, 600, 400, 200, 1);
    expect(w.dx).toBe(100);
    expect(w.dy).toBe(150);
    // The whole content still fits in the remaining viewport, so the source
    // spans all of it; only the destination offset changes.
    expect(w.sw).toBe(400);
    expect(w.sh).toBe(200);
  });

  it('over-scroll larger than the remaining viewport clips the source', () => {
    // Pinned so hard the content's far edge runs off-canvas: content starts
    // at screen x=450 and is 400 wide, so only 350px fit before x=800.
    const w = blitWindow(-150, -450, 800, 600, 400, 200, 1);
    expect(w.dx).toBe(450);
    expect(w.dy).toBe(150);
    expect(w.sw).toBe(800 - 450);
    expect(w.sh).toBe(200);
  });
});

describe('degenerate inputs', () => {
  it('empty pattern yields a zero rect', () => {
    const w = blitWindow(0, 0, 800, 600, 0, 0, 2);
    expect(w.sw).toBe(0);
    expect(w.sh).toBe(0);
  });

  it('zero viewport yields a zero rect without negative values', () => {
    const w = blitWindow(10, 10, 0, 0, 800, 600, 1);
    expect(w.sw).toBe(0);
    expect(w.sh).toBe(0);
  });

  it('fractional dpr keeps the rect in device pixels', () => {
    const w = blitWindow(33, 44, 320, 240, 800, 600, 1.5);
    expect(w.sx).toBe(66);
    expect(w.sy).toBe(49.5);
    expect(w.sw).toBe(480);
    expect(w.sh).toBe(360);
  });
});

/**
 * A pattern too big for a full-resolution bitmap is painted at a lower
 * scale and stretched by the blit (see pattern-bitmap): the source rect is
 * then in bitmap pixels and the destination in screen device pixels, and
 * the two no longer agree. Getting this wrong shows as a pattern drawn at a
 * fraction of its size in the corner of the canvas, or as a source rect
 * reaching past the end of the bitmap.
 */
describe('a bitmap painted below the screen scale', () => {
  it('reads at the bitmap scale and writes at the device scale', () => {
    // A 3x screen showing a bitmap painted at scale 1.
    const w = blitWindow(100, 50, 800, 600, 2000, 1500, 3, 1);

    expect(w).toEqual({
      sx: 50,
      sy: 100,
      sw: 800,
      sh: 600,
      dx: 0,
      dy: 0,
      dw: 2400,
      dh: 1800,
    });
  });

  it('keeps the source inside the bitmap at its own scale', () => {
    // Scrolled to the far corner: the source must stop at the bitmap's real
    // edge (2000x1500 at scale 1), not at the device-scaled one.
    const w = blitWindow(1400, 1800, 800, 600, 2000, 1500, 3, 1);

    expect(w.sx + w.sw).toBeLessThanOrEqual(2000);
    expect(w.sy + w.sh).toBeLessThanOrEqual(1500);
    expect(w.dw).toBe(w.sw * 3);
    expect(w.dh).toBe(w.sh * 3);
  });

  it('pins over-scrolled content to the viewport edge in device pixels', () => {
    const w = blitWindow(-20, -10, 800, 600, 2000, 1500, 3, 1.5);

    expect(w.sx).toBe(0);
    expect(w.sy).toBe(0);
    expect(w.dx).toBe(30); // 10 css × dpr 3
    expect(w.dy).toBe(60);
    // The slice is the viewport minus the pinned margin, in each space.
    expect(w.sw).toBe((800 - 10) * 1.5);
    expect(w.dw).toBe((800 - 10) * 3);
  });

  it('defaults the bitmap scale to the device scale', () => {
    const implicit = blitWindow(100, 50, 800, 600, 2000, 1500, 2);
    const explicit = blitWindow(100, 50, 800, 600, 2000, 1500, 2, 2);

    expect(implicit).toEqual(explicit);
  });
});
