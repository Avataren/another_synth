/**
 * Touch panning for the canvas pattern renderer.
 *
 * The canvas scrolls vertically through a native scroller and horizontally
 * through a proxy scrollbar (the scroller itself clips horizontally, see
 * PatternCanvas), so a finger dragged across the grid cannot reach the
 * horizontal axis on its own -- which on a phone is most of the pattern. This
 * drives both axes from one gesture instead.
 *
 * Pure module: it takes positions and timestamps and returns where the two
 * scrollers should be. The component owns the listeners and does the writing,
 * which is what keeps the gesture testable without a touch-capable DOM.
 */

export interface TouchPanOrigin {
  /** Where the finger went down, in client coordinates. */
  x: number;
  y: number;
  /** Scroll offsets at that moment. */
  scrollTop: number;
  scrollLeft: number;
  /** Timestamp of the touchstart, for the tap test and the fling velocity. */
  time: number;
}

export interface TouchPanTarget {
  scrollTop: number;
  scrollLeft: number;
}

/**
 * A drag of this many CSS pixels or less, released within `TAP_MAX_MS`, is a
 * tap rather than a pan. Deliberately generous: a finger never lands as
 * still as a mouse, and a tap that scrolls the grid a few pixels instead of
 * selecting the cell under it reads as the app ignoring you.
 */
export const TAP_MAX_MOVEMENT_PX = 10;
export const TAP_MAX_MS = 500;

/** Where the scrollers should sit for a finger now at (x, y). */
export function panTarget(
  origin: TouchPanOrigin,
  x: number,
  y: number,
  maxScrollTop: number,
  maxScrollLeft: number,
): TouchPanTarget {
  // Content follows the finger: dragging up moves the view down the pattern.
  const scrollTop = clamp(origin.scrollTop - (y - origin.y), 0, maxScrollTop);
  const scrollLeft = clamp(origin.scrollLeft - (x - origin.x), 0, maxScrollLeft);
  return { scrollTop, scrollLeft };
}

/** Whether a release at (x, y, time) counts as a tap on the starting cell. */
export function isTap(
  origin: TouchPanOrigin,
  x: number,
  y: number,
  time: number,
): boolean {
  if (time - origin.time > TAP_MAX_MS) return false;
  return Math.hypot(x - origin.x, y - origin.y) <= TAP_MAX_MOVEMENT_PX;
}

/**
 * Momentum after the finger leaves, in CSS pixels per millisecond.
 *
 * Measured over the last samples of the drag rather than the whole gesture:
 * a finger that pans, pauses and lifts should stop where it was let go, and
 * averaging over the whole drag would fling it on anyway.
 */
export const FLING_SAMPLE_MS = 100;
/** Below this the gesture was a drag-and-stop, not a throw. */
export const FLING_MIN_VELOCITY = 0.05;
/**
 * Ceiling on the launch speed, in CSS px/ms (~4 screen widths a second).
 *
 * Two samples a millisecond apart -- a jittery digitiser, a frame the page
 * missed -- divide a normal flick by a tiny interval and produce a velocity
 * that throws the pattern from end to end. The cap costs nothing on a real
 * throw and keeps a glitchy one legible.
 */
export const FLING_MAX_VELOCITY = 4;
/**
 * A release this long after the last movement is a stop, not a throw.
 *
 * The samples alone cannot tell the difference: a finger held still emits no
 * touchmove, so a pan that stops dead and lifts a moment later ends with the
 * same samples as one released mid-motion, and the grid would sail on from
 * under a finger that had already parked it. Only the release timestamp
 * carries the pause.
 */
export const FLING_RELEASE_GRACE_MS = 80;
/** Per-frame decay at 60fps, and the speed at which the fling gives up. */
export const FLING_DECAY = 0.94;
export const FLING_STOP_VELOCITY = 0.02;

export interface FlingSample {
  x: number;
  y: number;
  time: number;
}

export interface FlingVelocity {
  /** Scroll-space velocity: the sign is already flipped from finger motion. */
  vx: number;
  vy: number;
}

/**
 * Velocity from the tail of a gesture's samples, or null when it is a stop.
 *
 * `samples` is oldest-first; anything older than `FLING_SAMPLE_MS` before the
 * last sample is ignored. `releaseTime`, when given, is when the finger
 * actually left: a gesture that sat still before lifting is a stop however
 * fast it was moving before that.
 */
export function flingVelocity(
  samples: FlingSample[],
  releaseTime?: number,
): FlingVelocity | null {
  const last = samples[samples.length - 1];
  if (!last || samples.length < 2) return null;
  if (releaseTime !== undefined && releaseTime - last.time > FLING_RELEASE_GRACE_MS) {
    return null;
  }
  let first = last;
  for (let i = samples.length - 2; i >= 0; i--) {
    const sample = samples[i]!;
    if (last.time - sample.time > FLING_SAMPLE_MS) break;
    first = sample;
  }
  const dt = last.time - first.time;
  if (dt <= 0) return null;
  // Finger right means content left, hence the negation.
  const vx = -(last.x - first.x) / dt;
  const vy = -(last.y - first.y) / dt;
  const speed = Math.hypot(vx, vy);
  if (speed < FLING_MIN_VELOCITY) return null;
  if (speed > FLING_MAX_VELOCITY) {
    // Scale both axes together so the throw keeps its direction.
    const scale = FLING_MAX_VELOCITY / speed;
    return { vx: vx * scale, vy: vy * scale };
  }
  return { vx, vy };
}

function clamp(value: number, min: number, max: number): number {
  if (!(max > min)) return min;
  return Math.max(min, Math.min(max, value));
}
