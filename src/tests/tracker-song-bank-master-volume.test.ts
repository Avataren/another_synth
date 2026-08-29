import { describe, it, expect, vi } from 'vitest';
import { TrackerSongBank } from 'src/audio/tracker/song-bank';
import type AudioSystem from 'src/audio/AudioSystem';

/**
 * Regression coverage for "load one song, play it a bit, then load another
 * song and sometimes get no sound".
 *
 * Root cause: tracker look-ahead scheduling schedules effect automation
 * (including Gxx/Hxy global-volume commands) on masterGain.gain up to
 * several seconds ahead of real playback time. Stopping playback -- e.g.
 * to load a different song -- only ever cancelled per-instrument voice
 * automation (see TrackerSongBank.cancelAllScheduled ->
 * instrument.cancelScheduledNotes); nothing ever cancelled a
 * still-pending scheduled ramp on masterGain.gain itself. If playback was
 * stopped while a Gxx/Hxy-driven master-gain ramp was still queued in the
 * future, that automation event fired later regardless of what song was
 * now loaded -- silently (or partially) muting the *new* song. Because
 * this only happens when a fade/global-volume change happened to still be
 * pending at the exact moment playback stopped, it reproduced
 * intermittently ("sometimes I can load many songs and it's fine").
 *
 * Fix: TrackerSongBank now tracks the user's explicit master-volume choice
 * separately (setUserMasterVolume) and restores masterGain.gain to that
 * baseline -- cancelling any pending scheduled ramp first -- whenever
 * playback is stopped (cancelAllScheduled) or a new song is loaded
 * (resetForNewSong).
 */

function createMockAudioSystem() {
  const cancelScheduledValues = vi.fn();
  const setValueAtTime = vi.fn();
  const gain = {
    value: 1,
    cancelScheduledValues,
    setValueAtTime,
  };
  const gainNode = {
    gain,
    connect: vi.fn(),
    disconnect: vi.fn(),
    numberOfOutputs: 1,
  };
  const audioContext = {
    sampleRate: 48000,
    currentTime: 5, // pretend some time has already passed (mid-song)
    state: 'running' as const,
    createGain: () => gainNode,
    destination: gainNode,
    onstatechange: null as unknown,
  };

  return {
    system: {
      audioContext,
      destinationNode: { connect: vi.fn(), numberOfOutputs: 1 },
    },
    gain,
    audioContext,
  };
}

describe('TrackerSongBank master volume restoration', () => {
  it('cancelAllScheduled cancels pending master-gain automation and restores the user baseline', () => {
    const { system, gain } = createMockAudioSystem();
    const bank = new TrackerSongBank(system as unknown as AudioSystem);

    bank.setUserMasterVolume(0.75);
    gain.cancelScheduledValues.mockClear();
    gain.setValueAtTime.mockClear();

    // Simulate a song's Gxx/Hxy effect having scheduled a future fade,
    // as the look-ahead scheduler would.
    bank.setMasterVolume(0.1, system.audioContext.currentTime + 3);

    bank.cancelAllScheduled();

    // The pending fade must be cancelled...
    expect(gain.cancelScheduledValues).toHaveBeenCalledWith(
      system.audioContext.currentTime,
    );
    // ...and gain restored to the user's chosen baseline, not left at
    // whatever the song's effect last set it to.
    const lastCall =
      gain.setValueAtTime.mock.calls[gain.setValueAtTime.mock.calls.length - 1];
    expect(lastCall).toEqual([0.75, system.audioContext.currentTime]);
  });

  it('resetForNewSong cancels pending master-gain automation and restores the user baseline', () => {
    const { system, gain } = createMockAudioSystem();
    const bank = new TrackerSongBank(system as unknown as AudioSystem);

    bank.setUserMasterVolume(0.5);
    gain.cancelScheduledValues.mockClear();
    gain.setValueAtTime.mockClear();

    bank.setMasterVolume(0.05, system.audioContext.currentTime + 5);

    bank.resetForNewSong();

    expect(gain.cancelScheduledValues).toHaveBeenCalledWith(
      system.audioContext.currentTime,
    );
    const lastCall =
      gain.setValueAtTime.mock.calls[gain.setValueAtTime.mock.calls.length - 1];
    expect(lastCall).toEqual([0.5, system.audioContext.currentTime]);
  });

  it('setMasterVolume (the effect-driven path) does not change the remembered user baseline', () => {
    const { system, gain } = createMockAudioSystem();
    const bank = new TrackerSongBank(system as unknown as AudioSystem);

    bank.setUserMasterVolume(0.9);
    // A song effect temporarily lowers the master volume mid-playback.
    bank.setMasterVolume(0.2);
    gain.setValueAtTime.mockClear();

    // Stopping playback must restore 0.9 (the user's choice), not 0.2
    // (the last effect-driven value).
    bank.cancelAllScheduled();
    const lastCall =
      gain.setValueAtTime.mock.calls[gain.setValueAtTime.mock.calls.length - 1];
    expect(lastCall?.[0]).toBe(0.9);
  });
});

/**
 * The song's global volume and the user's master level are independent: the
 * song says how loud this moment is relative to the rest of itself, the user
 * says how loud the app is. What reaches masterGain is the product.
 *
 * Writing the song's value straight onto the gain made every module that
 * touched Gxx override the user's setting outright -- and made a module that
 * never touches it override the setting anyway, because looping the song
 * restores global volume to full. sweetdre.xm is 24 channels with no Gxx at
 * all: at the wrap the master jumped from the user's 50% to 100% and clipped.
 */
describe('song global volume scales the user baseline', () => {
  const lastGain = (gain: { setValueAtTime: { mock: { calls: unknown[][] } } }) =>
    gain.setValueAtTime.mock.calls[gain.setValueAtTime.mock.calls.length - 1]?.[0];

  it('multiplies rather than replaces', () => {
    const { system, gain } = createMockAudioSystem();
    const bank = new TrackerSongBank(system as unknown as AudioSystem);

    bank.setUserMasterVolume(0.5);
    bank.setMasterVolume(0.5); // the song asks for half

    expect(lastGain(gain)).toBeCloseTo(0.25, 10);
  });

  it('restoring full song volume does not exceed the user level', () => {
    // The restart path: a song looping back to the start pushes global volume
    // 1.0, which must land on the user's level and not above it.
    const { system, gain } = createMockAudioSystem();
    const bank = new TrackerSongBank(system as unknown as AudioSystem);

    bank.setUserMasterVolume(0.5);
    bank.setMasterVolume(1.0);

    expect(lastGain(gain)).toBeCloseTo(0.5, 10);
  });

  it('keeps the song volume when the user moves the slider mid-song', () => {
    const { system, gain } = createMockAudioSystem();
    const bank = new TrackerSongBank(system as unknown as AudioSystem);

    bank.setUserMasterVolume(0.8);
    bank.setMasterVolume(0.5); // song is halfway through a fade
    bank.setUserMasterVolume(0.4);

    expect(lastGain(gain)).toBeCloseTo(0.2, 10);
  });

  it('forgets the previous song global volume when a new song loads', () => {
    // Otherwise a song stopped mid-fade would scale the next song down.
    const { system, gain } = createMockAudioSystem();
    const bank = new TrackerSongBank(system as unknown as AudioSystem);

    bank.setUserMasterVolume(0.5);
    bank.setMasterVolume(0.1);
    bank.resetForNewSong();
    bank.setUserMasterVolume(0.5);

    expect(lastGain(gain)).toBeCloseTo(0.5, 10);
  });
});
