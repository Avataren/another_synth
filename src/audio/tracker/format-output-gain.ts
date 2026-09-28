import type { ModuleFormat } from '@another-synth/tracker-playback';

/**
 * A fixed level trim per playback format, so one master-volume setting suits
 * every kind of song.
 *
 * Each format reaches the mix bus at its own natural level, and they differ a
 * lot. A sampler channel at full volume is full scale (centred: -3 dB a
 * side), and a module sums 4 to 32 of them, so MOD, XM and S3M run far past
 * full scale. The chip formats come out of their emulators already mixed to
 * 16 bits (AHX/HVL, OPL) or a 3-voice chip (SID), well under it.
 *
 * Measured pre-limiter, 50 s from the start of each song, user volume at 1
 * (136 demos; `.ai/format-gain-sweep.md`). Loudness is the mean of the
 * 400 ms blocks within 10 dB of the song's mean, in dBFS:
 *
 *   format          n   peak (median)  99.9th pct (median)  loudness (median)
 *   MOD 4ch        15      +4.6            +2.0                 -9.6
 *   MOD >4ch        2     +11.5            +8.1                 -3.1
 *   XM             18      +8.0            +3.5                 -9.0
 *   S3M            20      +8.2            +3.9                 -9.9
 *   S3M AdLib      14      +4.9            +1.9                 -8.9
 *   A2M            27      -0.4            -3.0                -13.5
 *   AHX/HVL        14      -1.1            -3.0                -13.0
 *   SID (PSID/GT)  26      -3.2            -6.2                -17.4
 *
 * The trims put a typical song's 99.9th percentile just under the limiter's
 * -1.5 dBFS ceiling, so the limiter only catches transients, and bring the
 * medians within about 3 dB of each other (-13 to -16).
 */
const FORMAT_TRIM_DB: Record<ModuleFormat, number> = {
  // Songs authored here: their level is whatever the patches say.
  native: 0,
  protracker: -4,
  xm: -6,
  // Samples and AdLib alike: both measured about 6 dB over.
  s3m: -6,
  ahx: 0,
  a2m: 0,
  sid: 3,
};

/**
 * A MOD with more than Paula's four channels comes from a PC tracker (6CHN,
 * 8CHN, xxCH) and is mixed like one: its channels are centred and there are
 * more of them, so it takes XM's trim, not ProTracker's.
 */
const MULTICHANNEL_MOD_TRIM_DB = -6;

/** The linear gain for a song of `format` with `trackCount` tracks. */
export function formatOutputGain(
  format: ModuleFormat | undefined,
  trackCount: number,
): number {
  const db =
    format === 'protracker' && trackCount > 4
      ? MULTICHANNEL_MOD_TRIM_DB
      : FORMAT_TRIM_DB[format ?? 'native'];
  return 10 ** (db / 20);
}
