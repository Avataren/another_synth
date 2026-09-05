import { describe, it, expect } from 'vitest';
import { TrackerSamplerInstrument } from '../sampler-instrument';
import type { TrackerSamplerConfig } from '../tracker-sample';
import {
  crossfadeLoop,
  removeDcOffset,
} from '../sample-conditioning';
import {
  resetSampleQuality,
  setSampleQuality,
  type SampleQualitySettings,
} from '../sample-quality';

/**
 * The load() copy loops used to (a) always take a defensive Float32Array.from
 * copy before conditioning and (b) de-interleave per frame with a multiply
 * and a `?? 0` per sample even though every tracker sample is mono. Now the
 * copy is skipped when conditioning cannot mutate the caller's array, and the
 * mono case is a single channelData.set().
 *
 * Both paths must produce exactly the same buffer contents as before, and the
 * defensive copy must still stand whenever conditioning could write to the
 * input -- the host may retain its `data` and must not see it re-centred or
 * crossfaded in place.
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

function makeAudioContext() {
  const buffers: Array<{
    length: number;
    sampleRate: number;
    duration: number;
    channels: Float32Array[];
    getChannelData: (ch: number) => Float32Array;
  }> = [];
  const ctx = {
    currentTime: 10,
    sampleRate: 44100,
    state: 'running' as AudioContextState,
    destination: { connect: vi.fn() },
    createBuffer: (channels: number, length: number, rate: number) => {
      const chans = Array.from(
        { length: channels },
        () => new Float32Array(length),
      );
      const buffer = {
        length,
        sampleRate: rate,
        duration: length / rate,
        channels: chans,
        getChannelData: (ch: number) => chans[ch]!,
      };
      buffers.push(buffer);
      return buffer;
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
    createBufferSource: () => ({
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
    }),
    createOscillator: () => ({
      type: 'sine',
      frequency: makeParam(),
      connect: vi.fn(),
      disconnect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    }),
  };
  return { ctx: ctx as unknown as AudioContext, buffers };
}

const config = (
  loopMode: TrackerSamplerConfig['loopMode'] = 'off',
): TrackerSamplerConfig => ({
  id: 'test-instrument',
  rootNote: 69,
  detune: 0,
  gain: 1,
  loopMode,
  loopStart: 0.1,
  loopEnd: 0.5,
});

function makeData(frames: number, offset = 0): Float32Array {
  const out = new Float32Array(frames);
  let state = 11;
  for (let i = 0; i < frames; i++) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    out[i] = (state / 0x3fffffff - 1) * 0.5 + offset;
  }
  return out;
}

async function load(
  data: Float32Array,
  quality: Partial<SampleQualitySettings>,
  channels = 1,
  cfg?: TrackerSamplerConfig,
) {
  resetSampleQuality();
  setSampleQuality(quality);
  const { ctx, buffers } = makeAudioContext();
  const instrument = new TrackerSamplerInstrument(ctx.destination, ctx);
  await instrument.load(cfg ?? config(), data, 44100, channels, 4);
  // Level 0 is the first buffer createBuffer makes; the mip levels (built at
  // load since P2) follow it and must not be confused with it.
  return { instrument, buffer: buffers[0]! };
}

function expectSame(a: Float32Array, b: Float32Array, label: string): void {
  expect(a.length).toBe(b.length);
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      throw new Error(`${label}: first differing element at ${i}`);
    }
  }
}

describe('mono load fast path is bit-exact with the old copy loops', () => {
  it('no conditioning applies: straight set() of the input, input untouched', async () => {
    const data = makeData(2000);
    const snapshot = Float32Array.from(data);
    const { buffer } = await load(data, {
      oversampleFactor: 1,
      removeDcOffset: false,
      loopCrossfadeFrames: 0,
    });
    expectSame(buffer.getChannelData(0), snapshot, 'buffer contents');
    // The caller's array must be exactly as handed in.
    expectSame(data, snapshot, 'caller data');
  });

  it('DC removal can mutate: the defensive copy still protects the caller', async () => {
    const data = makeData(2000, 0.3); // well above the DC threshold
    const snapshot = Float32Array.from(data);
    const expected = Float32Array.from(data);
    removeDcOffset(expected);

    const { buffer } = await load(data, {
      oversampleFactor: 1,
      removeDcOffset: true,
      loopCrossfadeFrames: 0,
    });
    expectSame(buffer.getChannelData(0), expected, 'conditioned contents');
    // The caller's data must NOT have been re-centred in place.
    expectSame(data, snapshot, 'caller data');
  });

  it('loop crossfade can mutate: copy taken, original untouched', async () => {
    const data = makeData(2000, 0.3);
    const snapshot = Float32Array.from(data);
    const expected = Float32Array.from(data);
    // conditionSample derives the loop from the config fractions over 2000
    // frames: start 200, end 1000; crossfade = min(64, 200, 400) = 64.
    crossfadeLoop(expected, 200, 1000, 64);

    const { buffer } = await load(
      data,
      {
        oversampleFactor: 1,
        removeDcOffset: false,
        loopCrossfadeFrames: 64,
      },
      1,
      config('forward'),
    );
    expectSame(buffer.getChannelData(0), expected, 'crossfaded contents');
    expectSame(data, snapshot, 'caller data');
  });

  it('interleaved stereo path is unchanged', async () => {
    const data = makeData(4000);
    const snapshot = Float32Array.from(data);
    const { buffer } = await load(
      data,
      {
        oversampleFactor: 1,
        removeDcOffset: false,
        loopCrossfadeFrames: 0,
      },
      2,
    );
    const left = new Float32Array(2000);
    const right = new Float32Array(2000);
    for (let i = 0; i < 2000; i++) {
      left[i] = snapshot[i * 2] ?? 0;
      right[i] = snapshot[i * 2 + 1] ?? 0;
    }
    expectSame(buffer.getChannelData(0), left, 'left channel');
    expectSame(buffer.getChannelData(1), right, 'right channel');
  });
});
