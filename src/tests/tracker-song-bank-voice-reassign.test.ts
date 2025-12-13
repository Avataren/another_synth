import { describe, it, expect, vi } from 'vitest';
import { TrackerSongBank } from 'src/audio/tracker/song-bank';
import type AudioSystem from 'src/audio/AudioSystem';

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

describe('TrackerSongBank voice tracking across tracks', () => {
  it('reassigns a voice to the new track and clears it from previous tracks', () => {
    const bank = new TrackerSongBank(
      createMockAudioSystem() as unknown as AudioSystem,
    );

    // Seed lastTrackVoice with voice 3 on track 1
    const lastTrackVoice = Reflect.get(bank as object, 'lastTrackVoice') as Map<
      string,
      Map<number, number>
    >;
    const instrumentId = 'inst';
    const map = new Map<number, number>();
    map.set(1, 3);
    lastTrackVoice.set(instrumentId, map);

    // Call private setLastVoiceForTrack via reflection; it should move voice 3 to track 2
    (bank as unknown as {
      setLastVoiceForTrack: (id: string, trackIndex: number, voice: number) => void;
    }).setLastVoiceForTrack(instrumentId, 2, 3);

    const byTrack = lastTrackVoice.get(instrumentId);
    expect(byTrack?.get(1)).toBeUndefined();
    expect(byTrack?.get(2)).toBe(3);
  });
});
