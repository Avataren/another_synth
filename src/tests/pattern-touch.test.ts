import { describe, it, expect } from 'vitest';
import {
  flingVelocity,
  isTap,
  panTarget,
  FLING_MAX_VELOCITY,
  FLING_RELEASE_GRACE_MS,
  FLING_MIN_VELOCITY,
  TAP_MAX_MOVEMENT_PX,
  TAP_MAX_MS,
  type FlingSample,
  type TouchPanOrigin,
} from 'src/components/tracker/pattern-canvas/pattern-touch';

/**
 * One finger has to reach both axes.
 *
 * The canvas scrolls vertically through a native scroller and horizontally
 * through a proxy scrollbar, so the browser's own touch scrolling can only
 * ever move one of them -- and on a phone the pattern is far wider than the
 * screen, so the axis it cannot reach is the one that matters most.
 */
const origin = (over: Partial<TouchPanOrigin> = {}): TouchPanOrigin => ({
  x: 200,
  y: 300,
  scrollTop: 100,
  scrollLeft: 50,
  time: 1000,
  ...over,
});

describe('panTarget', () => {
  it('moves the content with the finger on both axes', () => {
    // Finger up and left by 40/30: the view goes further down and right into
    // the pattern, which is the direction that keeps the grid under the
    // fingertip rather than fleeing it.
    const target = panTarget(origin(), 160, 260, 5000, 5000);

    expect(target.scrollTop).toBe(140);
    expect(target.scrollLeft).toBe(90);
  });

  it('clamps at both ends instead of running off the pattern', () => {
    const atTop = panTarget(origin(), 200, 900, 5000, 5000);
    expect(atTop.scrollTop).toBe(0);

    const atEnd = panTarget(origin({ scrollTop: 4990 }), 200, 0, 5000, 5000);
    expect(atEnd.scrollTop).toBe(5000);
  });

  it('pins to zero when there is nothing to scroll', () => {
    // A pattern narrower than the viewport has no horizontal extent; the
    // gesture must not drag it out of frame.
    const target = panTarget(origin(), 900, 300, 0, 0);

    expect(target).toEqual({ scrollTop: 0, scrollLeft: 0 });
  });
});

describe('isTap', () => {
  it('accepts a still, quick release', () => {
    expect(isTap(origin(), 203, 302, 1120)).toBe(true);
  });

  it('rejects a release that travelled', () => {
    // A finger never lands as still as a mouse, so the threshold is
    // generous -- but a drag across a cell is a pan, not a pick.
    expect(isTap(origin(), 200 + TAP_MAX_MOVEMENT_PX + 1, 300, 1100)).toBe(false);
  });

  it('rejects a long press', () => {
    expect(isTap(origin(), 200, 300, 1000 + TAP_MAX_MS + 1)).toBe(false);
  });
});

describe('flingVelocity', () => {
  it('reads the throw from the tail of the gesture, negated into scroll space', () => {
    const velocity = flingVelocity([
      { x: 200, y: 300, time: 1000 },
      { x: 180, y: 260, time: 1016 },
      { x: 160, y: 220, time: 1032 },
    ]);

    // 20px of finger per 16ms, and the content moves the other way.
    expect(velocity).not.toBeNull();
    expect(velocity!.vx).toBeCloseTo(20 / 16, 6);
    expect(velocity!.vy).toBeCloseTo(40 / 16, 6);
  });

  it('ignores samples older than the tail window', () => {
    // A long slow drag that ends in a flick throws at the flick's speed, not
    // the average of the whole gesture.
    const velocity = flingVelocity([
      { x: 0, y: 0, time: 0 },
      { x: 10, y: 0, time: 900 },
      { x: 40, y: 0, time: 950 },
      { x: 70, y: 0, time: 1000 },
    ]);

    expect(velocity!.vx).toBeCloseTo(-60 / 100, 6);
  });

  it('returns null for a drag that stopped before release', () => {
    // Pan, pause, lift: the grid stays where it was let go.
    expect(
      flingVelocity([
        { x: 200, y: 300, time: 1000 },
        { x: 100, y: 100, time: 1100 },
        { x: 100, y: 100, time: 1200 },
      ]),
    ).toBeNull();
  });

  it('returns null when the finger sat still before lifting', () => {
    // The case the samples cannot show: a finger held still emits no
    // touchmove, so a pan that stops dead and lifts a moment later ends on
    // the same samples as one released mid-flick. Caught in the browser --
    // a deliberate drag kept sailing after the finger had parked it.
    const moving: FlingSample[] = [
      { x: 200, y: 300, time: 1000 },
      { x: 160, y: 240, time: 1032 },
    ];

    expect(flingVelocity(moving, 1040)).not.toBeNull();
    expect(flingVelocity(moving, 1032 + FLING_RELEASE_GRACE_MS + 1)).toBeNull();
  });

  it('returns null for a single sample or an instant one', () => {
    expect(flingVelocity([{ x: 0, y: 0, time: 0 }])).toBeNull();
    expect(
      flingVelocity([
        { x: 0, y: 0, time: 5 },
        { x: 50, y: 0, time: 5 },
      ]),
    ).toBeNull();
  });

  it('caps a glitched sample pair without turning the throw', () => {
    // Two samples a millisecond apart: a real flick divided by a bad
    // interval, which without the cap threw the pattern end to end.
    const velocity = flingVelocity([
      { x: 0, y: 0, time: 0 },
      { x: -30, y: -60, time: 1 },
    ])!;

    expect(Math.hypot(velocity.vx, velocity.vy)).toBeCloseTo(FLING_MAX_VELOCITY, 6);
    // Direction survives: still down-and-right through the pattern, in the
    // same 1:2 ratio the finger moved.
    expect(velocity.vy / velocity.vx).toBeCloseTo(2, 6);
    expect(velocity.vx).toBeGreaterThan(0);
  });

  it('keeps a real flick above the floor it is measured against', () => {
    const velocity = flingVelocity([
      { x: 0, y: 0, time: 0 },
      { x: 30, y: 0, time: 16 },
    ]);

    expect(Math.abs(velocity!.vx)).toBeGreaterThan(FLING_MIN_VELOCITY);
  });
});
