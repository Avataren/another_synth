import { computed, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { useTrackerStore } from 'src/stores/tracker-store';
import { useTrackerAudioStore } from 'src/stores/tracker-audio-store';
import { useTrackerPlaybackStore } from 'src/stores/tracker-playback-store';
import { useUserSettingsStore } from 'src/stores/user-settings-store';
import {
  formatInstrumentId,
  normalizeInstrumentId,
  pickActiveInstrumentId,
} from 'src/audio/tracker/instrument-ids';
import { useTrackerSongBuilder } from 'src/composables/useTrackerSongBuilder';
import type { TrackerSongBuilderContext } from 'src/composables/useTrackerSongBuilder';
import { useTrackerFileIO } from 'src/composables/useTrackerFileIO';
import type { TrackerFileIOContext } from 'src/composables/useTrackerFileIO';
import { useMobileLayout } from 'src/composables/useMobileLayout';
import type { TrackerTrackData } from 'src/components/tracker/tracker-types';

export interface TrackerSongHostOptions {
  /**
   * Extra work when a load resets the sequence to the top -- the tracker page
   * scrolls its sequence list back up; the jukebox has no such list.
   */
  onSequenceReset?: () => void;
}

/**
 * Everything needed to *have a song loaded and playing*, without any of the
 * editing surface.
 *
 * The tracker page and the jukebox both need the same machinery: build the
 * playback song out of the store, keep the song bank in step with the
 * instrument slots, hand the visualizers a node per track, and load a module
 * from bytes. Only the tracker page needs the pattern editor on top of it.
 *
 * All the underlying state is in shared stores, so this can be called from
 * more than one component; what it creates per caller is the wiring, not the
 * song.
 */
export function useTrackerSongHost(options: TrackerSongHostOptions = {}) {
  const trackerStore = useTrackerStore();
  trackerStore.initializeIfNeeded();
  const playbackStore = useTrackerPlaybackStore();
  const trackerAudioStore = useTrackerAudioStore();
  const userSettingsStore = useUserSettingsStore();
  const songBank = trackerAudioStore.songBank;

  const {
    currentSong,
    moduleFormat,
    initialSpeed,
    linearFrequency,
    vblankTiming,
    defaultPatternRows,
    patterns,
    sequence,
    currentPatternId,
    instrumentSlots,
    activeInstrumentId,
    songPatches,
  } = storeToRefs(trackerStore);

  const { isPlaying, isPaused, playbackMode, currentSequenceIndex } =
    storeToRefs(playbackStore);

  const currentPattern = computed(() => trackerStore.currentPattern);
  const trackCount = computed(() => currentPattern.value?.tracks.length ?? 0);
  const audioContext = computed(() => songBank.audioContext);
  const masterOutputNode = computed(() => songBank.output);

  /** A load is in progress; watchers that rebuild audio must keep out of it. */
  const isLoadingSong = ref(false);

  function ensureActiveInstrument(): void {
    activeInstrumentId.value = pickActiveInstrumentId(
      instrumentSlots.value,
      activeInstrumentId.value,
    );
  }

  const songBuilderContext: TrackerSongBuilderContext = {
    currentSong,
    moduleFormat,
    initialSpeed,
    linearFrequency,
    vblankTiming,
    patterns,
    sequence,
    currentPatternId,
    currentPattern,
    defaultPatternRows,
    instrumentSlots,
    songPatches,
    songBank,
    normalizeInstrumentId,
    formatInstrumentId,
  };

  const {
    buildPlaybackSong,
    syncSongBankFromSlots: syncSongBankFromSlotsBase,
    resolveInstrumentForTrack,
  } = useTrackerSongBuilder(songBuilderContext);

  // ------------------------------------------------------------------
  // Per-track visualization nodes
  // ------------------------------------------------------------------

  const trackAudioNodes = ref<Record<number, AudioNode | null>>({});
  const tracksWithActiveNotes = ref<Set<number>>(new Set());

  /**
   * Whether anything is actually looking at the per-track taps.
   *
   * The phone layout draws neither the per-track waveforms nor the spectrum
   * analyser, and turning them off in settings has the same effect on a
   * desktop: with no viewer, every tap is a GainNode plus a second
   * connection from every voice, kept awake by a silent sink, for nothing.
   * The bank is told to stop building them at all.
   */
  const isMobileLayout = useMobileLayout();
  const trackMonitoringWanted = computed(
    () =>
      !isMobileLayout.value &&
      (userSettingsStore.settings.showWaveformVisualizers ||
        userSettingsStore.settings.showSpectrumAnalyzer),
  );

  watch(
    trackMonitoringWanted,
    (wanted) => {
      songBank.setTrackMonitoringEnabled(wanted);
      // The nodes handed to the visualizers are the taps: stale ones would
      // keep a disconnected graph alive, and a fresh set is needed the
      // moment monitoring comes back.
      if (wanted) updateTrackAudioNodes();
      else clearTrackAudioNodes();
    },
    { immediate: true },
  );

  /**
   * Ordered by track index, for the spectrum analyzer's per-channel mode --
   * which only applies to the classic 4-channel Amiga layout.
   */
  const spectrumTrackNodes = computed<(AudioNode | null)[]>(() =>
    Array.from(
      { length: trackCount.value },
      (_, i) => trackAudioNodes.value[i] ?? null,
    ),
  );

  function setTrackAudioNodeForInstrument(
    trackIndex: number,
    instrumentId?: string,
  ): void {
    if (!trackMonitoringWanted.value) return;
    const normalized = normalizeInstrumentId(instrumentId);
    // Not the instrument's output: one sample is one instrument, shared by
    // every channel that plays it, so that node carries other tracks too. The
    // bank hands back a per-track tap where it can.
    const node = songBank.getTrackVisualizationNode(trackIndex, normalized);
    if (trackAudioNodes.value[trackIndex] === node) return;
    trackAudioNodes.value = { ...trackAudioNodes.value, [trackIndex]: node };
  }

  function updateTrackAudioNodes(): void {
    if (!trackMonitoringWanted.value) {
      clearTrackAudioNodes();
      return;
    }
    const nodes: Record<number, AudioNode | null> = {};
    const tracks = (currentPattern.value?.tracks ?? []) as TrackerTrackData[];
    for (let i = 0; i < tracks.length; i++) {
      // Only meter tracks that actually play something in this pattern; while
      // playing, a track with nothing here may still be sounding a note from
      // the pattern before, so its node stays put.
      const resolvedId = resolveInstrumentForTrack(tracks[i], i);
      if (resolvedId) {
        nodes[i] = songBank.getTrackVisualizationNode(i, resolvedId);
      } else if (isPlaying.value || isPaused.value) {
        nodes[i] = trackAudioNodes.value[i] ?? null;
      } else {
        nodes[i] = null;
      }
    }
    trackAudioNodes.value = nodes;
  }

  function clearTrackAudioNodes(): void {
    const tracks = (currentPattern.value?.tracks ?? []) as TrackerTrackData[];
    const nodes: Record<number, AudioNode | null> = {};
    for (let i = 0; i < tracks.length; i++) nodes[i] = null;
    trackAudioNodes.value = nodes;
  }

  function markTrackNotePlayed(trackIndex: number): void {
    if (tracksWithActiveNotes.value.has(trackIndex)) return;
    tracksWithActiveNotes.value = new Set([
      ...tracksWithActiveNotes.value,
      trackIndex,
    ]);
  }

  function clearActiveNoteTracks(): void {
    tracksWithActiveNotes.value = new Set();
  }

  /**
   * Point the playback store's note callback at this component's visualizers.
   * Cleared on unmount, so whichever page is on screen owns it.
   */
  function claimTrackAudioNodeSetter(): void {
    playbackStore.setTrackAudioNodeSetter((trackIndex, instrumentId) => {
      setTrackAudioNodeForInstrument(trackIndex, instrumentId);
      markTrackNotePlayed(trackIndex);
    });
  }

  function releaseTrackAudioNodeSetter(): void {
    playbackStore.setTrackAudioNodeSetter(null);
  }

  // ------------------------------------------------------------------
  // Song bank and playback
  // ------------------------------------------------------------------

  /** Rebuild the bank's instruments, then re-apply nodes and slot volumes. */
  async function syncSongBankFromSlots(): Promise<void> {
    await syncSongBankFromSlotsBase();
    updateTrackAudioNodes();
    for (const slot of trackerStore.instrumentSlots) {
      if (!slot.patchId) continue;
      songBank.setInstrumentOutputGain(
        formatInstrumentId(slot.slot),
        slot.volume ?? 1.0,
      );
    }
  }

  async function initializePlayback(
    mode: 'pattern' | 'song' = playbackMode.value,
    skipIfPlaying = false,
  ): Promise<boolean> {
    updateTrackAudioNodes();
    return await playbackStore.loadSong(
      buildPlaybackSong(mode),
      mode,
      skipIfPlaying,
      currentSequenceIndex.value,
    );
  }

  async function play(
    mode: 'pattern' | 'song',
    startRow: number,
  ): Promise<void> {
    clearActiveNoteTracks();
    clearTrackAudioNodes();
    await playbackStore.play(
      buildPlaybackSong(mode),
      mode,
      startRow,
      currentSequenceIndex.value,
    );
  }

  function stopPlayback(): void {
    playbackStore.stop();
    clearTrackAudioNodes();
  }

  /** Master volume as the user last set it, applied to the live bank. */
  function applyMasterVolume(): void {
    songBank.setUserMasterVolume(userSettingsStore.settings.masterVolume);
  }

  // ------------------------------------------------------------------
  // Loading songs
  // ------------------------------------------------------------------

  const fileIOContext: TrackerFileIOContext = {
    trackerStore,
    songBank,
    currentSong,
    playbackMode,
    isLoadingSong,
    ensureActiveInstrument,
    syncSongBankFromSlots,
    initializePlayback,
    stopPlayback,
    resetSequenceIndex: () => {
      playbackStore.setSequenceIndex(0);
      options.onSequenceReset?.();
    },
  };

  const {
    promptSaveFile,
    promptOpenFile,
    handleSaveSongFile,
    handleLoadSongFile,
    loadSongFromUrl,
    parseSongBuffer,
    applySongFile,
  } = useTrackerFileIO(fileIOContext);

  return {
    // stores and audio
    trackerStore,
    playbackStore,
    songBank,
    audioContext,
    masterOutputNode,

    // song shape
    currentSong,
    currentPattern,
    trackCount,
    instrumentSlots,
    activeInstrumentId,

    // visualization
    trackAudioNodes,
    spectrumTrackNodes,
    tracksWithActiveNotes,
    setTrackAudioNodeForInstrument,
    updateTrackAudioNodes,
    clearTrackAudioNodes,
    markTrackNotePlayed,
    clearActiveNoteTracks,
    claimTrackAudioNodeSetter,
    releaseTrackAudioNodeSetter,

    // playback
    buildPlaybackSong,
    resolveInstrumentForTrack,
    syncSongBankFromSlots,
    initializePlayback,
    play,
    stopPlayback,
    applyMasterVolume,
    ensureActiveInstrument,

    // files
    isLoadingSong,
    promptSaveFile,
    promptOpenFile,
    handleSaveSongFile,
    handleLoadSongFile,
    loadSongFromUrl,
    parseSongBuffer,
    applySongFile,

    // identity helpers, so callers do not import them separately
    formatInstrumentId,
    normalizeInstrumentId,
  };
}

export type TrackerSongHost = ReturnType<typeof useTrackerSongHost>;
