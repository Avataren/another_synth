/**
 * A MOD note has to come out of the sampler at the PAL Paula rate.
 *
 * ProTracker is a PAL Amiga program: period p plays a sample at
 * `3546895 / p` Hz, and that is what OpenMPT, libopenmpt and a real Amiga
 * all produce. Rendering a one-cycle sine MOD at period 428 through
 * libopenmpt measures 258.976 Hz against the 258.973 that rate predicts, so
 * the constant is not a matter of taste.
 *
 * Nothing in the app plays a MOD in one step, though: the pitch model turns
 * the period into "musical Hz" (the Paula rate over PAULA_TO_SYNTH_SCALE),
 * and the sampler turns that back into a playback rate over a buffer
 * declared at 44100 -- `playbackRate = frequency / f(rootNote)`, see
 * `calculatePlaybackRate` in sampler-instrument.ts. Only the *product* of
 * those two halves is audible, which is how they drifted apart: an NTSC
 * clock in the pitch model against a hand-fitted root note of 65 in the
 * importer left every module 7.6 cents flat, "a bit off compared to the
 * original".
 *
 * So this asserts the product, end to end, rather than either half.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  AMIGA_CLOCK,
  PAULA_TO_SYNTH_SCALE,
  buildModTrackerSamples,
  parseMod,
} from '@another-synth/tracker-playback';

/** Paula's rate on a PAL Amiga is this over the period. */
const PAL_PAULA_CLOCK = 3546895;

/** C-1, C-2, C-3 and the two ends of ProTracker's table. */
const PERIODS = [856, 428, 214, 113, 480, 404];

function firstSample() {
  const buf = fs.readFileSync(
    path.resolve(__dirname, '../../public/demos/amiga/to the beach.mod'),
  );
  const { samples } = buildModTrackerSamples(parseMod(new Uint8Array(buf)));
  const sample = samples[0];
  expect(sample).toBeDefined();
  return sample!;
}

/** What the sampler will clock the buffer out at, for a written period. */
function playbackRateHz(
  sample: ReturnType<typeof firstSample>,
  period: number,
): number {
  const frequency = AMIGA_CLOCK / (2 * period * PAULA_TO_SYNTH_SCALE);
  const rootFrequency = 440 * Math.pow(2, (sample.rootNote - 69) / 12);
  const detuneRatio = Math.pow(2, (sample.detuneCents ?? 0) / 1200);
  return sample.sampleRate * (frequency / rootFrequency) * detuneRatio;
}

describe('MOD tuning', () => {
  it('plays every period at the PAL Paula rate', () => {
    const sample = firstSample();
    // The song's samples are all finetune 0, so nothing else is in play.
    expect(sample.detuneCents).toBe(0);

    for (const period of PERIODS) {
      const cents =
        1200 *
        Math.log2(playbackRateHz(sample, period) / (PAL_PAULA_CLOCK / period));
      expect(cents).toBeCloseTo(0, 6);
    }
  });

  it('is not running on the NTSC clock', () => {
    // The regression this file exists for: 7159090.5 is the NTSC colour
    // clock, a quarter-tone (23.4 cents) above PAL.
    const cents = 1200 * Math.log2(7159090.5 / AMIGA_CLOCK);
    expect(cents).toBeCloseTo(15.86, 2);
    expect(AMIGA_CLOCK).toBe(PAL_PAULA_CLOCK * 2);
  });
});
