import { describe, it, expect, vi } from 'vitest';
import { StandaloneTrackerSink } from '../standalone-sink';
import type { TrackerSink } from '../sink';
import type { TrackerSample } from '../tracker-sample';

/**
 * The standalone sink is the second `TrackerSink`, and the only one a consumer
 * outside this repo gets. The app's suite exercises `TrackerSongBank`
 * thoroughly and this not at all, so these tests cover the routing that is
 * specific to it: which instrument a command reaches, and which voice.
 *
 * Web Audio is mocked rather than polyfilled -- the questions here are about
 * dispatch, not about what the sample sounds like.
 */

interface Recorded {
  gainNodes: Array<{ setValueAtTime: ReturnType<typeof vi.fn> }>;
}

function makeAudioContext(recorded: Recorded) {
  const makeParam = () => {
    const setValueAtTime = vi.fn();
    recorded.gainNodes.push({ setValueAtTime });
    return {
      value: 1,
      setValueAtTime,
      linearRampToValueAtTime: vi.fn(),
      exponentialRampToValueAtTime: vi.fn(),
      cancelScheduledValues: vi.fn(),
    };
  };

  return {
    currentTime: 10,
    sampleRate: 44100,
    state: 'running' as AudioContextState,
    destination: { connect: vi.fn() },
    resume: vi.fn(),
    createGain: () => ({
      gain: makeParam(),
      connect: vi.fn(),
      disconnect: vi.fn(),
    }),
    createStereoPanner: () => ({
      pan: makeParam(),
      connect: vi.fn(),
      disconnect: vi.fn(),
    }),
    createBufferSource: () => ({
      buffer: null as unknown,
      loop: false,
      loopStart: 0,
      loopEnd: 0,
      playbackRate: makeParam(),
      connect: vi.fn(),
      disconnect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      onended: null as unknown,
    }),
    createBuffer: (channels: number, length: number, sampleRate: number) => ({
      numberOfChannels: channels,
      length,
      sampleRate,
      duration: length / sampleRate,
      getChannelData: () => new Float32Array(length),
    }),
  } as unknown as AudioContext;
}

function sample(slot: number, overrides: Partial<TrackerSample> = {}): TrackerSample {
  return {
    slot,
    sourceIndex: slot,
    name: `sample ${slot}`,
    data: new Float32Array(256).fill(0.5),
    sampleRate: 44100,
    rootNote: 65,
    detuneCents: 0,
    gain: 1,
    loop: 'off',
    loopStartFrames: 0,
    loopLengthFrames: 256,
    voiceCount: 4,
    ...overrides,
  };
}

async function makeSink(samples: TrackerSample[]) {
  const recorded: Recorded = { gainNodes: [] };
  const audioContext = makeAudioContext(recorded);
  const sink = new StandaloneTrackerSink({ audioContext });
  await sink.loadSamples(samples);
  return { sink, audioContext, recorded };
}

/** The instruments the sink built, by id. */
function instrumentsOf(sink: StandaloneTrackerSink): Map<string, { instrument: unknown }> {
  return Reflect.get(sink as object, 'instruments') as Map<
    string,
    { instrument: unknown }
  >;
}

describe('StandaloneTrackerSink', () => {
  it('satisfies TrackerSink', async () => {
    const { sink } = await makeSink([sample(1)]);
    // The assignment is the assertion: it fails to compile if the class and
    // the interface drift apart.
    const asSink: TrackerSink = sink;
    expect(asSink.audioContext).toBeDefined();
  });

  it('addresses instruments by the zero-padded slot id rows carry', async () => {
    const { sink } = await makeSink([sample(1), sample(7), sample(12)]);
    expect([...instrumentsOf(sink).keys()]).toEqual(['01', '07', '12']);
  });

  it('builds no instrument for an OPL slot, which has nothing to play', async () => {
    const { sink } = await makeSink([
      sample(1),
      sample(2, {
        data: new Float32Array(0),
        opl: { kind: 'melody', registers: [1, 2, 3], volume: 32, c2spd: 8363 },
      }),
    ]);
    expect([...instrumentsOf(sink).keys()]).toEqual(['01']);
  });

  it('ignores commands for an instrument that was never loaded', async () => {
    const { sink } = await makeSink([sample(1)]);
    expect(() => {
      sink.noteOnAtTime('99', 60, 64, 11, 0);
      sink.setVoicePitchAtTime('99', 0, 440, 11, 0);
      sink.noteOffAtTime(undefined, 60, 11, 0);
    }).not.toThrow();
  });

  it('routes a per-voice command to the voice that track started', async () => {
    const { sink } = await makeSink([sample(1)]);
    const loaded = instrumentsOf(sink).get('01')!;
    const instrument = loaded.instrument as {
      noteOnAtTime: (...args: unknown[]) => number | undefined;
      setVoiceFrequencyAtTime: ReturnType<typeof vi.fn>;
    };

    // Track 3's note lands on voice 2, whatever the engine later guesses.
    instrument.noteOnAtTime = vi.fn().mockReturnValue(2);
    instrument.setVoiceFrequencyAtTime = vi.fn();

    sink.noteOnAtTime('01', 60, 64, 11, 3);
    sink.setVoicePitchAtTime('01', 0, 440, 11, 3, 'linear');

    expect(instrument.setVoiceFrequencyAtTime).toHaveBeenCalledWith(
      2,
      440,
      11,
      'linear',
    );
  });

  it('falls back to the engine voice index for a track it has not seen', async () => {
    const { sink } = await makeSink([sample(1)]);
    const instrument = instrumentsOf(sink).get('01')!.instrument as {
      setVoiceGainAtTime: ReturnType<typeof vi.fn>;
    };
    instrument.setVoiceGainAtTime = vi.fn();

    sink.setVoiceVolumeAtTime('01', 5, 0.5, 11, 9, 'step');

    expect(instrument.setVoiceGainAtTime).toHaveBeenCalledWith(5, 0.5, 11, 'step');
  });

  it('never schedules in the past: a late tick still sounds', async () => {
    const { sink, audioContext } = await makeSink([sample(1)]);
    const instrument = instrumentsOf(sink).get('01')!.instrument as {
      noteOnAtTime: ReturnType<typeof vi.fn>;
    };
    instrument.noteOnAtTime = vi.fn().mockReturnValue(0);

    // currentTime is 10; the transport asks for 4, which has already gone.
    sink.noteOnAtTime('01', 60, 64, 4, 0);

    const when = instrument.noteOnAtTime.mock.calls[0]![2];
    expect(when).toBe(audioContext.currentTime);
  });

  it('cuts only the named track on notesOffForTrack', async () => {
    const { sink } = await makeSink([sample(1)]);
    const instrument = instrumentsOf(sink).get('01')!.instrument as {
      noteOnAtTime: ReturnType<typeof vi.fn>;
      cutVoiceAtTime: ReturnType<typeof vi.fn>;
    };
    instrument.noteOnAtTime = vi
      .fn()
      .mockReturnValueOnce(1)
      .mockReturnValueOnce(2);
    instrument.cutVoiceAtTime = vi.fn();

    sink.noteOnAtTime('01', 60, 64, 11, 0);
    sink.noteOnAtTime('01', 62, 64, 11, 1);
    sink.notesOffForTrack(1);

    expect(instrument.cutVoiceAtTime).toHaveBeenCalledTimes(1);
    expect(instrument.cutVoiceAtTime.mock.calls[0]![0]).toBe(2);
  });

  it('cuts every tracked voice on cutAllVoicesAtTime', async () => {
    const { sink } = await makeSink([sample(1)]);
    const instrument = instrumentsOf(sink).get('01')!.instrument as {
      noteOnAtTime: ReturnType<typeof vi.fn>;
      cutVoiceAtTime: ReturnType<typeof vi.fn>;
    };
    instrument.noteOnAtTime = vi
      .fn()
      .mockReturnValueOnce(1)
      .mockReturnValueOnce(2);
    instrument.cutVoiceAtTime = vi.fn();

    sink.noteOnAtTime('01', 60, 64, 11, 0);
    sink.noteOnAtTime('01', 62, 64, 11, 1);
    sink.cutAllVoicesAtTime(12);

    expect(instrument.cutVoiceAtTime.mock.calls.map((c) => c[0]).sort()).toEqual([
      1, 2,
    ]);
  });

  it('restarts rather than layers on retrigger', async () => {
    const { sink } = await makeSink([sample(1)]);
    const instrument = instrumentsOf(sink).get('01')!.instrument as {
      noteOnAtTime: ReturnType<typeof vi.fn>;
      cutVoiceAtTime: ReturnType<typeof vi.fn>;
    };
    instrument.noteOnAtTime = vi.fn().mockReturnValue(3);
    instrument.cutVoiceAtTime = vi.fn();

    sink.noteOnAtTime('01', 60, 64, 11, 0);
    sink.retriggerNoteAtTime('01', 60, 64, 12, 0);

    // The channel's sounding voice is cut before the new note starts.
    expect(instrument.cutVoiceAtTime).toHaveBeenCalledWith(3, 12);
    expect(instrument.noteOnAtTime).toHaveBeenCalledTimes(2);
  });

  it('clamps master volume to 0..1', async () => {
    const { sink, recorded } = await makeSink([sample(1)]);
    // The sink's own master gain is the first gain node it created.
    const master = recorded.gainNodes[0]!;

    sink.setMasterVolume(2, 11);
    sink.setMasterVolume(-1, 12);

    expect(master.setValueAtTime).toHaveBeenNthCalledWith(1, 1, 11);
    expect(master.setValueAtTime).toHaveBeenNthCalledWith(2, 0, 12);
  });

  it('reports needsResume from the context state', async () => {
    const { sink, audioContext } = await makeSink([sample(1)]);
    expect(sink.needsResume).toBe(false);

    Reflect.set(audioContext as object, 'state', 'suspended');
    expect(sink.needsResume).toBe(true);
    await expect(sink.ensureAudioContextRunning()).resolves.toBe(false);
  });
});
