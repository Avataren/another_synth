import { describe, it, expect, vi } from 'vitest';
import { ref, computed } from 'vue';
import {
  useTrackerExport,
  type TrackerExportContext,
} from 'src/composables/useTrackerExport';

vi.mock('src/audio/tracker/exporter', () => ({
  encodeRecordingToMp3: vi.fn(async () => new Blob([])),
}));

/**
 * The playback store re-applies its own loop flag to the engine on every song
 * load, so an export that switched looping off on the engine alone had it
 * switched back on by `initializePlayback`, and the recording ran into a
 * second pass of the song.
 */
describe('MP3 export loop handling', () => {
  it('records a single pass even though loading re-applies the store flag', async () => {
    let storeLoop = true;
    const engineLoop = { value: true };
    const seenAtPlay: boolean[] = [];

    const listeners: Array<(s: string) => void> = [];
    const engine = {
      setLoopSong: (l: boolean) => {
        engineLoop.value = l;
      },
      stop: vi.fn(),
      seek: vi.fn(),
      on: (event: string, cb: (s: string) => void) => {
        if (event === 'state') listeners.push(cb);
        return () => {};
      },
      play: vi.fn(async () => {
        seenAtPlay.push(engineLoop.value);
        // The song plays once and the engine reports it stopped.
        queueMicrotask(() => listeners.forEach((cb) => cb('stopped')));
      }),
    };

    const context = {
      getPlaybackEngine: () => engine,
      songBank: {
        cancelAllScheduled: vi.fn(),
        allNotesOff: vi.fn(),
        startRecording: vi.fn(async () => {}),
        stopRecording: vi.fn(async () => ({
          interleaved: new Float32Array(0),
          sampleRate: 48000,
        })),
      },
      rowsCount: ref(64),
      currentSong: ref({ title: '', author: '', bpm: 125 }),
      sequence: ref(['a']),
      patterns: ref([{ id: 'a', rows: 64 }]),
      currentPatternId: ref('a'),
      currentPattern: computed(() => undefined),
      playbackMode: ref('song'),
      activeRow: ref(0),
      playbackRow: ref(0),
      getLoopSong: () => storeLoop,
      setLoopSong: (l: boolean) => {
        storeLoop = l;
        engine.setLoopSong(l);
      },
      syncSongBankFromSlots: async () => {},
      // What the real store does on load.
      initializePlayback: async () => {
        engine.setLoopSong(storeLoop);
        return true;
      },
    } as unknown as TrackerExportContext;

    // jsdom has no anchor download / object URLs.
    globalThis.URL.createObjectURL = vi.fn(() => 'blob:x');
    globalThis.URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    vi.useFakeTimers();

    const { exportSongToMp3, exportStage } = useTrackerExport(context);
    const done = exportSongToMp3();
    await vi.runAllTimersAsync();
    await done;
    vi.useRealTimers();

    expect(exportStage.value).toBe('done');
    expect(seenAtPlay).toEqual([false]);
    // The user's own setting (looping on) is back afterwards.
    expect(storeLoop).toBe(true);
    expect(engineLoop.value).toBe(true);
  });
});
