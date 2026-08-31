import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import ModInstrument from 'src/audio/mod-instrument';
import { importXmToTrackerSong } from 'src/audio/tracker/xm-import';
import { deserializePatch } from 'src/audio/serialization/patch-serializer';
import { SamplerLoopMode } from 'src/audio/types/synth-layout';
import { buildXm, cell } from './helpers/xm-builder';
import {
  resetSampleQuality,
  setSampleQuality,
} from 'src/audio/sample-quality';

/**
 * Sample looping, exercised through the real patch pipeline rather than by
 * injecting sampler state — a previous fault in this area survived eleven unit
 * tests precisely because they bypassed normalization.
 *
 * An AudioBufferSourceNode can only loop forwards, so ping-pong loops are
 * materialised at load: the loop region is followed by a reversed copy and the
 * loop spans both halves. 27 samples in the local XM corpus use ping-pong, and
 * they previously failed the `loopMode === 1` check and did not loop at all.
 *
 * These are about how loop points map from the file to the source node, so
 * offline conditioning is switched off for them -- it multiplies frame counts
 * and loop times by the oversampling factor, which would obscure the mapping
 * rather than test it. The geometry *with* conditioning has its own test at
 * the end of this file.
 */
interface SourceRecord {
  loop: boolean;
  loopStart: number;
  loopEnd: number;
}

beforeEach(() => {
  setSampleQuality({
    oversampleFactor: 1,
    removeDcOffset: false,
    loopCrossfadeFrames: 0,
    antiAliasHighNotes: false,
  });
});

afterEach(resetSampleQuality);

function makeHarness() {
  const sources: SourceRecord[] = [];
  const buffers: Array<{ length: number; data: Float32Array[] }> = [];

  const audioContext = {
    currentTime: 0,
    sampleRate: 44100,
    createBuffer: (channels: number, length: number, sampleRate: number) => {
      const data = Array.from({ length: channels }, () => new Float32Array(length));
      const record = { length, data };
      buffers.push(record);
      return {
        duration: length / sampleRate,
        sampleRate,
        length,
        numberOfChannels: channels,
        getChannelData: (ch: number) => data[ch]!,
      };
    },
    createBufferSource: () => {
      // A real AudioBufferSourceNode accepts `buffer` exactly once: assigning
      // a second non-null buffer throws InvalidStateError. The mock enforces
      // that, because a version of it that did not let a double assignment
      // ship -- picking the anti-aliased buffer after setting a default one
      // threw on the first note of every song.
      let assigned: unknown = null;
      const source: SourceRecord & Record<string, unknown> = {
        loop: false,
        loopStart: 0,
        loopEnd: 0,
        get buffer() {
          return assigned;
        },
        set buffer(next: unknown) {
          if (next !== null && assigned !== null) {
            throw new Error(
              "InvalidStateError: Failed to set the 'buffer' property on " +
                "'AudioBufferSourceNode': Cannot set buffer to non-null after " +
                'it has been already been set to a non-null buffer',
            );
          }
          assigned = next;
        },
        playbackRate: {
          value: 1,
          setValueAtTime: vi.fn(),
          linearRampToValueAtTime: vi.fn(),
        },
        connect: vi.fn(),
        disconnect: vi.fn(),
        stop: vi.fn(),
        start: vi.fn(),
        onended: null,
      };
      sources.push(source);
      return source;
    },
    createGain: () => ({
      gain: {
        value: 1,
        setValueAtTime: vi.fn(),
        linearRampToValueAtTime: vi.fn(),
        cancelScheduledValues: vi.fn(),
        cancelAndHoldAtTime: vi.fn(),
      },
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

  return { instrument, sources, buffers };
}

/** Import a one-instrument XM and normalize it the way song-bank does. */
function normalizedPatchFor(sample: {
  frames: number[];
  loopType?: number;
  loopStartFrames?: number;
  loopLengthFrames?: number;
  bits?: 8 | 16;
}) {
  const song = importXmToTrackerSong(
    buildXm({
      numChannels: 1,
      instruments: [{ samples: [sample] }],
      patterns: [{ numRows: 1, cells: [[cell(49, { instrument: 1 })]] }],
    }).buffer as ArrayBuffer,
  );
  const patch = Object.values(song.data.songPatches)[0]!;
  const deserialized = deserializePatch(patch);
  return {
    ...patch,
    synthState: {
      ...patch.synthState,
      samplers: Object.fromEntries(deserialized.samplers),
    },
  };
}

const frames16 = Array.from({ length: 16 }, (_, i) => i * 4);

describe('sample loops reach the source node', () => {
  it('imports a forward loop with the right normalized range', () => {
    const patch = normalizedPatchFor({
      frames: frames16,
      loopType: 1,
      loopStartFrames: 4,
      loopLengthFrames: 8,
    });
    const sampler = Object.values(patch.synthState.samplers)[0]!;

    expect(sampler.loopMode).toBe(SamplerLoopMode.Loop);
    expect(sampler.loopStart).toBeCloseTo(4 / 16, 6);
    expect(sampler.loopEnd).toBeCloseTo(12 / 16, 6);
  });

  it('applies a forward loop to the playing source', async () => {
    const { instrument, sources } = makeHarness();
    await instrument.loadPatch(
      normalizedPatchFor({
        frames: frames16,
        loopType: 1,
        loopStartFrames: 4,
        loopLengthFrames: 8,
      }),
    );
    instrument.noteOnAtTime(60, 127, 0, { trackIndex: 0 });

    const source = sources[0]!;
    expect(source.loop).toBe(true);
    // Loop points are buffer seconds against the declared 44100 rate.
    expect(source.loopStart).toBeCloseTo(4 / 44100, 9);
    expect(source.loopEnd).toBeCloseTo(12 / 44100, 9);
  });

  it('loops ping-pong samples instead of leaving them one-shot', async () => {
    const { instrument, sources } = makeHarness();
    await instrument.loadPatch(
      normalizedPatchFor({
        frames: frames16,
        loopType: 2,
        loopStartFrames: 4,
        loopLengthFrames: 8,
      }),
    );
    instrument.noteOnAtTime(60, 127, 0, { trackIndex: 0 });

    const source = sources[0]!;
    expect(source.loop).toBe(true);
    expect(source.loopStart).toBeCloseTo(4 / 44100, 9);
    // The loop spans the region plus its mirror: 4..12 then 12..20.
    expect(source.loopEnd).toBeCloseTo(20 / 44100, 9);
  });

  it('mirrors the loop region into the buffer for ping-pong', async () => {
    const { instrument, buffers } = makeHarness();
    await instrument.loadPatch(
      normalizedPatchFor({
        frames: frames16,
        loopType: 2,
        loopStartFrames: 4,
        loopLengthFrames: 8,
      }),
    );

    // The last buffer built is the mirrored one: 12 original frames + 8 mirrored.
    const mirrored = buffers[buffers.length - 1]!;
    expect(mirrored.length).toBe(20);

    const data = mirrored.data[0]!;
    // Frames 12..19 are frames 11..4 reversed.
    for (let i = 0; i < 8; i++) {
      expect(data[12 + i]).toBeCloseTo(data[11 - i]!, 6);
    }
  });

  it('leaves an unlooped sample alone', async () => {
    const { instrument, sources } = makeHarness();
    await instrument.loadPatch(normalizedPatchFor({ frames: frames16 }));
    instrument.noteOnAtTime(60, 127, 0, { trackIndex: 0 });

    expect(sources[0]!.loop).toBe(false);
  });

  it('survives normalization, which rebuilds sampler state field by field', () => {
    // Loop fields must be named in normalizeSamplerStateWithDefaults; the
    // volume envelope was silently dropped there once already.
    const patch = normalizedPatchFor({
      frames: frames16,
      loopType: 2,
      loopStartFrames: 4,
      loopLengthFrames: 8,
    });
    const sampler = Object.values(patch.synthState.samplers)[0]!;

    expect(sampler.loopMode).toBe(SamplerLoopMode.PingPong);
    expect(sampler.loopStart).toBeCloseTo(4 / 16, 6);
    expect(sampler.loopEnd).toBeCloseTo(12 / 16, 6);
  });

  it('converts 16-bit loop points from bytes to frames end to end', async () => {
    const { instrument, sources } = makeHarness();
    await instrument.loadPatch(
      normalizedPatchFor({
        frames: frames16,
        bits: 16,
        loopType: 1,
        loopStartFrames: 4,
        loopLengthFrames: 8,
      }),
    );
    instrument.noteOnAtTime(60, 127, 0, { trackIndex: 0 });

    expect(sources[0]!.loopStart).toBeCloseTo(4 / 44100, 9);
    expect(sources[0]!.loopEnd).toBeCloseTo(12 / 44100, 9);
  });
});

/**
 * Oversampling lengthens the buffer without changing the rate it is declared
 * at, and corrects the pitch by reading it proportionally faster. Everything
 * measured in buffer time therefore scales with it, and the only thing that
 * must not move is what you actually hear: the loop's duration in real time,
 * and the pitch.
 */
/**
 * Both note-start paths must set the source's buffer exactly once.
 *
 * A real AudioBufferSourceNode refuses a second non-null buffer, and choosing
 * the anti-aliased copy means the choice has to be made *before* the buffer is
 * assigned rather than by replacing it afterwards. Only noteOnAtTime was
 * covered when that went in, so the immediate path threw on the first note of
 * every song and no test noticed.
 */
describe('every path that starts a note', () => {
  it('assigns the buffer once from noteOnAtTime', async () => {
    const { instrument, sources } = makeHarness();
    await instrument.loadPatch(
      normalizedPatchFor({ frames: frames16, loopType: 1, loopStartFrames: 4, loopLengthFrames: 8 }),
    );

    expect(() =>
      instrument.noteOnAtTime(60, 127, 0, { trackIndex: 0 }),
    ).not.toThrow();
    expect(sources[0]!.loop).toBe(true);
  });

  it('assigns the buffer once from noteOn', async () => {
    const { instrument, sources } = makeHarness();
    await instrument.loadPatch(
      normalizedPatchFor({ frames: frames16, loopType: 1, loopStartFrames: 4, loopLengthFrames: 8 }),
    );

    expect(() => instrument.noteOn(60, 127)).not.toThrow();
    expect(sources[0]!.loop).toBe(true);
  });

  it('assigns the buffer once for a note pitched into a filtered copy', async () => {
    // Two octaves up selects a mipmap level, which is the case that made the
    // buffer choice late enough to collide with the default assignment.
    setSampleQuality({ oversampleFactor: 4, antiAliasHighNotes: true });
    const { instrument } = makeHarness();
    await instrument.loadPatch(
      normalizedPatchFor({ frames: frames16, loopType: 0 }),
    );

    expect(() =>
      instrument.noteOnAtTime(96, 127, 0, { trackIndex: 0 }),
    ).not.toThrow();
  });
});

describe('loop geometry survives oversampling', () => {
  const FACTOR = 4;

  /**
   * Load the same sample at a given oversampling factor and report what the
   * source node ends up playing, in terms that do not depend on the factor:
   * real time, not buffer time.
   */
  async function measure(factor: number) {
    setSampleQuality({
      oversampleFactor: factor,
      removeDcOffset: false,
      loopCrossfadeFrames: 0,
      antiAliasHighNotes: false,
    });

    const { instrument, sources, buffers } = makeHarness();
    await instrument.loadPatch(
      normalizedPatchFor({
        frames: frames16,
        loopType: 1,
        loopStartFrames: 4,
        loopLengthFrames: 8,
      }),
    );
    instrument.noteOnAtTime(60, 127, 0, {
      trackIndex: 0,
      sampleOffsetFrames: 8,
    });

    const source = sources[0]!;
    const rate = (source as unknown as { playbackRate: { value: number } })
      .playbackRate.value;
    const startCall = (
      source as unknown as { start: { mock: { calls: number[][] } } }
    ).start.mock.calls[0]!;

    return {
      bufferFrames: buffers[0]!.length,
      rate,
      // Buffer time divided by the rate it is read at is real time, which is
      // what a listener hears.
      loopSeconds: (source.loopEnd - source.loopStart) / rate,
      loopStartSeconds: source.loopStart / rate,
      offsetSeconds: (startCall[1] ?? 0) / rate,
    };
  }

  it('changes nothing that is audible', async () => {
    const plain = await measure(1);
    const oversampled = await measure(FACTOR);

    // The buffer really is bigger and really is read faster...
    expect(oversampled.bufferFrames).toBe(plain.bufferFrames * FACTOR);
    expect(oversampled.rate).toBeCloseTo(plain.rate * FACTOR, 9);

    // ...and none of that reaches the listener: same loop, in the same place,
    // for the same length of time, and the same 9xx start point.
    expect(oversampled.loopSeconds).toBeCloseTo(plain.loopSeconds, 9);
    expect(oversampled.loopStartSeconds).toBeCloseTo(plain.loopStartSeconds, 9);
    expect(oversampled.offsetSeconds).toBeCloseTo(plain.offsetSeconds, 9);
  });

  it('puts the loop where the file asked, in real time', async () => {
    const { loopSeconds, loopStartSeconds } = await measure(FACTOR);
    const { rate } = await measure(1);

    // Four frames in, eight frames long, at the rate this note plays.
    expect(loopStartSeconds).toBeCloseTo(4 / 44100 / rate, 9);
    expect(loopSeconds).toBeCloseTo(8 / 44100 / rate, 9);
  });
});

/**
 * The anti-aliased copies played above the sample's own pitch are filtered
 * from the conditioned data, so a ping-pong loop has to be materialised there
 * too. Mirroring only the level-0 buffer left every copy above it shorter than
 * the loop the source node was told to play; the browser clamps `loopEnd` to
 * the buffer it is given, so the mirrored half vanished and the note looped
 * forwards over a hard seam -- audible on exactly the high notes that already
 * needed the filtering.
 */
describe('anti-aliased copies of a ping-pong loop', () => {
  it('still spans the mirrored region for a note above the root', async () => {
    setSampleQuality({
      oversampleFactor: 1,
      removeDcOffset: false,
      loopCrossfadeFrames: 0,
      antiAliasHighNotes: true,
    });

    const { instrument, sources, buffers } = makeHarness();
    await instrument.loadPatch(
      normalizedPatchFor({
        frames: frames16,
        loopType: 2,
        loopStartFrames: 4,
        loopLengthFrames: 8,
      }),
    );
    // Well above the sample's own pitch (XM roots sit around note 89), which
    // selects a filtered copy rather than the plain buffer.
    instrument.noteOnAtTime(108, 127, 0, { trackIndex: 0 });

    const source = sources[0]!;
    const played = (source as unknown as { buffer: { length: number } }).buffer;

    // A filtered copy really was built and handed to the note...
    expect(buffers.length).toBeGreaterThan(2);
    expect(played).not.toBe(buffers[0]!);
    // ...and it is the mirrored length, so the loop the node was given fits.
    expect(played.length).toBe(20);
    expect(source.loopEnd).toBeCloseTo(20 / 44100, 9);
    expect(source.loopEnd).toBeLessThanOrEqual(played.length / 44100);
  });
});
