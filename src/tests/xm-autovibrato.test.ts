import { describe, it, expect, vi } from 'vitest';
import { importXmToTrackerSong } from 'src/audio/tracker/xm-import';
import { deserializePatch } from 'src/audio/serialization/patch-serializer';
import ModInstrument from 'src/audio/mod-instrument';
import { buildXm, cell } from './helpers/xm-builder';
import { createXmAmigaPitchModel, type PitchModel } from '../../packages/tracker-playback/src/pitch-model';
import { TrackerSongBank } from 'src/audio/tracker/song-bank';
import type AudioSystem from 'src/audio/AudioSystem';

/**
 * XM instrument-level ("auto") vibrato.
 *
 * A property of the instrument, not of the pattern: every note it plays
 * wobbles without any 4xy in the song. 20 of the 219 instruments in the local
 * XM corpus declare one and they account for 13.4% of all played notes, which
 * until now played dead straight.
 *
 * It is driven as an LFO on the source's `detune`, which is a separate
 * AudioParam from `playbackRate`. That is what lets it compose with the
 * channel's own pitch automation -- portamento, 4xy, arpeggio -- instead of
 * the two overwriting each other.
 */

function importWithVibrato(
  autoVibrato: { type?: number; sweep?: number; depth?: number; rate?: number },
) {
  const song = importXmToTrackerSong(
    buildXm({
      numChannels: 1,
      instruments: [{ samples: [{ frames: [0, 1, 0, -1] }], autoVibrato }],
      patterns: [{ numRows: 1, cells: [[cell(49, { instrument: 1 })]] }],
    }).buffer as ArrayBuffer,
  );
  const patch = Object.values(song.data.songPatches!)[0]!;
  // Through the normalizer, not the raw patch: it rebuilds sampler state from
  // an explicit field list, and anything not named there is silently dropped
  // -- which is exactly what happened to the volume envelope once (D34).
  return [...deserializePatch(patch).samplers.values()][0]!;
}

describe('XM autovibrato survives import', () => {
  it('carries every field through the patch normalizer', () => {
    const sampler = importWithVibrato({
      type: 2,
      sweep: 40,
      depth: 12,
      rate: 30,
    });

    expect(sampler.trackerAutoVibrato).toEqual({
      type: 2,
      sweepTicks: 40,
      depth: 12,
      rate: 30,
    });
  });

  it('carries nothing for an instrument that asks for none', () => {
    // Depth 0 means no vibrato however the other fields read, so those
    // instruments should not carry the extra state at all.
    expect(importWithVibrato({ depth: 0, rate: 30 }).trackerAutoVibrato)
      .toBeUndefined();
    expect(importWithVibrato({ depth: 12, rate: 0 }).trackerAutoVibrato)
      .toBeUndefined();
  });
});

interface FakeParam {
  value: number;
  setValueAtTime: ReturnType<typeof vi.fn>;
  linearRampToValueAtTime: ReturnType<typeof vi.fn>;
  cancelScheduledValues: ReturnType<typeof vi.fn>;
}

function makeParam(value = 0): FakeParam {
  return {
    value,
    setValueAtTime: vi.fn(),
    linearRampToValueAtTime: vi.fn(),
    cancelScheduledValues: vi.fn(),
  };
}

/** A ModInstrument whose graph is observable, with `sampleRate` Hz of buffer. */
function makeInstrument(
  autoVibrato?: {
    type: number;
    sweepTicks: number;
    depth: number;
    rate: number;
  },
  options?: { pitchModel?: PitchModel },
) {
  const oscillators: Array<{
    type: string;
    frequency: FakeParam;
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
  }> = [];
  const detune = makeParam();
  const gains: Array<{ gain: FakeParam }> = [];

  const audioContext = {
    currentTime: 0,
    createBufferSource: () => ({
      buffer: null as unknown,
      loop: false,
      loopStart: 0,
      loopEnd: 0,
      playbackRate: makeParam(1),
      detune,
      connect: vi.fn(),
      disconnect: vi.fn(),
      stop: vi.fn(),
      start: vi.fn(),
      onended: null as unknown,
    }),
    createGain: () => {
      const node = {
        gain: makeParam(1),
        connect: vi.fn(),
        disconnect: vi.fn(),
      };
      gains.push(node);
      return node;
    },
    createOscillator: () => {
      const osc = {
        type: 'sine',
        frequency: makeParam(),
        start: vi.fn(),
        stop: vi.fn(),
        connect: vi.fn(),
        disconnect: vi.fn(),
      };
      oscillators.push(osc);
      return osc;
    },
    createStereoPanner: () => ({
      pan: makeParam(),
      connect: vi.fn(),
      disconnect: vi.fn(),
    }),
  } as unknown as AudioContext;

  const instrument = new ModInstrument(
    { connect: vi.fn() } as unknown as AudioNode,
    audioContext,
    options,
  );
  Reflect.set(instrument as object, 'audioBuffer', {
    duration: 1,
    sampleRate: 8000,
    length: 8000,
  });
  Reflect.set(instrument as object, 'sampleFrames', 8000);
  Reflect.set(instrument as object, 'samplerState', {
    gain: 1,
    loopMode: 0,
    loopStart: 0,
    loopEnd: 1,
    rootNote: 65,
    sampleRate: 8000,
    ...(autoVibrato ? { trackerAutoVibrato: autoVibrato } : {}),
  });
  Reflect.set(instrument as object, 'ready', true);

  return { instrument, oscillators, gains, detune };
}

const TICK = 0.02; // 50 ticks a second

describe('autovibrato runs as an LFO on detune', () => {
  it('starts an oscillator at the rate the instrument asks for', () => {
    // The position advances by `rate` per tick over a 256-step cycle, so a
    // rate of 32 is one cycle per 8 ticks -- 6.25 Hz at 50 ticks a second.
    const { instrument, oscillators } = makeInstrument({
      type: 0,
      sweepTicks: 0,
      depth: 8,
      rate: 32,
    });

    instrument.noteOnAtTime(60, 127, 0, { tickSeconds: TICK });

    expect(oscillators).toHaveLength(1);
    expect(oscillators[0]!.type).toBe('sine');
    expect(oscillators[0]!.frequency.value).toBeCloseTo(32 / (256 * TICK), 6);
    expect(oscillators[0]!.start).toHaveBeenCalled();
  });

  it('scales depth from period units into cents', () => {
    // XM's linear table is 64 period units to a semitone, so a depth of 8 is
    // 8/64 of a semitone -- 12.5 cents.
    const { instrument, gains } = makeInstrument({
      type: 0,
      sweepTicks: 0,
      depth: 8,
      rate: 32,
    });

    instrument.noteOnAtTime(60, 127, 0, { tickSeconds: TICK });

    const depthGain = gains[gains.length - 1]!;
    const [magnitude] = depthGain.gain.setValueAtTime.mock.calls.at(-1)!;
    expect(Math.abs(magnitude as number)).toBeCloseTo(8 * (100 / 64), 6);
  });

  it('ramps the depth in over the sweep', () => {
    const { instrument, gains } = makeInstrument({
      type: 0,
      sweepTicks: 25,
      depth: 8,
      rate: 32,
    });

    instrument.noteOnAtTime(60, 127, 0, { tickSeconds: TICK });

    const depthGain = gains[gains.length - 1]!;
    expect(depthGain.gain.setValueAtTime).toHaveBeenCalledWith(0, 0);
    const [target, when] =
      depthGain.gain.linearRampToValueAtTime.mock.calls.at(-1)!;
    expect(Math.abs(target as number)).toBeCloseTo(8 * (100 / 64), 6);
    expect(when).toBeCloseTo(25 * TICK, 6);
  });

  it('maps the waveform types FT2 defines', () => {
    const shape = (type: number) => {
      const { instrument, oscillators } = makeInstrument({
        type,
        sweepTicks: 0,
        depth: 8,
        rate: 32,
      });
      instrument.noteOnAtTime(60, 127, 0, { tickSeconds: TICK });
      return oscillators[0]!.type;
    };

    expect(shape(0)).toBe('sine');
    expect(shape(1)).toBe('square');
    expect(shape(2)).toBe('sawtooth');
    expect(shape(3)).toBe('sawtooth');
  });

  it('does nothing for an instrument without autovibrato', () => {
    const { instrument, oscillators } = makeInstrument();

    instrument.noteOnAtTime(60, 127, 0, { tickSeconds: TICK });

    expect(oscillators).toHaveLength(0);
  });

  it('schedules the oscillator to stop with the note it belongs to', () => {
    // An oscillator connected to an AudioParam is inaudible, so one that
    // outlived its note would accumulate silently rather than announce itself.
    // The disconnect runs on a timer after the release ramp; the *stop* has to
    // be scheduled with the source regardless of when that timer fires.
    const { instrument, oscillators } = makeInstrument({
      type: 0,
      sweepTicks: 0,
      depth: 8,
      rate: 32,
    });
    const voice = instrument.noteOnAtTime(60, 127, 0, { tickSeconds: TICK })!;

    instrument.cutVoiceAtTime(voice, 0);

    expect(oscillators[0]!.stop).toHaveBeenCalled();
  });
});

/**
 * P4: the depth conversion belongs to the song's pitch model.
 *
 * FT2 adds the vibrato offset to the channel *period* and re-derives the
 * frequency from it (updateVolPanAutoVib, ft2-clone ft2_replayer.c):
 *
 *     autoVibVal = (autoVibVal * (int16_t)autoVibAmp) >> (6+8);
 *     uint16_t tmpPeriod = ch->outPeriod + autoVibVal;
 *     ch->finalPeriod = tmpPeriod;
 *
 * so a depth of N period units is a different musical interval in every
 * representation. The old code multiplied by a hardcoded 100/64 cents-per-unit
 * -- exact for XM's linear table, and roughly 30x too deep for an Amiga-table
 * XM, whose periods near the low notes sit in the tens of thousands. The
 * conversion now lives on the pitch model (D18 pattern) and is evaluated at
 * the voice's own frequency.
 */
describe('autovibrato depth goes through the pitch model (P4)', () => {
  it('stays exactly 100/64 cents per unit on the linear table', () => {
    // The linear default must be unchanged: XM's linear table moves 64 units
    // to a semitone at every pitch, so the old constant was already exact.
    const { instrument, gains } = makeInstrument({
      type: 0,
      sweepTicks: 0,
      depth: 8,
      rate: 32,
    });
    instrument.noteOnAtTime(60, 127, 0, { tickSeconds: TICK });
    const depthGain = gains[gains.length - 1]!;
    const [magnitude] = depthGain.gain.setValueAtTime.mock.calls.at(-1)!;
    expect(Math.abs(magnitude as number)).toBeCloseTo(8 * (100 / 64), 6);
  });

  it('is a pitch-dependent interval on the Amiga table', () => {
    // In FT2's Amiga table the frequency is proportional to 1/period, so a
    // depth-unit wobble around a low note's huge period is a fraction of a
    // cent -- while the hardcoded constant made it 12.5 cents regardless.
    const amiga = createXmAmigaPitchModel();
    const expectedAt = (frequency: number) => {
      // rate = 8363 * 1712 / period, so period = numerator / (frequency * 32).
      const period = (8363 * 1712) / (frequency * 32);
      return 1200 * Math.log2((period + 8) / period);
    };

    const { instrument: low, gains: lowGains } = makeInstrument(
      { type: 0, sweepTicks: 0, depth: 8, rate: 32 },
      { pitchModel: amiga },
    );
    low.noteOnAtTime(60, 127, 0, { tickSeconds: TICK, frequency: 440 });
    const [lowMagnitude] =
      lowGains[lowGains.length - 1]!.gain.setValueAtTime.mock.calls.at(-1)!;
    expect(Math.abs(lowMagnitude as number)).toBeCloseTo(expectedAt(440), 6);

    const { instrument: high, gains: highGains } = makeInstrument(
      { type: 0, sweepTicks: 0, depth: 8, rate: 32 },
      { pitchModel: amiga },
    );
    high.noteOnAtTime(72, 127, 0, { tickSeconds: TICK, frequency: 880 });
    const [highMagnitude] =
      highGains[highGains.length - 1]!.gain.setValueAtTime.mock.calls.at(-1)!;
    expect(Math.abs(highMagnitude as number)).toBeCloseTo(expectedAt(880), 6);
    // The same depth wobbles twice the interval an octave up: the conversion
    // is evaluated at the voice's own pitch, not a constant.
    expect(
      Math.abs(highMagnitude as number) / Math.abs(lowMagnitude as number),
    ).toBeCloseTo(2, 1);
  });

  it('does not apply the old linear constant on the Amiga table', () => {
    // The regression this test exists for: on FT2's Amiga table the period
    // halves every octave, so the same depth wobbles a wider interval the
    // higher the note. Around A4 (period ~1017) depth 8 is ~13.6 cents, not
    // the hardcoded 12.5; the error compounds with pitch, which is what the
    // hardcoded constant could never track.
    const amiga = createXmAmigaPitchModel();
    const { instrument, gains } = makeInstrument(
      { type: 0, sweepTicks: 0, depth: 8, rate: 32 },
      { pitchModel: amiga },
    );
    instrument.noteOnAtTime(60, 127, 0, { tickSeconds: TICK, frequency: 440 });
    const [magnitude] =
      gains[gains.length - 1]!.gain.setValueAtTime.mock.calls.at(-1)!;
    expect(Math.abs(magnitude as number)).toBeCloseTo(13.566, 2);
    expect(Math.abs(magnitude as number)).not.toBeCloseTo(8 * (100 / 64), 1);
  });

  it('reaches the bank per format, so module songs get their model', () => {
    const bank = new TrackerSongBank(
      {
        audioContext: {
          sampleRate: 48000,
          currentTime: 0,
          state: 'running' as const,
          createGain: () => ({ gain: { value: 1 }, connect: vi.fn() }),
          destination: { connect: vi.fn() },
        },
        destinationNode: { connect: vi.fn() },
      } as unknown as AudioSystem,
    );

    const kind = () =>
      (
        Reflect.get(bank as object, 'formatProfile') as {
          pitch: { kind: string };
        }
      ).pitch.kind;

    bank.setModuleFormat('xm', true);
    expect(kind()).toBe('linear');
    bank.setModuleFormat('xm', false);
    expect(kind()).toBe('amiga');
  });
});
