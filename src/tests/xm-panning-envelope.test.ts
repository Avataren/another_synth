import { describe, it, expect, vi } from 'vitest';
import { importXmToTrackerSong } from 'src/audio/tracker/xm-import';
import { deserializePatch } from 'src/audio/serialization/patch-serializer';
import ModInstrument from 'src/audio/mod-instrument';
import { parseEffectCommand } from 'src/audio/tracker/note-utils';
import {
  createTrackEffectState,
  processEffectTick0,
} from '@another-synth/tracker-playback';
import { XM_PROFILE } from '@another-synth/tracker-playback';
import { buildXm, cell } from './helpers/xm-builder';

/**
 * XM panning envelopes, and Lxx.
 *
 * FastTracker 2 does not treat the panning envelope as a position: it is an
 * *offset* around the channel's own pan, scaled by the room that pan leaves,
 * so an envelope can never push a channel past the edge of the field. That is
 * why it cannot simply be scheduled onto the pan parameter and forgotten --
 * a mid-note pan command changes the base the whole remaining envelope is
 * measured from.
 */

function importWithPanEnvelope(points: Array<[number, number]>) {
  const song = importXmToTrackerSong(
    buildXm({
      numChannels: 1,
      instruments: [
        {
          samples: [{ frames: [0, 1, 0, -1] }],
          panningEnvelope: { points, type: 1 },
        },
      ],
      patterns: [{ numRows: 1, cells: [[cell(49, { instrument: 1 })]] }],
    }).buffer as ArrayBuffer,
  );
  const patch = Object.values(song.data.songPatches!)[0]!;
  // Through the normalizer: it rebuilds sampler state from an explicit field
  // list and silently drops anything unnamed (D34, D57).
  return [...deserializePatch(patch).samplers.values()][0]!;
}

describe('the panning envelope survives import', () => {
  it('carries its points through the patch normalizer', () => {
    const sampler = importWithPanEnvelope([
      [0, 0],
      [10, 64],
    ]);

    expect(sampler.trackerPanEnvelope?.points).toEqual([
      { tick: 0, value: 0 },
      { tick: 10, value: 64 },
    ]);
  });

  it('carries nothing when the instrument does not enable one', () => {
    const song = importXmToTrackerSong(
      buildXm({
        numChannels: 1,
        instruments: [{ samples: [{ frames: [0, 1, 0, -1] }] }],
        patterns: [{ numRows: 1, cells: [[cell(49, { instrument: 1 })]] }],
      }).buffer as ArrayBuffer,
    );
    const patch = Object.values(song.data.songPatches!)[0]!;
    const sampler = [...deserializePatch(patch).samplers.values()][0]!;

    expect(sampler.trackerPanEnvelope).toBeUndefined();
  });
});

interface FakeParam {
  value: number;
  setValueAtTime: ReturnType<typeof vi.fn>;
  linearRampToValueAtTime: ReturnType<typeof vi.fn>;
  cancelScheduledValues: ReturnType<typeof vi.fn>;
}

const makeParam = (value = 0): FakeParam => ({
  value,
  setValueAtTime: vi.fn(),
  linearRampToValueAtTime: vi.fn(),
  cancelScheduledValues: vi.fn(),
});

function makeInstrument(state: Record<string, unknown>) {
  const panners: Array<{ pan: FakeParam }> = [];
  const gains: Array<{ gain: FakeParam }> = [];
  const audioContext = {
    currentTime: 0,
    createBufferSource: () => ({
      buffer: null as unknown,
      loop: false,
      loopStart: 0,
      loopEnd: 0,
      playbackRate: makeParam(1),
      detune: makeParam(),
      connect: vi.fn(),
      disconnect: vi.fn(),
      stop: vi.fn(),
      start: vi.fn(),
      onended: null as unknown,
    }),
    createGain: () => {
      const node = { gain: makeParam(1), connect: vi.fn(), disconnect: vi.fn() };
      gains.push(node);
      return node;
    },
    createStereoPanner: () => {
      const node = { pan: makeParam(), connect: vi.fn(), disconnect: vi.fn() };
      panners.push(node);
      return node;
    },
    createOscillator: () => ({
      type: 'sine',
      frequency: makeParam(),
      start: vi.fn(),
      stop: vi.fn(),
      connect: vi.fn(),
      disconnect: vi.fn(),
    }),
  } as unknown as AudioContext;

  const instrument = new ModInstrument(
    { connect: vi.fn() } as unknown as AudioNode,
    audioContext,
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
    ...state,
  });
  Reflect.set(instrument as object, 'ready', true);
  return { instrument, panners, gains };
}

const TICK = 0.02;
/** Hard-left to hard-right over 10 ticks. */
const SWEEP = {
  points: [
    { tick: 0, value: 0 },
    { tick: 10, value: 64 },
  ],
  sustainPoint: -1,
  loopStart: 0,
  loopEnd: 0,
  loopEnabled: false,
};

describe('the panning envelope offsets the channel pan', () => {
  it('sweeps the full field from a centred channel', () => {
    const { instrument, panners } = makeInstrument({
      trackerPanEnvelope: SWEEP,
    });

    instrument.noteOnAtTime(60, 127, 0, { pan: 0.5, tickSeconds: TICK });

    const pan = panners[panners.length - 1]!.pan;
    // Envelope 0 is hard left, 64 hard right, when the channel sits centre.
    expect(pan.setValueAtTime.mock.calls[0]![0]).toBeCloseTo(-1, 5);
    const [target, when] = pan.linearRampToValueAtTime.mock.calls.at(-1)!;
    expect(target as number).toBeCloseTo(1, 5);
    expect(when as number).toBeCloseTo(10 * TICK, 6);
  });

  it('cannot push a hard-panned channel past the edge', () => {
    // FT2 scales the offset by the room the channel pan leaves, so a channel
    // already hard left barely moves rather than wrapping or clipping.
    const { instrument, panners } = makeInstrument({
      trackerPanEnvelope: SWEEP,
    });

    instrument.noteOnAtTime(60, 127, 0, { pan: 0, tickSeconds: TICK });

    const pan = panners[panners.length - 1]!.pan;
    const start = pan.setValueAtTime.mock.calls[0]![0] as number;
    const [end] = pan.linearRampToValueAtTime.mock.calls.at(-1)!;
    expect(start).toBeCloseTo(-1, 5);
    expect(end as number).toBeGreaterThanOrEqual(-1);
    // The whole sweep stays within the left half.
    expect(end as number).toBeLessThan(0);
  });

  it('re-derives the envelope when a pan command moves the base', () => {
    // The parameter holds pan *and* envelope combined, so a pan command cannot
    // just write to it -- the rest of the envelope has to be rebuilt around
    // the new base.
    const { instrument, panners } = makeInstrument({
      trackerPanEnvelope: SWEEP,
    });
    const voice = instrument.noteOnAtTime(60, 127, 0, {
      pan: 0.5,
      tickSeconds: TICK,
    })!;
    const pan = panners[panners.length - 1]!.pan;
    pan.cancelScheduledValues.mockClear();
    pan.setValueAtTime.mockClear();

    instrument.setPan(voice, 0.25);

    expect(pan.cancelScheduledValues).toHaveBeenCalled();
    expect(pan.setValueAtTime).toHaveBeenCalled();
  });

  it('leaves the plain pan ramp alone when there is no envelope', () => {
    const { instrument, panners } = makeInstrument({});
    const voice = instrument.noteOnAtTime(60, 127, 0, { tickSeconds: TICK })!;
    const pan = panners[panners.length - 1]!.pan;

    instrument.setPan(voice, 1);

    const [target] = pan.linearRampToValueAtTime.mock.calls.at(-1)!;
    expect(target as number).toBeCloseTo(1, 5);
  });
});

describe('Lxx sets the envelope position', () => {
  it('parses as an effect rather than being dropped', () => {
    expect(parseEffectCommand('L18')).toEqual({
      type: 'effect',
      effect: { type: 'setEnvelopePos', paramX: 1, paramY: 8 },
    });
  });

  it('emits an envelope-position command carrying the tick', () => {
    const state = createTrackEffectState(XM_PROFILE);
    const { commands } = processEffectTick0(
      state,
      { type: 'setEnvelopePos', paramX: 1, paramY: 8 },
      60,
      255,
      261.63,
      6,
    );

    const jump = commands.find((c) => c.kind === 'envelopePosition');
    expect(jump && 'tick' in jump && jump.tick).toBe(0x18);
  });

  it('restarts the volume envelope from that tick without retriggering', () => {
    const { instrument, gains } = makeInstrument({
      trackerEnvelope: {
        points: [
          { tick: 0, value: 0 },
          { tick: 20, value: 64 },
        ],
        sustainPoint: -1,
        loopStart: 0,
        loopEnd: 0,
        loopEnabled: false,
        fadeout: 0,
      },
    });
    const voice = instrument.noteOnAtTime(60, 127, 0, { tickSeconds: TICK })!;
    // The instrument's output gain is created in the constructor, then the
    // channel gain, then the envelope's own stage last (see the note on
    // ActiveVoice.envelopeGain).
    const envelopeGain = gains[gains.length - 1]!;
    envelopeGain.gain.setValueAtTime.mockClear();

    instrument.setEnvelopePositionAtTime(voice, 10, 0);

    // Halfway up the ramp: value 32 of 64.
    const [value] = envelopeGain.gain.setValueAtTime.mock.calls.at(-1)!;
    expect(value as number).toBeCloseTo(0.5, 5);
    expect(envelopeGain.gain.cancelScheduledValues).toHaveBeenCalled();
  });

  it('moves the panning envelope too, as FT2 does', () => {
    const { instrument, panners } = makeInstrument({
      trackerPanEnvelope: SWEEP,
    });
    const voice = instrument.noteOnAtTime(60, 127, 0, {
      pan: 0.5,
      tickSeconds: TICK,
    })!;
    const pan = panners[panners.length - 1]!.pan;
    pan.setValueAtTime.mockClear();

    instrument.setEnvelopePositionAtTime(voice, 5, 0);

    // Half way through a hard-left-to-hard-right sweep is centre.
    const [value] = pan.setValueAtTime.mock.calls.at(-1)!;
    expect(value as number).toBeCloseTo(0, 5);
  });
});
