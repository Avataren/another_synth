import { describe, it, expect, vi } from 'vitest';
import ModInstrument from 'src/audio/mod-instrument';

/**
 * Regression coverage for the tracker "tone portamento gets stuck" bug.
 *
 * Root cause: setVoiceFrequencyAtTime used to read `playbackRate.value`
 * synchronously and anchor a fixed 5ms ramp to it. Tracker playback
 * schedules a whole row's worth of ticks synchronously, ahead of real
 * time, so `.value` never reflected not-yet-executed scheduled changes --
 * every tick's ramp started from a stale value, producing a discontinuous
 * jump-then-plateau instead of a smooth slide.
 *
 * The fix schedules directly on the native AudioParam (mirroring
 * PooledInstrument.setVoiceFrequencyAtTime) and never reads `.value`.
 */

// A minimal AudioParam mock that records every scheduling call in order,
// without needing a real AudioContext.
function createMockAudioParam(initialValue = 1) {
  const calls: Array<{ method: string; value: number; time: number }> = [];
  const param = {
    value: initialValue,
    setValueAtTime: vi.fn((value: number, time: number) => {
      calls.push({ method: 'setValueAtTime', value, time });
      param.value = value;
      return param;
    }),
    linearRampToValueAtTime: vi.fn((value: number, time: number) => {
      calls.push({ method: 'linearRampToValueAtTime', value, time });
      param.value = value;
      return param;
    }),
    exponentialRampToValueAtTime: vi.fn((value: number, time: number) => {
      calls.push({ method: 'exponentialRampToValueAtTime', value, time });
      param.value = value;
      return param;
    }),
  };
  return { param, calls };
}

const createMockAudioContext = () =>
  ({
    currentTime: 0,
    createGain: () => ({
      gain: { value: 1 },
      connect: vi.fn(),
      disconnect: vi.fn(),
    }),
  }) as unknown as AudioContext;

/** Builds a ModInstrument and injects a fake active voice, bypassing the
 * full loadPatch()/noteOn() machinery (which needs real decoded audio). */
function makeInstrumentWithVoice(voiceIndex = 0) {
  const instrument = new ModInstrument(
    { connect: vi.fn() } as unknown as AudioNode,
    createMockAudioContext(),
  );
  const { param: playbackRate, calls } = createMockAudioParam(1);
  const activeVoices = Reflect.get(
    instrument as object,
    'activeVoices',
  ) as Map<number, { source: { playbackRate: unknown }; frequency: number }>;
  activeVoices.set(voiceIndex, {
    source: { playbackRate },
    gainNode: {} as unknown as GainNode,
    panNode: {} as unknown as StereoPannerNode,
    noteNumber: 60,
    startTime: 0,
    frequency: 440,
    targetGain: 1,
  } as never);

  return { instrument, calls };
}

describe('ModInstrument.setVoiceFrequencyAtTime', () => {
  it('schedules setValueAtTime at the exact given time when no rampMode is given', () => {
    const { instrument, calls } = makeInstrumentWithVoice();

    instrument.setVoiceFrequencyAtTime(0, 880, 12.345);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('setValueAtTime');
    expect(calls[0]!.time).toBe(12.345);
  });

  it('schedules linearRampToValueAtTime at the exact given time for rampMode "linear"', () => {
    const { instrument, calls } = makeInstrumentWithVoice();

    instrument.setVoiceFrequencyAtTime(0, 880, 12.345, 'linear');

    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('linearRampToValueAtTime');
    expect(calls[0]!.time).toBe(12.345);
  });

  it('schedules exponentialRampToValueAtTime at the exact given time for rampMode "exponential"', () => {
    const { instrument, calls } = makeInstrumentWithVoice();

    instrument.setVoiceFrequencyAtTime(0, 880, 12.345, 'exponential');

    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('exponentialRampToValueAtTime');
    expect(calls[0]!.time).toBe(12.345);
  });

  it('never reads playbackRate.value before scheduling (no stale-value reset)', () => {
    const { instrument, calls } = makeInstrumentWithVoice();

    // Simulate a sequence of tracker ticks for a tone-portamento slide,
    // all scheduled synchronously ahead of real time (currentTime stays 0
    // throughout, exactly like look-ahead scheduling does).
    instrument.setVoiceFrequencyAtTime(0, 445, 1.0, 'linear');
    instrument.setVoiceFrequencyAtTime(0, 450, 1.02, 'linear');
    instrument.setVoiceFrequencyAtTime(0, 455, 1.04, 'linear');

    // Exactly one scheduling call per tick -- no extra setValueAtTime
    // "reset to stale current value" call is inserted before each ramp.
    expect(calls).toHaveLength(3);
    expect(calls.every((c) => c.method === 'linearRampToValueAtTime')).toBe(
      true,
    );
    expect(calls.map((c) => c.time)).toEqual([1.0, 1.02, 1.04]);
  });
});
