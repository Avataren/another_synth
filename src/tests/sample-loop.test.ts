import { describe, it, expect, vi } from 'vitest';
import ModInstrument from 'src/audio/mod-instrument';
import { importXmToTrackerSong } from 'src/audio/tracker/xm-import';
import { deserializePatch } from 'src/audio/serialization/patch-serializer';
import { SamplerLoopMode } from 'src/audio/types/synth-layout';
import { buildXm, cell } from './helpers/xm-builder';

/**
 * Sample looping, exercised through the real patch pipeline rather than by
 * injecting sampler state — a previous fault in this area survived eleven unit
 * tests precisely because they bypassed normalization.
 *
 * An AudioBufferSourceNode can only loop forwards, so ping-pong loops are
 * materialised at load: the loop region is followed by a reversed copy and the
 * loop spans both halves. 27 samples in the local XM corpus use ping-pong, and
 * they previously failed the `loopMode === 1` check and did not loop at all.
 */
interface SourceRecord {
  loop: boolean;
  loopStart: number;
  loopEnd: number;
}

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
      const source: SourceRecord & Record<string, unknown> = {
        loop: false,
        loopStart: 0,
        loopEnd: 0,
        buffer: null,
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
