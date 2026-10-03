import type { Ref } from 'vue';
import type { Song as PlaybackSong, TrackerPattern } from '@another-synth/tracker-playback';
import { createA2mPlayer, type A2mPlayerClient, type A2mPosition } from 'src/audio/tracker/a2m-player';
import { encodeA2mFile } from 'src/audio/tracker/a2m-file-codec';
import { a2mBytesFromSong, type A2mDoc, type A2mSongJson } from 'src/audio/tracker/a2m-codec';
import { compileA2mSong } from 'src/audio/tracker/a2m-grid';
import { reportAhxNotice } from 'src/audio/tracker/ahx-notices';
import type { TrackerSongBank } from 'src/audio/tracker/song-bank';

export type PlaybackMode = 'pattern' | 'song';

/** The part of the tracker store the A2M transport reads. */
export interface A2mSongTransportTracker {
  /** The song but for its patterns (`data.a2mDoc`): with the grid, what plays. */
  readonly a2mDoc: A2mDoc | null;
  readonly patterns: TrackerPattern[];
  readonly sequence: string[];
}

/** The module the song compiles to, and its identity (the file as base64: equal text is the same module). */
interface CompiledModule {
  key: string;
  bytes: Uint8Array;
}

/** What the playback store lends the A2M transport, like `SidSongTransportDeps`. */
export interface A2mSongTransportDeps {
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
  trackerStore: A2mSongTransportTracker;
  getSongBank(): TrackerSongBank;
  setPlaybackState(playing: boolean): void;
  applyPosition(pos: { row: number; patternId?: string | undefined; sequenceIndex?: number | undefined }): void;
  resolveStartSequenceIndex(song: PlaybackSong): number;
  recordLastSong(song: PlaybackSong, mode: PlaybackMode): void;
  sanitizeMuteSoloState(trackCount: number): void;
  /** Silence `PlaybackEngine` before the OPL worklet takes over. */
  stopSampleEngine(): void;
  /** Tell the user something (a refusal, a render failure). */
  notify?(message: string): void;
  /** Makes the worklet client; tests hand in one over the real core. */
  createPlayer?: (context: BaseAudioContext) => Promise<A2mPlayerClient>;
  /** Writes the module for a song; tests stand in for the wasm. */
  writeModule?: (song: A2mSongJson) => Promise<Uint8Array>;
}

/** Mute/solo masks cover the tracks an A2M song can have (20). */
const A2M_MAX_TRACKS = 20;

/**
 * The playback store's verbs for an `'a2m'` song (.ai/plan-opl.md O7 step 4),
 * played by an OPL worklet in song mode (`a2m-player.ts` / `opl-core.ts` /
 * the Rust `A2Player`) from the song's module bytes. Playback only (D3): the
 * grid is the module's display and nothing edits it.
 *
 * Places are the player's own: the grid's sequence index is the module's
 * order position, and its rows are the pattern's rows. "Play pattern" loops
 * the order position (`set-loop-order`); "play song" plays on, with the
 * worklet pausing at the song's end when the song must not loop (the
 * jukebox). The mute/solo sets go to the worklet as track masks; the player
 * mutes a track by muting the OPL channel it plays on.
 */
export class A2mSongTransport {
  private client: A2mPlayerClient | null = null;
  private creating: Promise<A2mPlayerClient> | null = null;
  private clientUnsubs: Array<() => void> = [];
  private active = false;
  /** Bumped whenever a load or start in flight stops being wanted. */
  private epoch = 0;
  /** The module the worklet holds (`CompiledModule.key`, by value: a string). */
  private loadedFile: string | null = null;
  private loading: Promise<boolean> | null = null;
  private loadingFile: string | null = null;
  /** The place last reported or set by a seek. */
  private place = { order: 0, row: 0 };
  private tracks = 0;

  constructor(private readonly deps: A2mSongTransportDeps) {}

  get isActive(): boolean {
    return this.active;
  }

  /** The worklet client, once one exists (tests, diagnostics). */
  get player(): A2mPlayerClient | null {
    return this.client;
  }

  private notify(message: string): void {
    if (this.deps.notify) this.deps.notify(message);
    else reportAhxNotice(message);
  }

  // ------------------------------------------------------------------
  // The worklet
  // ------------------------------------------------------------------

  private async ensureClient(): Promise<A2mPlayerClient> {
    const bank = this.deps.getSongBank();
    if (this.client && this.client.audioContext !== bank.audioContext) this.disposeClient();
    if (this.client) return this.client;
    const create = this.deps.createPlayer ?? createA2mPlayer;
    this.creating ??= create(bank.audioContext)
      .then((client) => {
        client.output.connect(bank.output);
        client.setStopAtEnd(!this.deps.loopSong.value);
        this.clientUnsubs = [
          client.onPosition(this.handlePosition),
          client.onSongEnd(this.handleSongEnd),
          client.onError((error) => this.notify(`The A2M player stopped: ${error.message}`)),
        ];
        this.client = client;
        this.syncMuteSolo();
        return client;
      })
      .finally(() => {
        this.creating = null;
      });
    return this.creating;
  }

  /**
   * Route each track's OPL channel into the song bank's per-track tap
   * (`getTrackTap`, the monitors a sampled track's voices feed), so the
   * per-track scopes and the spectrum see the module's tracks. Called when a
   * song loads and whenever the host rebuilds its taps.
   */
  connectTrackTaps(): void {
    const client = this.client;
    if (!client?.song) return;
    const bank = this.deps.getSongBank();
    client.connectTrackTaps(Array.from({ length: client.song.tracks }, (_, t) => bank.getTrackTap(t)));
  }

  private disposeClient(): void {
    for (const unsub of this.clientUnsubs) unsub();
    this.clientUnsubs = [];
    this.client?.dispose();
    this.client = null;
    this.loadedFile = null;
    this.loading = null;
    this.loadingFile = null;
  }

  // ------------------------------------------------------------------
  // Transport verbs
  // ------------------------------------------------------------------

  /**
   * The module the store's song makes: its doc and grid, written by the Rust
   * writer. Told to the user and null when the song cannot be written.
   */
  private async compile(): Promise<CompiledModule | null> {
    const t = this.deps.trackerStore;
    if (t.a2mDoc === null) {
      this.notify('This A2M song was saved without its module, so there is nothing to play.');
      return null;
    }
    try {
      const song = compileA2mSong(t.a2mDoc, t.patterns, t.sequence);
      const bytes = await (this.deps.writeModule ?? a2mBytesFromSong)(song);
      return { key: encodeA2mFile(bytes), bytes };
    } catch (error) {
      this.notify(error instanceof Error ? error.message : String(error));
      return null;
    }
  }

  /** Load the store's song into the worklet (the song passed in is only the display model). */
  async load(song: PlaybackSong, mode: PlaybackMode): Promise<boolean> {
    const module = await this.compile();
    if (module === null) return false;
    this.deps.stopSampleEngine();
    this.deps.playbackMode.value = mode;
    this.deps.getSongBank().setModuleFormat(song.moduleFormat, song.linearFrequency, song.amigaLimits);
    this.active = true;
    const epoch = this.epoch;
    if (this.deps.getSongBank().audioContext.state === 'running') {
      if (!(await this.loadModule(module))) return false;
      if (epoch !== this.epoch) return false;
    } else {
      // A suspended context cannot finish the handshake before a gesture; the
      // load carries on and `play` (which resumes the context) joins it.
      void this.loadModule(module);
    }
    this.deps.hasSongLoaded.value = true;
    this.deps.recordLastSong(song, mode);
    return true;
  }

  /** True once the worklet holds `module`; a refusal is told to the user and is false. */
  private loadModule(module: CompiledModule): Promise<boolean> {
    const file = module.key;
    if (this.loadedFile === file && this.client) return Promise.resolve(true);
    if (this.loading && this.loadingFile === file) return this.loading;
    this.loadingFile = file;
    const loading = (async () => {
      try {
        const client = await this.ensureClient();
        this.loadedFile = null;
        const info = await client.loadSong(module.bytes);
        if (this.loadingFile !== file) return false;
        this.loadedFile = file;
        this.tracks = info.tracks;
        this.deps.sanitizeMuteSoloState(info.tracks);
        this.syncMuteSolo();
        this.connectTrackTaps();
        return true;
      } catch (error) {
        if (this.loadingFile === file) this.notify(error instanceof Error ? error.message : String(error));
        return false;
      } finally {
        if (this.loadingFile === file) {
          this.loading = null;
          this.loadingFile = null;
        }
      }
    })();
    this.loading = loading;
    return loading;
  }

  /**
   * Start from `startRow` of order position `startSequenceIndex`, looping
   * that position when `mode` is `'pattern'`. A paused song asked to play
   * from where it paused resumes (the chip keeps its state); anywhere else
   * seeks.
   */
  async play(song: PlaybackSong, mode: PlaybackMode, startRow: number, startSequenceIndex: number | null): Promise<void> {
    const { isPaused, currentSequenceIndex, selectedSequenceIndex, playbackRow } = this.deps;
    const bank = this.deps.getSongBank();
    const count = Math.max(1, this.deps.trackerStore.sequence.length);
    const order = Math.max(0, Math.min(startSequenceIndex ?? this.deps.resolveStartSequenceIndex(song), count - 1));
    const row = Math.max(0, Math.round(startRow));
    const epoch = this.epoch;

    this.deps.stopSampleEngine();
    bank.cancelAllScheduled();
    bank.allNotesOff();
    const running = await bank.ensureAudioContextRunning();
    if (!running || bank.audioContext.state !== 'running') {
      console.warn(`[PlaybackStore] AudioContext not running; skipping A2M playback start (state=${bank.audioContext.state})`);
      return;
    }
    if (epoch !== this.epoch) return;
    // An edited song is a different module: the worklet reloads it, and
    // starts over (a pause only resumes the module it paused in).
    const module = await this.compile();
    if (module === null) return;
    const resuming =
      this.active &&
      isPaused.value &&
      this.client !== null &&
      this.loadedFile === module.key &&
      this.place.order === order &&
      this.place.row === row;
    if (!(await this.load(song, mode))) return;
    if (!(await this.loadModule(module)) || epoch !== this.epoch) return;
    const client = await this.ensureClient();
    client.setLoopOrder(mode === 'pattern' ? order : -1);
    if (!resuming) {
      client.seek(order, row);
      this.place = { order, row };
      currentSequenceIndex.value = order;
      selectedSequenceIndex.value = order;
      playbackRow.value = row;
    }
    client.play();
    this.setState('playing');
  }

  pause(): void {
    this.client?.pause();
    this.setState('paused');
  }

  resume(): void {
    this.client?.play();
    this.setState('playing');
  }

  stop(): void {
    this.epoch++;
    this.client?.pause();
    this.client?.seek(0, 0);
    this.place = { order: 0, row: 0 };
    this.setState('stopped');
    this.deps.playbackRow.value = 0;
  }

  /** Seek to a row of the current order position; play/pause is kept. */
  seek(row: number): void {
    const order = this.deps.currentSequenceIndex.value;
    const target = Math.max(0, Math.round(row));
    this.place = { order, row: target };
    this.client?.seek(order, target);
    this.deps.playbackRow.value = target;
  }

  setLoopSong(loop: boolean): void {
    this.client?.setStopAtEnd(!loop);
  }

  /** The store's mute and solo sets as the worklet's track masks. */
  syncMuteSolo(): void {
    if (!this.client) return;
    const mask = (tracks: Set<number>) => {
      let bits = 0;
      for (const i of tracks) if (i >= 0 && i < A2M_MAX_TRACKS) bits |= 1 << i;
      return bits >>> 0;
    };
    this.client.setMuteSolo(mask(this.deps.mutedTracks.value), mask(this.deps.soloedTracks.value));
  }

  /** Tracks of the loaded song (0 before one loads). */
  get trackCount(): number {
    return this.tracks;
  }

  // ------------------------------------------------------------------
  // Reports from the worklet
  // ------------------------------------------------------------------

  private handlePosition = (p: A2mPosition): void => {
    if (!this.active) return;
    this.place = { order: p.order, row: p.row };
    if (!this.deps.isPlaying.value) return;
    const sequence = this.deps.trackerStore.sequence;
    // A jump past the first order-list marker plays a position the grid does
    // not list: the playhead stays where it was.
    if (p.order >= sequence.length) return;
    this.deps.applyPosition({ row: p.row, patternId: sequence[p.order], sequenceIndex: p.order });
  };

  private handleSongEnd = (): void => {
    if (!this.active || this.deps.loopSong.value) return;
    this.client?.pause();
    this.client?.seek(0, 0);
    this.place = { order: 0, row: 0 };
    this.setState('stopped');
    this.deps.playbackRow.value = 0;
    for (const listener of this.deps.songEndListeners) listener();
  };

  private setState(state: 'playing' | 'paused' | 'stopped'): void {
    this.deps.isPlaying.value = state === 'playing';
    this.deps.isPaused.value = state === 'paused';
    this.deps.setPlaybackState(state === 'playing');
  }

  /** Hand the transport back: a non-A2M song is being loaded. */
  leave(): void {
    this.epoch++;
    if (!this.active) return;
    this.active = false;
    this.place = { order: 0, row: 0 };
    // Not just stopped: with no A2M song left, the node would sit idle on the mix bus.
    this.disposeClient();
  }

  dispose(): void {
    this.epoch++;
    this.active = false;
    this.disposeClient();
  }
}
