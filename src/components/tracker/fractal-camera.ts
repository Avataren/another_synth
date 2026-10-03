/**
 * The Fractal view's camera: a run of shots that cut from one to the next every
 * SHOT_SECONDS, each a slow move of its own (a wide orbit, a skim along the floor,
 * a look straight down, a fly-in, a side dolly, a view through the glass sphere, close and from a distance).
 * The order is a shuffle that never repeats a shot back to back. Pure arithmetic
 * on the clock, so the renderer only has to be handed numbers.
 */

export type Vec3 = [number, number, number];

export interface FractalCamera {
  eye: Vec3;
  look: Vec3;
  /** Vertical field of view, radians. */
  fovY: number;
  /** Which shot this is (0..SHOT_KINDS-1) and how far into it, 0..1: for tests and tuning. */
  kind: number;
  progress: number;
}

export const FLOOR_Y = -1.45;
export const SHOT_SECONDS = 10;
export const SHOT_KINDS = 7;
/** The camera keeps this far above the floor, from the bulb's middle and from the glass sphere. */
export const MIN_EYE_Y = FLOOR_Y + 0.3;
export const MIN_BULB_DISTANCE = 1.7;
export const MIN_GLASS_DISTANCE = 1.0;

const DEG = Math.PI / 180;
const GLASS_ORBIT = 2.35;
const GLASS_SPEED = 0.35;

/** Where the glass sphere is at `seconds`. */
export function glassPosition(seconds: number): Vec3 {
  const a = seconds * GLASS_SPEED;
  return [
    Math.cos(a) * GLASS_ORBIT,
    -0.75 + 0.35 * Math.sin(seconds * 0.8),
    Math.sin(a) * GLASS_ORBIT,
  ];
}

function hash(n: number): number {
  const x = Math.sin(n * 127.1 + 31.7) * 43758.5453;
  return x - Math.floor(x);
}

/** The shuffled order of the shots in one cycle of SHOT_KINDS. */
function cycleOrder(cycle: number): number[] {
  const order = Array.from({ length: SHOT_KINDS }, (_, i) => i);
  for (let i = SHOT_KINDS - 1; i > 0; i--) {
    const j = Math.floor(hash(cycle * 17 + i) * (i + 1));
    [order[i], order[j]] = [order[j] as number, order[i] as number];
  }
  return order;
}

/** The shot kind for shot number `index`: a shuffle per cycle, never the same twice in a row. */
export function shotKind(index: number): number {
  const cycle = Math.floor(index / SHOT_KINDS);
  const order = cycleOrder(cycle);
  if (cycle > 0 && order[0] === cycleOrder(cycle - 1)[SHOT_KINDS - 1]) {
    [order[0], order[1]] = [order[1] as number, order[0] as number];
  }
  return order[index - cycle * SHOT_KINDS] as number;
}

const clamp = (v: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, v));
const mix = (a: number, b: number, t: number): number => a + (b - a) * t;
const smooth = (t: number): number => t * t * (3 - 2 * t);

/** The camera at `seconds`; `bass` (0..1) draws it a little closer on a kick. */
export function fractalCamera(seconds: number, bass: number): FractalCamera {
  const t = Math.max(0, seconds);
  const index = Math.floor(t / SHOT_SECONDS);
  const kind = shotKind(index);
  const progress = (t - index * SHOT_SECONDS) / SHOT_SECONDS;
  const phase = hash(index + 5) * Math.PI * 2;
  const glass = glassPosition(t);
  const breath = 1 - 0.1 * bass;

  let eye: Vec3;
  let look: Vec3 = [0, -0.1, 0];
  let fov = 40;
  switch (kind) {
    case 0: {
      // A wide orbit.
      const yaw = phase + t * 0.14;
      const r = (4.8 + 0.5 * Math.sin(t * 0.3)) * breath;
      eye = [Math.sin(yaw) * r, 1.0 + 0.5 * Math.sin(t * 0.2), Math.cos(yaw) * r];
      break;
    }
    case 1: {
      // Skimming the floor, looking up at the bulb.
      const yaw = phase - t * 0.2;
      const r = (3.3 - 0.3 * progress) * breath;
      eye = [Math.sin(yaw) * r, -1.05 + 0.15 * Math.sin(t * 0.7), Math.cos(yaw) * r];
      look = [0, 0.15, 0];
      fov = 58;
      break;
    }
    case 2: {
      // From above, turning slowly, and sinking towards the bulb.
      const yaw = phase + t * 0.25;
      const r = mix(2.6, 1.9, smooth(progress)) * breath;
      eye = [Math.sin(yaw) * r, mix(5.4, 3.8, smooth(progress)), Math.cos(yaw) * r];
      look = [0, -0.5, 0];
      fov = 46;
      break;
    }
    case 3: {
      // A fly-in: out wide, then close to the surface.
      const yaw = phase + t * 0.18;
      const r = mix(5.0, 2.2, smooth(progress)) * breath;
      eye = [Math.sin(yaw) * r, mix(1.2, 0.3, smooth(progress)), Math.cos(yaw) * r];
      look = [0, 0, 0];
      fov = mix(44, 34, progress);
      break;
    }
    case 4: {
      // A dolly along the side, the bulb crossing the frame.
      const x = mix(-6.5, 6.5, progress);
      eye = [x, -0.6 + 0.8 * progress, 5.6 * breath];
      look = [x * 0.25, -0.1, 0];
      fov = 38;
      break;
    }
    default: {
      // From behind the glass sphere, looking back through it at the bulb: kind 5 hugs the sphere, kind 6 stands back so it sits in the frame.
      const len = Math.hypot(glass[0], glass[2]) || 1;
      const out = (kind === 5 ? 2.0 : 3.6) + 0.5 * Math.sin(t * 0.4);
      eye = [
        glass[0] + (glass[0] / len) * out,
        glass[1] + 0.25,
        glass[2] + (glass[2] / len) * out,
      ];
      look = [0, -0.15, 0];
      fov = 46;
      break;
    }
  }

  // Keep out of the floor, the bulb and the glass. Each push can undo the other, so go round a few times.
  for (let pass = 0; pass < 4; pass++) {
    eye[1] = Math.max(eye[1], MIN_EYE_Y);
    const fromBulb = Math.hypot(eye[0], eye[1], eye[2]);
    if (fromBulb < MIN_BULB_DISTANCE) {
      const k = MIN_BULB_DISTANCE / Math.max(fromBulb, 1e-3);
      eye = [eye[0] * k, eye[1] * k, eye[2] * k];
    }
    const gx = eye[0] - glass[0];
    const gy = eye[1] - glass[1];
    const gz = eye[2] - glass[2];
    const fromGlass = Math.hypot(gx, gy, gz);
    if (fromGlass < MIN_GLASS_DISTANCE) {
      const k = (MIN_GLASS_DISTANCE * 1.08) / Math.max(fromGlass, 1e-3);
      eye = [glass[0] + gx * k, glass[1] + gy * k, glass[2] + gz * k];
    }
  }
  eye[1] = Math.max(eye[1], MIN_EYE_Y);

  return { eye, look, fovY: clamp(fov, 20, 70) * DEG, kind, progress };
}
