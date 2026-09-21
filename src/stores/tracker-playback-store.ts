import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { PlaybackEngine } from '@another-synth/tracker-playback';
import type {
  Song as PlaybackSong,
  ScheduledNoteEvent,
} from '@another-synth/tracker-playback';
import { useTrackerAudioStore } from './tracker-audio-store';
import { useTrackerStore } from './tracker-store';
import { usePostFxStore } from 'src/stores/post-fx-store';
import { defaultLookaheadSeconds } from 'src/audio/device-profile';
import { AhxTransport } from 'src/audio/tracker/ahx-transport';
import { AhxPreview } from 'src/audio/tracker/ahx-preview';
import { clearAhxPListPlayhead, setAhxPListPlayhead } from 'src/audio/tracker/ahx-plist-playhead';
import type { AhxPosition, AhxWaveforms } from 'src/audio/tracker/ahx-player';
import {
  currentAhxSource,
  currentAhxPreviewSource,
  onAhxInstrumentEdit,
  onCurrentAhxSourceChange,
  type AhxInstrumentEdit,
} from 'src/audio/tracker/ahx-source';
import { AhxInstrumentSync } from 'src/audio/tracker/ahx-instrument-sync';
import {
  clearAhxNotices,
  reportAhxNotice,
  reportRejectedAhxInstruments,
} from 'src/audio/tracker/ahx-notices';

export type PlaybackMode = 'pattern' | 'song';

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

// The AHX/HVL transport. Unlike the engine above it is created only when an
// AHX or HVL song is first played, so the other formats never touch it.
let ahxTransportInstance: AhxTransport | null = null;
let ahxUnsubscribes: Array<() => void> = [];
/** The keyboard-preview voice: its own worklet, apart from the song's (`AhxTransport`). */
let ahxPreviewInstance: AhxPreview | null = null;
let ahxSourceUnsubscribe: (() => void) | null = null;
/** Carries instrument edits to the live worklets (song player and preview) once a burst of them is over. */
let ahxEditSync: AhxInstrumentSync | null = null;
let ahxEditUnsubscribe: (() => void) | null = null;
// Per-voice scope data from the AHX worklet: whether the tracker page wants it
// (the worklet records nothing otherwise), and the newest snapshot as one view
// per voice. Module-local and non-reactive on purpose: the scopes read it from
// their animation callback, and 25 Hz of reactive triggers would buy nothing.
let ahxScopesWanted = false;
let ahxScopeViews: Int16Array[] | null = null;

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

  /** Whether the sequence restarts when it runs out. */
  const loopSong = ref(true);

  /** Flag to suppress position updates during seek/stop operations */
  let suppressPositionUpdates = false;

  /**
   * Whether the song last loaded is an AHX/HVL one, and so owned by the
   * worklet's Rust engine rather than `PlaybackEngine`. Transport calls
   * (`stop`, `pause`, `resume`, ...) branch on it; the two engines are never
   * live at once.
   */
  let ahxSongActive = false;

  /**
   * Bumped whenever an AHX load or start in flight stops being wanted: the
   * transport is stopped, or handed back to `PlaybackEngine`. A load that
   * comes back from its `await` to a different value than it left with does
   * not go on to mark the song loaded (or start it).
   */
  let ahxEpoch = 0;

  /**
   * Where the AHX engine is, as last reported by the worklet or set by a seek.
   * Kept apart from `currentSequenceIndex` / `playbackRow` because those are
   * also the UI's selection: choosing another position while the song is
   * paused moves them, and a resume must compare against where the *engine*
   * is, not where the user is pointing.
   */
  let ahxPlace: { position: number; row: number } | null = null;

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

  // ============================================
  // AHX / HVL transport
  // ============================================
  //
  // The Rust engine in the AHX worklet owns the transport (ticks, rows, jumps,
  // speed), so none of `PlaybackEngine`'s scheduling applies: these functions
  // only start, pause and stop it, and mirror where it reports being. The
  // song's row model in the tracker store is display only.

  function ensureAhxTransport(): AhxTransport {
    if (!ahxTransportInstance) {
      ahxTransportInstance = new AhxTransport(getSongBank());
      ahxTransportInstance.setStopAtEnd(!loopSong.value);
      if (ahxScopesWanted) ahxTransportInstance.setCapture(true);
      syncAhxMuteSolo();
      ahxUnsubscribes = [
        ahxTransportInstance.onPosition(handleAhxPosition),
        ahxTransportInstance.onSongEnd(handleAhxSongEnd),
        ahxTransportInstance.onWaveforms(handleAhxWaveforms),
      ];
    }
    return ahxTransportInstance;
  }

  /** Free the worklet node and its wasm instance; the next AHX song makes a new one. */
  function disposeAhxTransport(): void {
    for (const unsubscribe of ahxUnsubscribes) unsubscribe();
    ahxUnsubscribes = [];
    ahxTransportInstance?.dispose();
    ahxTransportInstance = null;
  }

  /**
   * Play an AHX instrument from the keyboard: `instrument` (1-based, the
   * file's numbering, which is also the slot number) at `midi`. Sounded by a
   * preview voice of its own that the song's transport knows nothing about, so
   * it works with the song stopped, paused or playing and never disturbs it.
   * `false` when no AHX song is loaded.
   */
  async function previewAhxNoteOn(instrument: number, midi: number, velocity = 127): Promise<boolean> {
    const bytes = currentAhxPreviewSource();
    if (!bytes) {
      // Not (or no longer) an AHX song: nothing left for a preview to sound.
      disposeAhxPreview();
      return false;
    }
    ahxPreviewInstance ??= newAhxPreview();
    await ahxPreviewInstance.noteOn(bytes, instrument, midi, velocity);
    return true;
  }

  /**
   * Have the keyboard preview voice ready before the first key: called when
   * an AHX slot is selected and when an AHX song loads. It then stays until the
   * song changes or is unloaded (no idle drop). `false` when no AHX song is
   * loaded.
   */
  async function prepareAhxPreview(): Promise<boolean> {
    const bytes = currentAhxPreviewSource();
    if (!bytes) return false;
    ahxPreviewInstance ??= newAhxPreview();
    await ahxPreviewInstance.preload(bytes);
    return true;
  }

  function previewAhxNoteOff(midi: number): void {
    ahxPreviewInstance?.noteOff(midi);
  }

  function newAhxPreview(): AhxPreview {
    const preview = new AhxPreview(getSongBank(), undefined, undefined, (instruments) =>
      reportRejectedAhxInstruments(instruments, 'keyboard preview'),
    );
    // Lazy: this creates no worklet, it only says where to send the rows the
    // preview's worklet reports once there is one.
    preview.onPListRow(setAhxPListPlayhead);
    return preview;
  }

  function disposeAhxPreview(): void {
    ahxPreviewInstance?.dispose();
    ahxPreviewInstance = null;
    // The row belonged to that preview's note.
    clearAhxPListPlayhead();
  }

  // A new song (AHX or not) makes the preview voice stale: drop it at once,
  // with any held note; an AHX song gets its replacement made straight away.
  ahxSourceUnsubscribe?.();
  ahxSourceUnsubscribe = onCurrentAhxSourceChange(() => {
    // Edits waiting to be sent belong to the song that is gone.
    ahxEditSync?.discard();
    // What was said of the old song's edits is not the new one's to carry.
    clearAhxNotices();
    disposeAhxPreview();
    if (currentAhxPreviewSource()) void prepareAhxPreview().catch(() => undefined);
  });

  /**
   * Instrument edits. The store commits an edit to the song at once (the slot's
   * `ahxData` and `ahx-source`'s recorded edit); this hands it to the worklets
   * that already hold the song: the song player, so the song plays the new
   * instrument from its next trigger, and the preview voice, so the next key
   * sounds it. Both are the same instrument replaced in the same song data,
   * not a preview-only copy; a worklet made later starts from all the recorded
   * edits.
   *
   * The two are not sent alike. The preview swap is a data write (the note-on
   * prewarms what the new instrument needs, when a key is pressed), so it goes
   * at once and a key pressed right after an edit sounds it. The song player
   * may have to walk the whole song to build the hi-fi tables the new
   * instrument reaches, on the audio thread, so its edits are coalesced
   * (`AhxInstrumentSync`): a burst of edits (typing a number) costs one walk,
   * and none for volume or envelope edits, which reach no table.
   */
  function replaceInPreview(edit: AhxInstrumentEdit): void {
    ahxPreviewInstance?.replaceInstrument(edit.instrument, edit.bytes).catch((error) => {
      // The engine kept the old instrument: the keyboard sounds one thing and
      // the editor shows another until the next load. Say so, not just the log.
      reportAhxNotice(
        `Instrument #${edit.instrument}: the keyboard preview did not accept the edit (${errorText(error)}), so it sounds as before.`,
      );
    });
  }
  function sendAhxInstrumentEdits(edits: AhxInstrumentEdit[]): void {
    const transport = ahxTransportInstance;
    if (!transport) return;
    transport.replaceInstruments(edits).forEach((applied, index) => {
      applied.catch((error) => {
        reportAhxNotice(
          `Instrument #${edits[index]?.instrument}: the song did not accept the edit (${errorText(error)}), so it plays as before.`,
        );
      });
    });
  }
  const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));
  ahxEditSync?.discard();
  ahxEditSync = new AhxInstrumentSync(sendAhxInstrumentEdits);
  ahxEditUnsubscribe?.();
  ahxEditUnsubscribe = onAhxInstrumentEdit((edit) => {
    replaceInPreview(edit);
    ahxEditSync?.push(edit);
  });

  /** Send the song player the edits still waiting, now (a play must hear the edits made a moment ago). */
  function flushAhxInstrumentEdits(): void {
    ahxEditSync?.flush();
  }

  /** The worklet's position index is the sequence index: one pattern per position. */
  function handleAhxPosition(p: AhxPosition): void {
    if (ahxSongActive) ahxPlace = { position: p.position, row: p.row };
    // A report that was already in flight when the song was stopped.
    if (!ahxSongActive || !isPlaying.value) return;
    applyPosition({
      row: p.row,
      patternId: trackerStore.sequence[p.position],
      sequenceIndex: p.position,
    });
  }

  /** One view per voice into the snapshot; a report from a song no longer playing is dropped. */
  function handleAhxWaveforms(w: AhxWaveforms): void {
    if (!ahxSongActive || !isPlaying.value) return;
    ahxScopeViews = Array.from({ length: w.channels }, (_, voice) =>
      w.data.subarray(voice * w.points, (voice + 1) * w.points),
    );
  }

  /**
   * Ask the AHX worklet to record and report each voice's waveform, or stop
   * doing so. The tracker page turns it on while its per-track visualizers
   * are showing an AHX/HVL song; with it off the engine does no capture work.
   */
  function setAhxScopesEnabled(enabled: boolean): void {
    ahxScopesWanted = enabled;
    ahxTransportInstance?.setCapture(enabled);
    if (!enabled) ahxScopeViews = null;
  }

  /**
   * The newest waveform of one AHX/HVL voice (`i16`, oldest first, full scale
   * `AHX_SCOPE_FULL_SCALE`), or `null` when nothing is playing or no snapshot
   * has arrived yet. The array is a view into the latest snapshot: read it,
   * do not keep it. Not reactive; call it from a draw loop.
   */
  function getAhxChannelWaveform(channel: number): Int16Array | null {
    if (!ahxSongActive || !isPlaying.value) return null;
    return ahxScopeViews?.[channel] ?? null;
  }

  /**
   * The worklet keeps looping after the song's end; a non-looping song (the
   * jukebox) stops it here and tells the listeners, as the engine does for
   * the other formats.
   */
  function handleAhxSongEnd(): void {
    if (!ahxSongActive || loopSong.value) return;
    ahxTransportInstance?.stop();
    ahxPlace = { position: 0, row: 0 };
    setAhxTransportState('stopped');
    playbackRow.value = 0;
    for (const listener of songEndListeners) {
      listener();
    }
  }

  function setAhxTransportState(state: 'playing' | 'paused' | 'stopped'): void {
    // Not playing: the scopes go flat rather than freezing on the last snapshot.
    if (state !== 'playing') ahxScopeViews = null;
    isPlaying.value = state === 'playing';
    isPaused.value = state === 'paused';
    audioStore.setPlaybackState(state === 'playing');
  }

  /** Silence `PlaybackEngine` before the AHX engine takes over. */
  function stopSampleEngine(): void {
    if (!playbackEngineInstance) return;
    suppressPositionUpdates = true;
    playbackEngineInstance.stop();
    suppressPositionUpdates = false;
  }

  /** Hand the transport back to `PlaybackEngine`: a non-AHX song is being loaded. */
  function leaveAhx(): void {
    ahxEpoch++;
    disposeAhxPreview();
    if (!ahxSongActive) return;
    ahxSongActive = false;
    ahxPlace = null;
    ahxScopeViews = null;
    // Not just stopped: with no AHX song left to play, the worklet node would
    // sit idle (and connected to the mix bus) for the life of the app.
    disposeAhxTransport();
  }

  /**
   * Load an AHX/HVL song into the worklet: the bytes were kept at import
   * (`ahx-source`), the song passed in is only the display model.
   *
   * Throws if the worklet cannot read the file, so a caller loading a
   * playlist entry can move past it.
   */
  async function loadAhxSong(song: PlaybackSong, mode: PlaybackMode): Promise<boolean> {
    const bytes = currentAhxSource();
    if (!bytes) {
      console.warn(
        '[PlaybackStore] AHX song has no source bytes (a .cmod saved before AHX songs could be saved cannot carry them); cannot play',
      );
      return false;
    }
    if (!song.sequence.length) {
      console.warn('No patterns available to play.');
      return false;
    }
    stopSampleEngine();
    playbackMode.value = mode;
    // A mute/solo left over from a wider song must not outlive its track: a
    // solo on a voice this song lacks would silence every voice it has.
    const voices = song.patterns[0]?.tracks.length;
    if (voices) sanitizeMuteSoloState(voices);
    getSongBank().setModuleFormat(song.moduleFormat, song.linearFrequency, song.amigaLimits);
    const transport = ensureAhxTransport();
    // Claimed before the await, not after: a stop or a MOD load that lands
    // while the worklet is loading must see an AHX song and take the AHX
    // branch (`leaveAhx` / the transport stop), not the engine's.
    const wasActive = ahxSongActive;
    ahxSongActive = true;
    const epoch = ahxEpoch;
    const loading = transport.load(bytes).then((info) => {
      // An edit the engine refused at the load: the song plays the file's
      // instrument while the editor shows the edited one.
      reportRejectedAhxInstruments(info?.rejectedInstruments, 'song player');
      return info;
    });
    if (getSongBank().audioContext.state === 'running') {
      try {
        await loading;
      } catch (error) {
        if (epoch === ahxEpoch) ahxSongActive = wasActive;
        throw error;
      }
      // Stopped, or another format took over, while the worklet was loading.
      if (epoch !== ahxEpoch) return false;
    } else {
      // A suspended context does not run the worklet's render thread, so its
      // handshake cannot finish until a user gesture resumes it; awaiting it
      // here would hang a fresh-tab deep-link load. The load carries on, and
      // `play` (which resumes the context first) joins it.
      loading.catch((error) => {
        console.warn('[PlaybackStore] AHX load failed while the context was suspended', error);
      });
    }
    hasSongLoaded.value = true;
    return true;
  }

  /**
   * Start an AHX/HVL song from `startRow` of order position `startSequenceIndex`
   * ("play from here"), looping that position when `mode` is `'pattern'`.
   *
   * Nothing here restarts the song to get anywhere. The Rust engine owns the
   * transport, so every case is one of two commands to it:
   *  - a paused song asked to play from where it is paused **resumes**: the
   *    engine was only stopped from rendering, so the clock, the wave phases,
   *    envelopes, filter sweeps and the rest pick up on the next sample;
   *  - anywhere else is a **seek** (`AhxPlayer.seek`): the engine replays the
   *    song's flow up to that row without mixing, so the row starts with the
   *    voices it would have had if the song had played to there.
   * Whether the song loops that position is a flag on the same engine, so it
   * can be flipped while running without touching the clock.
   */
  async function playAhx(
    song: PlaybackSong,
    mode: PlaybackMode,
    startRow: number,
    startSequenceIndex: number | null,
  ): Promise<void> {
    const songBank = getSongBank();
    const position = Math.max(
      0,
      Math.min(startSequenceIndex ?? resolveStartSequenceIndex(song), song.sequence.length - 1),
    );
    const rows = trackerStore.rowsForPattern(song.sequence[position]);
    const row = Math.max(0, Math.min(Math.round(startRow), rows - 1));
    // What the editor holds (an edit the store has not flushed yet, an
    // instrument or title change) is in the bytes before they are compared or
    // loaded: the next Play plays what the grid shows. Swaps the bytes only
    // when their content changed, so a resume in place is not lost by asking.
    trackerStore.flushAhxBytes();
    // Decided before anything awaits or loads, from where the song is now: a
    // load of other bytes (the jukebox moving on) is never a resume.
    const bytes = currentAhxSource();
    const resuming =
      ahxSongActive &&
      isPaused.value &&
      ahxTransportInstance !== null &&
      bytes !== null &&
      ahxTransportInstance.isLoaded(bytes) &&
      ahxPlace?.position === position &&
      ahxPlace.row === row;
    const epoch = ahxEpoch;
    // A song that is already in the worklet plays the edits made a moment ago.
    flushAhxInstrumentEdits();

    stopSampleEngine();
    songBank.cancelAllScheduled();
    songBank.allNotesOff();

    const contextRunning = await songBank.ensureAudioContextRunning();
    if (!contextRunning || songBank.audioContext.state !== 'running') {
      console.warn(
        `[PlaybackStore] AudioContext not running; skipping AHX playback start (state=${songBank.audioContext.state})`,
      );
      return;
    }
    // Stopped while the context was being resumed.
    if (epoch !== ahxEpoch) return;

    if (!(await loadAhxSong(song, mode))) return;
    const transport = ensureAhxTransport();
    transport.setLoopPosition(mode === 'pattern');
    if (!resuming) {
      transport.seek(position, row);
      ahxPlace = { position, row };
      ahxScopeViews = null;
      currentSequenceIndex.value = position;
      selectedSequenceIndex.value = position;
      playbackRow.value = row;
    }
    transport.play();
    setAhxTransportState('playing');
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
    console.log(`[PlaybackStore] loadSong called: mode=${mode}, skipIfPlaying=${skipIfPlaying}, isPlaying=${isPlaying.value}, isPaused=${isPaused.value}, hasSongLoaded=${hasSongLoaded.value}`);
    console.log(`[PlaybackStore] Song has ${song.sequence.length} patterns, ${song.bpm} BPM`);

    // If already playing/paused and skipIfPlaying is set, don't disturb the current playback
    if (skipIfPlaying && (isPlaying.value || isPaused.value) && hasSongLoaded.value) {
      console.log('[PlaybackStore] Skipping load - playback active and skipIfPlaying=true');
      return true;
    }

    if (song.moduleFormat === 'ahx') return loadAhxSong(song, mode);
    leaveAhx();

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
    console.log('[PlaybackStore] Loading song into engine...');
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
    console.log('[PlaybackStore] Preparing instruments...');
    await engine.prepareInstruments();
    hasSongLoaded.value = true;
    console.log('[PlaybackStore] Song loaded successfully');

    return true;
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
    console.log(
      `[PlaybackStore] play() called: mode=${mode}, startRow=${startRow}, startSequenceIndex=${startSequenceIndex ?? 'auto'}`,
    );
    if (song.moduleFormat === 'ahx') return playAhx(song, mode, startRow, startSequenceIndex);
    leaveAhx();
    const songBank = getSongBank();

    // Resolve and persist the starting sequence index up front so UI selection stays in sync
    const sequenceIndex = startSequenceIndex ?? resolveStartSequenceIndex(song);
    currentSequenceIndex.value = sequenceIndex;
    selectedSequenceIndex.value = sequenceIndex;

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
    const loaded = await loadSong(song, mode, false, sequenceIndex);
    if (!loaded) {
      console.warn('[PlaybackStore] Failed to load song, aborting play');
      return;
    }

    const engine = ensureEngine();

    // Configure and start
    console.log(`[PlaybackStore] Starting playback: bpm=${song.bpm}`);
    engine.setBpm(song.bpm);
    // Pattern lengths travel on the Song itself now; no song-level override.
    engine.seek(startRow);

    await engine.play();
    console.log('[PlaybackStore] Playback started');
  }

  /**
   * Pause playback (keep position)
   */
  function pause(): void {
    if (ahxSongActive) {
      ahxTransportInstance?.pause();
      setAhxTransportState('paused');
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
    if (ahxSongActive) {
      ahxTransportInstance?.play();
      setAhxTransportState('playing');
      return;
    }
    await playbackEngineInstance?.play();
  }

  /**
   * Stop playback and reset to beginning of current pattern
   */
  function stop(): void {
    if (ahxSongActive) {
      ahxEpoch++;
      ahxTransportInstance?.stop();
      ahxPlace = { position: 0, row: 0 };
      setAhxTransportState('stopped');
      playbackRow.value = 0;
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
    if (ahxSongActive) {
      // The engine replays to the row on its own clock; play/pause is kept.
      const rows = trackerStore.rowsForPattern(trackerStore.sequence[currentSequenceIndex.value]);
      const target = Math.max(0, Math.min(Math.round(row), rows - 1));
      ahxTransportInstance?.seek(currentSequenceIndex.value, target);
      ahxPlace = { position: currentSequenceIndex.value, row: target };
      playbackRow.value = target;
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
    if (ahxSongActive || !playbackEngineInstance) return;
    playbackEngineInstance.setBpm(bpm);
  }

  /**
   * Update the row count of a single pattern in the loaded song, so an edit
   * takes effect without restarting playback.
   */
  function setPatternLength(patternId: string | null, rows: number): void {
    if (ahxSongActive || !playbackEngineInstance || !patternId) return;
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
    if (ahxSongActive) {
      syncAhxMuteSolo();
      return;
    }
    muteInaudibleTracks(before, getAudibilitySnapshot(trackCount));
  }

  /**
   * The store's mute and solo sets as the bit masks the AHX worklet takes.
   * The worklet keeps them across song loads; a transport made later gets
   * them when it is created (`ensureAhxTransport`).
   */
  function syncAhxMuteSolo(): void {
    if (!ahxTransportInstance) return;
    const mask = (tracks: Set<number>) => {
      let bits = 0;
      for (const i of tracks) if (i >= 0 && i < 32) bits |= 1 << i;
      return bits >>> 0;
    };
    ahxTransportInstance.setMuteSolo(mask(mutedTracks.value), mask(soloedTracks.value));
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
    syncAhxMuteSolo();
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
    ahxTransportInstance?.setStopAtEnd(!loop);
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

    disposeAhxTransport();
    disposeAhxPreview();
    ahxSourceUnsubscribe?.();
    ahxSourceUnsubscribe = null;
    ahxEditUnsubscribe?.();
    ahxEditUnsubscribe = null;
    ahxEditSync?.discard();
    ahxEditSync = null;
    ahxSongActive = false;
    ahxScopeViews = null;
    ahxEpoch++;

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
    loopSong,

    // Getters
    engine,
    isTrackAudible,
    setSequenceIndex,

    // Transport
    loadSong,
    play,
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
