/**
 * Deep-link fix: songs must load fully while the AudioContext is suspended
 * (fresh tab, no user gesture); only playback depends on a running context.
 *
 * The mocks mirror the real browser behaviour that motivated this fix: on a
 * fresh tab, `AudioContext.resume()` returns a promise that stays pending
 * until the user interacts — it neither resolves nor rejects. On the old
 * code, `applySongFile` awaited that promise unconditionally and hung, and
 * `syncSlots` deferred instrument construction entirely; both tests time out
 * (i.e. FAIL) against main and pass after the fix.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ref } from 'vue';
import { setActivePinia, createPinia } from 'pinia';
import { useTrackerFileIO } from 'src/composables/useTrackerFileIO';
import type { TrackerFileIOContext } from 'src/composables/useTrackerFileIO';
import type { TrackerSongFile } from 'src/stores/tracker-store';
import type AudioSystem from 'src/audio/AudioSystem';
import { TrackerSongBank } from 'src/audio/tracker/song-bank';

/**
 * A suspended AudioContext whose resume() behaves like a real browser's on a
 * fresh tab without a user gesture: the promise never settles.
 */
function makeSuspendedAudioContext() {
  const gainNode = {
    gain: { value: 1 },
    connect: vi.fn(),
    numberOfOutputs: 1,
  };
  return {
    state: 'suspended' as AudioContextState,
    currentTime: 0,
    sampleRate: 48000,
    resume: () => new Promise<void>(() => undefined),
    createGain: () => ({ ...gainNode }),
    destination: gainNode,
  };
}

function makeSongFile(): TrackerSongFile {
  return {
    version: '3',
    data: {
      currentSong: { title: 'Deep Link Test', author: '', bpm: 125 },
      patternRows: 64,
      stepSize: 4,
      patterns: [],
      sequence: [],
    },
  } as unknown as TrackerSongFile;
}

function makeFileIOContext(
  audioContext: ReturnType<typeof makeSuspendedAudioContext>,
): TrackerFileIOContext {
  const trackerStore = {
    loadSongFile: vi.fn(),
    instrumentSlots: [],
    moduleFormat: 'protracker',
    linearFrequency: false,
    amigaLimits: false,
  };
  const songBank = {
    audioContext,
    resetForNewSong: vi.fn(),
    setModuleFormat: vi.fn(),
  };
  return {
    trackerStore: trackerStore as unknown as TrackerFileIOContext['trackerStore'],
    songBank: songBank as unknown as TrackerSongBank,
    currentSong: ref({ title: '', author: '', bpm: 125 }),
    playbackMode: ref<'pattern' | 'song'>('song'),
    isLoadingSong: ref(false),
    ensureActiveInstrument: vi.fn(),
    syncSongBankFromSlots: vi.fn().mockResolvedValue(undefined),
    initializePlayback: vi.fn().mockResolvedValue(true),
    stopPlayback: vi.fn(),
    resetSequenceIndex: vi.fn(),
  };
}

describe('song load with a suspended AudioContext (deep-link fix)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('applySongFile completes and loads the song while the context is suspended', async () => {
    const ctx = makeFileIOContext(makeSuspendedAudioContext());
    const fileIO = useTrackerFileIO(ctx);
    const songFile = makeSongFile();

    // On the pre-fix code this never settles: applySongFile awaits
    // audioContext.resume(), whose promise stays pending without a gesture.
    await fileIO.applySongFile(songFile);

    expect(ctx.trackerStore.loadSongFile).toHaveBeenCalledWith(songFile);
    expect(ctx.ensureActiveInstrument).toHaveBeenCalled();
    expect(ctx.songBank.setModuleFormat).toHaveBeenCalled();
    expect(ctx.syncSongBankFromSlots).toHaveBeenCalled();
    expect(ctx.initializePlayback).toHaveBeenCalledWith('song', false);
    expect(ctx.isLoadingSong.value).toBe(false);
  });

  it('syncSlots builds instruments instead of deferring while suspended', async () => {
    const audioContext = makeSuspendedAudioContext();
    const bank = new TrackerSongBank({
      audioContext,
      destinationNode: { connect: vi.fn(), numberOfOutputs: 1 },
    } as unknown as AudioSystem);

    const ensureInstrument = vi
      .spyOn(
        bank as unknown as {
          ensureInstrument: (id: string, patch: unknown) => Promise<void>;
        },
        'ensureInstrument',
      )
      .mockResolvedValue(undefined);

    const patch = { metadata: { id: 'patch-1' } };
    // On the pre-fix code this never settles either: syncSlots awaited
    // ensureAudioContextRunning(), whose first await on resume() hangs
    // without a gesture, then deferred all construction.
    await bank.syncSlots([
      { instrumentId: 'inst-01', patch: patch as never },
    ]);

    expect(ensureInstrument).toHaveBeenCalledWith('inst-01', patch);
    expect(
      (bank as unknown as { needsAudioContextResume: boolean })
        .needsAudioContextResume,
    ).toBe(true);
  });
});
