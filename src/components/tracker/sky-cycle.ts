/**
 * The day and night of the raytraced scene: where the sun and moon are, what
 * colour their light is, and how dark the sky has gone, all from the clock.
 * Pure arithmetic, so the shader only has to be handed numbers.
 */

/** A whole day, sunrise to sunrise, in seconds. */
export const CYCLE_SECONDS = 150;
/** The scene opens just after sunrise. */
export const START_PHASE = 0.015;

export type Vec3 = [number, number, number];

export interface SkyState {
  /** Unit vectors towards the sun and the moon (the moon is opposite the sun). */
  sunDir: Vec3;
  moonDir: Vec3;
  /** Light arriving from each, already reddened by the air it crossed, and 0 below the horizon. */
  sunColor: Vec3;
  moonColor: Vec3;
  /** The brighter of the two: the direction and colour the clouds are lit by. */
  keyDir: Vec3;
  keyColor: Vec3;
  /** Sky light that fills the shade. */
  ambient: Vec3;
  /** Sine of the sun's elevation, -1..1. */
  sunElevation: number;
  /** 0 at night, 1 by day. */
  day: number;
  /** 1 once the sky is dark enough for stars, 0 by day. */
  night: number;
  /** How strong the aurora is, 0..1: only for a short stretch of the night. */
  aurora: number;
}

/** Rayleigh scattering per unit air mass for red, green and blue: blue goes first. */
const BETA_RAYLEIGH: Vec3 = [0.037, 0.087, 0.212];
const SUN_INTENSITY = 3.4;
const MOON_INTENSITY = 0.9;
const MOON_TINT: Vec3 = [0.55, 0.68, 1.0];
const AMBIENT_NIGHT: Vec3 = [0.012, 0.02, 0.048];
const AMBIENT_DAY: Vec3 = [0.11, 0.15, 0.23];
const AMBIENT_TWILIGHT: Vec3 = [0.05, 0.02, 0.012];

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function normalize(v: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

/** The relative length of the path through the atmosphere at this elevation (sine), Kasten & Young. */
export function airMass(elevation: number): number {
  const s = Math.max(elevation, 0);
  const degrees = (Math.asin(s) * 180) / Math.PI;
  return 1 / (s + 0.15 * Math.pow(degrees + 3.885, -1.253));
}

/** Light from a body at this elevation, reddened by the air it crosses and faded out at the horizon. */
function bodyColor(elevation: number, intensity: number, tint: Vec3): Vec3 {
  const am = airMass(elevation);
  const fade = smoothstep(-0.04, 0.04, elevation) * intensity;
  return [
    Math.exp(-BETA_RAYLEIGH[0] * am) * fade * tint[0],
    Math.exp(-BETA_RAYLEIGH[1] * am) * fade * tint[1],
    Math.exp(-BETA_RAYLEIGH[2] * am) * fade * tint[2],
  ];
}

const luma = (c: Vec3): number => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

/** The orbit: a shallow arc behind the row, rising on the left and setting on the right. */
function bodyDirection(angle: number, sign: 1 | -1): Vec3 {
  return normalize([-Math.cos(angle) * 0.6 * sign, Math.sin(angle) * 0.4 * sign, -1]);
}

/** The aurora shows for an eighth of the day, late at night, fading in and out. */
function auroraWindow(dayFraction: number): number {
  return smoothstep(0.76, 0.79, dayFraction) * (1 - smoothstep(0.85, 0.88, dayFraction));
}

/** The sky at `seconds` on the clock (any origin; the day repeats every CYCLE_SECONDS). */
export function skyState(seconds: number, startPhase = START_PHASE): SkyState {
  const phase = seconds / CYCLE_SECONDS + startPhase;
  const angle = 2 * Math.PI * (phase - Math.floor(phase));
  const sunDir = bodyDirection(angle, 1);
  const moonDir = bodyDirection(angle, -1);
  const sunE = sunDir[1];
  const moonE = moonDir[1];

  const sunColor = bodyColor(sunE, SUN_INTENSITY, [1, 1, 1]);
  const moonColor = bodyColor(moonE, MOON_INTENSITY, MOON_TINT);

  const day = smoothstep(-0.15, 0.25, sunE);
  const night = 1 - smoothstep(-0.3, -0.03, sunE);
  // A warm wash in the shade while the sun is on the horizon.
  const warm = Math.exp(-Math.pow(sunE / 0.12, 2));
  const ambient: Vec3 = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    ambient[i] =
      (AMBIENT_NIGHT[i] as number) * (1 - day) +
      (AMBIENT_DAY[i] as number) * day +
      (AMBIENT_TWILIGHT[i] as number) * warm;
  }

  const ls = luma(sunColor);
  const lm = luma(moonColor);
  const w = ls / (ls + lm + 1e-4);
  const keyDir = normalize([
    moonDir[0] + (sunDir[0] - moonDir[0]) * w,
    moonDir[1] + (sunDir[1] - moonDir[1]) * w,
    moonDir[2] + (sunDir[2] - moonDir[2]) * w,
  ]);
  const keyColor: Vec3 = [sunColor[0] + moonColor[0], sunColor[1] + moonColor[1], sunColor[2] + moonColor[2]];

  return {
    sunDir,
    moonDir,
    sunColor,
    moonColor,
    keyDir,
    keyColor,
    ambient,
    sunElevation: sunE,
    day,
    night,
    aurora: night * auroraWindow(phase - Math.floor(phase)) * (0.85 + 0.15 * Math.sin(seconds * 0.11)),
  };
}
