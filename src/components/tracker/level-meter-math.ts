/**
 * The arithmetic behind the stereo level meter, kept out of the SFC so it can
 * be tested without a DOM or an AudioContext.
 *
 * The meter exists to answer one question -- did the mix go past full scale --
 * so the parts worth pinning are the ones that could be quietly wrong while
 * still looking plausible: where 0 dB lands on the bar, and what counts as an
 * over.
 */

/** Bottom of the meter. Anything below this reads as silence. */
export const MIN_DB = -48;

/** Top of the meter. Above 0 deliberately, so overs have somewhere to go. */
export const MAX_DB = 6;

/** Sample magnitude at or above which the mix has clipped. */
export const CLIP_AMPLITUDE = 1;

/** Where a level sits on the bar, 0 at the floor and 100 at the top. */
export function dbToPercent(db: number): number {
  const clamped = Math.max(MIN_DB, Math.min(MAX_DB, db));
  return ((clamped - MIN_DB) / (MAX_DB - MIN_DB)) * 100;
}

export function amplitudeToDb(amplitude: number): number {
  return amplitude > 0 ? 20 * Math.log10(amplitude) : -Infinity;
}

/**
 * The largest magnitude in a block.
 *
 * True sample peak rather than RMS: an RMS reading averages a brief over away,
 * which is exactly the event this meter is for.
 */
export function peakMagnitude(samples: ArrayLike<number>): number {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const magnitude = Math.abs(samples[i] as number);
    if (magnitude > peak) peak = magnitude;
  }
  return peak;
}

/**
 * Advance a displayed level toward a new reading.
 *
 * Rises are instant -- a meter that eases upward under-reads a transient,
 * which for a peak meter is the one thing it must not do -- and falls are
 * time-based so the rate is independent of frame rate.
 */
export function decayTowards(
  currentDb: number,
  targetDb: number,
  fallDbPerSecond: number,
  deltaSeconds: number,
): number {
  if (targetDb > currentDb) return targetDb;
  return Math.max(targetDb, currentDb - fallDbPerSecond * deltaSeconds);
}

/** Formats the numeric readout under the bars. */
export function formatPeakLabel(amplitude: number): string {
  const db = amplitudeToDb(amplitude);
  if (db === -Infinity || db < MIN_DB) return '-inf';
  return `${db > 0 ? '+' : ''}${db.toFixed(1)}`;
}
