import { describe, it, expect, vi } from 'vitest';
import ModInstrument from 'src/audio/mod-instrument';

/**
 * A tracker channel has no polyphony: a new note ends the previous note on
 * that channel rather than releasing it.
 *
 * These are two different operations that had been conflated. Key-off runs the
 * envelope release and the fadeout, and the note is meant to ring on. A new
 * note must cut. Using the release path for replacement left the previous note
 * sounding underneath the new one for the whole fadeout - seconds, on XM.
 *
 * The case that exposed it was a channel switching instrument: the old
 * instrument's voice went into its own releasing set and nothing on the new
 * instrument ever came back to stop it.
 */
function harness() {
  const stops: Array<number | undefined> = [];
  const gainRamps: Array<{ value: number; time: number }> = [];
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
      stop: (when?: number) => stops.push(when),
      start: vi.fn(),
      onended: null as unknown,
    }),
    createGain: () => {
      gainNodes++;
      const isChannel = gainNodes === 2; // output node is first
      return {
        gain: {
          value: 1,
          setValueAtTime: vi.fn(),
          linearRampToValueAtTime: (value: number, time: number) => {
            if (isChannel) gainRamps.push({ value, time });
          },
          cancelScheduledValues: vi.fn(),
          cancelAndHoldAtTime: vi.fn(),
        },
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
      // A slow fadeout, so a release and a cut are clearly distinguishable.
      fadeout: 128,
    },
  });

  return { instrument, stops, gainRamps };
}

describe('cutting a voice for replacement', () => {
  it('stops promptly rather than running the fadeout', () => {
    const { instrument, stops } = harness();
    const voice = instrument.noteOnAtTime(60, 127, 0, {
      tickSeconds: 0.02,
      trackIndex: 0,
    })!;
    stops.length = 0;

    instrument.cutVoiceAtTime(voice, 1.0);

    // 32768/128 = 256 ticks = 5.12s of fadeout. A cut must be a few
    // milliseconds, not that.
    expect(stops).toHaveLength(1);
    expect(stops[0]!).toBeGreaterThanOrEqual(1.0);
    expect(stops[0]!).toBeLessThan(1.05);
  });

  it('ramps the channel gain down to avoid a click', () => {
    const { instrument, gainRamps } = harness();
    const voice = instrument.noteOnAtTime(60, 127, 0, {
      tickSeconds: 0.02,
      trackIndex: 0,
    })!;
    gainRamps.length = 0;

    instrument.cutVoiceAtTime(voice, 1.0);

    const toZero = gainRamps.find((r) => r.value === 0);
    expect(toZero).toBeDefined();
    expect(toZero!.time).toBeGreaterThan(1.0);
  });

  it('also cuts a voice that is already releasing', () => {
    // A channel keyed off and then replaced must still be silenced; the
    // release alone would leave it ringing under the new note.
    const { instrument, stops } = harness();
    const voice = instrument.noteOnAtTime(60, 127, 0, {
      tickSeconds: 0.02,
      trackIndex: 0,
    })!;
    instrument.gateOffVoiceAtTime(voice, 0.5);
    stops.length = 0;

    instrument.cutVoiceAtTime(voice, 1.0);

    expect(stops).toHaveLength(1);
    expect(stops[0]!).toBeLessThan(1.05);
  });

  it('does nothing for a voice that was never started', () => {
    const { instrument, stops } = harness();
    instrument.cutVoiceAtTime(3, 1.0);
    expect(stops).toHaveLength(0);
  });

  it('leaves key-off as a release rather than a cut', () => {
    // Guard against "fixing" replacement by making every stop immediate.
    const { instrument, stops } = harness();
    const voice = instrument.noteOnAtTime(60, 127, 0, {
      tickSeconds: 0.02,
      trackIndex: 0,
    })!;
    stops.length = 0;

    instrument.gateOffVoiceAtTime(voice, 1.0);

    expect(stops).toHaveLength(1);
    // Fadeout capped at 10s, so the note rings well past the cut window.
    expect(stops[0]!).toBeGreaterThan(2);
  });
});
