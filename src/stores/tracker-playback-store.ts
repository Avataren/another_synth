import { defineStore } from 'pinia';
import { ref, computed, watch } from 'vue';
import { PlaybackEngine } from '@another-synth/tracker-playback';
import type {
  Song as PlaybackSong,
  ScheduledNoteEvent,
} from '@another-synth/tracker-playback';
import { useTrackerAudioStore } from './tracker-audio-store';
import { useTrackerStore } from './tracker-store';
import { usePostFxStore } from 'src/stores/post-fx-store';
import { defaultLookaheadSeconds } from 'src/audio/device-profile';
import {
  AhxSongTransport,
  type PlaybackMode,
} from 'src/audio/tracker/ahx-song-transport';
import { SidSongTransport } from 'src/audio/tracker/sid-song-transport';
import type { Sid6581Revision } from 'src/audio/tracker/sid-player';
import { debugLog } from 'src/diagnostics/debug-log';

export type { PlaybackMode };

/**
 * Position listener callback type
 */
export type PositionListener = (row: number, patternId: string | undefined) => void;

/**
 * Note event callback - for visualization (track waveforms)
 */
export type NoteEventListener = (trackIndex: number, instrumentId: string | undefined) => void;

/**
 * Called when a non-looping song reaches its end and playback stops.
 *
 * Fires when the final row has been heard rather than when it was scheduled,
 * so a listener that starts the next song does not clip this one's tail.
 */
export type SongEndListener = () => void;

// Singleton PlaybackEngine instance - lives outside Pinia to avoid reactivity issues
let playbackEngineInstance: PlaybackEngine | null = null;

// Event subscription handles
let positionUnsubscribe: (() => void) | null = null;
let stateUnsubscribe: (() => void) | null = null;
let songEndUnsubscribe: (() => void) | null = null;

// Position event listeners (for UI components)
const positionListeners = new Set<PositionListener>();

// Note event listeners (for visualization)
const noteEventListeners = new Set<NoteEventListener>();

// Song-end listeners (the jukebox advances its playlist on these)
const songEndListeners = new Set<SongEndListener>();

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
  /** Manually selected sequence index for starting playback */
  const selectedSequenceIndex = ref<number | null>(null);

  /** Set of muted track indices */
  const mutedTracks = ref<Set<number>>(new Set());

  /** Set of soloed track indices */
  const soloedTracks = ref<Set<number>>(new Set());

  /** Whether to auto-scroll to follow playback */
  const autoScroll = ref(true);

  /** Whether a song has been loaded into the engine */
  const hasSongLoaded = ref(false);

  /**
   * The last song that went through a successful load, and the mode it was
   * loaded for. This is the top-bar replay's source of truth (plan
   * topbar-play D-A'): a song loaded-and-stopped has nothing else in the store
   * to remember it by — `hasSongLoaded` only says *that* one was loaded, and
   * the page builds a fresh `PlaybackSong` per start (`useTrackerSongHost.ts`
   * `buildPlaybackSong`), never handing one back. Retained here, the layout's
   * stopped-state play can re-enter the real `play()` path with it.
   *
   * Set at the two load choke points (`loadSong` / `loadAhxSong`), so every
   * caller — the tracker page and the jukebox alike — records the same way.
   * AHX replays stay audibly fresh regardless of this snapshot: `playAhx`
   * re-flushes and re-reads the current bytes on its own.
   */
  const lastPlaybackSong = ref<PlaybackSong | null>(null);

  /** The mode the retained song was last loaded for (`playLast` re-uses it). */
  const lastPlaybackMode = ref<PlaybackMode>('song');

  function recordLastSong(song: PlaybackSong, mode: PlaybackMode): void {
    lastPlaybackSong.value = song;
    lastPlaybackMode.value = mode;
  }

  /** Whether a stopped-state play has a retained song to restart. */
  const canReplay = computed(
    () => !isPlaying.value && !isPaused.value && lastPlaybackSong.value !== null,
  );

  /** Whether the sequence restarts when it runs out. */
  const loopSong = ref(true);

  /** Flag to suppress position updates during seek/stop operations */
  let suppressPositionUpdates = false;


  // ============================================
  // Selection helpers
  // ============================================

  function setSequenceIndex(index: number) {
    const max = Math.max(0, trackerStore.sequence.length - 1);
    const clamped = Math.max(0, Math.min(index, max));
    selectedSequenceIndex.value = clamped;
    currentSequenceIndex.value = clamped;
  }

  function resolveStartSequenceIndex(song: PlaybackSong): number {
    const max = Math.max(0, song.sequence.length - 1);
    const preferred = selectedSequenceIndex.value ?? currentSequenceIndex.value ?? 0;
    return Math.max(0, Math.min(preferred, max));
  }

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
    const postFxStore = usePostFxStore();

    const engine = new PlaybackEngine({
      instrumentResolver: (instrumentId) => songBank.prepareInstrument(instrumentId),
      audioContext: songBank.audioContext,
      // The scheduling loop shares the main thread with the UI, so the
      // window has to cover the longest task that can land between two of
      // its wake-ups -- which is a good deal longer on a phone.
      lookaheadSeconds: defaultLookaheadSeconds(),

      // Automation handlers
      scheduledAutomationHandler: (instrumentId, gain, time) => {
        songBank.setInstrumentGain(instrumentId, gain, time);
      },
      automationHandler: (instrumentId, gain) => {
        songBank.setInstrumentGain(instrumentId, gain);
      },

      // Macro handlers
      scheduledMacroHandler: (instrumentId, macroIndex, value, time, ramp) => {
        songBank.setInstrumentMacro(instrumentId, macroIndex, value, time, ramp);
      },
      macroHandler: (instrumentId, macroIndex, value) => {
        songBank.setInstrumentMacro(instrumentId, macroIndex, value);
      },

      // Effect handlers
      scheduledPitchHandler: (instrumentId, voiceIndex, frequency, time, trackIndex, rampMode) => {
        songBank.setVoicePitchAtTime(instrumentId, voiceIndex, frequency, time, trackIndex, rampMode);
      },
      scheduledVolumeHandler: (instrumentId, voiceIndex, volume, time, trackIndex, rampMode) => {
        songBank.setVoiceVolumeAtTime(instrumentId, voiceIndex, volume, time, trackIndex, rampMode);
      },
      scheduledPanHandler: (
        instrumentId: string,
        voiceIndex: number,
        pan: number,
        time: number,
        trackIndex: number,
      ) => {
        if (!isTrackAudible(trackIndex)) return;
        songBank.setVoicePanAtTime(instrumentId, voiceIndex, pan, time, trackIndex);
      },

      scheduledSampleOffsetHandler: (instrumentId, voiceIndex, offset, time, trackIndex) => {
        songBank.setVoiceSampleOffsetAtTime(instrumentId, voiceIndex, offset, time, trackIndex);
      },
      scheduledEnvelopePositionHandler: (instrumentId, voiceIndex, tick, time, trackIndex) => {
        songBank.setVoiceEnvelopePositionAtTime(instrumentId, voiceIndex, tick, time, trackIndex);
      },
      scheduledAllNotesOffHandler: (time) => {
        songBank.cutAllVoicesAtTime(time);
      },
      scheduledGlobalVolumeHandler: (gain, time) => {
        songBank.setMasterVolume(gain, time);
      },
      scheduledFilterHandler: (active, time) => {
        // E0x reaches the post-fx store, which owns the mode decision: AUTO
        // toggles the LED filter, manual on/off swallows the event there (the
        // single choke point, plan review M7).
        postFxStore.applyEngineEvent(active, time);
      },
      scheduledRetriggerHandler: (instrumentId, midi, velocity, time, trackIndex, frequency) => {
        songBank.retriggerNoteAtTime(instrumentId, midi, velocity, time, trackIndex, frequency);
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
          songBank.noteOnAtTime(event.instrumentId, event.midi, velocity, event.time, event.trackIndex, event.frequency, event.pan, event.sampleOffsetFrames, event.tickSeconds);
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
   * Mirror a transport position into the store and tell the UI listeners.
   * Shared by `PlaybackEngine`'s position events and the AHX worklet's.
   */
  function applyPosition(pos: {
    row: number;
    patternId?: string | undefined;
    sequenceIndex?: number | undefined;
  }): void {
    // Wrap against the row count of the pattern the position refers to:
    // patterns can differ in length since song-file v3.
    const rowsCount = trackerStore.rowsForPattern(
      pos.patternId ?? trackerStore.currentPatternId,
    );
    const row = ((pos.row % rowsCount) + rowsCount) % rowsCount;
    playbackRow.value = row;

    // Update sequence index if provided
    if (pos.sequenceIndex !== undefined) {
      currentSequenceIndex.value = pos.sequenceIndex;
      selectedSequenceIndex.value = pos.sequenceIndex;
    }

    // Update current pattern if changed
    if (pos.patternId && pos.patternId !== trackerStore.currentPatternId) {
      trackerStore.setCurrentPatternId(pos.patternId);
    }

    // Broadcast to UI listeners
    broadcastPosition(row, pos.patternId);
  }

  /** Silence `PlaybackEngine` before the AHX engine takes over. */
  function stopSampleEngine(): void {
    if (!playbackEngineInstance) return;
    suppressPositionUpdates = true;
    playbackEngineInstance.stop();
    suppressPositionUpdates = false;
  }

  // ============================================
  // AHX / HVL transport
  // ============================================
  //
  // The AHX worklet's transport lives in `AhxSongTransport`; the store lends it
  // its reactive state and the helpers the AHX path calls, and its verbs
  // hand the AHX branch over to it.

  const ahx = new AhxSongTransport({
    isPlaying,
    isPaused,
    playbackMode,
    playbackRow,
    currentSequenceIndex,
    selectedSequenceIndex,
    mutedTracks,
    soloedTracks,
    hasSongLoaded,
    loopSong,
    songEndListeners,
    trackerStore,
    getSongBank,
    setPlaybackState: (playing) => audioStore.setPlaybackState(playing),
    applyPosition,
    resolveStartSequenceIndex,
    recordLastSong,
    sanitizeMuteSoloState,
    stopSampleEngine,
  });

  // ============================================
  // SID transport (plan-sid-tracking.md S4)
  // ============================================
  //
  // A `'sid'` song plays in the SID worklet (`SidSongTransport`) from the
  // store's doc, like an AHX song plays in the AHX worklet from its bytes.

  const sid = new SidSongTransport({
    isPlaying,
    isPaused,
    playbackMode,
    playbackRow,
    currentSequenceIndex,
    selectedSequenceIndex,
    mutedTracks,
    soloedTracks,
    hasSongLoaded,
    loopSong,
    songEndListeners,
    trackerStore,
    getSongBank,
    setPlaybackState: (playing) => audioStore.setPlaybackState(playing),
    applyPosition,
    resolveStartSequenceIndex,
    recordLastSong,
    sanitizeMuteSoloState,
    stopSampleEngine,
  });
  // An edit of the doc (the grid's write-back, the instrument page, an undo)
  // reaches a playing song through a reload.
  watch(
    () => trackerStore.sidRevision,
    () => sid.onDocChange(),
  );

  /** Sound a SID instrument from the keyboard (the instrument page): its own preview voice. */
  async function previewSidNoteOn(instrument: number, midi: number): Promise<boolean> {
    return sid.previewNoteOn(instrument, midi);
  }

  /** Let go of the SID preview note; with `midi`, only if that key is the one held (the voice is mono). */
  function previewSidNoteOff(midi?: number): void {
    sid.previewNoteOff(midi);
  }

  /** Make the SID preview voice ready for the first key (selecting a SID instrument). */
  async function prepareSidPreview(): Promise<void> {
    return sid.preparePreview();
  }

  /** The SID preview voice's output (the instrument page's analyzer), or null before its first note. */
  function sidPreviewOutput(): AudioNode | null {
    return sid.previewOutput;
  }

  function onSidPreviewOutput(listener: (node: AudioNode | null) => void): () => void {
    return sid.onPreviewOutput(listener);
  }

  /** Re-route the SID worklet's voices into the bank's current per-track taps (the host rebuilt them). */
  function connectSidVoiceTaps(): void {
    sid.connectVoiceTaps();
  }

  /** A SID voice tap's full scale, for the per-track scopes (`null`: no song loaded). */
  function getSidVoiceFullScale(): number | null {
    return sid.voiceFullScale();
  }

  /** The SID keyboard preview voice's full scale, for the instrument page's scope (`null`: not known yet). */
  function getSidPreviewFullScale(): number | null {
    return sid.previewFullScale();
  }

  /** Play SID songs' 6581 as `revision` (the user's setting), at once, mid-song. */
  function setSidRevision(revision: Sid6581Revision): void {
    sid.setRevision(revision);
  }

  /** The SID transport itself (tests and diagnostics). */
  function sidTransport(): SidSongTransport {
    return sid;
  }

  async function previewAhxNoteOn(instrument: number, midi: number, velocity = 127): Promise<boolean> {
    return ahx.previewAhxNoteOn(instrument, midi, velocity);
  }

  async function prepareAhxPreview(): Promise<boolean> {
    return ahx.prepareAhxPreview();
  }

  function previewAhxNoteOff(midi: number): void {
    ahx.previewAhxNoteOff(midi);
  }

  function flushAhxInstrumentEdits(): void {
    ahx.flushAhxInstrumentEdits();
  }

  function setAhxScopesEnabled(enabled: boolean): void {
    ahx.setAhxScopesEnabled(enabled);
  }

  function getAhxChannelWaveform(channel: number): Int16Array | null {
    return ahx.getAhxChannelWaveform(channel);
  }

  /** The instrument page's scope: record the AHX keyboard preview voice's waveform, or stop. */
  function setAhxPreviewScopeEnabled(enabled: boolean): void {
    ahx.setAhxPreviewScopeEnabled(enabled);
  }

  /** The AHX preview voice's newest waveform, in `TrackWaveform`'s `scopeSource` shape (the channel is ignored). */
  function getAhxPreviewWaveform(_channel?: number): Int16Array | null {
    return ahx.getAhxPreviewWaveform();
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
        applyPosition(pos);
      });
    }

    if (!songEndUnsubscribe) {
      songEndUnsubscribe = playbackEngineInstance.on('songEnd', () => {
        for (const listener of songEndListeners) {
          listener();
        }
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
  async function loadSong(
    song: PlaybackSong,
    mode: PlaybackMode = 'song',
    skipIfPlaying: boolean = false,
    startSequenceIndex: number | null = null,
  ): Promise<boolean> {
    debugLog(`[PlaybackStore] loadSong called: mode=${mode}, skipIfPlaying=${skipIfPlaying}, isPlaying=${isPlaying.value}, isPaused=${isPaused.value}, hasSongLoaded=${hasSongLoaded.value}`);
    debugLog(`[PlaybackStore] Song has ${song.sequence.length} patterns, ${song.bpm} BPM`);

    // If already playing/paused and skipIfPlaying is set, don't disturb the current playback
    if (skipIfPlaying && (isPlaying.value || isPaused.value) && hasSongLoaded.value) {
      debugLog('[PlaybackStore] Skipping load - playback active and skipIfPlaying=true');
      return true;
    }

    if (song.moduleFormat === 'ahx') {
      sid.leave();
      return ahx.loadAhxSong(song, mode);
    }
    ahx.leaveAhx();
    if (song.moduleFormat === 'sid') return sid.load(song, mode);
    sid.leave();

    const engine = ensureEngine();

    if (!song.sequence.length) {
      console.warn('No patterns available to play.');
      return false;
    }

    playbackMode.value = mode;
    engine.setLoopCurrentPattern(mode === 'pattern');
    // Re-applied on every load: setLoopSong may have been called before this
    // engine existed, and a fresh engine defaults to looping.
    engine.setLoopSong(loopSong.value);
    debugLog('[PlaybackStore] Loading song into engine...');
    const sequenceIndex = startSequenceIndex ?? resolveStartSequenceIndex(song);
    // The bank needs the format too: it decides whether a new note on a track
    // cuts the previous one (a module channel is monophonic) or releases it
    // (a song authored here may overlap notes on a track).
    getSongBank().setModuleFormat(
      song.moduleFormat,
      song.linearFrequency,
      song.amigaLimits,
    );
    engine.loadSong(song, sequenceIndex);
    debugLog('[PlaybackStore] Preparing instruments...');
    await engine.prepareInstruments();
    hasSongLoaded.value = true;
    recordLastSong(song, mode);
    debugLog('[PlaybackStore] Song loaded successfully');

    return true;
  }

  /**
   * Replay the retained song from the beginning (plan topbar-play D-B'):
   * stop→play ⇒ top of the song, position 0, row 0. Mid-song resume is the
   * paused toggle's job (`resume`), so `playLast` only answers the fully
   * stopped state, and only when a load actually recorded a song — a fresh
   * tab with nothing ever loaded has nothing to start (topbar-play S1).
   */
  async function playLast(): Promise<void> {
    const song = lastPlaybackSong.value;
    if (!song) return;
    if (isPlaying.value || isPaused.value) return;
    await play(song, lastPlaybackMode.value, 0, 0);
  }

  /**
   * Start playback
   */
  async function play(
    song: PlaybackSong,
    mode: PlaybackMode,
    startRow: number = 0,
    startSequenceIndex: number | null = null,
  ): Promise<void> {
    debugLog(
      `[PlaybackStore] play() called: mode=${mode}, startRow=${startRow}, startSequenceIndex=${startSequenceIndex ?? 'auto'}`,
    );
    if (song.moduleFormat === 'ahx') {
      sid.leave();
      return ahx.playAhx(song, mode, startRow, startSequenceIndex);
    }
    ahx.leaveAhx();
    if (song.moduleFormat === 'sid') return sid.play(song, mode, startRow, startSequenceIndex);
    sid.leave();
    const songBank = getSongBank();

    // Resolve and persist the starting sequence index up front so UI selection stays in sync
    const sequenceIndex = startSequenceIndex ?? resolveStartSequenceIndex(song);
    currentSequenceIndex.value = sequenceIndex;
    selectedSequenceIndex.value = sequenceIndex;

    // Stop any existing playback
    suppressPositionUpdates = true;
    if (playbackEngineInstance) {
      debugLog('[PlaybackStore] Stopping existing playback');
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
    const loaded = await loadSong(song, mode, false, sequenceIndex);
    if (!loaded) {
      console.warn('[PlaybackStore] Failed to load song, aborting play');
      return;
    }

    const engine = ensureEngine();

    // Configure and start
    debugLog(`[PlaybackStore] Starting playback: bpm=${song.bpm}`);
    engine.setBpm(song.bpm);
    // Pattern lengths travel on the Song itself now; no song-level override.
    engine.seek(startRow);

    await engine.play();
    debugLog('[PlaybackStore] Playback started');
  }

  /**
   * Pause playback (keep position)
   */
  function pause(): void {
    if (ahx.isActive) {
      ahx.pause();
      return;
    }
    if (sid.isActive) {
      sid.pause();
      return;
    }
    if (!playbackEngineInstance) return;

    playbackEngineInstance.pause();
    getSongBank().cancelAllScheduled();
    getSongBank().allNotesOff();
  }

  /**
   * Continue a paused song where it stopped.
   */
  async function resume(): Promise<void> {
    if (ahx.isActive) {
      ahx.resume();
      return;
    }
    if (sid.isActive) {
      sid.resume();
      return;
    }
    await playbackEngineInstance?.play();
  }

  /**
   * Stop playback and reset to beginning of current pattern
   */
  function stop(): void {
    if (ahx.isActive) {
      ahx.stop();
      return;
    }
    if (sid.isActive) {
      sid.stop();
      return;
    }
    if (!playbackEngineInstance) return;

    playbackEngineInstance.stop();
    playbackRow.value = 0;
    getSongBank().cancelAllScheduled();
    getSongBank().allNotesOff();
    // Drop queued E0x toggles with the song; the applied LED state persists
    // (review S4).
    usePostFxStore().onPlaybackStopped();
    isPlaying.value = false;
    isPaused.value = false;
    audioStore.setPlaybackState(false);
  }

  /**
   * Seek to a specific row
   */
  function seek(row: number): void {
    if (ahx.isActive) {
      ahx.seek(row);
      return;
    }
    if (sid.isActive) {
      sid.seek(row);
      return;
    }
    if (!playbackEngineInstance) return;
    playbackEngineInstance.seek(row);
  }

  /**
   * Update BPM during playback
   */
  function setBpm(bpm: number): void {
    // The AHX engine's tempo comes from the song's own speed commands.
    if (ahx.isActive || sid.isActive || !playbackEngineInstance) return;
    playbackEngineInstance.setBpm(bpm);
  }

  /**
   * Update the row count of a single pattern in the loaded song, so an edit
   * takes effect without restarting playback.
   */
  function setPatternLength(patternId: string | null, rows: number): void {
    if (ahx.isActive || sid.isActive || !playbackEngineInstance || !patternId) return;
    playbackEngineInstance.setPatternLength(patternId, rows);
  }

  // ============================================
  // Mute/Solo controls
  // ============================================

  /**
   * Push the mute/solo the UI shows to whoever mixes the tracks: the AHX
   * worklet while it plays (voice `i` is track `i`), otherwise the song bank's
   * per-track sampler nodes.
   */
  function applyAudibilityChange(before: boolean[], trackCount: number): void {
    if (ahx.isActive) {
      ahx.syncAhxMuteSolo();
      return;
    }
    if (sid.isActive) {
      sid.syncMuteSolo();
      return;
    }
    muteInaudibleTracks(before, getAudibilitySnapshot(trackCount));
  }

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

    applyAudibilityChange(before, trackCount);
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

    applyAudibilityChange(before, trackCount);
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
    ahx.syncAhxMuteSolo();
    sid.syncMuteSolo();
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
   * Subscribe to the end of a non-looping song.
   */
  function onSongEnd(listener: SongEndListener): () => void {
    songEndListeners.add(listener);
    return () => songEndListeners.delete(listener);
  }

  /**
   * Fire the song-end listeners directly, for tests: the real event comes
   * from the playback engine, which needs an audio context tests do not have.
   */
  function emitSongEndForTest(): void {
    for (const listener of songEndListeners) {
      listener();
    }
  }

  /**
   * Choose whether the sequence restarts when it runs out.
   *
   * Off, the engine plays the song once and stops -- which is what makes an
   * end-of-song event possible at all. The jukebox turns it off so it can
   * advance its playlist; everything else leaves songs looping.
   */
  function setLoopSong(loop: boolean): void {
    loopSong.value = loop;
    playbackEngineInstance?.setLoopSong(loop);
    ahx.setLoopSong(loop);
    sid.setLoopSong(loop);
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

    ahx.dispose();
    sid.dispose();

    if (positionUnsubscribe) {
      positionUnsubscribe();
      positionUnsubscribe = null;
    }

    if (stateUnsubscribe) {
      stateUnsubscribe();
      stateUnsubscribe = null;
    }

    if (songEndUnsubscribe) {
      songEndUnsubscribe();
      songEndUnsubscribe = null;
    }

    positionListeners.clear();
    noteEventListeners.clear();
    songEndListeners.clear();
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
    lastPlaybackSong,
    lastPlaybackMode,
    canReplay,
    loopSong,

    // Getters
    engine,
    isTrackAudible,
    setSequenceIndex,

    // Transport
    loadSong,
    play,
    playLast,
    pause,
    resume,
    stop,
    seek,
    setBpm,
    setPatternLength,
    setLoopSong,

    // AHX keyboard preview
    previewAhxNoteOn,
    previewAhxNoteOff,
    flushAhxInstrumentEdits,
    prepareAhxPreview,

    // AHX/HVL per-voice scopes
    setAhxScopesEnabled,
    getAhxChannelWaveform,
    setAhxPreviewScopeEnabled,
    getAhxPreviewWaveform,

    // SID (plan-sid-tracking.md S4)
    previewSidNoteOn,
    previewSidNoteOff,
    prepareSidPreview,
    sidPreviewOutput,
    onSidPreviewOutput,
    connectSidVoiceTaps,
    getSidVoiceFullScale,
    getSidPreviewFullScale,
    sidTransport,
    setSidRevision,

    // Mute/Solo
    toggleMute,
    toggleSolo,
    sanitizeMuteSoloState,

    // Event subscriptions
    onPosition,
    onNoteEvent,
    onSongEnd,
    emitSongEndForTest,
    setTrackAudioNodeSetter,

    // Cleanup
    dispose,
  };
});
