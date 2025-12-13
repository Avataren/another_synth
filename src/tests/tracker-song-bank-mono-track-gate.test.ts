import { describe, it, expect, vi } from 'vitest';
import { TrackerSongBank } from 'src/audio/tracker/song-bank';
import type AudioSystem from 'src/audio/AudioSystem';

type InstrumentEntry = {
  instrument: {
    getVoiceLimit: () => number;
    gateOffVoiceAtTime: ReturnType<typeof vi.fn>;
    cancelAndSilenceVoice: ReturnType<typeof vi.fn>;
    getQuantumDurationSeconds: () => number;
  };
  patchId: string;
  patchSignature: string | null;
  hasPortamento: boolean;
};

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

describe('TrackerSongBank.gateOffOtherTracksForInstrument (mono)', () => {
  it('gates off voices on other tracks for mono patches', () => {
    const bank = new TrackerSongBank(
      createMockAudioSystem() as unknown as AudioSystem,
    );

    const instruments = Reflect.get(bank as object, 'instruments') as Map<
      string,
      {
        instrument: {
          getVoiceLimit: () => number;
          gateOffVoiceAtTime: ReturnType<typeof vi.fn>;
          cancelAndSilenceVoice: ReturnType<typeof vi.fn>;
        };
      }
    >;
    const lastTrackVoice = Reflect.get(bank as object, 'lastTrackVoice') as Map<
      string,
      Map<number, number>
    >;

    const instrument = {
      getVoiceLimit: () => 1,
      gateOffVoiceAtTime: vi.fn(),
      cancelAndSilenceVoice: vi.fn(),
      getQuantumDurationSeconds: () => 0.005,
    };

    const entry: InstrumentEntry = {
      instrument,
      patchId: 'p',
      patchSignature: null,
      hasPortamento: false,
    };
    instruments.set('inst', entry);

    const voices = new Map<number, number>();
    voices.set(1, 2); // track 1 owns voice 2
    lastTrackVoice.set('inst', voices);

    // Call helper via reflection
    (bank as unknown as {
      gateOffOtherTracksForInstrument: (
        id: string,
        trackIndex: number,
        time: number,
      ) => void;
    }).gateOffOtherTracksForInstrument('inst', 2, 1.0);

    expect(instrument.gateOffVoiceAtTime).toHaveBeenCalledWith(2, expect.any(Number));
    // Track 1 should NOT be cleared - voice tracking is preserved until the new note is allocated
    // This prevents a gap where the voice isn't tracked and might linger
    expect(voices.get(1)).toBe(2);
  });
});
