import { ref, type Ref, type ComputedRef } from 'vue';
import type { PlaybackEngine } from '../../packages/tracker-playback/src/engine';
import type { Song as PlaybackSong } from '../../packages/tracker-playback/src/types';
import type { TrackerSongBank } from 'src/audio/tracker/song-bank';
import type { TrackerPattern } from 'src/stores/tracker-store';
import type { PlaybackMode } from './useTrackerExport';
import type { TrackerTrackData } from 'src/components/tracker/tracker-types';

/**
 * Dependencies required by the playback composable
 */
export interface TrackerPlaybackContext {
  // Playback dependencies
  playbackEngine: PlaybackEngine;
  songBank: TrackerSongBank;

  // State refs
  rowsCount: Ref<number>;
  trackCount: ComputedRef<number>;
  currentSong: Ref<{ title: string; author: string; bpm: number }>;
  currentPatternId: Ref<string | null>;
  currentPattern: ComputedRef<TrackerPattern | undefined>;
  activeRow: Ref<number>;

  // Mute/solo state (managed externally due to PlaybackEngine dependency)
  mutedTracks: Ref<Set<number>>;
  soloedTracks: Ref<Set<number>>;

  // Functions
  buildPlaybackSong: (mode: PlaybackMode) => PlaybackSong;
  syncSongBankFromSlots: () => Promise<void>;
  setCurrentPatternId: (patternId: string) => void;
  normalizeInstrumentId: (instrumentId?: string) => string | undefined;
  resolveInstrumentForTrack: (track: TrackerTrackData | undefined, trackIndex: number) => string | undefined;
}

/**
 * Composable for managing tracker playback
 *
 * Handles:
 * - Playback state (playing, paused, stopped)
 * - PlaybackEngine lifecycle and event subscriptions
 * - Track audio node management for visualization
 * - Mute/solo functionality
 * - Transport controls (play, pause, stop)
 *
 * @param context - Playback context with all dependencies
 */
export function useTrackerPlayback(context: TrackerPlaybackContext) {
  // Playback state
  const isPlaying = ref(false);
  const playbackRow = ref(0);
  const playbackMode = ref<PlaybackMode>('song');
  const autoScroll = ref(true);

  // Track audio nodes for visualization
  const trackAudioNodes = ref<Record<number, AudioNode | null>>({});

  // Tracks that have actually played notes (for waveform visualization)
  const tracksWithActiveNotes = ref<Set<number>>(new Set());

  // Event subscription handles
  let unsubscribePosition: (() => void) | null = null;
  let unsubscribeState: (() => void) | null = null;

  // Suppress position updates flag (used during stop/seek operations)
  let suppressPositionUpdates = false;

  /**
   * Set the audio node for a specific track
   */
  function setTrackAudioNodeForInstrument(trackIndex: number, instrumentId?: string) {
    const normalized = context.normalizeInstrumentId(instrumentId);
    const node = normalized ? context.songBank.getInstrumentOutput(normalized) : null;
    if (trackAudioNodes.value[trackIndex] === node) return;
    trackAudioNodes.value = {
      ...trackAudioNodes.value,
      [trackIndex]: node
    };
  }

  /**
   * Update all track audio nodes based on current pattern
   */
  function updateTrackAudioNodes() {
    const nodes: Record<number, AudioNode | null> = {};
    const tracks = (context.currentPattern.value?.tracks ?? []) as TrackerTrackData[];
    for (let i = 0; i < tracks.length; i++) {
      const instrumentId = context.resolveInstrumentForTrack(tracks[i], i);
      nodes[i] = instrumentId ? context.songBank.getInstrumentOutput(instrumentId) : null;
    }
    trackAudioNodes.value = nodes;
  }

  /**
   * Mark a track as having played a note (enables waveform visualization)
   */
  function markTrackNotePlayed(trackIndex: number) {
    if (!tracksWithActiveNotes.value.has(trackIndex)) {
      tracksWithActiveNotes.value = new Set([...tracksWithActiveNotes.value, trackIndex]);
    }
  }

  /**
   * Clear all active note tracking (called on stop)
   */
  function clearActiveNoteTracks() {
    tracksWithActiveNotes.value = new Set();
  }

  /**
   * Toggle mute state for a track
   */
  function toggleMute(trackIndex: number) {
    const newMuted = new Set(context.mutedTracks.value);
    if (newMuted.has(trackIndex)) {
      newMuted.delete(trackIndex);
    } else {
      newMuted.add(trackIndex);
    }
    context.mutedTracks.value = newMuted;
  }

  /**
   * Toggle solo state for a track
   */
  function toggleSolo(trackIndex: number) {
    const newSoloed = new Set(context.soloedTracks.value);
    if (newSoloed.has(trackIndex)) {
      newSoloed.delete(trackIndex);
    } else {
      newSoloed.add(trackIndex);
    }
    context.soloedTracks.value = newSoloed;
  }

  /**
   * Sanitize mute/solo state when track count changes
   */
  function sanitizeMuteSoloState(trackTotal = context.trackCount.value) {
    const maxIndex = Math.max(0, trackTotal - 1);
    const nextMuted = new Set<number>();
    const nextSoloed = new Set<number>();

    context.mutedTracks.value.forEach((idx) => {
      if (idx <= maxIndex) {
        nextMuted.add(idx);
      }
    });

    context.soloedTracks.value.forEach((idx) => {
      if (idx <= maxIndex) {
        nextSoloed.add(idx);
      }
    });

    context.mutedTracks.value = nextMuted;
    context.soloedTracks.value = nextSoloed;
  }

  /**
   * Initialize playback for a given mode
   * Sets up the playback engine with the current song and subscribes to events
   */
  async function initializePlayback(mode: PlaybackMode = playbackMode.value): Promise<boolean> {
    updateTrackAudioNodes();
    const song = context.buildPlaybackSong(mode);
    if (!song.sequence.length) {
      console.warn('No patterns available to play.');
      return false;
    }

    playbackMode.value = mode;
    context.playbackEngine.setLoopCurrentPattern(mode === 'pattern');
    context.playbackEngine.loadSong(song);
    await context.playbackEngine.prepareInstruments();

    // Subscribe to position updates
    unsubscribePosition?.();
    unsubscribePosition = context.playbackEngine.on('position', (pos) => {
      if (suppressPositionUpdates) return;
      const row = ((pos.row % context.rowsCount.value) + context.rowsCount.value) % context.rowsCount.value;
      playbackRow.value = row;
      if (pos.patternId && pos.patternId !== context.currentPatternId.value) {
        context.setCurrentPatternId(pos.patternId);
      }
    });

    // Subscribe to state updates
    unsubscribeState?.();
    unsubscribeState = context.playbackEngine.on('state', (state) => {
      isPlaying.value = state === 'playing';
    });

    return true;
  }

  /**
   * Start playback in a given mode
   * Initializes the audio context, syncs instruments, and starts playing
   */
  async function startPlayback(mode: PlaybackMode) {
    suppressPositionUpdates = true;
    context.playbackEngine.stop();
    suppressPositionUpdates = false;
    context.songBank.cancelAllScheduled();
    context.songBank.allNotesOff();
    clearActiveNoteTracks();

    const resumed = await context.songBank.ensureAudioContextRunning();
    await context.syncSongBankFromSlots();
    if (resumed) {
      // Sync again after resume to rebuild instruments if we were suspended
      await context.syncSongBankFromSlots();
    }
    const initialized = await initializePlayback(mode);
    if (!initialized) return;

    context.playbackEngine.setBpm(context.currentSong.value.bpm);
    context.playbackEngine.setLength(context.rowsCount.value);
    // Always start from the currently selected row
    context.playbackEngine.seek(context.activeRow.value);
    await context.playbackEngine.play();
  }

  /**
   * Start pattern playback
   */
  async function handlePlayPattern() {
    await startPlayback('pattern');
  }

  /**
   * Start song playback
   */
  async function handlePlaySong() {
    await startPlayback('song');
  }

  /**
   * Pause playback
   */
  function handlePause() {
    // Set the active row to the current playback position
    context.activeRow.value = playbackRow.value;
    context.playbackEngine.pause();
    context.songBank.cancelAllScheduled();
    context.songBank.allNotesOff();
  }

  /**
   * Stop playback
   */
  function handleStop() {
    const wasPlaying = isPlaying.value;
    context.playbackEngine.stop();
    playbackRow.value = 0;
    if (wasPlaying) {
      context.activeRow.value = 0;
    }
    context.songBank.cancelAllScheduled();
    context.songBank.allNotesOff();
    clearActiveNoteTracks();
  }

  /**
   * Toggle pattern playback (play/pause)
   */
  function togglePatternPlayback() {
    if (isPlaying.value && playbackMode.value === 'pattern') {
      handlePause();
      return;
    }
    void handlePlayPattern();
  }

  /**
   * Cleanup function to unsubscribe from events
   */
  function cleanup() {
    unsubscribePosition?.();
    unsubscribeState?.();
    unsubscribePosition = null;
    unsubscribeState = null;
  }

  return {
    // State
    isPlaying,
    playbackRow,
    playbackMode,
    autoScroll,
    trackAudioNodes,
    tracksWithActiveNotes,

    // Mute/Solo
    // Note: isTrackAudible, mutedTracks, and soloedTracks are defined in TrackerPage before PlaybackEngine
    toggleMute,
    toggleSolo,
    sanitizeMuteSoloState,

    // Track audio nodes
    setTrackAudioNodeForInstrument,
    updateTrackAudioNodes,
    markTrackNotePlayed,
    clearActiveNoteTracks,

    // Playback controls
    initializePlayback,
    startPlayback,
    handlePlayPattern,
    handlePlaySong,
    handlePause,
    handleStop,
    togglePatternPlayback,

    // Lifecycle
    cleanup
  };
}
