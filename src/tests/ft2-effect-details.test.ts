import { describe, it, expect } from 'vitest';
import {
  createTrackEffectState,
  processEffectTick0,
  processEffectTickN,
  resetEffectStateForNote,
  type ProcessorCommand,
  type TrackEffectState,
} from '../../packages/tracker-playback/src/effect-processor';
import {
  PROTRACKER_PROFILE,
  XM_PROFILE,
} from '../../packages/tracker-playback/src/format-profile';
import { parseEffectCommand } from 'src/audio/tracker/note-utils';
import type { EffectCommand } from '../../packages/tracker-playback/src/types';

/**
 * The smaller FastTracker 2 behaviours: parameter memories, the waveform
 * commands' "don't retrigger" bit, tremor's continuous counter, and Xxy.
 */

const PERIOD_C2 = 428;
const freqOf = (period: number) =>
  PROTRACKER_PROFILE.pitch.frequencyFromPeriod(period);

function ptState(): TrackEffectState {
  return createTrackEffectState(PROTRACKER_PROFILE);
}

const volumesOf = (commands: ProcessorCommand[]) =>
  commands.filter((c) => c.kind === 'volume').map((c) => c.volume);

describe('E4x / E7x waveform retrigger bit', () => {
  it('restarts the vibrato waveform on a new note for values 0-3', () => {
    const state = ptState();
    processEffectTick0(state, {
      type: 'setVibratoWave',
      paramX: 4,
      paramY: 1,
      extSubtype: 'vibratoWave',
    });
    state.vibratoPos = 40;

    resetEffectStateForNote(state);

    expect(state.vibratoWaveform).toBe(1);
    expect(state.vibratoPos).toBe(0);
  });

  it('carries the waveform position across notes for values 4-7', () => {
    // Bit 2 selects the same three waveforms but asks for the position to be
    // kept. Masking the parameter with & 3 threw that choice away.
    const state = ptState();
    processEffectTick0(state, {
      type: 'setVibratoWave',
      paramX: 4,
      paramY: 5,
      extSubtype: 'vibratoWave',
    });
    state.vibratoPos = 40;

    resetEffectStateForNote(state);

    expect(state.vibratoWaveform).toBe(1);
    expect(state.vibratoPos).toBe(40);
  });

  it('applies the same bit to the tremolo waveform', () => {
    const state = ptState();
    processEffectTick0(state, {
      type: 'setTremoloWave',
      paramX: 7,
      paramY: 6,
      extSubtype: 'tremoloWave',
    });
    state.tremoloPos = 12;

    resetEffectStateForNote(state);

    expect(state.tremoloWaveform).toBe(2);
    expect(state.tremoloPos).toBe(12);
  });
});

describe('Rxy retrigger parameter memory', () => {
  const retrig = (x: number, y: number): EffectCommand => ({
    type: 'retrigVol',
    paramX: x,
    paramY: y,
  });

  it('remembers each nibble independently', () => {
    const state = ptState();
    processEffectTick0(state, retrig(0, 3), 60, 255, freqOf(PERIOD_C2), 6);
    expect(state.retriggerInterval).toBe(3);

    // R80 changes the volume change but keeps the interval.
    processEffectTick0(state, retrig(8, 0), undefined, undefined, undefined, 6);
    expect(state.retriggerInterval).toBe(3);
    expect(state.retriggerVolChange).toBe(8);
  });

  it('repeats the whole remembered command for R00', () => {
    const state = ptState();
    processEffectTick0(state, retrig(2, 4), 60, 255, freqOf(PERIOD_C2), 6);
    processEffectTick0(state, retrig(0, 0), undefined, undefined, undefined, 6);

    expect(state.retriggerInterval).toBe(4);
    expect(state.retriggerVolChange).toBe(2);
  });

  it('gives E9x no memory of its own', () => {
    // E9x is a plain "retrigger every x ticks" with no volume change and no
    // parameter memory, so it must not read or write Rxy's.
    const state = ptState();
    processEffectTick0(state, retrig(2, 4), 60, 255, freqOf(PERIOD_C2), 6);
    processEffectTick0(
      state,
      {
        type: 'retrigVol',
        paramX: 9,
        paramY: 0,
        extSubtype: 'retrigger',
      },
      undefined,
      undefined,
      undefined,
      6,
    );

    expect(state.retriggerInterval).toBe(0);
    expect(state.retriggerVolChange).toBe(0);
    expect(state.lastRetrigger).toBe((2 << 4) | 4);
  });
});

describe('Txy tremor', () => {
  const tremor = (x: number, y: number): EffectCommand => ({
    type: 'tremor',
    paramX: x,
    paramY: y,
  });

  it('counts continuously across rows rather than restarting each row', () => {
    // T11: two ticks on, two off. At speed 6 a row covers ticks 1..5, so the
    // cycle should carry into the next row mid-phase rather than starting over
    // on the "on" phase every time.
    const state = ptState();
    state.currentVolume = 1;
    const command = tremor(1, 1);

    const run = () => {
      processEffectTick0(state, command, undefined, undefined, undefined, 6);
      const seen: number[] = [];
      for (let tick = 1; tick < 6; tick++) {
        seen.push(...volumesOf(processEffectTickN(state, command, tick, 6).commands));
      }
      return seen;
    };

    expect(run()).toEqual([1, 1, 0, 0, 1]);
    // Deriving the phase from the tick index would repeat the first row here.
    expect(run()).toEqual([1, 0, 0, 1, 1]);
  });

  it('reuses the last parameter for T00', () => {
    const state = ptState();
    state.currentVolume = 1;
    processEffectTick0(state, tremor(3, 1), undefined, undefined, undefined, 6);
    expect(state.lastTremor).toBe(0x31);

    processEffectTick0(state, tremor(0, 0), undefined, undefined, undefined, 6);
    // 4 ticks on, 2 off, continuing from where the first row left off.
    state.tremorPos = 0;
    const seen: number[] = [];
    for (let tick = 1; tick < 7; tick++) {
      seen.push(...volumesOf(processEffectTickN(state, tremor(0, 0), tick, 7).commands));
    }
    expect(seen).toEqual([1, 1, 1, 1, 0, 0]);
  });
});

describe('Xxy extra fine portamento', () => {
  it('parses as an effect rather than being dropped', () => {
    // XM numbers it 0x21, which xmEffectToMacro writes as the letter X.
    expect(parseEffectCommand('X13')).toEqual({
      type: 'effect',
      effect: { type: 'extraFinePorta', paramX: 1, paramY: 3 },
    });
  });

  it('moves a quarter as far as E1x for the same parameter', () => {
    const fine = createTrackEffectState(XM_PROFILE);
    processEffectTick0(
      fine,
      { type: 'finePortaUp', paramX: 1, paramY: 4, extSubtype: 'finePortaUp' },
      60,
      255,
      XM_PROFILE.pitch.frequencyFromPeriod(4608),
      6,
    );
    // E1x uses the format's portamento scale, which is 4 for XM.
    expect(fine.currentPeriod).toBeCloseTo(4608 - 16, 4);

    const extra = createTrackEffectState(XM_PROFILE);
    processEffectTick0(
      extra,
      { type: 'extraFinePorta', paramX: 1, paramY: 4 },
      60,
      255,
      XM_PROFILE.pitch.frequencyFromPeriod(4608),
      6,
    );
    expect(extra.currentPeriod).toBeCloseTo(4608 - 4, 4);
  });

  it('slides down for x=2', () => {
    const state = createTrackEffectState(XM_PROFILE);
    processEffectTick0(
      state,
      { type: 'extraFinePorta', paramX: 2, paramY: 4 },
      60,
      255,
      XM_PROFILE.pitch.frequencyFromPeriod(4608),
      6,
    );
    expect(state.currentPeriod).toBeCloseTo(4608 + 4, 4);
  });
});
