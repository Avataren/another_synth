import type { Ref } from 'vue';
import type { Song as PlaybackSong } from '@another-synth/tracker-playback';
import {
  AHX_RECOVERY_NOTICE_ID,
  AHX_RELOAD_FAILED_NOTICE_ID,
  AhxTransport,
  type AhxReloadOutcome,
} from 'src/audio/tracker/ahx-transport';
import type { AhxDoc, AhxPositionMap } from 'src/audio/tracker/ahx-doc';
import { composeAhxPositionMaps, mapAhxPlace, AhxReloadScheduler } from 'src/audio/tracker/ahx-reload';
import { reportAhxEditNotice } from 'src/audio/tracker/ahx-edit-notice';
import { AhxPreview } from 'src/audio/tracker/ahx-preview';
import {
  clearAhxPListPlayhead,
  pushAhxPListReport,
  setAhxPListTimingSource,
} from 'src/audio/tracker/ahx-plist-playhead';
import { setAhxPreviewOutputNode } from 'src/audio/tracker/ahx-preview-output';
import { playheadLatencyMs, playheadTiming } from 'src/audio/tracker/plist-playhead-clock';
import type { AhxPosition, AhxWaveforms } from 'src/audio/tracker/ahx-player';
import {
  currentAhxSource,
  currentAhxPreviewSource,
  ahxSpeedMultiplierOf,
  onAhxInstrumentEdit,
  onAhxStructureChange,
  onCurrentAhxSourceChange,
  type AhxInstrumentEdit,
  type AhxStructureChange,
} from 'src/audio/tracker/ahx-source';
import { AhxInstrumentSync } from 'src/audio/tracker/ahx-instrument-sync';
import {
  clearAhxNotice,
  clearAhxNotices,
  reportAhxNotice,
  reportRejectedAhxInstruments,
} from 'src/audio/tracker/ahx-notices';
import type { TrackerSongBank } from 'src/audio/tracker/song-bank';

export type PlaybackMode = 'pattern' | 'song';

/** The part of the tracker store the AHX transport reads and flushes. */
export interface AhxSongTransportTracker {
  readonly sequence: string[];
  readonly ahxDoc: AhxDoc | null | undefined;
  rowsForPattern(patternId: string | undefined): number;
  flushAhxBytes(): void;
}

/**
 * What the playback store lends the AHX transport: its reactive state (the
 * store keeps owning all of it) and the store-side helpers the AHX path calls.
 */
export interface AhxSongTransportDeps {
  isPlaying: Ref<boolean>;
  isPaused: Ref<boolean>;
  playbackMode: Ref<PlaybackMode>;
  playbackRow: Ref<number>;
  currentSequenceIndex: Ref<number>;
  selectedSequenceIndex: Ref<number | null>;
  mutedTracks: Ref<Set<number>>;
  soloedTracks: Ref<Set<number>>;
  hasSongLoaded: Ref<boolean>;
  loopSong: Ref<boolean>;
  songEndListeners: Set<() => void>;
  trackerStore: AhxSongTransportTracker;
  getSongBank(): TrackerSongBank;
  setPlaybackState(playing: boolean): void;
  applyPosition(pos: { row: number; patternId?: string | undefined; sequenceIndex?: number | undefined }): void;
  resolveStartSequenceIndex(song: PlaybackSong): number;
  recordLastSong(song: PlaybackSong, mode: PlaybackMode): void;
  sanitizeMuteSoloState(trackCount: number): void;
  /** Silence `PlaybackEngine` before the AHX engine takes over. */
  stopSampleEngine(): void;
}

// The AHX/HVL transport. Unlike the engine above it is created only when an
// AHX or HVL song is first played, so the other formats never touch it.
let ahxTransportInstance: AhxTransport | null = null;
let ahxUnsubscribes: Array<() => void> = [];
/** The keyboard-preview voice: its own worklet, apart from the song's (`AhxTransport`). */
let ahxPreviewInstance: AhxPreview | null = null;
/** Whether the instrument page's scope wants the preview voice's waveform (applied to a preview made later too). */
let ahxPreviewScopeWanted = false;
let ahxSourceUnsubscribe: (() => void) | null = null;
let ahxStructureUnsubscribe: (() => void) | null = null;
/** The debounce in front of a live reload of a playing AHX song (`AhxReloadScheduler`). */
let ahxReloadScheduler: AhxReloadScheduler | null = null;
/** Carries instrument edits to the live worklets (song player and preview) once a burst of them is over. */
let ahxEditSync: AhxInstrumentSync | null = null;
let ahxEditUnsubscribe: (() => void) | null = null;
// Per-voice scope data from the AHX worklet: whether the tracker page wants it
// (the worklet records nothing otherwise), and the newest snapshot as one view
// per voice. Module-local and non-reactive on purpose: the scopes read it from
// their animation callback, and 25 Hz of reactive triggers would buy nothing.
let ahxScopesWanted = false;
let ahxScopeViews: Int16Array[] | null = null;

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

// ============================================
// AHX / HVL transport
// ============================================
//
// The Rust engine in the AHX worklet owns the transport (ticks, rows, jumps,
// speed), so none of `PlaybackEngine`'s scheduling applies: these functions
// only start, pause and stop it, and mirror where it reports being. The
// song's row model in the tracker store is display only.
//
// The worklet handles above are module-level, as they were in the playback
// store: they outlive a Pinia, and a new transport takes over (and a
// `dispose` frees) whatever the previous one left behind. The per-song state
// below is the instance's, as it was the store instance's.

export class AhxSongTransport {
  /**
   * Whether the song last loaded is an AHX/HVL one, and so owned by the
   * worklet's Rust engine rather than `PlaybackEngine`. Transport calls
   * (`stop`, `pause`, `resume`, ...) branch on it; the two engines are never
   * live at once.
   */
  private ahxSongActive = false;

  /**
   * Bumped whenever an AHX load or start in flight stops being wanted: the
   * transport is stopped, or handed back to `PlaybackEngine`. A load that
   * comes back from its `await` to a different value than it left with does
   * not go on to mark the song loaded (or start it).
   */
  private ahxEpoch = 0;

  /**
   * Where the AHX engine is, as last reported by the worklet or set by a seek.
   * Kept apart from `currentSequenceIndex` / `playbackRow` because those are
   * also the UI's selection: choosing another position while the song is
   * paused moves them, and a resume must compare against where the *engine*
   * is, not where the user is pointing.
   */
  private ahxPlace: { position: number; row: number } | null = null;

  /**
   * Where the worklet's song and the editor's song part ways: `map(i)` is the
   * editor's index of the worklet song's position `i` (`null`: it is gone,
   * `undefined`: nothing moved). Position ops change the editor's song at
   * once and the worklet's only when the reload runs, so until then (and after
   * a reload the engine refused) the positions the worklet reports are in the
   * old song's terms. It composes the maps of the reloads already sent; the
   * edits still waiting in the scheduler come on top (`ahxHighlightMap`).
   */
  private ahxSpaceMap: AhxPositionMap | undefined;

  /** A reload burst has been sent and its `song-loaded` has not come back: the reports are still the old song's. */
  private ahxReloadInFlight = false;

  /** Which burst the outcome that comes back belongs to; a newer one, a stop or a song change orphans it. */
  private ahxReloadBurst = 0;

  /** The epoch a scheduled reload was scheduled in (see `ahxEpoch`). */
  private ahxReloadEpoch = 0;

  /** A reload's `seek` has been sent and its answer (the kind) is still to come. */
  private ahxAwaitingSeekKind = false;

  constructor(private readonly deps: AhxSongTransportDeps) {
    // A new song (AHX or not) makes the preview voice stale: drop it at once,
    // with any held note; an AHX song gets its replacement made straight away.
    ahxSourceUnsubscribe?.();
    ahxSourceUnsubscribe = onCurrentAhxSourceChange(() => {
      // Edits waiting to be sent belong to the song that is gone, and so does a reload.
      ahxEditSync?.discard();
      this.resetAhxReload();
      // What was said of the old song's edits is not the new one's to carry.
      clearAhxNotices();
      this.disposeAhxPreview();
      if (currentAhxPreviewSource()) void this.prepareAhxPreview().catch(() => undefined);
    });

    ahxReloadScheduler?.cancel();
    ahxReloadScheduler = new AhxReloadScheduler((map) => this.runAhxReload(map));
    ahxStructureUnsubscribe?.();
    ahxStructureUnsubscribe = onAhxStructureChange(this.handleAhxStructureChange);

    ahxEditSync?.discard();
    ahxEditSync = new AhxInstrumentSync(this.sendAhxInstrumentEdits);
    ahxEditUnsubscribe?.();
    ahxEditUnsubscribe = onAhxInstrumentEdit((edit) => {
      this.replaceInPreview(edit);
      ahxEditSync?.push(edit);
    });
  }

  /** Whether the song last loaded is an AHX/HVL one (see `ahxSongActive`). */
  get isActive(): boolean {
    return this.ahxSongActive;
  }

  private ensureAhxTransport(): AhxTransport {
    if (!ahxTransportInstance) {
      ahxTransportInstance = new AhxTransport(this.deps.getSongBank());
      ahxTransportInstance.setStopAtEnd(!this.deps.loopSong.value);
      if (ahxScopesWanted) ahxTransportInstance.setCapture(true);
      this.syncAhxMuteSolo();
      ahxUnsubscribes = [
        ahxTransportInstance.onPosition(this.handleAhxPosition),
        ahxTransportInstance.onSongEnd(this.handleAhxSongEnd),
        ahxTransportInstance.onWaveforms(this.handleAhxWaveforms),
        ahxTransportInstance.onSeekKind(this.handleAhxSeekKind),
      ];
    }
    return ahxTransportInstance;
  }

  /** Free the worklet node and its wasm instance; the next AHX song makes a new one. */
  private disposeAhxTransport(): void {
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
  async previewAhxNoteOn(instrument: number, midi: number, velocity = 127): Promise<boolean> {
    const bytes = currentAhxPreviewSource();
    if (!bytes) {
      // Not (or no longer) an AHX song: nothing left for a preview to sound.
      this.disposeAhxPreview();
      return false;
    }
    ahxPreviewInstance ??= this.newAhxPreview();
    await ahxPreviewInstance.noteOn(bytes, instrument, midi, velocity);
    return true;
  }

  /**
   * Have the keyboard preview voice ready before the first key: called when
   * an AHX slot is selected and when an AHX song loads. It then stays until the
   * song changes or is unloaded (no idle drop). `false` when no AHX song is
   * loaded.
   */
  async prepareAhxPreview(): Promise<boolean> {
    const bytes = currentAhxPreviewSource();
    if (!bytes) return false;
    ahxPreviewInstance ??= this.newAhxPreview();
    await ahxPreviewInstance.preload(bytes);
    return true;
  }

  previewAhxNoteOff(midi: number): void {
    ahxPreviewInstance?.noteOff(midi);
  }

  /** Record the keyboard preview voice's waveform for the instrument page's scope, or stop. */
  setAhxPreviewScopeEnabled(enabled: boolean): void {
    ahxPreviewScopeWanted = enabled;
    ahxPreviewInstance?.setCapture(enabled);
  }

  /** The preview voice's newest waveform (see `AhxPreview.getWaveform`), or null. Not reactive. */
  getAhxPreviewWaveform(): Int16Array | null {
    return ahxPreviewInstance?.getWaveform() ?? null;
  }

  /**
   * What the playhead's clock holds a row back by, and how often the engine
   * can step: the preview's context latency (seconds; 0 where the browser does
   * not report it) and the song's speed multiplier at the context's rate.
   */
  private ahxPlayheadTiming = () => {
    const context = this.deps.getSongBank().audioContext as AudioContext & { outputLatency?: number };
    const bytes = currentAhxPreviewSource();
    return playheadTiming(
      context.sampleRate,
      bytes ? ahxSpeedMultiplierOf(bytes) : 1,
      playheadLatencyMs(context.baseLatency, context.outputLatency),
    );
  };

  private newAhxPreview(): AhxPreview {
    const preview = new AhxPreview(this.deps.getSongBank(), undefined, undefined, (instruments) =>
      reportRejectedAhxInstruments(instruments, 'keyboard preview'),
    );
    // Lazy: this creates no worklet, it only says where to send the rows the
    // preview's worklet reports once there is one.
    preview.onPListRow(pushAhxPListReport);
    preview.onOutputNode(setAhxPreviewOutputNode);
    preview.setCapture(ahxPreviewScopeWanted);
    setAhxPListTimingSource(this.ahxPlayheadTiming);
    return preview;
  }

  private disposeAhxPreview(): void {
    ahxPreviewInstance?.dispose();
    ahxPreviewInstance = null;
    // The row belonged to that preview's note.
    clearAhxPListPlayhead();
    setAhxPreviewOutputNode(null);
  }

  // ------------------------------------------------------------------
  // Live reload of a playing AHX song
  // ------------------------------------------------------------------
  //
  // A structural edit (a cell, a position, an added instrument, an undo) makes
  // the store swap in new bytes (`replaceCurrentAhxBytes`), which lands here.
  // Stopped or paused nothing is sent: the next Play loads what the editor
  // holds. Playing, the song is reloaded once the edits stop coming
  // (`AhxReloadScheduler`): one burst of `load-song`, `seek(place)`, `play`
  // (`AhxTransport.reloadInPlace`), at a place that has been through every
  // position op the burst coalesced. A reload costs an audible dropout (the
  // worklet prewarms the hi-fi tables on the audio thread).

  /** Forget a scheduled or running reload: the song changed, or playback stopped or left the AHX engine. */
  private resetAhxReload(): void {
    ahxReloadScheduler?.cancel();
    this.ahxReloadBurst++;
    this.ahxReloadInFlight = false;
    this.ahxAwaitingSeekKind = false;
    this.ahxSpaceMap = undefined;
  }

  private handleAhxStructureChange = (change: AhxStructureChange): void => {
    // An undo starts the song's instruments over: edits waiting to be sent are older than that.
    if (change.resetEdits) ahxEditSync?.discard();
    // The preview needs the instrument list, never the patterns: its bytes moved
    // only when the instruments did. Not created just for this (its first key loads).
    if ((change.instrumentsChanged || change.resetEdits) && ahxPreviewInstance) {
      void this.prepareAhxPreview().catch(() => undefined);
    }
    if (this.ahxSongActive && this.deps.isPlaying.value) {
      if (!ahxReloadScheduler?.pending) this.ahxReloadEpoch = this.ahxEpoch;
      ahxReloadScheduler?.schedule(change.mapPosition);
      return;
    }
    // Paused: the worklet keeps the old song until a resume or a Play, so the
    // map is kept for the place. Stopped: the next Play seeks from the selection.
    if (this.ahxSongActive && this.deps.isPaused.value) {
      this.ahxSpaceMap = composeAhxPositionMaps(this.ahxSpaceMap, change.mapPosition);
    }
    if (change.mapPosition) this.remapAhxSelection(change.mapPosition);
  };

  /** Not playing, so nothing else moves the selection: a deleted position lands on the one now at its index. */
  private remapAhxSelection(map: AhxPositionMap): void {
    const { trackerStore, currentSequenceIndex, selectedSequenceIndex } = this.deps;
    const count = trackerStore.ahxDoc?.positions.length ?? trackerStore.sequence.length;
    const last = Math.max(0, count - 1);
    const through = (index: number): number => Math.min(last, map(index) ?? index);
    currentSequenceIndex.value = through(currentSequenceIndex.value);
    if (selectedSequenceIndex.value !== null) selectedSequenceIndex.value = through(selectedSequenceIndex.value);
  }

  /** The debounce ran out: reload the playing song, if it still needs it. */
  private runAhxReload(map: AhxPositionMap | undefined): void {
    // Stopped, or another format took over, while the edits were coming in.
    if (this.ahxReloadEpoch !== this.ahxEpoch || !this.ahxSongActive) return;
    this.ahxSpaceMap = composeAhxPositionMaps(this.ahxSpaceMap, map);
    // Paused meanwhile: the next Play (or a resume) loads the bytes.
    if (!this.deps.isPlaying.value) return;
    this.sendAhxReload();
  }

  /** The reload burst. `false` when there was nothing to send (the worklet already holds the current bytes). */
  private sendAhxReload(): boolean {
    const { trackerStore, currentSequenceIndex, playbackRow } = this.deps;
    const transport = ahxTransportInstance;
    if (!transport) return false;
    // What the editor holds (an un-flushed cell edit, an instrument or title
    // change) goes into the bytes first; swaps them only when the content differs.
    trackerStore.flushAhxBytes();
    const bytes = currentAhxSource();
    if (!bytes || (transport.isLoaded(bytes) && !this.ahxReloadInFlight)) return false;
    const from = this.ahxPlace ?? { position: currentSequenceIndex.value, row: playbackRow.value };
    const count = trackerStore.ahxDoc?.positions.length ?? trackerStore.sequence.length;
    const place = mapAhxPlace(from, this.ahxSpaceMap, count);
    const rows = trackerStore.rowsForPattern(trackerStore.sequence[place.position]);
    place.row = Math.max(0, Math.min(place.row, rows - 1));
    this.ahxPlace = place;
    this.ahxReloadInFlight = true;
    this.ahxAwaitingSeekKind = true;
    const burst = ++this.ahxReloadBurst;
    void transport.reloadInPlace(bytes, place, true, from).then((outcome) => {
      if (burst === this.ahxReloadBurst) this.onAhxReloaded(outcome, from);
    });
    return true;
  }

  private onAhxReloaded(outcome: AhxReloadOutcome, from: { position: number; row: number }): void {
    this.ahxReloadInFlight = false;
    switch (outcome.outcome) {
      case 'superseded':
        break;
      case 'loaded':
        // The worklet's song is the editor's again: reports need no map now, and
        // what an earlier refusal said no longer holds.
        this.ahxSpaceMap = undefined;
        clearAhxNotice(AHX_RECOVERY_NOTICE_ID);
        clearAhxNotice(AHX_RELOAD_FAILED_NOTICE_ID);
        reportRejectedAhxInstruments(outcome.info.rejectedInstruments, 'song player');
        break;
      case 'recovered':
        // The worklet plays the last version it accepted (the transport said so),
        // from where it was: its positions are still the old song's, and
        // `ahxSpaceMap` keeps mapping them to the editor's.
        this.ahxPlace = from;
        break;
      case 'failed':
        // The worklet holds no song (the transport said so): nothing plays.
        this.ahxSpaceMap = undefined;
        this.ahxAwaitingSeekKind = false;
        this.ahxPlace = { position: 0, row: 0 };
        this.setAhxTransportState('stopped');
        this.deps.playbackRow.value = 0;
        break;
    }
  }

  /** The `seek` of a reload was answered: kind 2 means the row starts cold. */
  private handleAhxSeekKind = (kind: 1 | 2): void => {
    if (!this.ahxAwaitingSeekKind) return;
    this.ahxAwaitingSeekKind = false;
    if (kind === 2) {
      reportAhxEditNotice(
        "The edit changed the song's flow so that it no longer reaches the row that was playing: playback continues from that row with no notes carried over.",
      );
    }
  };

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
  private replaceInPreview(edit: AhxInstrumentEdit): void {
    ahxPreviewInstance?.replaceInstrument(edit.instrument, edit.bytes).catch((error) => {
      // The engine kept the old instrument: the keyboard sounds one thing and
      // the editor shows another until the next load. Say so, not just the log.
      reportAhxNotice(
        `Instrument #${edit.instrument}: the keyboard preview did not accept the edit (${errorText(error)}), so it sounds as before.`,
      );
    });
  }
  private sendAhxInstrumentEdits = (edits: AhxInstrumentEdit[]): void => {
    const transport = ahxTransportInstance;
    if (!transport) return;
    transport.replaceInstruments(edits).forEach((applied, index) => {
      applied.catch((error) => {
        reportAhxNotice(
          `Instrument #${edits[index]?.instrument}: the song did not accept the edit (${errorText(error)}), so it plays as before.`,
        );
      });
    });
  };

  /** Send the song player the edits still waiting, now (a play must hear the edits made a moment ago). */
  flushAhxInstrumentEdits(): void {
    ahxEditSync?.flush();
  }

  /** The worklet's position index is the sequence index: one pattern per position. */
  private handleAhxPosition = (p: AhxPosition): void => {
    // While a reload is on its way the reports are the old song's: the place the
    // burst was sent with is the truth until the new song answers.
    if (this.ahxSongActive && !this.ahxReloadInFlight) this.ahxPlace = { position: p.position, row: p.row };
    // A report that was already in flight when the song was stopped.
    if (!this.ahxSongActive || !this.deps.isPlaying.value) return;
    // The editor's song may already be another one than the worklet plays (an
    // edit is waiting for its reload): its sequence is the new order, the report
    // is in the old one. Through the map, or no highlight rather than a wrong one.
    const map = this.ahxHighlightMap();
    const index = map ? map(p.position) : p.position;
    if (index === null) return;
    this.deps.applyPosition({
      row: p.row,
      patternId: this.deps.trackerStore.sequence[index],
      sequenceIndex: index,
    });
  };

  /** Old-song index to editor index for a report: what was sent already, then what is still waiting. */
  private ahxHighlightMap(): AhxPositionMap | undefined {
    return composeAhxPositionMaps(this.ahxSpaceMap, ahxReloadScheduler?.pendingMap);
  }

  /** One view per voice into the snapshot; a report from a song no longer playing is dropped. */
  private handleAhxWaveforms = (w: AhxWaveforms): void => {
    if (!this.ahxSongActive || !this.deps.isPlaying.value) return;
    ahxScopeViews = Array.from({ length: w.channels }, (_, voice) =>
      w.data.subarray(voice * w.points, (voice + 1) * w.points),
    );
  };

  /**
   * Ask the AHX worklet to record and report each voice's waveform, or stop
   * doing so. The tracker page turns it on while its per-track visualizers
   * are showing an AHX/HVL song; with it off the engine does no capture work.
   */
  setAhxScopesEnabled(enabled: boolean): void {
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
  getAhxChannelWaveform(channel: number): Int16Array | null {
    if (!this.ahxSongActive || !this.deps.isPlaying.value) return null;
    return ahxScopeViews?.[channel] ?? null;
  }

  /**
   * The worklet keeps looping after the song's end; a non-looping song (the
   * jukebox) stops it here and tells the listeners, as the engine does for
   * the other formats.
   */
  private handleAhxSongEnd = (): void => {
    if (!this.ahxSongActive || this.deps.loopSong.value) return;
    ahxTransportInstance?.stop();
    this.ahxPlace = { position: 0, row: 0 };
    this.setAhxTransportState('stopped');
    this.deps.playbackRow.value = 0;
    for (const listener of this.deps.songEndListeners) {
      listener();
    }
  };

  private setAhxTransportState(state: 'playing' | 'paused' | 'stopped'): void {
    // Not playing: the scopes go flat rather than freezing on the last snapshot.
    if (state !== 'playing') ahxScopeViews = null;
    this.deps.isPlaying.value = state === 'playing';
    this.deps.isPaused.value = state === 'paused';
    this.deps.setPlaybackState(state === 'playing');
  }

  /** Hand the transport back to `PlaybackEngine`: a non-AHX song is being loaded. */
  leaveAhx(): void {
    this.ahxEpoch++;
    this.resetAhxReload();
    this.disposeAhxPreview();
    if (!this.ahxSongActive) return;
    this.ahxSongActive = false;
    this.ahxPlace = null;
    ahxScopeViews = null;
    // Not just stopped: with no AHX song left to play, the worklet node would
    // sit idle (and connected to the mix bus) for the life of the app.
    this.disposeAhxTransport();
  }

  /**
   * Load an AHX/HVL song into the worklet: the bytes were kept at import
   * (`ahx-source`), the song passed in is only the display model.
   *
   * Throws if the worklet cannot read the file, so a caller loading a
   * playlist entry can move past it.
   */
  async loadAhxSong(song: PlaybackSong, mode: PlaybackMode): Promise<boolean> {
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
    this.deps.stopSampleEngine();
    this.deps.playbackMode.value = mode;
    // A mute/solo left over from a wider song must not outlive its track: a
    // solo on a voice this song lacks would silence every voice it has.
    const voices = song.patterns[0]?.tracks.length;
    if (voices) this.deps.sanitizeMuteSoloState(voices);
    this.deps.getSongBank().setModuleFormat(song.moduleFormat, song.linearFrequency, song.amigaLimits);
    const transport = this.ensureAhxTransport();
    // Claimed before the await, not after: a stop or a MOD load that lands
    // while the worklet is loading must see an AHX song and take the AHX
    // branch (`leaveAhx` / the transport stop), not the engine's.
    const wasActive = this.ahxSongActive;
    this.ahxSongActive = true;
    const epoch = this.ahxEpoch;
    const loading = transport.load(bytes).then((info) => {
      // An edit the engine refused at the load: the song plays the file's
      // instrument while the editor shows the edited one.
      reportRejectedAhxInstruments(info?.rejectedInstruments, 'song player');
      // A load that took the current bytes: what a refused reload said is over.
      clearAhxNotice(AHX_RECOVERY_NOTICE_ID);
      clearAhxNotice(AHX_RELOAD_FAILED_NOTICE_ID);
      return info;
    });
    if (this.deps.getSongBank().audioContext.state === 'running') {
      try {
        await loading;
      } catch (error) {
        if (epoch === this.ahxEpoch) this.ahxSongActive = wasActive;
        throw error;
      }
      // Stopped, or another format took over, while the worklet was loading.
      if (epoch !== this.ahxEpoch) return false;
    } else {
      // A suspended context does not run the worklet's render thread, so its
      // handshake cannot finish until a user gesture resumes it; awaiting it
      // here would hang a fresh-tab deep-link load. The load carries on, and
      // `play` (which resumes the context first) joins it.
      loading.catch((error) => {
        console.warn('[PlaybackStore] AHX load failed while the context was suspended', error);
      });
    }
    this.deps.hasSongLoaded.value = true;
    this.deps.recordLastSong(song, mode);
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
  async playAhx(
    song: PlaybackSong,
    mode: PlaybackMode,
    startRow: number,
    startSequenceIndex: number | null,
  ): Promise<void> {
    const { trackerStore, isPaused, currentSequenceIndex, selectedSequenceIndex, playbackRow } = this.deps;
    const songBank = this.deps.getSongBank();
    const position = Math.max(
      0,
      Math.min(startSequenceIndex ?? this.deps.resolveStartSequenceIndex(song), song.sequence.length - 1),
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
      this.ahxSongActive &&
      isPaused.value &&
      ahxTransportInstance !== null &&
      bytes !== null &&
      ahxTransportInstance.isLoaded(bytes) &&
      this.ahxPlace?.position === position &&
      this.ahxPlace.row === row;
    const epoch = this.ahxEpoch;
    // A song that is already in the worklet plays the edits made a moment ago.
    this.flushAhxInstrumentEdits();

    this.deps.stopSampleEngine();
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
    if (epoch !== this.ahxEpoch) return;

    if (!(await this.loadAhxSong(song, mode))) return;
    const transport = this.ensureAhxTransport();
    // The worklet holds the editor's song now: what was waiting for a reload is
    // done (an edit that landed while it loaded is not, and stays scheduled).
    const loadedBytes = currentAhxSource();
    if (loadedBytes && transport.isLoaded(loadedBytes)) this.resetAhxReload();
    transport.setLoopPosition(mode === 'pattern');
    if (!resuming) {
      transport.seek(position, row);
      this.ahxPlace = { position, row };
      ahxScopeViews = null;
      currentSequenceIndex.value = position;
      selectedSequenceIndex.value = position;
      playbackRow.value = row;
    }
    transport.play();
    this.setAhxTransportState('playing');
    // An edit landed between the load and here: what plays is one edit behind.
    if (loadedBytes && !transport.isLoaded(loadedBytes)) this.sendAhxReload();
  }

  // ------------------------------------------------------------------
  // The AHX branches of the store's transport verbs
  // ------------------------------------------------------------------

  /** Pause playback (keep position). */
  pause(): void {
    ahxTransportInstance?.pause();
    this.setAhxTransportState('paused');
  }

  /** Continue a paused song where it stopped. */
  resume(): void {
    ahxTransportInstance?.play();
    this.setAhxTransportState('playing');
    // Edits made while it was paused: the worklet still holds the old song, and
    // a resume (unlike a Play) loads nothing. Reload it now, at the place it
    // was paused at.
    ahxReloadScheduler?.flush();
    if (!this.ahxReloadInFlight) this.sendAhxReload();
  }

  /** Stop playback and reset to the beginning. */
  stop(): void {
    this.ahxEpoch++;
    this.resetAhxReload();
    ahxTransportInstance?.stop();
    this.ahxPlace = { position: 0, row: 0 };
    this.setAhxTransportState('stopped');
    this.deps.playbackRow.value = 0;
  }

  /** Seek to a row of the current position. */
  seek(row: number): void {
    const { trackerStore, currentSequenceIndex, playbackRow } = this.deps;
    // The engine replays to the row on its own clock; play/pause is kept.
    const rows = trackerStore.rowsForPattern(trackerStore.sequence[currentSequenceIndex.value]);
    const target = Math.max(0, Math.min(Math.round(row), rows - 1));
    ahxTransportInstance?.seek(currentSequenceIndex.value, target);
    this.ahxPlace = { position: currentSequenceIndex.value, row: target };
    playbackRow.value = target;
  }

  /** Whether the song stops at its end (`false`) or loops (`true`). */
  setLoopSong(loop: boolean): void {
    ahxTransportInstance?.setStopAtEnd(!loop);
  }

  /**
   * The store's mute and solo sets as the bit masks the AHX worklet takes.
   * The worklet keeps them across song loads; a transport made later gets
   * them when it is created (`ensureAhxTransport`).
   */
  syncAhxMuteSolo(): void {
    if (!ahxTransportInstance) return;
    const mask = (tracks: Set<number>) => {
      let bits = 0;
      for (const i of tracks) if (i >= 0 && i < 32) bits |= 1 << i;
      return bits >>> 0;
    };
    ahxTransportInstance.setMuteSolo(mask(this.deps.mutedTracks.value), mask(this.deps.soloedTracks.value));
  }

  /** Full cleanup - call on app shutdown. */
  dispose(): void {
    this.disposeAhxTransport();
    this.disposeAhxPreview();
    ahxSourceUnsubscribe?.();
    ahxSourceUnsubscribe = null;
    ahxStructureUnsubscribe?.();
    ahxStructureUnsubscribe = null;
    ahxReloadScheduler?.cancel();
    this.ahxReloadBurst++;
    ahxEditUnsubscribe?.();
    ahxEditUnsubscribe = null;
    ahxEditSync?.discard();
    ahxEditSync = null;
    this.ahxSongActive = false;
    ahxScopeViews = null;
    this.ahxEpoch++;
  }
}
