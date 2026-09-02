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
    expect(w).toEqual({ sx: 50, sy: 100, sw: 800, sh: 600, dx: 0, dy: 0 });
  });

  it('scales source and destination by dpr', () => {
    const w = blitWindow(100, 50, 800, 600, 2000, 1500, 2);
    expect(w).toEqual({ sx: 100, sy: 200, sw: 1600, sh: 1200, dx: 0, dy: 0 });
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
    for (const [top, left] of [[0, 0], [10, 10], [1499, 1999]]) {
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
    expect(w).toEqual({ sx: 0, sy: 0, sw: 400, sh: 200, dx: 0, dy: 0 });
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
    // The visible slice shrinks by exactly the pinned amount.
    expect(w.sw).toBe(400 - 100);
    expect(w.sh).toBe(200 - 150);
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
