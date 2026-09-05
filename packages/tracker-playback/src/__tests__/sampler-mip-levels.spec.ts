import { describe, it, expect } from 'vitest';
import { TrackerSamplerInstrument } from '../sampler-instrument';
import type { TrackerSamplerConfig } from '../tracker-sample';
import {
  resetSampleQuality,
  setSampleQuality,
  type SampleQualitySettings,
} from '../sample-quality';

/**
 * The anti-alias (mip) levels used to be built lazily inside the note-on
 * path: the first note pitched high enough to need a level ran a 33-tap
 * filter over the entire oversampled copy synchronously on the scheduling
 * thread (~130 ms on the largest corpus sample). They are now built at load.
 *
 * What must not change is *which* buffer a note gets: these tests pin the
 * bufferForRate selection across a rate sweep (driven through noteOnAtTime,
 * the only caller) and assert the levels already exist after load.
 *
 * Web Audio is mocked, but createBuffer hands back real Float32Array channel
 * data, so the filtering pipeline runs for real.
 */

interface Param {
  value: number;
  setValueAtTime: ReturnType<typeof vi.fn>;
  linearRampToValueAtTime: ReturnType<typeof vi.fn>;
  exponentialRampToValueAtTime: ReturnType<typeof vi.fn>;
  cancelScheduledValues: ReturnType<typeof vi.fn>;
}

const makeParam = (): Param => ({
  value: 1,
  setValueAtTime: vi.fn(),
  linearRampToValueAtTime: vi.fn(),
  exponentialRampToValueAtTime: vi.fn(),
  cancelScheduledValues: vi.fn(),
});

type SourceStub = {
  buffer: unknown;
  playbackRate: Param;
  detune: Param;
  loop: boolean;
  loopStart: number;
  loopEnd: number;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  onended: unknown;
};

function makeAudioContext() {
  const now = { t: 10 };
  const sources: SourceStub[] = [];

  const ctx = {
    get currentTime() {
      return now.t;
    },
    set currentTime(value: number) {
      now.t = value;
    },
    sampleRate: 44100,
    state: 'running' as AudioContextState,
    destination: { connect: vi.fn() },
    createBuffer: (channels: number, length: number, rate: number) => {
      const channelData = Array.from(
        { length: channels },
        () => new Float32Array(length),
      );
      return {
        length,
        sampleRate: rate,
        duration: length / rate,
        getChannelData: (ch: number) => channelData[ch]!,
      };
    },
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
    createBufferSource: (): SourceStub => {
      const source: SourceStub = {
        buffer: null,
        playbackRate: makeParam(),
        detune: makeParam(),
        loop: false,
        loopStart: 0,
        loopEnd: 0,
        connect: vi.fn(),
        disconnect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
        onended: null,
      };
      sources.push(source);
      return source;
    },
    createOscillator: () => ({
      type: 'sine',
      frequency: makeParam(),
      connect: vi.fn(),
      disconnect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    }),
  };
  return { ctx: ctx as unknown as AudioContext, sources, now };
}

const config = (): TrackerSamplerConfig => ({
  id: 'test-instrument',
  rootNote: 69, // A4 = 440 Hz
  detune: 0,
  gain: 1,
  loopMode: 'off',
  loopStart: 0,
  loopEnd: 1,
});

/** A short noisy sample; contents are irrelevant to the selection tests. */
function makeData(frames: number): Float32Array {
  const out = new Float32Array(frames);
  let state = 7;
  for (let i = 0; i < frames; i++) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    out[i] = (state / 0x3fffffff - 1) * 0.5;
  }
  return out;
}

async function loadInstrument(
  quality?: Partial<SampleQualitySettings>,
  frames = 2000,
) {
  resetSampleQuality();
  if (quality) setSampleQuality(quality);
  const { ctx, sources, now } = makeAudioContext();
  const instrument = new TrackerSamplerInstrument(ctx.destination, ctx);
  await instrument.load(config(), makeData(frames), 44100, 1, 4);
  return { instrument, sources, now };
}

const mipsOf = (instrument: TrackerSamplerInstrument) =>
  Reflect.get(instrument, 'mipBuffers') as (AudioBuffer | null)[];

describe('mip levels are built at load, not in the note-on path', () => {
  it('all anti-alias levels exist immediately after load', async () => {
    const { instrument } = await loadInstrument();
    const mips = mipsOf(instrument);
    expect(mips).toHaveLength(4);
    expect(mips[0]).not.toBeNull(); // level 0 is the played buffer
    for (let level = 1; level < 4; level++) {
      expect(mips[level], `level ${level}`).not.toBeNull();
    }
  });

  it('each prebuilt level is a distinct full-length filtered copy', async () => {
    const { instrument } = await loadInstrument();
    const mips = mipsOf(instrument);
    const conditioned = Reflect.get(
      instrument,
      'conditionedMono',
    ) as Float32Array;
    for (let level = 1; level < 4; level++) {
      expect(mips[level]!.length, `level ${level} frames`).toBe(
        conditioned.length,
      );
      expect(mips[level]).not.toBe(mips[0]);
    }
    // Higher levels are filtered harder; they must differ from level 0's data.
    const base = mips[0]!.getChannelData(0);
    for (let level = 1; level < 4; level++) {
      const levelData = mips[level]!.getChannelData(0);
      let identical = true;
      for (let i = 0; i < base.length; i++) {
        if (base[i] !== levelData[i]) {
          identical = false;
          break;
        }
      }
      expect(identical, `level ${level} is not a copy of level 0`).toBe(false);
    }
  });

  it('bufferForRate selection is unchanged across a rate sweep', async () => {
    const { instrument, sources, now } = await loadInstrument();
    const mips = mipsOf(instrument);

    // noteOnAtTime passes playbackRate / oversampleFactor (4) to
    // bufferForRate; playbackRate = frequency/rootFrequency * oversampleFactor,
    // so the musical rate reaching mipLevelForRate is frequency/440.
    const cases: Array<{ freq: number; level: number }> = [
      { freq: 220, level: 0 }, // rate 0.5
      { freq: 440, level: 0 }, // rate 1
      { freq: 441, level: 1 }, // just above 1
      { freq: 880, level: 1 }, // rate 2
      { freq: 881, level: 2 }, // just above 2
      { freq: 1760, level: 2 }, // rate 4
      { freq: 3521, level: 3 }, // just above 8
      { freq: 8000, level: 3 }, // clamped to the top level
    ];

    for (const { freq, level } of cases) {
      const before = sources.length;
      instrument.noteOnAtTime(69, 100, now.t, { frequency: freq });
      expect(sources.length).toBe(before + 1);
      const source = sources[sources.length - 1]!;
      expect(source.buffer, `freq ${freq} should select level ${level}`).toBe(
        mips[level],
      );
    }
  });

  it('levels built at load equal the ones the lazy path builds', async () => {
    // Load with anti-alias off: no levels prebuilt. Then trigger the lazy
    // build note by note and compare against a load-built instance.
    const lazy = await loadInstrument({ antiAliasHighNotes: false });
    const eager = await loadInstrument();
    expect(mipsOf(lazy.instrument)).toHaveLength(1); // only level 0

    setSampleQuality({ antiAliasHighNotes: true });
    // One note per level: 2x, 4x, and far past 8x musical rate.
    for (const freq of [880, 1760, 8000]) {
      lazy.instrument.noteOnAtTime(69, 100, lazy.now.t, { frequency: freq });
    }

    const lazyBuilt = mipsOf(lazy.instrument).slice(1);
    const eagerMips = mipsOf(eager.instrument).slice(1);
    for (let i = 0; i < 3; i++) {
      const a = lazyBuilt[i]!;
      const b = eagerMips[i]!;
      expect(a.length).toBe(b.length);
      const la = a.getChannelData(0);
      const lb = b.getChannelData(0);
      for (let j = 0; j < a.length; j++) {
        expect(la[j]).toBe(lb[j]);
      }
    }
  });
});
