/**
 * The bouncing ball: when it is on screen, where it is and how it is turned.
 * It makes a pass across the scene every PASS_PERIOD seconds, coming in from a
 * random side and leaving by the other, bouncing on the floor as it goes, in a
 * lane either in front of the bars or behind them. Pure arithmetic of the clock.
 */

/** Seconds from the start of one pass to the next: the pass itself, then a rest. */
export const PASS_PERIOD = 24;
/** How fast the ball crosses, world units per second, so a wide canvas does not make it zip. */
const SPEED = 3;
/** A pass lasts between these, however narrow or wide the canvas. */
const MIN_PASS_SECONDS = 8;
const MAX_PASS_SECONDS = 18;

/** How long a pass takes when it has `reach` to go each side of the middle. */
export function passSeconds(reach: number): number {
  return Math.min(MAX_PASS_SECONDS, Math.max(MIN_PASS_SECONDS, (2 * reach) / SPEED));
}
/** Seconds from one touch of the floor to the next when there is no tempo to follow. */
export const BOUNCE_SECONDS = 2.3;

/**
 * Seconds between bounces at a tempo: a beat, or a whole number of them, or a
 * half, doubled or halved until it sits in a range that looks like bouncing
 * (too fast is a buzz, too slow a float).
 */
export function bounceSeconds(bpm: number): number {
  if (!Number.isFinite(bpm) || bpm < 20) return BOUNCE_SECONDS;
  let period = 60 / bpm;
  while (period < 0.9) period *= 2;
  while (period > 2.0) period /= 2;
  return period;
}
export const BALL_RADIUS = 0.9;
/** How far the sea's mean level sits above y = 0 (the shader gets the same number), so the ball lands on it. */
export const SEA_LIFT = 0.14;
/** Height of the top of a bounce above the floor, to the ball's centre: lower in front, where the ball is close to the camera and would leave the frame. */
const BOUNCE_HEIGHT = { front: 1.1, back: 2.1 };
/** Lanes, in world z: the bars stand at z = 0, the camera is at +z. */
export const FRONT_LANE_Z = 1.25;
export const BACK_LANE_Z = -1.35;
/** Tilt of the spin axis, like the classic ball's. */
const TILT = 0.41;
const SPIN_RATE = 2.1;

export interface BallState {
  visible: boolean;
  x: number;
  y: number;
  z: number;
  radius: number;
  /** Rotation from the ball's own axes to the world, column-major 3x3. */
  rotation: Float32Array;
  /** 1 when it comes in from the left, -1 from the right. */
  direction: 1 | -1;
  lane: 'front' | 'back';
}

/** A number in 0..1 from a whole number: the same pass always gets the same luck. */
function hash(n: number): number {
  const v = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return v - Math.floor(v);
}

/** Which way and in which lane pass number `index` goes. */
export function passPlan(index: number): { direction: 1 | -1; lane: 'front' | 'back' } {
  return {
    direction: hash(index) < 0.5 ? 1 : -1,
    lane: hash(index + 57.3) < 0.5 ? 'front' : 'back',
  };
}

/** Ry(spin) then Rz(tilt), column-major. */
function rotation(spin: number, tilt: number): Float32Array {
  const cs = Math.cos(spin);
  const sn = Math.sin(spin);
  const ct = Math.cos(tilt);
  const st = Math.sin(tilt);
  // Ry: [cs 0 sn; 0 1 0; -sn 0 cs]; Rz: [ct -st 0; st ct 0; 0 0 1]; result = Rz * Ry
  const m = [
    ct * cs, st * cs, -sn,
    -st, ct, 0,
    ct * sn, st * sn, cs,
  ];
  return new Float32Array(m);
}

/**
 * The ball at `seconds`. `offscreenAt(z)` is how far from the centre (world x) a
 * ball at depth z must be to be entirely out of sight, its own size and the
 * camera's perspective included, so a pass starts and ends where nobody can see it.
 * `bounces` is how many bounces have happened so far (its fraction is where the
 * ball is in the current one); the caller counts them at the tempo, which keeps
 * the bounce in step when the tempo changes. Left out, it bounces at a fixed rate.
 */
export function ballState(
  seconds: number,
  offscreenAt: (z: number) => number,
  bounces: number = seconds / BOUNCE_SECONDS,
): BallState {
  const index = Math.floor(seconds / PASS_PERIOD);
  const inPass = seconds - index * PASS_PERIOD;
  const { direction, lane } = passPlan(index);
  const z = lane === 'front' ? FRONT_LANE_Z : BACK_LANE_Z;
  const reach = offscreenAt(z);
  const u = inPass / passSeconds(reach);
  const visible = u >= 0 && u <= 1;

  const x = direction * (-reach + 2 * reach * Math.min(Math.max(u, 0), 1));
  const b = bounces - Math.floor(bounces);
  const y = SEA_LIFT + BALL_RADIUS + BOUNCE_HEIGHT[lane] * 4 * b * (1 - b);
  return {
    visible,
    x,
    y,
    z,
    radius: BALL_RADIUS,
    rotation: rotation(seconds * SPIN_RATE * -direction, TILT),
    direction,
    lane,
  };
}
