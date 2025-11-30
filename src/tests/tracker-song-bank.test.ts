import { describe, it, expect, vi } from 'vitest';
import { TrackerSongBank } from 'src/audio/tracker/song-bank';
import type AudioSystem from 'src/audio/AudioSystem';

// Minimal AudioContext/AudioSystem mocks to satisfy constructor requirements.
const createMockAudioSystem = () => {
  const gainNode = {
    gain: { value: 1 },
    connect: vi.fn(),
    numberOfOutputs: 1,
  };
  const audioContext = {
    sampleRate: 48000,
    currentTime: 0,
    state: 'running' as const,
    createGain: () => ({ ...gainNode }),
    destination: gainNode,
    onstatechange: null as unknown,
  };

  return {
    audioContext,
    destinationNode: { connect: vi.fn(), numberOfOutputs: 1 },
  };
};

type InstrumentEntry = {
  instrument: {
    getVoiceLimit: () => number;
    setVoiceFrequencyAtTime: ReturnType<typeof vi.fn>;
  };
  patchId: string;
  patchSignature: string | null;
  hasPortamento: boolean;
};

describe('TrackerSongBank.setVoicePitchAtTime', () => {
  it('ignores invalid voice indices and does not broadcast pitch updates', () => {
    const bank = new TrackerSongBank(
      createMockAudioSystem() as unknown as AudioSystem,
    );
    const mutableInstruments = Reflect.get(
      bank as object,
      'instruments',
    ) as Map<string, InstrumentEntry>;
    const instrument = {
      getVoiceLimit: () => 8,
      setVoiceFrequencyAtTime: vi.fn(),
    };

    // Inject a fake active instrument
    mutableInstruments.set('inst', {
      instrument,
      patchId: 'p',
      patchSignature: null,
      hasPortamento: false,
    });

    // Invalid voice index (-1) should be ignored
    bank.setVoicePitchAtTime('inst', -1, 440, 0, 0);
    expect(instrument.setVoiceFrequencyAtTime).not.toHaveBeenCalled();

    // Valid voice index should be forwarded
    bank.setVoicePitchAtTime('inst', 3, 440, 0, 0);
    expect(instrument.setVoiceFrequencyAtTime).toHaveBeenCalledOnce();
    expect(instrument.setVoiceFrequencyAtTime).toHaveBeenCalledWith(3, 440, 0, undefined);
  });

  it('uses track-specific last voice fallback when provided', () => {
    const bank = new TrackerSongBank(
      createMockAudioSystem() as unknown as AudioSystem,
    );
    const mutableInstruments = Reflect.get(
      bank as object,
      'instruments',
    ) as Map<string, InstrumentEntry>;
    const mutableLastTrackVoice = Reflect.get(
      bank as object,
      'lastTrackVoice',
    ) as Map<string, Map<number, number>>;
    const instrument = {
      getVoiceLimit: () => 8,
      setVoiceFrequencyAtTime: vi.fn(),
    };

    // Inject a fake active instrument and track voice history
    mutableInstruments.set('inst', {
      instrument,
      patchId: 'p',
      patchSignature: null,
      hasPortamento: false,
    });
    mutableLastTrackVoice.set(
      'inst',
      new Map([
        [2, 5], // track 2 last voice
        [-1, 6], // global fallback
      ]),
    );

    bank.setVoicePitchAtTime('inst', -1, 440, 0, 2, undefined);
    expect(instrument.setVoiceFrequencyAtTime).toHaveBeenCalledWith(5, 440, 0, undefined);
  });
});
