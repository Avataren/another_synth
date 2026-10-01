/**
 * The Terrain view's camera path: a slow drift that sometimes comes in close and low, sometimes backs away and
 * climbs, swings a little sideways and turns, and breathes its field of view so the perspective changes. Pure
 * arithmetic on the clock, so the renderer only has to be handed numbers.
 *
 * The one rule it keeps: the bottom edge of the frame meets the sea no farther from the camera than the vent (the
 * newest row of the spectrum), so the music always appears at the bottom of the picture, however the camera moves.
 */

export type Vec3 = [number, number, number];

export interface TerrainCamera {
  eye: Vec3;
  look: Vec3;
  /** Vertical field of view, radians. */
  fovY: number;
  /** How far the camera is from the vent along z, and how high it is: for tests and tuning. */
  distance: number;
  height: number;
}

const DEG = Math.PI / 180;

/** The ranges the path stays within. */
export const MIN_HEIGHT = 2.0;
export const MAX_HEIGHT = 4.6;
export const MIN_DISTANCE = 3.4;
export const MAX_DISTANCE = 8.0;
/** How high the camera may be, as a fraction of its distance from the vent. */
export const MAX_HEIGHT_PER_DISTANCE = 0.6;
/** The least the camera looks down, radians: it always looks well ahead, never at the sky. */
export const MIN_PITCH_DOWN = 8 * (Math.PI / 180);
export const MIN_FOV = 34 * DEG;
export const MAX_FOV = 52 * DEG;

/** How far ahead the camera looks (only sets the length of the look vector). */
const LOOK_REACH = 12;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** The camera at `seconds`, for a vent whose newest row lies at world z = `ventZ`. */
export function terrainCamera(seconds: number, ventZ: number): TerrainCamera {
  const t = seconds;
  const height = clamp(3.4 + 1.4 * Math.sin(t * 0.075 + 1.0) + 0.5 * Math.sin(t * 0.18), MIN_HEIGHT, MAX_HEIGHT);
  // Never high and close at once: that would force a pitch steeply down at the water. Height may reach at most
  // MAX_HEIGHT_PER_DISTANCE of the distance, which keeps the look-down angle shallow (about 31 degrees to the vent), so the
  // camera always looks well ahead, toward the horizon.
  const wanted = 6.0 + 2.8 * Math.sin(t * 0.05 + 2.0) + 0.9 * Math.sin(t * 0.13 + 0.5);
  const distance = clamp(Math.max(wanted, height / MAX_HEIGHT_PER_DISTANCE), MIN_DISTANCE, MAX_DISTANCE);
  const x = 2.5 * Math.sin(t * 0.06) + 1.0 * Math.sin(t * 0.17);
  const yaw = 0.22 * Math.sin(t * 0.07 + 0.7) + 0.08 * Math.sin(t * 0.2);
  const fovY = clamp(42 * DEG + 8 * DEG * Math.sin(t * 0.045 + 1.3), MIN_FOV, MAX_FOV);
  // The bottom edge, looking down at the sea, would meet it exactly at the vent with a pitch of
  // atan(height / distance) - fov / 2. A little more than that (0..4 degrees) brings the edge in front of the vent.
  const extra = (2 + 2 * Math.sin(t * 0.09 + 0.2)) * DEG;
  // Never less than MIN_PITCH_DOWN; more pitch only brings the bottom edge nearer, so the rule above still holds.
  const pitchDown = Math.max(MIN_PITCH_DOWN, Math.atan2(height, distance) - fovY / 2 + extra);

  const eye: Vec3 = [x, height, ventZ + distance];
  const cp = Math.cos(pitchDown);
  const look: Vec3 = [
    eye[0] + Math.sin(yaw) * cp * LOOK_REACH,
    eye[1] - Math.sin(pitchDown) * LOOK_REACH,
    eye[2] - Math.cos(yaw) * cp * LOOK_REACH,
  ];
  return { eye, look, fovY, distance, height };
}

/**
 * How far from the camera, along the view, the bottom edge of the frame meets the sea (height 0). The path keeps this
 * at or below `distance`, the distance to the vent.
 */
export function bottomEdgeReach(camera: TerrainCamera): number {
  const dx = camera.look[0] - camera.eye[0];
  const dy = camera.look[1] - camera.eye[1];
  const dz = camera.look[2] - camera.eye[2];
  const pitchDown = Math.atan2(-dy, Math.hypot(dx, dz));
  const below = pitchDown + camera.fovY / 2;
  return camera.height / Math.tan(below);
}
