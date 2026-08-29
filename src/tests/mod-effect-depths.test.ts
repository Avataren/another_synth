import { describe, it, expect } from 'vitest';
import {
  createTrackEffectState,
  processEffectTick0,
  processEffectTickN,
  type TrackEffectState,
} from '../../packages/tracker-playback/src/effect-processor';
import {
  PROTRACKER_PROFILE,
  XM_PROFILE,
} from '../../packages/tracker-playback/src/format-profile';
import type { EffectCommand } from '../../packages/tracker-playback/src/types';

/**
 * Depth and unit calibration for the effects ProTracker defines in *period*
 * and *volume* units rather than musically.
 *
 * Each of these was implemented as a fixed musical amount -- a fraction of a
 * semitone, or a fraction of full volume -- which is not what the trackers do
 * and, for vibrato, is not even a constant error: a period-domain deviation
 * covers a wider musical interval the lower the note.
 */

const PERIOD_C2 = 428;
const pitch = PROTRACKER_PROFILE.pitch;
const freqOf = (period: number) => pitch.frequencyFromPeriod(period);

/** The period a pitch command lands on, for comparison against ProTracker. */
function periodOfLastPitch(commands: { kind: string }[]): number {
  const pitches = commands.filter((c) => c.kind === 'pitch');
  const last = pitches[pitches.length - 1] as
    | { frequency: number }
    | undefined;
  if (!last) throw new Error('no pitch command emitted');
  return pitch.rawPeriodFromFrequency(last.frequency);
}

function stateOnC2(): TrackEffectState {
  return createTrackEffectState(PROTRACKER_PROFILE);
}

/** Start a note at C-2 (period 428) carrying `effect`. */
function startNote(state: TrackEffectState, effect: EffectCommand) {
  return processEffectTick0(state, effect, 60, 255, freqOf(PERIOD_C2), 6);
}

describe('vibrato depth is measured in period units', () => {
  it('swings the period by (255 * depth) / 128', () => {
    const state = stateOnC2();
    // Square waveform so the deviation is exactly the peak, with no sine
    // rounding to reason about.
    state.vibratoWaveform = 2;

    startNote(state, { type: 'vibrato', paramX: 4, paramY: 8 });
    const { commands } = processEffectTickN(
      state,
      { type: 'vibrato', paramX: 4, paramY: 8 },
      1,
      6,
    );

    // ProTracker: periodDelta = table(255 at peak) * depth / 128 = 15.9375,
    // and a positive waveform value raises the pitch, i.e. lowers the period.
    expect(periodOfLastPitch(commands)).toBeCloseTo(PERIOD_C2 - 15.9375, 4);
  });

  it('covers a wider interval on a lower note, as a period deviation does', () => {
    // The old semitone-based formula gave the same musical width at every
    // pitch. A fixed period swing does not: an octave down is twice the
    // period, so the same +-15.9375 is half the musical distance.
    const low = stateOnC2();
    low.vibratoWaveform = 2;
    const lowPeriod = PERIOD_C2 * 2; // C-1
    processEffectTick0(
      low,
      { type: 'vibrato', paramX: 4, paramY: 8 },
      48,
      255,
      freqOf(lowPeriod),
      6,
    );
    const { commands } = processEffectTickN(
      low,
      { type: 'vibrato', paramX: 4, paramY: 8 },
      1,
      6,
    );

    expect(periodOfLastPitch(commands)).toBeCloseTo(lowPeriod - 15.9375, 4);
  });

  it('does not disturb the channel pitch itself', () => {
    // Vibrato is a deviation around the note, not a slide: the next tick must
    // swing from the original period, not from the previous tick's.
    const state = stateOnC2();
    state.vibratoWaveform = 2;
    startNote(state, { type: 'vibrato', paramX: 4, paramY: 8 });
    processEffectTickN(state, { type: 'vibrato', paramX: 4, paramY: 8 }, 1, 6);

    expect(state.currentPeriod).toBeCloseTo(PERIOD_C2, 6);
  });
});

describe('tremolo depth is measured in volume units', () => {
  it('swings volume by (255 * depth) / 64 of 64', () => {
    const state = stateOnC2();
    state.tremoloWaveform = 2;
    state.currentVolume = 0.5;

    processEffectTick0(state, { type: 'tremolo', paramX: 4, paramY: 4 }, 60, undefined, freqOf(PERIOD_C2), 6);
    const { commands } = processEffectTickN(
      state,
      { type: 'tremolo', paramX: 4, paramY: 4 },
      1,
      6,
    );

    const volume = commands.find((c) => c.kind === 'volume') as
      | { volume: number }
      | undefined;
    // 255 * 4 / 64 = 15.9375 volume units out of 64 = 0.2490 of full scale.
    // The old code dropped the table's 255 peak and produced 4/64 = 0.0625,
    // a quarter of the depth, which is why tremolo was barely audible.
    expect(volume?.volume).toBeCloseTo(0.5 + 15.9375 / 64, 5);
  });
});

describe('fine portamento is measured in period units', () => {
  it('E1x subtracts x from the period', () => {
    const state = stateOnC2();
    const { commands } = startNote(state, {
      type: 'finePortaUp',
      paramX: 1,
      paramY: 3,
      extSubtype: 'finePortaUp',
    });

    expect(periodOfLastPitch(commands)).toBeCloseTo(PERIOD_C2 - 3, 4);
  });

  it('E2x adds x to the period', () => {
    const state = stateOnC2();
    const { commands } = startNote(state, {
      type: 'finePortaDown',
      paramX: 2,
      paramY: 3,
      extSubtype: 'finePortaDown',
    });

    expect(periodOfLastPitch(commands)).toBeCloseTo(PERIOD_C2 + 3, 4);
  });
});

describe('ECx note cut zeroes the volume rather than releasing the note', () => {
  it('emits volume 0 at the cut tick and no note-off', () => {
    const state = stateOnC2();
    startNote(state, { type: 'noteCut', paramX: 0xc, paramY: 2, extSubtype: 'noteCut' });

    const early = processEffectTickN(
      state,
      { type: 'noteCut', paramX: 0xc, paramY: 2, extSubtype: 'noteCut' },
      1,
      6,
    );
    expect(early.commands).toHaveLength(0);

    const cut = processEffectTickN(
      state,
      { type: 'noteCut', paramX: 0xc, paramY: 2, extSubtype: 'noteCut' },
      2,
      6,
    );
    // A note-off would run the release path -- on XM, the instrument's volume
    // fadeout, which can last seconds where ProTracker stops dead.
    expect(cut.commands.find((c) => c.kind === 'noteOff')).toBeUndefined();
    const volume = cut.commands.find((c) => c.kind === 'volume') as
      | { volume: number }
      | undefined;
    expect(volume?.volume).toBe(0);
    expect(state.currentVolume).toBe(0);
  });

  it('cuts immediately on EC0', () => {
    const state = stateOnC2();
    const { commands } = startNote(state, {
      type: 'noteCut',
      paramX: 0xc,
      paramY: 0,
      extSubtype: 'noteCut',
    });

    expect(commands.find((c) => c.kind === 'noteOff')).toBeUndefined();
    const volumes = commands.filter((c) => c.kind === 'volume') as {
      volume: number;
    }[];
    expect(volumes[volumes.length - 1]?.volume).toBe(0);
  });
});

describe('E5x finetune follows the format convention', () => {
  const finetuneEffect = (nibble: number): EffectCommand => ({
    type: 'extEffect',
    paramX: 5,
    paramY: nibble,
    extSubtype: 'setFinetune',
  });

  /** Cents the note ended up away from where it started. */
  function centsShift(profile: typeof PROTRACKER_PROFILE, nibble: number) {
    const state = createTrackEffectState(profile);
    const base = profile.pitch.frequencyFromPeriod(
      profile.format === 'xm' ? 1712 : PERIOD_C2,
    );
    const { commands } = processEffectTick0(
      state,
      finetuneEffect(nibble),
      60,
      255,
      base,
      6,
    );
    const pitches = commands.filter((c) => c.kind === 'pitch');
    const last = pitches[pitches.length - 1] as { frequency: number };
    return 1200 * Math.log2(last.frequency / base);
  }

  it('reads the nibble as signed eighths of a semitone on ProTracker', () => {
    // 0-7 tune up, 8-15 tune down.
    expect(centsShift(PROTRACKER_PROFILE, 1)).toBeCloseTo(12.5, 3);
    expect(centsShift(PROTRACKER_PROFILE, 6)).toBeCloseTo(75, 3);
    expect(centsShift(PROTRACKER_PROFILE, 15)).toBeCloseTo(-12.5, 3);
  });

  it('reads the nibble as a position in FT2 finetune on XM', () => {
    // finetune = x*16 - 128, and 128 units is a semitone, so 8 is neutral.
    // Reading these ProTracker-style put them a full semitone sharp -- which
    // is what happened to all 840 E5x commands in the local XM corpus, every
    // one of which uses nibble 1 or 6.
    expect(centsShift(XM_PROFILE, 1)).toBeCloseTo(-87.5, 3);
    expect(centsShift(XM_PROFILE, 6)).toBeCloseTo(-25, 3);
    expect(centsShift(XM_PROFILE, 8)).toBeCloseTo(0, 3);
  });
});
