import { describe, it, expect, vi } from 'vitest';
import ModInstrument from 'src/audio/mod-instrument';
import { importXmToTrackerSong } from 'src/audio/tracker/xm-import';
import { buildXm, cell } from './helpers/xm-builder';

/**
 * XM volume envelopes and fadeout.
 *
 * Measured across the real corpus, 92-100% of notes in most modules are played
 * by instruments that define a volume envelope or a fadeout (only 4-mat's
 * "rose" is an outlier at 19%/10%, which is why it was the one module that
 * already sounded close to right). Without them every note plays at a constant
 * level and key-off cuts abruptly.
 *
 * The envelope gets its own gain stage so it multiplies with the channel
 * volume that effects automate, rather than overwriting it.
 */
interface ParamCall {
  kind: 'setValueAtTime' | 'linearRamp' | 'cancelAndHold';
  value?: number;
  time: number;
}

function makeParam(calls: ParamCall[]) {
  return {
    value: 1,
    setValueAtTime: (value: number, time: number) => {
      calls.push({ kind: 'setValueAtTime', value, time });
    },
    linearRampToValueAtTime: (value: number, time: number) => {
      calls.push({ kind: 'linearRamp', value, time });
    },
    cancelScheduledValues: vi.fn(),
    cancelAndHoldAtTime: (time: number) => {
      calls.push({ kind: 'cancelAndHold', time });
    },
  };
}

function makeInstrument() {
  const envelopeCalls: ParamCall[] = [];
  const channelCalls: ParamCall[] = [];
  let gainNodesCreated = 0;

  const audioContext = {
    currentTime: 0,
    createBufferSource: () => ({
      buffer: null as unknown,
      loop: false,
      loopStart: 0,
      loopEnd: 0,
      playbackRate: { value: 1, setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() },
      connect: vi.fn(),
      disconnect: vi.fn(),
      stop: vi.fn(),
      start: vi.fn(),
      onended: null as unknown,
    }),
    createGain: () => {
      gainNodesCreated++;
      // The first gain node built per voice is the channel volume; the
      // envelope stage is created afterwards.
      const isEnvelope = gainNodesCreated > 1;
      return {
        gain: makeParam(isEnvelope ? envelopeCalls : channelCalls),
        connect: vi.fn(),
        disconnect: vi.fn(),
      };
    },
    createStereoPanner: () => ({
      pan: {
        value: 0,
        setValueAtTime: vi.fn(),
        linearRampToValueAtTime: vi.fn(),
        cancelScheduledValues: vi.fn(),
      },
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
  Reflect.set(instrument as object, 'ready', true);

  const setEnvelope = (trackerEnvelope: unknown) => {
    Reflect.set(instrument as object, 'samplerState', {
      gain: 1,
      loopMode: 0,
      loopStart: 0,
      loopEnd: 1,
      rootNote: 60,
      sampleRate: 8000,
      trackerEnvelope,
    });
  };

  return { instrument, envelopeCalls, channelCalls, setEnvelope };
}

describe('tracker volume envelope', () => {
  it('schedules envelope points on their own gain stage', () => {
    const { instrument, envelopeCalls, setEnvelope } = makeInstrument();
    setEnvelope({
      // 0 -> full, tick 10 -> half, tick 20 -> silent
      points: [
        { tick: 0, value: 64 },
        { tick: 10, value: 32 },
        { tick: 20, value: 0 },
      ],
      sustainPoint: -1,
      loopStart: 0,
      loopEnd: 0,
      loopEnabled: false,
      fadeout: 0,
    });

    instrument.noteOnAtTime(60, 127, 0, { tickSeconds: 0.02 });

    expect(envelopeCalls[0]).toEqual({
      kind: 'setValueAtTime',
      value: 1,
      time: 0,
    });
    // Values are 0..64 in the file and 0..1 on the param; ticks scale by the
    // tick duration.
    expect(envelopeCalls[1]).toEqual({
      kind: 'linearRamp',
      value: 0.5,
      time: 0.2,
    });
    expect(envelopeCalls[2]).toEqual({
      kind: 'linearRamp',
      value: 0,
      time: 0.4,
    });
  });

  it('stops at the sustain point and leaves the rest for key-off', () => {
    const { instrument, envelopeCalls, setEnvelope } = makeInstrument();
    setEnvelope({
      points: [
        { tick: 0, value: 0 },
        { tick: 5, value: 64 },
        { tick: 50, value: 0 },
      ],
      sustainPoint: 1,
      loopStart: 0,
      loopEnd: 0,
      loopEnabled: false,
      fadeout: 0,
    });

    instrument.noteOnAtTime(60, 127, 0, { tickSeconds: 0.02 });

    // Attack to the sustain point only; the decay past it must not be
    // scheduled while the note is held.
    expect(envelopeCalls).toHaveLength(2);
    expect(envelopeCalls[1]).toEqual({ kind: 'linearRamp', value: 1, time: 0.1 });
  });

  it('scales envelope timing with the tick duration', () => {
    const points = [
      { tick: 0, value: 64 },
      { tick: 10, value: 0 },
    ];
    const envelope = {
      points,
      sustainPoint: -1,
      loopStart: 0,
      loopEnd: 0,
      loopEnabled: false,
      fadeout: 0,
    };

    const slow = makeInstrument();
    slow.setEnvelope(envelope);
    slow.instrument.noteOnAtTime(60, 127, 0, { tickSeconds: 0.02 });

    const fast = makeInstrument();
    fast.setEnvelope(envelope);
    fast.instrument.noteOnAtTime(60, 127, 0, { tickSeconds: 0.01 });

    expect(slow.envelopeCalls[1]!.time).toBeCloseTo(0.2, 6);
    expect(fast.envelopeCalls[1]!.time).toBeCloseTo(0.1, 6);
  });

  it('leaves the channel volume stage alone', () => {
    // The envelope must multiply with effect-driven volume, not replace it.
    const { instrument, channelCalls, setEnvelope } = makeInstrument();
    setEnvelope({
      points: [
        { tick: 0, value: 64 },
        { tick: 10, value: 0 },
      ],
      sustainPoint: -1,
      loopStart: 0,
      loopEnd: 0,
      loopEnabled: false,
      fadeout: 0,
    });

    instrument.noteOnAtTime(60, 127, 0, { tickSeconds: 0.02 });

    expect(channelCalls).toHaveLength(0);
  });

  it('creates no envelope stage for an instrument without one', () => {
    const { instrument, envelopeCalls, setEnvelope } = makeInstrument();
    setEnvelope(undefined);

    instrument.noteOnAtTime(60, 127, 0, { tickSeconds: 0.02 });

    expect(envelopeCalls).toHaveLength(0);
  });

  it('fades out over 65536/fadeout ticks on key-off', () => {
    const { instrument, envelopeCalls, setEnvelope } = makeInstrument();
    setEnvelope({
      points: [{ tick: 0, value: 64 }],
      sustainPoint: 0,
      loopStart: 0,
      loopEnd: 0,
      loopEnabled: false,
      fadeout: 1024,
    });

    const voice = instrument.noteOnAtTime(60, 127, 0, { tickSeconds: 0.02 })!;
    envelopeCalls.length = 0;
    instrument.gateOffVoiceAtTime(voice, 1.0);

    // 65536 / 1024 = 64 ticks, at 0.02s each = 1.28s.
    expect(envelopeCalls[0]!.kind).toBe('cancelAndHold');
    const ramp = envelopeCalls.find((c) => c.kind === 'linearRamp')!;
    expect(ramp.value).toBe(0);
    expect(ramp.time).toBeCloseTo(1.0 + 1.28, 6);
  });

  it('cuts quickly when the instrument has no fadeout', () => {
    const { instrument, envelopeCalls, setEnvelope } = makeInstrument();
    setEnvelope({
      points: [{ tick: 0, value: 64 }],
      sustainPoint: 0,
      loopStart: 0,
      loopEnd: 0,
      loopEnabled: false,
      fadeout: 0,
    });

    const voice = instrument.noteOnAtTime(60, 127, 0, { tickSeconds: 0.02 })!;
    envelopeCalls.length = 0;
    instrument.gateOffVoiceAtTime(voice, 1.0);

    const ramp = envelopeCalls.find((c) => c.kind === 'linearRamp')!;
    expect(ramp.time).toBeCloseTo(1.01, 6);
  });
});

describe('XM import carries envelopes onto the patch', () => {
  function importWith(
    instrumentSpec: NonNullable<Parameters<typeof buildXm>[0]['instruments']>,
  ) {
    const song = importXmToTrackerSong(
      buildXm({
        numChannels: 1,
        instruments: instrumentSpec,
        patterns: [{ numRows: 1, cells: [[cell(49, { instrument: 1 })]] }],
      }).buffer as ArrayBuffer,
    );
    const patch = Object.values(song.data.songPatches)[0]!;
    return Object.values(patch.synthState.samplers)[0]!;
  }

  it('carries an enabled envelope and its sustain point', () => {
    const sampler = importWith([
      {
        samples: [{ frames: [0, 1, 2] }],
        volumeEnvelope: {
          points: [
            [0, 0],
            [8, 64],
            [40, 0],
          ],
          type: 0x03, // enabled + sustain
          sustain: 1,
        },
      },
    ]);

    expect(sampler.trackerEnvelope).toBeDefined();
    expect(sampler.trackerEnvelope!.points).toEqual([
      { tick: 0, value: 0 },
      { tick: 8, value: 64 },
      { tick: 40, value: 0 },
    ]);
    expect(sampler.trackerEnvelope!.sustainPoint).toBe(1);
  });

  it('ignores the sustain point when sustain is not enabled', () => {
    const sampler = importWith([
      {
        samples: [{ frames: [0, 1, 2] }],
        volumeEnvelope: {
          points: [
            [0, 64],
            [20, 0],
          ],
          type: 0x01, // enabled, no sustain
          sustain: 1,
        },
      },
    ]);

    expect(sampler.trackerEnvelope!.sustainPoint).toBe(-1);
  });

  it('carries fadeout even when the envelope is disabled', () => {
    // Most modules in the corpus use fadeout far more than envelopes.
    const sampler = importWith([
      { samples: [{ frames: [0, 1, 2] }], volumeFadeout: 512 },
    ]);

    expect(sampler.trackerEnvelope).toBeDefined();
    expect(sampler.trackerEnvelope!.fadeout).toBe(512);
    expect(sampler.trackerEnvelope!.points).toEqual([]);
  });

  it('adds no envelope when the instrument has neither', () => {
    const sampler = importWith([{ samples: [{ frames: [0, 1, 2] }] }]);
    expect(sampler.trackerEnvelope).toBeUndefined();
  });
});
