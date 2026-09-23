import type { Ref } from 'vue';
import type { Song as PlaybackSong } from '@another-synth/tracker-playback';
import { SID_INDEX_TO_MIDI, serializeSidFile, type SidDoc } from 'src/audio/tracker/sid-doc';
import { createSidPlayer, type SidPlayerClient, type SidPosition } from 'src/audio/tracker/sid-player';
import { reportAhxNotice } from 'src/audio/tracker/ahx-notices';
import type { TrackerSongBank } from 'src/audio/tracker/song-bank';

export type PlaybackMode = 'pattern' | 'song';

/** The part of the tracker store the SID transport reads. */
export interface SidSongTransportTracker {
  readonly sidDoc: SidDoc | null;
  readonly sequence: string[];
  readonly patterns: ReadonlyArray<{ id: string; rows: number }>;
  syncSidWriteBack(): boolean;
}

/** What the playback store lends the SID transport (its reactive state and helpers), like `AhxSongTransportDeps`. */
export interface SidSongTransportDeps {
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
  trackerStore: SidSongTransportTracker;
  getSongBank(): TrackerSongBank;
  setPlaybackState(playing: boolean): void;
  applyPosition(pos: { row: number; patternId?: string | undefined; sequenceIndex?: number | undefined }): void;
  resolveStartSequenceIndex(song: PlaybackSong): number;
  recordLastSong(song: PlaybackSong, mode: PlaybackMode): void;
  sanitizeMuteSoloState(trackCount: number): void;
  /** Silence `PlaybackEngine` before the SID worklet takes over. */
  stopSampleEngine(): void;
  /** Makes the worklet client; tests hand in one over the real core. */
  createPlayer?: (context: BaseAudioContext) => Promise<SidPlayerClient>;
}

/** How long edits must pause before a playing song is reloaded with them. */
export const SID_RELOAD_IDLE_MS = 150;

const SID_VOICES = 3;

/**
 * The SID counterpart of `AhxSongTransport` (plan-sid-tracking.md S4): the
 * playback store's verbs for a `'sid'` song, played by the SID worklet
 * (`sid-player.ts` / `sid-core.ts` / the Rust `SidPlayer`) from the song's
 * doc. The row model in the tracker store is what the grid shows; the doc is
 * what plays (`serializeSidFile(trackerStore.sidDoc)`).
 *
 * Places: the player counts song rows from the top; the grid's positions are
 * consecutive row ranges of that count (`sidGridLayout`), so row `r` of
 * position `p` is song row `start(p) + r`. Past the song's end the player
 * plays on (each voice loops its orderlist); the playhead then shows the row
 * modulo the song's length, which is exact when every voice restarts at its
 * top and a display approximation otherwise.
 *
 * Edits: a doc change while playing reloads the song once the edits pause
 * (`SID_RELOAD_IDLE_MS`) and puts it back at the row it was on (a load, a
 * seek and a play, ordered on the port). Paused, the reload waits for the
 * resume; stopped, the next Play loads the doc as it is.
 */
export class SidSongTransport {
  private client: SidPlayerClient | null = null;
  private creating: Promise<SidPlayerClient> | null = null;
  private clientUnsubs: Array<() => void> = [];
  /** The song last loaded is a SID one: the store's transport verbs branch on it. */
  private active = false;
  /** Bumped whenever a load or start in flight stops being wanted. */
  private epoch = 0;
  /** The doc the worklet holds (by identity: docs are immutable). */
  private loadedDoc: SidDoc | null = null;
  /** The song row the player is on, as last reported or set by a seek. */
  private place = 0;
  private reloadTimer: ReturnType<typeof setTimeout> | null = null;
  /** The keyboard-preview voice: its own worklet, and the doc it holds. */
  private preview: SidPlayerClient | null = null;
  private previewCreating: Promise<SidPlayerClient> | null = null;
  private previewDoc: SidDoc | null = null;
  private previewOutputListeners = new Set<(node: AudioNode | null) => void>();

  constructor(private readonly deps: SidSongTransportDeps) {}

  get isActive(): boolean {
    return this.active;
  }

  /** The worklet client, once one exists (tests, the page's diagnostics). */
  get player(): SidPlayerClient | null {
    return this.client;
  }

  // ------------------------------------------------------------------
  // Places: song rows <-> grid positions
  // ------------------------------------------------------------------

  private positionStart(index: number): number {
    const { patterns } = this.deps.trackerStore;
    let at = 0;
    for (let i = 0; i < index && i < patterns.length; i++) at += patterns[i]?.rows ?? 0;
    return at;
  }

  private songLength(): number {
    return this.deps.trackerStore.patterns.reduce((n, p) => n + p.rows, 0);
  }

  /** The grid place of song row `row` (modulo the song's length). */
  placeOf(row: number): { position: number; row: number } {
    const total = this.songLength();
    const { patterns } = this.deps.trackerStore;
    let r = total > 0 ? row % total : 0;
    for (let p = 0; p < patterns.length; p++) {
      const rows = patterns[p]?.rows ?? 0;
      if (r < rows) return { position: p, row: r };
      r -= rows;
    }
    return { position: 0, row: 0 };
  }

  // ------------------------------------------------------------------
  // The worklet
  // ------------------------------------------------------------------

  private async ensureClient(): Promise<SidPlayerClient> {
    const bank = this.deps.getSongBank();
    if (this.client && this.client.audioContext !== bank.audioContext) this.disposeClient();
    if (this.client) return this.client;
    const create = this.deps.createPlayer ?? createSidPlayer;
    this.creating ??= create(bank.audioContext)
      .then((client) => {
        client.output.connect(bank.output);
        client.setStopAtEnd(!this.deps.loopSong.value);
        this.clientUnsubs = [
          client.onPosition(this.handlePosition),
          client.onSongEnd(this.handleSongEnd),
          client.onError((error) => reportAhxNotice(`The SID player stopped: ${error.message}`)),
        ];
        this.client = client;
        this.connectVoiceTaps();
        this.syncMuteSolo();
        return client;
      })
      .finally(() => {
        this.creating = null;
      });
    return this.creating;
  }

  /**
   * Route the worklet's three voice outputs into the song bank's per-track
   * taps (`getTrackTap`: the same monitors a sampled track's voices feed, so
   * the per-track scopes and the spectrum analyse a SID voice like any other
   * track). Called when the client is made and whenever the host rebuilds its
   * taps (monitoring switched back on makes new ones).
   */
  connectVoiceTaps(): void {
    const bank = this.deps.getSongBank();
    this.client?.connectVoiceTaps(Array.from({ length: SID_VOICES }, (_, i) => bank.getTrackTap(i)));
  }

  private disposeClient(): void {
    for (const unsub of this.clientUnsubs) unsub();
    this.clientUnsubs = [];
    this.client?.dispose();
    this.client = null;
    this.loadedDoc = null;
  }

  // ------------------------------------------------------------------
  // Transport verbs
  // ------------------------------------------------------------------

  /** Load the store's SID doc into the worklet (the song passed in is only the display model). */
  async load(song: PlaybackSong, mode: PlaybackMode): Promise<boolean> {
    const { trackerStore } = this.deps;
    trackerStore.syncSidWriteBack();
    const doc = trackerStore.sidDoc;
    if (!doc) {
      console.warn('[PlaybackStore] SID song has no doc (a .cmod saved without its SID file): cannot play');
      return false;
    }
    this.deps.stopSampleEngine();
    this.deps.playbackMode.value = mode;
    this.deps.sanitizeMuteSoloState(SID_VOICES);
    this.deps.getSongBank().setModuleFormat(song.moduleFormat, song.linearFrequency, song.amigaLimits);
    const wasActive = this.active;
    this.active = true;
    const epoch = this.epoch;
    const loading = this.loadDoc(doc);
    if (this.deps.getSongBank().audioContext.state === 'running') {
      try {
        await loading;
      } catch (error) {
        if (epoch === this.epoch) this.active = wasActive;
        throw error;
      }
      if (epoch !== this.epoch) return false;
    } else {
      // A suspended context cannot finish the handshake before a gesture; the
      // load carries on and `play` (which resumes the context) joins it.
      loading.catch((error) => console.warn('[PlaybackStore] SID load failed while the context was suspended', error));
    }
    this.deps.hasSongLoaded.value = true;
    this.deps.recordLastSong(song, mode);
    return true;
  }

  private async loadDoc(doc: SidDoc): Promise<void> {
    const client = await this.ensureClient();
    if (this.loadedDoc === doc) return;
    this.loadedDoc = null;
    await client.loadSong(serializeSidFile(doc));
    this.loadedDoc = doc;
  }

  /**
   * Start from `startRow` of position `startSequenceIndex`, looping that
   * position when `mode` is `'pattern'`. A paused song asked to play from
   * where it paused resumes (the chip keeps its state); anywhere else seeks.
   */
  async play(song: PlaybackSong, mode: PlaybackMode, startRow: number, startSequenceIndex: number | null): Promise<void> {
    const { trackerStore, isPaused, currentSequenceIndex, selectedSequenceIndex, playbackRow } = this.deps;
    const bank = this.deps.getSongBank();
    const count = Math.max(1, trackerStore.patterns.length);
    const position = Math.max(0, Math.min(startSequenceIndex ?? this.deps.resolveStartSequenceIndex(song), count - 1));
    const rows = trackerStore.patterns[position]?.rows ?? 1;
    const row = Math.max(0, Math.min(Math.round(startRow), rows - 1));
    const target = this.positionStart(position) + row;
    trackerStore.syncSidWriteBack();
    const resuming =
      this.active && isPaused.value && this.client !== null && this.loadedDoc === trackerStore.sidDoc && this.placeOf(this.place).position === position && this.placeOf(this.place).row === row;
    const epoch = this.epoch;

    this.deps.stopSampleEngine();
    bank.cancelAllScheduled();
    bank.allNotesOff();
    const running = await bank.ensureAudioContextRunning();
    if (!running || bank.audioContext.state !== 'running') {
      console.warn(`[PlaybackStore] AudioContext not running; skipping SID playback start (state=${bank.audioContext.state})`);
      return;
    }
    if (epoch !== this.epoch) return;
    if (!(await this.load(song, mode))) return;
    const client = await this.ensureClient();
    this.cancelReload();
    const start = this.positionStart(position);
    if (mode === 'pattern') client.setLoopRows(start, start + rows);
    else client.setLoopRows(0, 0);
    if (!resuming) {
      client.seek(target);
      this.place = target;
      currentSequenceIndex.value = position;
      selectedSequenceIndex.value = position;
      playbackRow.value = row;
    }
    client.play();
    this.setState('playing');
  }

  pause(): void {
    this.client?.pause();
    this.setState('paused');
  }

  /** Continue a paused song; edits made while paused are loaded first, at the paused row. */
  resume(): void {
    if (this.loadedDoc !== this.deps.trackerStore.sidDoc) this.reloadInPlace(true);
    else this.client?.play();
    this.setState('playing');
  }

  stop(): void {
    this.epoch++;
    this.cancelReload();
    this.client?.pause();
    this.client?.seek(0);
    this.place = 0;
    this.setState('stopped');
    this.deps.playbackRow.value = 0;
  }

  /** Seek to a row of the current position; play/pause is kept. */
  seek(row: number): void {
    const { currentSequenceIndex, trackerStore, playbackRow } = this.deps;
    const rows = trackerStore.patterns[currentSequenceIndex.value]?.rows ?? 1;
    const target = Math.max(0, Math.min(Math.round(row), rows - 1));
    this.place = this.positionStart(currentSequenceIndex.value) + target;
    this.client?.seek(this.place);
    playbackRow.value = target;
  }

  setLoopSong(loop: boolean): void {
    this.client?.setStopAtEnd(!loop);
  }

  /** The store's mute and solo sets as the worklet's voice masks. */
  syncMuteSolo(): void {
    if (!this.client) return;
    const mask = (tracks: Set<number>) => {
      let bits = 0;
      for (const i of tracks) if (i >= 0 && i < SID_VOICES) bits |= 1 << i;
      return bits >>> 0;
    };
    this.client.setMuteSolo(mask(this.deps.mutedTracks.value), mask(this.deps.soloedTracks.value));
  }

  // ------------------------------------------------------------------
  // Edits while playing
  // ------------------------------------------------------------------

  /** The store's SID doc changed (an edit, an undo): reload a playing song once the edits pause. */
  onDocChange(): void {
    if (!this.active || !this.deps.isPlaying.value) return;
    this.cancelReload();
    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = null;
      if (this.active && this.deps.isPlaying.value) this.reloadInPlace(true);
    }, SID_RELOAD_IDLE_MS);
    (this.reloadTimer as { unref?: () => void }).unref?.();
  }

  private cancelReload(): void {
    if (this.reloadTimer !== null) clearTimeout(this.reloadTimer);
    this.reloadTimer = null;
  }

  /** One load, one seek to the current row and (when `resume`) one play, ordered on the port. */
  private reloadInPlace(resume: boolean): void {
    const client = this.client;
    const { trackerStore } = this.deps;
    trackerStore.syncSidWriteBack();
    const doc = trackerStore.sidDoc;
    if (!client || !doc) return;
    this.loadedDoc = null;
    const loading = client.loadSong(serializeSidFile(doc));
    client.seek(this.place);
    if (resume) client.play();
    loading.then(
      () => {
        if (this.client === client) this.loadedDoc = doc;
      },
      (error: unknown) => reportAhxNotice(`The SID player could not load the edited song (${error instanceof Error ? error.message : String(error)}).`),
    );
  }

  // ------------------------------------------------------------------
  // Reports from the worklet
  // ------------------------------------------------------------------

  private handlePosition = (p: SidPosition): void => {
    if (!this.active) return;
    this.place = p.row;
    if (!this.deps.isPlaying.value) return;
    const at = this.placeOf(p.row);
    this.deps.applyPosition({ row: at.row, patternId: this.deps.trackerStore.sequence[at.position], sequenceIndex: at.position });
  };

  private handleSongEnd = (): void => {
    if (!this.active || this.deps.loopSong.value) return;
    this.client?.pause();
    this.client?.seek(0);
    this.place = 0;
    this.setState('stopped');
    this.deps.playbackRow.value = 0;
    for (const listener of this.deps.songEndListeners) listener();
  };

  private setState(state: 'playing' | 'paused' | 'stopped'): void {
    this.deps.isPlaying.value = state === 'playing';
    this.deps.isPaused.value = state === 'paused';
    this.deps.setPlaybackState(state === 'playing');
  }

  // ------------------------------------------------------------------
  // Keyboard preview (the instrument page)
  // ------------------------------------------------------------------

  private async ensurePreview(): Promise<SidPlayerClient> {
    const bank = this.deps.getSongBank();
    if (this.preview && this.preview.audioContext !== bank.audioContext) this.disposePreview();
    if (this.preview) return this.preview;
    const create = this.deps.createPlayer ?? createSidPlayer;
    this.previewCreating ??= create(bank.audioContext)
      .then((client) => {
        client.output.connect(bank.output);
        client.setPreview(true);
        this.preview = client;
        for (const listener of this.previewOutputListeners) listener(client.output);
        return client;
      })
      .finally(() => {
        this.previewCreating = null;
      });
    return this.previewCreating;
  }

  /**
   * Sound instrument `instrument` (1-based) of the store's doc at `midi`, on a
   * preview voice of its own (the song's transport is untouched). The preview
   * holds the doc as it is now: an instrument edit is heard at the next key.
   * `false` when there is no SID doc or the note is outside C-0..G#7.
   */
  async previewNoteOn(instrument: number, midi: number): Promise<boolean> {
    const doc = this.deps.trackerStore.sidDoc;
    const note = midi - SID_INDEX_TO_MIDI;
    if (!doc || note < 0 || note > 92) return false;
    const bank = this.deps.getSongBank();
    if (!(await bank.ensureAudioContextRunning())) return false;
    const client = await this.ensurePreview();
    if (this.previewDoc !== doc) {
      // Ordered on the port: the note lands on this load.
      void client.loadSong(serializeSidFile(doc)).catch(() => undefined);
      this.previewDoc = doc;
    }
    client.previewNoteOn(instrument, note);
    return true;
  }

  previewNoteOff(): void {
    this.preview?.previewNoteOff();
  }

  /** The preview voice's output (the page's analyzer), or null before its first note. */
  get previewOutput(): AudioNode | null {
    return this.preview?.output ?? null;
  }

  onPreviewOutput(listener: (node: AudioNode | null) => void): () => void {
    this.previewOutputListeners.add(listener);
    return () => this.previewOutputListeners.delete(listener);
  }

  private disposePreview(): void {
    this.preview?.dispose();
    this.preview = null;
    this.previewDoc = null;
    for (const listener of this.previewOutputListeners) listener(null);
  }

  /** Hand the transport back to `PlaybackEngine` (or the AHX worklet): a non-SID song is being loaded. */
  leave(): void {
    this.epoch++;
    this.cancelReload();
    // The preview voice holds the SID song's instruments: not the next song's.
    this.disposePreview();
    if (!this.active) return;
    this.active = false;
    this.place = 0;
    // Not just stopped: with no SID song left, the node would sit idle on the mix bus.
    this.disposeClient();
  }

  dispose(): void {
    this.epoch++;
    this.cancelReload();
    this.active = false;
    this.disposeClient();
    this.disposePreview();
    this.previewOutputListeners.clear();
  }
}
