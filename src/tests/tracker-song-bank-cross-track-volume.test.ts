import { describe, it, expect, vi } from 'vitest';
import { TrackerSongBank } from 'src/audio/tracker/song-bank';
import type AudioSystem from 'src/audio/AudioSystem';

/**
 * Regression coverage for cross-track volume corruption.
 *
 * Instruments are per-sample, so two tracks playing the same sample share one
 * instrument and its voice pool. When a volume command arrived for a track
 * that had no voice of its own yet, voice resolution fell back to voice 0 --
 * whichever track happened to own it -- and silently rewrote that channel's
 * gain.
 *
 * GSLINGER.MOD pattern 2 is the case that exposed it: channels 1 and 3 both
 * play sample 9, and channel 3's row-0 "C00" (volume zero, no note of its
 * own) landed on channel 1's just-started lead and killed its volume.
 */
const createMockAudioSystem = () => {
  const gainNode = {
    gain: { value: 1 },
    connect: vi.fn(),
    numberOfOutputs: 1,
  };
  return {
    audioContext: {
      sampleRate: 48000,
      currentTime: 0,
      state: 'running' as const,
      createGain: () => ({ ...gainNode }),
      destination: gainNode,
      onstatechange: null as unknown,
    },
    destinationNode: { connect: vi.fn(), numberOfOutputs: 1 },
  };
};

function makeBank() {
  const bank = new TrackerSongBank(
    createMockAudioSystem() as unknown as AudioSystem,
  );

  const setVoiceGainAtTime = vi.fn();
  const setVoiceMacroAtTime = vi.fn();
  const instrument = {
    getVoiceLimit: () => 4,
    setVoiceGainAtTime,
    setVoiceMacroAtTime,
    getQuantumDurationSeconds: () => 128 / 48000,
  };

  const instruments = Reflect.get(bank as object, 'instruments') as Map<
    string,
    unknown
  >;
  instruments.set('09', {
    instrument,
    patchId: 'p',
    patchReuseKey: null,
    hasPortamento: false,
  });

  const lastTrackVoice = Reflect.get(bank as object, 'lastTrackVoice') as Map<
    string,
    Map<number, number>
  >;

  return { bank, setVoiceGainAtTime, setVoiceMacroAtTime, lastTrackVoice };
}

describe('TrackerSongBank voice resolution across tracks', () => {
  it('does not apply a volume command to another track’s voice', () => {
    const { bank, setVoiceGainAtTime, lastTrackVoice } = makeBank();

    // Track 0 owns voice 0 (its lead just started). Track 2 shares the sample
    // but has nothing sounding yet.
    lastTrackVoice.set('09', new Map([[0, 0]]));

    bank.setVoiceVolumeAtTime('09', -1, 0, 1.0, 2);

    expect(setVoiceGainAtTime).not.toHaveBeenCalled();
  });

  it('still applies a volume command to the track that owns a voice', () => {
    const { bank, setVoiceGainAtTime, lastTrackVoice } = makeBank();
    lastTrackVoice.set('09', new Map([[0, 0]]));

    bank.setVoiceVolumeAtTime('09', -1, 0.5, 1.0, 0);

    expect(setVoiceGainAtTime).toHaveBeenCalledWith(0, 0.5, 1.0, 'linear');
  });

  it('routes each track to its own voice when both are sounding', () => {
    const { bank, setVoiceGainAtTime, lastTrackVoice } = makeBank();
    lastTrackVoice.set(
      '09',
      new Map([
        [0, 0],
        [2, 1],
      ]),
    );

    bank.setVoiceVolumeAtTime('09', -1, 0.25, 1.0, 2);

    expect(setVoiceGainAtTime).toHaveBeenCalledWith(1, 0.25, 1.0, 'linear');
  });

  it('honours an explicit voice index', () => {
    const { bank, setVoiceGainAtTime } = makeBank();

    bank.setVoiceVolumeAtTime('09', 2, 0.75, 1.0, 0);

    expect(setVoiceGainAtTime).toHaveBeenCalledWith(2, 0.75, 1.0, 'linear');
  });

  it('does not apply a 9xx offset to another track’s voice', () => {
    const { bank, setVoiceMacroAtTime, lastTrackVoice } = makeBank();
    lastTrackVoice.set('09', new Map([[0, 0]]));

    bank.setVoiceSampleOffsetAtTime('09', -1, 0.5, 1.0, 2);

    expect(setVoiceMacroAtTime).not.toHaveBeenCalled();
  });
});
