import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { PlaybackEngine } from '../../packages/tracker-playback/src/engine';
import type {
  Song as PlaybackSong,
  ScheduledNoteEvent,
} from '../../packages/tracker-playback/src/types';
import { useTrackerAudioStore } from './tracker-audio-store';
import { useTrackerStore } from './tracker-store';

export type PlaybackMode = 'pattern' | 'song';

/**
 * Position listener callback type
 */
export type PositionListener = (row: number, patternId: string | undefined) => void;

/**
 * Note event callback - for visualization (track waveforms)
 */
export type NoteEventListener = (trackIndex: number, instrumentId: string | undefined) => void;

// Singleton PlaybackEngine instance - lives outside Pinia to avoid reactivity issues
let playbackEngineInstance: PlaybackEngine | null = null;

// Event subscription handles
let positionUnsubscribe: (() => void) | null = null;
let stateUnsubscribe: (() => void) | null = null;

// Position event listeners (for UI components)
const positionListeners = new Set<PositionListener>();

// Note event listeners (for visualization)
const noteEventListeners = new Set<NoteEventListener>();

// Track audio node setter (injected by TrackerPage for visualization)
let trackAudioNodeSetter: ((trackIndex: number, instrumentId: string | undefined) => void) | null = null;

/**
 * Store for tracker playback state that persists across page navigation.
 *
 * This store owns the PlaybackEngine singleton and all playback-related state,
 * allowing playback to continue uninterrupted when navigating between pages.
 */
export const useTrackerPlaybackStore = defineStore('trackerPlayback', () => {
  // Get dependent stores
  const audioStore = useTrackerAudioStore();
  const trackerStore = useTrackerStore();

  // ============================================
  // State
  // ============================================

  /** Whether playback is currently active */
  const isPlaying = ref(false);

  /** Whether playback is paused (vs stopped) */
  const isPaused = ref(false);

  /** Current playback mode */
  const playbackMode = ref<PlaybackMode>('song');

  /** Current playback row within the pattern */
  const playbackRow = ref(0);

  /** Current sequence index (for song mode) */
  const currentSequenceIndex = ref(0);

  /** Set of muted track indices */
  const mutedTracks = ref<Set<number>>(new Set());

  /** Set of soloed track indices */
  const soloedTracks = ref<Set<number>>(new Set());

  /** Whether to auto-scroll to follow playback */
  const autoScroll = ref(true);

  /** Whether a song has been loaded into the engine */
  const hasSongLoaded = ref(false);

  /** Flag to suppress position updates during seek/stop operations */
  let suppressPositionUpdates = false;

  // ============================================
  // Getters
  // ============================================

  /** Get the PlaybackEngine instance (creates if needed) */
  const engine = computed(() => playbackEngineInstance);

  /** Check if a track is audible given current mute/solo state */
  function isTrackAudible(trackIndex: number): boolean {
    const hasSolo = soloedTracks.value.size > 0;
    const isSoloed = soloedTracks.value.has(trackIndex);
    const isMuted = mutedTracks.value.has(trackIndex);
    return hasSolo ? isSoloed : !isMuted;
  }

  // ============================================
  // Private helpers
  // ============================================

  /**
   * Get the song bank from audio store
   */
  function getSongBank() {
    return audioStore.songBank;
  }

  /**
   * Broadcast position update to all listeners
   */
  function broadcastPosition(row: number, patternId: string | undefined) {
    positionListeners.forEach(listener => {
      try {
        listener(row, patternId);
      } catch (e) {
        console.error('Position listener error:', e);
      }
    });
  }

  /**
   * Broadcast note event to all listeners
   */
  function broadcastNoteEvent(trackIndex: number, instrumentId: string | undefined) {
    noteEventListeners.forEach(listener => {
      try {
        listener(trackIndex, instrumentId);
      } catch (e) {
        console.error('Note event listener error:', e);
      }
    });
  }

  /**
   * Get audibility snapshot for all tracks
   */
  function getAudibilitySnapshot(trackCount: number): boolean[] {
    const result: boolean[] = [];
    for (let i = 0; i < trackCount; i++) {
      result.push(isTrackAudible(i));
    }
    return result;
  }

  /**
   * Stop notes on tracks that became inaudible
   */
  function muteInaudibleTracks(previouslyAudible: boolean[], newlyAudible: boolean[]) {
    const songBank = getSongBank();
    for (let i = 0; i < previouslyAudible.length; i++) {
      if (previouslyAudible[i] && !newlyAudible[i]) {
        songBank.notesOffForTrack(i);
      }
    }
  }

  // ============================================
  // Engine initialization
  // ============================================

  /**
   * Create and configure the PlaybackEngine instance
   */
  function createEngine(): PlaybackEngine {
    const songBank = getSongBank();

    const engine = new PlaybackEngine({
      instrumentResolver: (instrumentId) => songBank.prepareInstrument(instrumentId),
      audioContext: songBank.audioContext,

      // Automation handlers
      scheduledAutomationHandler: (instrumentId, gain, time) => {
        songBank.setInstrumentGain(instrumentId, gain, time);
      },
      automationHandler: (instrumentId, gain) => {
        songBank.setInstrumentGain(instrumentId, gain);
      },

      // Macro handlers
      scheduledMacroHandler: (instrumentId, macroIndex, value, time) => {
        songBank.setInstrumentMacro(instrumentId, macroIndex, value, time);
      },
      macroHandler: (instrumentId, macroIndex, value) => {
        songBank.setInstrumentMacro(instrumentId, macroIndex, value);
      },

      // Effect handlers
      scheduledPitchHandler: (instrumentId, voiceIndex, frequency, time) => {
        songBank.setVoicePitchAtTime(instrumentId, voiceIndex, frequency, time);
      },
      scheduledVolumeHandler: (instrumentId, voiceIndex, volume, time) => {
        songBank.setVoiceVolumeAtTime(instrumentId, voiceIndex, volume, time);
      },
      scheduledRetriggerHandler: (instrumentId, midi, velocity, time) => {
        songBank.retriggerNoteAtTime(instrumentId, midi, velocity, time);
      },

      // Note handlers
      scheduledNoteHandler: (event: ScheduledNoteEvent) => {
        // Check mute/solo state
        if (!isTrackAudible(event.trackIndex)) return;

        // Notify visualization
        if (trackAudioNodeSetter) {
          trackAudioNodeSetter(event.trackIndex, event.instrumentId);
        }
        broadcastNoteEvent(event.trackIndex, event.instrumentId);

        if (event.type === 'noteOn') {
          if (event.instrumentId === undefined || event.midi === undefined) return;
          const velocity = Number.isFinite(event.velocity) ? (event.velocity as number) : 100;
          songBank.noteOnAtTime(event.instrumentId, event.midi, velocity, event.time, event.trackIndex);
        } else {
          if (event.instrumentId === undefined) return;
          songBank.noteOffAtTime(event.instrumentId, event.midi, event.time, event.trackIndex);
        }
      },

      // Legacy note handler (for preview)
      noteHandler: (event) => {
        if (!isTrackAudible(event.trackIndex)) return;

        if (trackAudioNodeSetter) {
          trackAudioNodeSetter(event.trackIndex, event.instrumentId);
        }
        broadcastNoteEvent(event.trackIndex, event.instrumentId);

        if (event.type === 'noteOn') {
          if (event.instrumentId === undefined || event.midi === undefined) return;
          const velocity = Number.isFinite(event.velocity) ? (event.velocity as number) : 100;
          songBank.noteOn(event.instrumentId, event.midi, velocity, event.trackIndex);
        } else {
          if (event.instrumentId === undefined) return;
          songBank.noteOff(event.instrumentId, event.midi, event.trackIndex);
        }
      }
    });

    return engine;
  }

  /**
   * Ensure PlaybackEngine exists and subscribe to its events
   */
  function ensureEngine(): PlaybackEngine {
    if (!playbackEngineInstance) {
      playbackEngineInstance = createEngine();
    }

    // Set up event subscriptions if not already done
    if (!positionUnsubscribe) {
      positionUnsubscribe = playbackEngineInstance.on('position', (pos) => {
        if (suppressPositionUpdates) return;

        const rowsCount = trackerStore.patternRows;
        const row = ((pos.row % rowsCount) + rowsCount) % rowsCount;
        playbackRow.value = row;

        // Update current pattern if changed
        if (pos.patternId && pos.patternId !== trackerStore.currentPatternId) {
          trackerStore.setCurrentPatternId(pos.patternId);
        }

        // Broadcast to UI listeners
        broadcastPosition(row, pos.patternId);
      });
    }

    if (!stateUnsubscribe) {
      stateUnsubscribe = playbackEngineInstance.on('state', (state) => {
        isPlaying.value = state === 'playing';
        isPaused.value = state === 'paused';

        // Sync to audio store for other parts of app
        audioStore.setPlaybackState(state === 'playing');
      });
    }

    return playbackEngineInstance;
  }

  // ============================================
  // Transport controls
  // ============================================

  /**
   * Load a song into the engine and prepare for playback.
   * If skipIfPlaying is true and playback is active, skips reloading to preserve position.
   */
  async function loadSong(song: PlaybackSong, mode: PlaybackMode = 'song', skipIfPlaying: boolean = false): Promise<boolean> {
    console.log(`[PlaybackStore] loadSong called: mode=${mode}, skipIfPlaying=${skipIfPlaying}, isPlaying=${isPlaying.value}, isPaused=${isPaused.value}, hasSongLoaded=${hasSongLoaded.value}`);
    console.log(`[PlaybackStore] Song has ${song.sequence.length} patterns, ${song.bpm} BPM`);

    // If already playing/paused and skipIfPlaying is set, don't disturb the current playback
    if (skipIfPlaying && (isPlaying.value || isPaused.value) && hasSongLoaded.value) {
      console.log('[PlaybackStore] Skipping load - playback active and skipIfPlaying=true');
      return true;
    }

    const engine = ensureEngine();

    if (!song.sequence.length) {
      console.warn('No patterns available to play.');
      return false;
    }

    playbackMode.value = mode;
    engine.setLoopCurrentPattern(mode === 'pattern');
    console.log('[PlaybackStore] Loading song into engine...');
    engine.loadSong(song);
    console.log('[PlaybackStore] Preparing instruments...');
    await engine.prepareInstruments();
    hasSongLoaded.value = true;
    console.log('[PlaybackStore] Song loaded successfully');

    return true;
  }

  /**
   * Start playback
   */
  async function play(song: PlaybackSong, mode: PlaybackMode, startRow: number = 0): Promise<void> {
    console.log(`[PlaybackStore] play() called: mode=${mode}, startRow=${startRow}`);
    const songBank = getSongBank();

    // Stop any existing playback
    suppressPositionUpdates = true;
    if (playbackEngineInstance) {
      console.log('[PlaybackStore] Stopping existing playback');
      playbackEngineInstance.stop();
    }
    suppressPositionUpdates = false;

    songBank.cancelAllScheduled();
    songBank.allNotesOff();

    // Ensure audio context is running
    const contextRunning = await songBank.ensureAudioContextRunning();
    if (!contextRunning || songBank.audioContext.state !== 'running') {
      console.warn(
        `[PlaybackStore] AudioContext not running; skipping playback start (state=${songBank.audioContext.state}, needsResume=${songBank.needsResume})`,
      );
      return;
    }

    // Load song
    const loaded = await loadSong(song, mode);
    if (!loaded) {
      console.warn('[PlaybackStore] Failed to load song, aborting play');
      return;
    }

    const engine = ensureEngine();

    // Configure and start
    console.log(`[PlaybackStore] Starting playback: bpm=${song.bpm}, length=${trackerStore.patternRows}`);
    engine.setBpm(song.bpm);
    engine.setLength(trackerStore.patternRows);
    engine.seek(startRow);

    await engine.play();
    console.log('[PlaybackStore] Playback started');
  }

  /**
   * Pause playback (keep position)
   */
  function pause(): void {
    if (!playbackEngineInstance) return;

    playbackEngineInstance.pause();
    getSongBank().cancelAllScheduled();
    getSongBank().allNotesOff();
  }

  /**
   * Stop playback and reset to beginning of current pattern
   */
  function stop(): void {
    if (!playbackEngineInstance) return;

    playbackEngineInstance.stop();
    playbackRow.value = 0;
    getSongBank().cancelAllScheduled();
    getSongBank().allNotesOff();
  }

  /**
   * Seek to a specific row
   */
  function seek(row: number): void {
    if (!playbackEngineInstance) return;
    playbackEngineInstance.seek(row);
  }

  /**
   * Update BPM during playback
   */
  function setBpm(bpm: number): void {
    if (!playbackEngineInstance) return;
    playbackEngineInstance.setBpm(bpm);
  }

  /**
   * Update pattern length
   */
  function setLength(rows: number): void {
    if (!playbackEngineInstance) return;
    playbackEngineInstance.setLength(rows);
  }

  // ============================================
  // Mute/Solo controls
  // ============================================

  /**
   * Toggle mute state for a track
   */
  function toggleMute(trackIndex: number, trackCount: number): void {
    const before = getAudibilitySnapshot(trackCount);

    const newMuted = new Set(mutedTracks.value);
    if (newMuted.has(trackIndex)) {
      newMuted.delete(trackIndex);
    } else {
      newMuted.add(trackIndex);
    }
    mutedTracks.value = newMuted;

    const after = getAudibilitySnapshot(trackCount);
    muteInaudibleTracks(before, after);
  }

  /**
   * Toggle solo state for a track
   */
  function toggleSolo(trackIndex: number, trackCount: number): void {
    const before = getAudibilitySnapshot(trackCount);

    const newSoloed = new Set(soloedTracks.value);
    if (newSoloed.has(trackIndex)) {
      newSoloed.delete(trackIndex);
    } else {
      newSoloed.add(trackIndex);
    }
    soloedTracks.value = newSoloed;

    const after = getAudibilitySnapshot(trackCount);
    muteInaudibleTracks(before, after);
  }

  /**
   * Sanitize mute/solo state when track count changes
   */
  function sanitizeMuteSoloState(trackCount: number): void {
    const maxIndex = Math.max(0, trackCount - 1);

    const newMuted = new Set<number>();
    const newSoloed = new Set<number>();

    mutedTracks.value.forEach((idx) => {
      if (idx <= maxIndex) newMuted.add(idx);
    });

    soloedTracks.value.forEach((idx) => {
      if (idx <= maxIndex) newSoloed.add(idx);
    });

    mutedTracks.value = newMuted;
    soloedTracks.value = newSoloed;
  }

  // ============================================
  // Event subscription management
  // ============================================

  /**
   * Subscribe to position updates
   */
  function onPosition(listener: PositionListener): () => void {
    positionListeners.add(listener);
    return () => positionListeners.delete(listener);
  }

  /**
   * Subscribe to note events (for visualization)
   */
  function onNoteEvent(listener: NoteEventListener): () => void {
    noteEventListeners.add(listener);
    return () => noteEventListeners.delete(listener);
  }

  /**
   * Set the track audio node setter (for visualization)
   */
  function setTrackAudioNodeSetter(setter: ((trackIndex: number, instrumentId: string | undefined) => void) | null): void {
    trackAudioNodeSetter = setter;
  }

  // ============================================
  // Cleanup
  // ============================================

  /**
   * Full cleanup - call on app shutdown
   */
  function dispose(): void {
    if (playbackEngineInstance) {
      playbackEngineInstance.stop();
    }

    if (positionUnsubscribe) {
      positionUnsubscribe();
      positionUnsubscribe = null;
    }

    if (stateUnsubscribe) {
      stateUnsubscribe();
      stateUnsubscribe = null;
    }

    positionListeners.clear();
    noteEventListeners.clear();
    trackAudioNodeSetter = null;

    playbackEngineInstance = null;
  }

  // ============================================
  // Return public API
  // ============================================

  return {
    // State
    isPlaying,
    isPaused,
    playbackMode,
    playbackRow,
    currentSequenceIndex,
    mutedTracks,
    soloedTracks,
    autoScroll,
    hasSongLoaded,

    // Getters
    engine,
    isTrackAudible,

    // Transport
    loadSong,
    play,
    pause,
    stop,
    seek,
    setBpm,
    setLength,

    // Mute/Solo
    toggleMute,
    toggleSolo,
    sanitizeMuteSoloState,

    // Event subscriptions
    onPosition,
    onNoteEvent,
    setTrackAudioNodeSetter,

    // Cleanup
    dispose,
  };
});
