import { describe, it, expect, vi } from 'vitest';
import ModInstrument from 'src/audio/mod-instrument';

/**
 * ModInstrument is the default MOD playback path, and it applies 9xx by
 * passing an offset to AudioBufferSourceNode.start(when, offset) -- the only
 * way to honour it, since a buffer source cannot be repositioned after it
 * starts. These tests capture the actual start() arguments.
 *
 * The offset arrives in sample *frames* (ProTracker 9xx = param * 256), not
 * as a fraction of the sample: 9xx is an absolute distance into the sample
 * and has nothing to do with how long the sample is.
 */
interface StartCall {
  when: number | undefined;
  offset: number | undefined;
}

function makeInstrument(durationSeconds = 2, sampleRate = 8000) {
  const startCalls: StartCall[] = [];

  const makeSource = () => ({
    buffer: null as unknown,
    loop: false,
    loopStart: 0,
    loopEnd: 0,
    playbackRate: { value: 1, setValueAtTime: vi.fn() },
    connect: vi.fn(),
    disconnect: vi.fn(),
    stop: vi.fn(),
    start: (when?: number, offset?: number) => {
      startCalls.push({ when, offset });
    },
    onended: null as unknown,
  });

  const audioContext = {
    currentTime: 0,
    createBufferSource: makeSource,
    createGain: () => ({
      gain: { value: 1, setValueAtTime: vi.fn() },
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

  // Bypass loadPatch(), which needs real encoded audio.
  Reflect.set(instrument as object, 'audioBuffer', {
    duration: durationSeconds,
    sampleRate,
    length: durationSeconds * sampleRate,
  });
  Reflect.set(instrument as object, 'sampleFrames', durationSeconds * sampleRate);
  Reflect.set(instrument as object, 'samplerState', {
    gain: 1,
    loopMode: 0,
    loopStart: 0,
    loopEnd: 1,
    rootNote: 65,
    sampleRate,
  });
  Reflect.set(instrument as object, 'ready', true);

  return { instrument, startCalls };
}

describe('ModInstrument 9xx sample offset', () => {
  it('starts the source at the frame the offset names', () => {
    // 8000 Hz x 2 s = 16000 frames. A 9xx of 0x20 is 32 * 256 = 8192 frames
    // in, i.e. 1.024 s -- which is *not* 0x20/255 of the sample (0.25 s), the
    // fraction the old code computed.
    const { instrument, startCalls } = makeInstrument(2, 8000);

    instrument.noteOnAtTime(60, 127, 0, { sampleOffsetFrames: 0x20 * 256 });

    expect(startCalls).toHaveLength(1);
    expect(startCalls[0]!.offset).toBeCloseTo(8192 / 8000, 6);
  });

  it('is independent of the sample length', () => {
    // The same parameter names the same position in a much longer sample.
    const { instrument, startCalls } = makeInstrument(10, 8000);

    instrument.noteOnAtTime(60, 127, 0, { sampleOffsetFrames: 0x20 * 256 });

    expect(startCalls[0]!.offset).toBeCloseTo(8192 / 8000, 6);
  });

  it('starts from the beginning when no offset is given', () => {
    const { instrument, startCalls } = makeInstrument(2);

    instrument.noteOnAtTime(60, 127, 0);

    expect(startCalls).toHaveLength(1);
    expect(startCalls[0]!.offset).toBeUndefined();
  });

  it('drops into the loop when the offset runs past the sample', () => {
    // ProTracker clamps the remaining one-shot length to a single word when
    // the offset overruns, so the channel falls straight into the loop.
    const { instrument, startCalls } = makeInstrument(2, 8000);
    Reflect.set(instrument as object, 'loopEnabled', true);
    Reflect.set(instrument as object, 'loopStartSeconds', 0.25);

    instrument.noteOnAtTime(60, 127, 0, { sampleOffsetFrames: 999_999 });

    expect(startCalls[0]!.offset).toBeCloseTo(0.25, 6);
  });

  it('starts an unlooped sample just inside the end when the offset overruns', () => {
    // Starting exactly at (or past) the end yields a node that produces
    // nothing and never fires onended, leaking the voice.
    const { instrument, startCalls } = makeInstrument(2, 8000);

    instrument.noteOnAtTime(60, 127, 0, { sampleOffsetFrames: 999_999 });

    const offset = startCalls[0]!.offset as number;
    expect(offset).toBeLessThan(2);
    expect(offset).toBeCloseTo(2 - 1 / 8000, 6);
  });

  it('does not latch a macro-1 offset onto the next note', () => {
    // A 9xx row with no note is silent in ProTracker -- it only updates the
    // channel's offset memory. Latching it here applied it to whatever note
    // came next, including notes on other channels carrying no 9xx at all,
    // which starts the sample mid-waveform and clicks.
    const { instrument, startCalls } = makeInstrument(2);

    instrument.setVoiceMacroAtTime(0, 1, 0.25, 0);
    instrument.noteOnAtTime(60, 127, 0);

    expect(startCalls[0]!.offset).toBeUndefined();
  });

  it('still routes macro 0 to panning', () => {
    // Guard against "fixing" macro 1 by breaking the pan route.
    const { instrument } = makeInstrument(2);
    instrument.noteOnAtTime(60, 127, 0, { pan: 0.5 });

    expect(() => instrument.setVoiceMacroAtTime(0, 0, 1, 0)).not.toThrow();
  });
});
