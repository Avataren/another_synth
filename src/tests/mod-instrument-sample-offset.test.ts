import { describe, it, expect, vi } from 'vitest';
import ModInstrument from 'src/audio/mod-instrument';

/**
 * ModInstrument is the default MOD playback path, and it applies 9xx by
 * passing an offset to AudioBufferSourceNode.start(when, offset) -- the only
 * way to honour it, since a buffer source cannot be repositioned after it
 * starts. These tests capture the actual start() arguments.
 */
interface StartCall {
  when?: number;
  offset?: number;
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
  it('starts the source at the offset position when one is given', () => {
    const { instrument, startCalls } = makeInstrument(2);

    instrument.noteOnAtTime(60, 127, 0, { sampleOffset: 0.5 });

    expect(startCalls).toHaveLength(1);
    // Half way into a 2 second buffer.
    expect(startCalls[0]!.offset).toBeCloseTo(1.0, 5);
  });

  it('starts from the beginning when no offset is given', () => {
    const { instrument, startCalls } = makeInstrument(2);

    instrument.noteOnAtTime(60, 127, 0);

    expect(startCalls).toHaveLength(1);
    expect(startCalls[0]!.offset).toBeUndefined();
  });

  it('clamps an offset at or past the end to just inside the buffer', () => {
    // Starting exactly at (or past) the end yields a node that produces
    // nothing and never fires onended for looped samples, leaking the voice.
    const { instrument, startCalls } = makeInstrument(2, 8000);

    instrument.noteOnAtTime(60, 127, 0, { sampleOffset: 1 });

    const offset = startCalls[0]!.offset as number;
    expect(offset).toBeLessThan(2);
    expect(offset).toBeCloseTo(2 - 1 / 8000, 6);
  });

  it('consumes an offset set via macro 1 on the next note', () => {
    // A 9xx row carrying no note arrives as macro automation; ProTracker
    // remembers it per channel and applies it to the next note.
    const { instrument, startCalls } = makeInstrument(2);

    instrument.setVoiceMacroAtTime(0, 1, 0.25, 0);
    instrument.noteOnAtTime(60, 127, 0);

    expect(startCalls[0]!.offset).toBeCloseTo(0.5, 5);
  });

  it('does not reapply a consumed offset to a later note', () => {
    const { instrument, startCalls } = makeInstrument(2);

    instrument.setVoiceMacroAtTime(0, 1, 0.25, 0);
    instrument.noteOnAtTime(60, 127, 0);
    instrument.noteOnAtTime(62, 127, 0);

    expect(startCalls[0]!.offset).toBeCloseTo(0.5, 5);
    expect(startCalls[1]!.offset).toBeUndefined();
  });

  it('still routes macro 0 to panning', () => {
    // Guard against "fixing" macro 1 by breaking the pan route.
    const { instrument } = makeInstrument(2);
    instrument.noteOnAtTime(60, 127, 0, { pan: 0.5 });

    expect(() => instrument.setVoiceMacroAtTime(0, 0, 1, 0)).not.toThrow();
  });
});
