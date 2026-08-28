import { describe, it, expect, vi } from 'vitest';
import ModInstrument from 'src/audio/mod-instrument';
import { importXmToTrackerSong } from 'src/audio/tracker/xm-import';
import { deserializePatch } from 'src/audio/serialization/patch-serializer';
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

  it('sustains rather than cutting when there is no fadeout or release tail', () => {
    // Key-off is an envelope release, not a mute. An envelope with nothing
    // after its sustain point and no fadeout has no defined end in FT2: the
    // note rings until the channel plays again. Cutting it instead removes
    // notes that were meant to sound.
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

    expect(envelopeCalls.some((c) => c.kind === 'linearRamp' && c.value === 0))
      .toBe(false);
  });

  it('follows the envelope’s release segment past the sustain point', () => {
    // The points after the sustain are the instrument's own release shape.
    const { instrument, envelopeCalls, setEnvelope } = makeInstrument();
    setEnvelope({
      points: [
        { tick: 0, value: 64 },
        { tick: 10, value: 64 },
        { tick: 20, value: 32 },
        { tick: 40, value: 0 },
      ],
      sustainPoint: 1,
      loopStart: 0,
      loopEnd: 0,
      loopEnabled: false,
      fadeout: 0,
    });

    const voice = instrument.noteOnAtTime(60, 127, 0, { tickSeconds: 0.02 })!;
    envelopeCalls.length = 0;
    instrument.gateOffVoiceAtTime(voice, 1.0);

    // Tail runs 10 -> 40 ticks after the sustain point: 0.6s of release,
    // passing through the half-level point on the way.
    const half = envelopeCalls.find((c) => c.value === 0.5);
    expect(half).toBeDefined();
    expect(half!.time).toBeCloseTo(1.0 + 0.2, 6);
    const end = envelopeCalls[envelopeCalls.length - 1]!;
    expect(end.value).toBe(0);
    expect(end.time).toBeCloseTo(1.0 + 0.6, 6);
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

/**
 * End-to-end: the envelope must survive every stage between the importer and
 * the instrument.
 *
 * The tests above inject `samplerState` directly, which verifies the
 * scheduling maths but bypasses the patch pipeline entirely. That gap hid a
 * real fault: `normalizeSamplerStateWithDefaults` rebuilds SamplerState from an
 * explicit field list, so `trackerEnvelope` was silently dropped on the way to
 * the instrument. Every unit test passed while envelopes did nothing at all.
 *
 * These go through the real path instead.
 */
describe('envelope survives the patch pipeline', () => {
  function importedPatch() {
    const song = importXmToTrackerSong(
      buildXm({
        numChannels: 1,
        instruments: [
          {
            samples: [{ frames: [0, 1, 2, 3] }],
            volumeFadeout: 512,
            volumeEnvelope: {
              points: [
                [0, 64],
                [20, 0],
              ],
              type: 0x01,
            },
          },
        ],
        patterns: [{ numRows: 1, cells: [[cell(49, { instrument: 1 })]] }],
      }).buffer as ArrayBuffer,
    );
    return Object.values(song.data.songPatches)[0]!;
  }

  it('survives deserializePatch, which rebuilds sampler state field by field', () => {
    const deserialized = deserializePatch(importedPatch());
    const sampler = [...deserialized.samplers.values()][0]!;

    expect(sampler.trackerEnvelope).toBeDefined();
    expect(sampler.trackerEnvelope!.fadeout).toBe(512);
    expect(sampler.trackerEnvelope!.points).toEqual([
      { tick: 0, value: 64 },
      { tick: 20, value: 0 },
    ]);
  });

  it('survives a JSON round-trip, as saved songs take', () => {
    const roundTripped = JSON.parse(JSON.stringify(importedPatch())) as ReturnType<
      typeof importedPatch
    >;
    const sampler = Object.values(roundTripped.synthState.samplers)[0]!;
    expect(sampler.trackerEnvelope?.fadeout).toBe(512);
  });

  it('reaches the instrument and schedules automation, via the normalized patch', async () => {
    // The decisive check: no injected state, no reflection. The patch is
    // normalized first, exactly as song-bank does before handing it to the
    // instrument, so a field dropped anywhere in that path fails here.
    const envelopeCalls: ParamCall[] = [];
    let gainNodes = 0;
    const audioContext = {
      currentTime: 0,
      sampleRate: 44100,
      createBuffer: (channels: number, length: number, sampleRate: number) => ({
        duration: length / sampleRate,
        sampleRate,
        length,
        getChannelData: () => new Float32Array(length),
      }),
      createBufferSource: () => ({
        buffer: null as unknown,
        loop: false,
        loopStart: 0,
        loopEnd: 0,
        playbackRate: {
          value: 1,
          setValueAtTime: vi.fn(),
          linearRampToValueAtTime: vi.fn(),
        },
        connect: vi.fn(),
        disconnect: vi.fn(),
        stop: vi.fn(),
        start: vi.fn(),
        onended: null as unknown,
      }),
      createGain: () => {
        gainNodes++;
        const isEnvelope = gainNodes > 2; // output node, then channel, then envelope
        return {
          gain: makeParam(isEnvelope ? envelopeCalls : []),
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
    // Round-trip through the serializer the way song-bank's normalizePatch
    // does, so this covers the pipeline rather than just loadPatch.
    const patch = importedPatch();
    const deserialized = deserializePatch(patch);
    const normalized = {
      ...patch,
      synthState: {
        ...patch.synthState,
        samplers: Object.fromEntries(deserialized.samplers),
      },
    };

    await instrument.loadPatch(normalized);
    instrument.noteOnAtTime(60, 127, 0, { tickSeconds: 0.02, trackIndex: 0 });

    // Envelope: full at the note, silent 20 ticks later.
    expect(envelopeCalls.length).toBeGreaterThan(0);
    expect(envelopeCalls[0]!.value).toBe(1);
    const decay = envelopeCalls.find((c) => c.kind === 'linearRamp')!;
    expect(decay.value).toBe(0);
    expect(decay.time).toBeCloseTo(0.4, 6);
  });
});

/**
 * Note release.
 *
 * `noteOffAtTime` used to act only when the release was within 100ms of the
 * current time and silently drop it otherwise. The engine schedules half a
 * second to a second ahead, so in practice every note-off was discarded:
 * notes were never released, and XM key-off did nothing at all. The fadeout
 * never ran either, because nothing reached gateOffVoiceAtTime.
 */
describe('note release is scheduled, not dropped', () => {
  function harness() {
    const stops: number[] = [];
    const envelopeCalls: ParamCall[] = [];
    let gainNodes = 0;
    const audioContext = {
      currentTime: 0,
      createBufferSource: () => ({
        buffer: null as unknown,
        loop: false,
        loopStart: 0,
        loopEnd: 0,
        playbackRate: {
          value: 1,
          setValueAtTime: vi.fn(),
          linearRampToValueAtTime: vi.fn(),
        },
        connect: vi.fn(),
        disconnect: vi.fn(),
        stop: (when?: number) => stops.push(when ?? -1),
        start: vi.fn(),
        onended: null as unknown,
      }),
      createGain: () => {
        gainNodes++;
        return {
          gain: makeParam(gainNodes > 1 ? envelopeCalls : []),
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
    Reflect.set(instrument as object, 'samplerState', {
      gain: 1,
      loopMode: 0,
      loopStart: 0,
      loopEnd: 1,
      rootNote: 60,
      sampleRate: 8000,
      trackerEnvelope: {
        points: [{ tick: 0, value: 64 }],
        sustainPoint: 0,
        loopStart: 0,
        loopEnd: 0,
        loopEnabled: false,
        fadeout: 1024,
      },
    });

    return { instrument, stops, envelopeCalls };
  }

  it('releases a note scheduled well beyond the old 100ms window', () => {
    const { instrument, stops } = harness();
    instrument.noteOnAtTime(60, 127, 0, { tickSeconds: 0.02, trackIndex: 3 });

    // Far outside the window that used to be required.
    instrument.noteOffAtTime(60, 0.8, 3);

    expect(stops.length).toBeGreaterThan(0);
    // 65536/1024 = 64 ticks at 0.02s = 1.28s of fadeout after the release.
    expect(stops[0]).toBeCloseTo(0.8 + 1.28, 6);
  });

  it('runs the fadeout on release', () => {
    const { instrument, envelopeCalls } = harness();
    instrument.noteOnAtTime(60, 127, 0, { tickSeconds: 0.02, trackIndex: 3 });
    envelopeCalls.length = 0;

    instrument.noteOffAtTime(60, 0.8, 3);

    const ramp = envelopeCalls.find((c) => c.kind === 'linearRamp');
    expect(ramp).toBeDefined();
    expect(ramp!.value).toBe(0);
  });

  it('releases the channel’s own voice whatever note it holds', () => {
    // A tracker key-off releases the channel, not a pitch.
    const { instrument, stops } = harness();
    instrument.noteOnAtTime(64, 127, 0, { tickSeconds: 0.02, trackIndex: 3 });

    instrument.noteOffAtTime(60, 0.5, 3);

    expect(stops.length).toBeGreaterThan(0);
  });

  it('falls back to matching the note when no channel is given', () => {
    const { instrument, stops } = harness();
    instrument.noteOnAtTime(60, 127, 0, { tickSeconds: 0.02, trackIndex: 3 });

    instrument.noteOffAtTime(60, 0.5);

    expect(stops.length).toBeGreaterThan(0);
  });
});

/**
 * A tracker channel is monophonic, so a new note replaces whatever the channel
 * was doing - including a note part-way through its release. Released voices
 * are removed from the active set immediately so the slot can be reused, which
 * left nothing able to stop them; the released note carried on underneath the
 * new one. Inaudible while releases lasted 10ms, obvious once XM fadeouts
 * stretched them past a second.
 */
describe('a new note cuts a note still fading on the same channel', () => {
  function harness() {
    const stopped: object[] = [];
    const audioContext = {
      currentTime: 0,
      createBufferSource: () => {
        const source: Record<string, unknown> = {
          buffer: null,
          loop: false,
          loopStart: 0,
          loopEnd: 0,
          playbackRate: {
            value: 1,
            setValueAtTime: vi.fn(),
            linearRampToValueAtTime: vi.fn(),
          },
          connect: vi.fn(),
          disconnect: vi.fn(),
          start: vi.fn(),
          onended: null,
        };
        source.stop = () => stopped.push(source);
        return source;
      },
      createGain: () => ({
        gain: makeParam([]),
        connect: vi.fn(),
        disconnect: vi.fn(),
      }),
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
    Reflect.set(instrument as object, 'samplerState', {
      gain: 1,
      loopMode: 0,
      loopStart: 0,
      loopEnd: 1,
      rootNote: 60,
      sampleRate: 8000,
      trackerEnvelope: {
        points: [{ tick: 0, value: 64 }],
        sustainPoint: 0,
        loopStart: 0,
        loopEnd: 0,
        loopEnabled: false,
        fadeout: 256, // long fadeout: 256 ticks
      },
    });

    return { instrument, stopped };
  }

  it('stops a releasing voice when the channel plays again', () => {
    const { instrument, stopped } = harness();
    instrument.noteOnAtTime(60, 127, 0, { tickSeconds: 0.02, trackIndex: 2 });
    instrument.noteOffAtTime(60, 0.1, 2);

    const afterRelease = stopped.length;
    // The released note is still fading; a new note on the channel must cut it.
    instrument.noteOnAtTime(64, 127, 0.2, { tickSeconds: 0.02, trackIndex: 2 });

    expect(stopped.length).toBeGreaterThan(afterRelease);
  });

  it('leaves another channel’s fading note alone', () => {
    const { instrument, stopped } = harness();
    instrument.noteOnAtTime(60, 127, 0, { tickSeconds: 0.02, trackIndex: 2 });
    instrument.noteOffAtTime(60, 0.1, 2);
    const afterRelease = stopped.length;

    // A different channel must not cut it.
    instrument.noteOnAtTime(64, 127, 0.2, { tickSeconds: 0.02, trackIndex: 5 });

    expect(stopped.length).toBe(afterRelease);
  });

  it('stops fading voices when all notes are cut', () => {
    const { instrument, stopped } = harness();
    instrument.noteOnAtTime(60, 127, 0, { tickSeconds: 0.02, trackIndex: 2 });
    instrument.noteOffAtTime(60, 0.1, 2);
    const afterRelease = stopped.length;

    instrument.allNotesOff();

    expect(stopped.length).toBeGreaterThan(afterRelease);
  });
});

/**
 * Envelope loops. FT2 repeats loopStart..loopEnd for as long as the note is
 * held; AudioParam automation cannot loop, so the passes are unrolled.
 *
 * Playing a looping envelope once and holding its final value silences most
 * instruments that use one -- all 16 envelopes in external.xm loop, and 23
 * across the corpus do.
 */
describe('looping volume envelopes', () => {
  const loopingEnvelope = {
    // Rises, dips, and loops points 1..2 forever.
    points: [
      { tick: 0, value: 0 },
      { tick: 5, value: 64 },
      { tick: 15, value: 16 },
    ],
    sustainPoint: -1,
    loopStart: 1,
    loopEnd: 2,
    loopEnabled: true,
    fadeout: 0,
  };

  it('keeps scheduling past the last point instead of holding it', () => {
    const { instrument, envelopeCalls, setEnvelope } = makeInstrument();
    setEnvelope(loopingEnvelope);

    instrument.noteOnAtTime(60, 127, 0, { tickSeconds: 0.02 });

    // Without loop support this would stop at the third point, 0.3s in.
    const last = envelopeCalls[envelopeCalls.length - 1]!;
    expect(last.time).toBeGreaterThan(1);
  });

  it('repeats the loop segment’s values', () => {
    const { instrument, envelopeCalls, setEnvelope } = makeInstrument();
    setEnvelope(loopingEnvelope);

    instrument.noteOnAtTime(60, 127, 0, { tickSeconds: 0.02 });

    // The peak (64 -> 1.0) recurs rather than appearing once.
    const peaks = envelopeCalls.filter((c) => c.value === 1);
    expect(peaks.length).toBeGreaterThan(3);
  });

  it('does not loop when the envelope has a sustain point', () => {
    // Sustain wins: the envelope waits for key-off instead of looping.
    const { instrument, envelopeCalls, setEnvelope } = makeInstrument();
    setEnvelope({ ...loopingEnvelope, sustainPoint: 1 });

    instrument.noteOnAtTime(60, 127, 0, { tickSeconds: 0.02 });

    expect(envelopeCalls).toHaveLength(2);
    expect(envelopeCalls[1]!.time).toBeCloseTo(0.1, 6);
  });

  it('plays a non-looping envelope through to its end', () => {
    const { instrument, envelopeCalls, setEnvelope } = makeInstrument();
    setEnvelope({ ...loopingEnvelope, loopEnabled: false });

    instrument.noteOnAtTime(60, 127, 0, { tickSeconds: 0.02 });

    expect(envelopeCalls).toHaveLength(3);
    expect(envelopeCalls[2]!.time).toBeCloseTo(0.3, 6);
  });

  it('ignores a degenerate loop rather than scheduling forever', () => {
    const { instrument, envelopeCalls, setEnvelope } = makeInstrument();
    setEnvelope({ ...loopingEnvelope, loopStart: 2, loopEnd: 2 });

    instrument.noteOnAtTime(60, 127, 0, { tickSeconds: 0.02 });

    expect(envelopeCalls.length).toBeLessThan(10);
  });
});

/**
 * Replacing a voice must not silence it before it has been heard.
 *
 * Rows are scheduled up to a second ahead of the audio, so when a note is
 * scheduled the note it replaces has usually not started playing yet. Stopping
 * the old source with no time argument stopped it *immediately*, killing notes
 * at the moment their successor was scheduled rather than when it sounded.
 *
 * external.xm is the case that exposed it: every note is followed by a key-off
 * a row later and the next note a few rows on, so scheduling a batch of rows
 * wiped out most of the notes in it.
 */
describe('replacing a voice waits for the replacing note', () => {
  function harness() {
    const stops: Array<{ when: number | undefined }> = [];
    const audioContext = {
      currentTime: 0,
      createBufferSource: () => ({
        buffer: null as unknown,
        loop: false,
        loopStart: 0,
        loopEnd: 0,
        playbackRate: {
          value: 1,
          setValueAtTime: vi.fn(),
          linearRampToValueAtTime: vi.fn(),
        },
        connect: vi.fn(),
        disconnect: vi.fn(),
        stop: (when?: number) => stops.push({ when }),
        start: vi.fn(),
        onended: null as unknown,
      }),
      createGain: () => ({
        gain: makeParam([]),
        connect: vi.fn(),
        disconnect: vi.fn(),
      }),
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
    Reflect.set(instrument as object, 'samplerState', {
      gain: 1,
      loopMode: 0,
      loopStart: 0,
      loopEnd: 1,
      rootNote: 60,
      sampleRate: 8000,
      trackerEnvelope: {
        points: [{ tick: 0, value: 64 }],
        sustainPoint: 0,
        loopStart: 0,
        loopEnd: 0,
        loopEnabled: false,
        fadeout: 512,
      },
    });

    return { instrument, stops };
  }

  it('stops a still-sounding note at the replacing note’s time', () => {
    const { instrument, stops } = harness();
    // Both scheduled ahead: the first at 0.5s, its replacement at 0.9s.
    instrument.noteOnAtTime(60, 127, 0.5, { tickSeconds: 0.02, trackIndex: 0 });
    stops.length = 0;
    instrument.noteOnAtTime(64, 127, 0.9, { tickSeconds: 0.02, trackIndex: 0 });

    expect(stops).toHaveLength(1);
    // Not "now" (0), which would silence a note that has not played yet.
    expect(stops[0]!.when).toBeCloseTo(0.9, 6);
  });

  it('stops a releasing note at the replacing note’s time', () => {
    const { instrument, stops } = harness();
    instrument.noteOnAtTime(60, 127, 0.5, { tickSeconds: 0.02, trackIndex: 0 });
    instrument.noteOffAtTime(60, 0.6, 0);
    stops.length = 0;

    instrument.noteOnAtTime(64, 127, 0.9, { tickSeconds: 0.02, trackIndex: 0 });

    expect(stops.length).toBeGreaterThan(0);
    expect(stops[0]!.when).toBeCloseTo(0.9, 6);
  });

  it('never schedules a stop before the present', () => {
    const { instrument, stops } = harness();
    instrument.noteOnAtTime(60, 127, 0.5, { tickSeconds: 0.02, trackIndex: 0 });
    stops.length = 0;
    // A late row, already behind the clock.
    instrument.noteOnAtTime(64, 127, -1, { tickSeconds: 0.02, trackIndex: 0 });

    expect(stops[0]!.when).toBeGreaterThanOrEqual(0);
  });
});
