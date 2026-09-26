import {
  createAhxPlayer,
  type AhxPlayerClient,
  type AhxPosition,
  type AhxSongInfo,
  type AhxWaveforms,
} from 'src/audio/tracker/ahx-player';
import { reportAhxNotice } from 'src/audio/tracker/ahx-notices';
import {
  ahxInstrumentCount,
  currentAhxInstrumentEdits,
  lastGoodAhxLoad,
  recordAhxLoad,
  type AhxInstrumentEdit,
} from 'src/audio/tracker/ahx-source';

/** The id of the notice a rejected reload leaves (the store clears it when a reload succeeds). */
export const AHX_RECOVERY_NOTICE_ID = 'ahx-reload-recovered';
/** The id of the notice that a reload and its recovery were both refused. */
export const AHX_RELOAD_FAILED_NOTICE_ID = 'ahx-reload-failed';

/** What a `reloadInPlace` came to. */
export type AhxReloadOutcome =
  /** The engine took the new bytes. */
  | { outcome: 'loaded'; info: AhxSongInfo }
  /** The engine refused them; the last version it accepted is playing again. */
  | { outcome: 'recovered'; info: AhxSongInfo; error: Error }
  /** It refused both: the worklet holds no song and playback was paused. */
  | { outcome: 'failed'; error: Error }
  /** A newer load or reload (or a dispose) took over before this one answered. */
  | { outcome: 'superseded' };

/** What the transport needs from the song bank: a context and the mix bus. */
export interface AhxTransportHost {
  readonly audioContext: AudioContext;
  /** The pre-rack mix bus; the master volume and post-fx rack sit behind it. */
  readonly output: AudioNode;
}

/**
 * The AHX/HVL counterpart of `PlaybackEngine`, as far as the playback store is
 * concerned: load a song, play, pause, stop, and hear where it is.
 *
 * The Rust engine in the worklet owns the transport, so this schedules
 * nothing. It owns one lazily created `AhxPlayerClient`, routes it into the
 * song bank's mix bus (so the master volume, post-fx rack, meters and
 * recorder treat it like any other song), and re-exposes position and
 * song-end as listener sets that survive the client being replaced.
 */
export class AhxTransport {
  private client: AhxPlayerClient | null = null;
  private creating: Promise<AhxPlayerClient> | null = null;
  private loadedSource: Uint8Array | null = null;
  private loadedInfo: AhxSongInfo | null = null;
  /** A load under way, so a second ask for the same bytes joins it rather than superseding it. */
  private loading: { bytes: Uint8Array; promise: Promise<AhxSongInfo> } | null = null;
  private clientUnsubs: Array<() => void> = [];
  /** Remembered here, not just on the client, so a client made later (or replaced) gets it. */
  private stopAtEnd = false;
  private loopPosition = false;
  private capture = false;
  private mute = 0;
  private solo = 0;
  private disposed = false;
  /** Bumped by every load and reload: an answer that comes back to another value was superseded. */
  private loadGeneration = 0;
  /** What the last `seek` the worklet answered said (`AhxPosition.seekKind`); `null` before one. */
  private seekKind: 1 | 2 | null = null;
  private readonly seekKindListeners = new Set<(kind: 1 | 2) => void>();
  private readonly positionListeners = new Set<(p: AhxPosition) => void>();
  private readonly songEndListeners = new Set<() => void>();
  private readonly waveformListeners = new Set<(w: AhxWaveforms) => void>();

  constructor(
    private readonly host: AhxTransportHost,
    private readonly createPlayer: (
      ctx: AudioContext,
    ) => Promise<AhxPlayerClient> = createAhxPlayer,
    /** The instrument edits a load applies on top of the file's own bytes. */
    private readonly editsToApply: () => readonly AhxInstrumentEdit[] = currentAhxInstrumentEdits,
  ) {}

  get info(): AhxSongInfo | null {
    return this.loadedInfo;
  }

  /** Whether `bytes` (by identity) is the song the worklet currently holds. */
  isLoaded(bytes: Uint8Array): boolean {
    return this.loadedSource === bytes && this.loadedInfo !== null;
  }

  private async ensureClient(): Promise<AhxPlayerClient> {
    if (this.client && this.client.audioContext !== this.host.audioContext) {
      this.disposeClient();
    }
    if (this.client) return this.client;
    this.creating ??= this.createPlayer(this.host.audioContext)
      .then((client) => {
        // Disposed while the worklet was starting: nobody is left to use it.
        if (this.disposed) {
          client.dispose();
          throw new Error('AHX transport disposed');
        }
        client.output.connect(this.host.output);
        client.setStopAtEnd(this.stopAtEnd);
        if (this.loopPosition) client.setLoopPosition(true);
        if (this.capture) client.setCapture(true);
        if (this.mute || this.solo) client.setMuteSolo(this.mute, this.solo);
        // Always band-limited: told before any load, so the worklet prewarms
        // the song's tables as it loads. (The reference path is engine-only.)
        client.setHifi(true);
        this.clientUnsubs = [
          client.onPosition((p) => {
            if (p.seekKind !== undefined) {
              this.seekKind = p.seekKind;
              for (const listener of this.seekKindListeners) listener(p.seekKind);
            }
            for (const listener of this.positionListeners) listener(p);
          }),
          client.onSongEnd(() => {
            for (const listener of this.songEndListeners) listener();
          }),
          client.onWaveforms((w) => {
            for (const listener of this.waveformListeners) listener(w);
          }),
        ];
        this.client = client;
        return client;
      })
      .finally(() => {
        this.creating = null;
      });
    return this.creating;
  }

  /**
   * Whether the worklet pauses itself at the song's end (a non-looping play)
   * rather than looping on until `stop()` reaches it from the main thread.
   */
  setStopAtEnd(enabled: boolean): void {
    this.stopAtEnd = enabled;
    this.client?.setStopAtEnd(enabled);
  }

  /**
   * Whether the song loops the order position it is on ("play pattern")
   * instead of moving on. Remembered here so a client made later (or
   * replaced) gets it; the worklet keeps it across song loads.
   */
  setLoopPosition(enabled: boolean): void {
    this.loopPosition = enabled;
    this.client?.setLoopPosition(enabled);
  }

  /**
   * Whether the worklet records per-voice waveforms and reports them through
   * `onWaveforms`. Off by default; remembered here so a client made later (or
   * replaced) gets it.
   */
  setCapture(enabled: boolean): void {
    this.capture = enabled;
    this.client?.setCapture(enabled);
  }

  /**
   * Per-voice mute and solo as bit masks (bit `i` = voice `i`): muted voices
   * drop out of the mix, and while `solo` is non-zero only its voices are
   * heard. Remembered here so a client made later (or replaced) gets it; the
   * worklet keeps it across song loads.
   */
  setMuteSolo(mute: number, solo: number): void {
    this.mute = mute >>> 0;
    this.solo = solo >>> 0;
    this.client?.setMuteSolo(this.mute, this.solo);
  }

  /**
   * Hand the file to the worklet. Loading the bytes already loaded is a no-op
   * that touches nothing: the song stays wherever it is, playing or paused
   * (`loadNow` returns early). Callers that want the top call `stop()`.
   */
  load(bytes: Uint8Array): Promise<AhxSongInfo> {
    if (this.loading?.bytes === bytes) return this.loading.promise;
    const promise = this.loadNow(bytes);
    const entry = { bytes, promise };
    this.loading = entry;
    const clear = () => {
      if (this.loading === entry) this.loading = null;
    };
    promise.then(clear, clear);
    return promise;
  }

  private async loadNow(bytes: Uint8Array): Promise<AhxSongInfo> {
    const client = await this.ensureClient();
    if (this.isLoaded(bytes) && this.loadedInfo) return this.loadedInfo;
    this.loadedSource = null;
    this.loadedInfo = null;
    this.loadGeneration++;
    // The song as edited, not as imported: a load after a reload of the worklet
    // must not lose the edits made since.
    const applied = this.editsToApply();
    const info = await client.loadSong(bytes, 2, applied);
    this.loadedSource = bytes;
    this.loadedInfo = info;
    recordAhxLoad(bytes, applied);
    return info;
  }

  /**
   * Swap the song the worklet plays for `bytes` without the caller waiting for
   * it, and put the playhead back: one `load-song`, one `seek(place)` and (when
   * `resume`) one `play`, sent together, no await between them (the port is
   * ordered, so the seek and the play land on the new song).
   *
   * A reload costs an audible dropout (the worklet prewarms the hi-fi tables on
   * the audio thread), and the worklet drops its player *before* it parses, so
   * a refused reload leaves it with no song at all. Then the last version it
   * accepted (`lastGoodAhxLoad`) is loaded at `recoverPlace` (the place in
   * *that* song's terms; `place` by default) and a persistent notice says the
   * editor and the sound disagree. If that is refused too it does not go round
   * again: playback is paused, the notice says so, and the outcome is `failed`.
   *
   * A concurrent `load(bytes)` for the same bytes joins this one. The `seek`
   * kind the worklet answers with is read from `lastSeekKind` / `onSeekKind`.
   */
  async reloadInPlace(
    bytes: Uint8Array,
    place: { position: number; row: number },
    resume: boolean,
    recoverPlace: { position: number; row: number } = place,
  ): Promise<AhxReloadOutcome> {
    const client = await this.ensureClient();
    const generation = ++this.loadGeneration;
    this.loadedSource = null;
    this.loadedInfo = null;
    this.seekKind = null;
    const applied = this.editsToApply();
    const loading = client.loadSong(bytes, 2, applied);
    const entry = { bytes, promise: loading };
    this.loading = entry;
    const clear = () => {
      if (this.loading === entry) this.loading = null;
    };
    loading.then(clear, clear);
    client.seek(place.position, place.row);
    if (resume) client.play();
    try {
      const info = await loading;
      if (generation !== this.loadGeneration) return { outcome: 'superseded' };
      this.loadedSource = bytes;
      this.loadedInfo = info;
      recordAhxLoad(bytes, applied);
      return { outcome: 'loaded', info };
    } catch (error) {
      if (generation !== this.loadGeneration || this.disposed) return { outcome: 'superseded' };
      return this.recover(client, error instanceof Error ? error : new Error(String(error)), recoverPlace, resume, generation);
    }
  }

  private async recover(
    client: AhxPlayerClient,
    error: Error,
    place: { position: number; row: number },
    resume: boolean,
    generation: number,
  ): Promise<AhxReloadOutcome> {
    const good = lastGoodAhxLoad();
    if (good) {
      const loading = client.loadSong(good.bytes, 2, good.edits);
      client.seek(place.position, place.row);
      if (resume) client.play();
      try {
        const info = await loading;
        if (generation !== this.loadGeneration) return { outcome: 'superseded' };
        this.loadedSource = good.bytes;
        this.loadedInfo = info;
        reportAhxNotice(
          'The last edit could not be loaded by the engine; playing the last version it accepted. What the editor shows and what plays differ until an edit loads.',
          AHX_RECOVERY_NOTICE_ID,
        );
        return { outcome: 'recovered', info, error };
      } catch (second) {
        if (generation !== this.loadGeneration || this.disposed) return { outcome: 'superseded' };
        error = second instanceof Error ? second : new Error(String(second));
      }
    }
    client.pause();
    reportAhxNotice(
      `The engine could not load the edited song and no earlier version could be restored (${error.message}): playback stopped.`,
      AHX_RELOAD_FAILED_NOTICE_ID,
    );
    return { outcome: 'failed', error };
  }

  /** What the worklet's last answer to a `seek` said: 1 the flow reaches the row, 2 it does not (cold start); `null` before one. */
  get lastSeekKind(): 1 | 2 | null {
    return this.seekKind;
  }

  /** Called with the kind of every `seek` the worklet answers (a reload's, or any other). */
  onSeekKind(listener: (kind: 1 | 2) => void): () => void {
    this.seekKindListeners.add(listener);
    return () => this.seekKindListeners.delete(listener);
  }

  /**
   * Replace ONE instrument of the song the worklet holds (`AhxPlayerClient.replaceInstrument`):
   * the song is not reloaded, does not restart and does not move, and plays the
   * new instrument from its next trigger. Resolves at once when there is no
   * worklet yet: its load applies every edit (`editsToApply`). Rejects with the
   * engine's reason when it refuses the bytes.
   */
  replaceInstrument(instrument: number, bytes: Uint8Array): Promise<void> {
    return this.client ? this.client.replaceInstrument(instrument, bytes) : Promise.resolve();
  }

  /**
   * `replaceInstrument` for several at once: one walk of the song for hi-fi
   * tables however many instruments changed (`AhxPlayerClient.replaceInstruments`).
   * One promise per edit; nothing to do (all resolved) with no worklet yet: its
   * load applies every recorded edit.
   */
  replaceInstruments(edits: ReadonlyArray<AhxInstrumentEdit>): Promise<void>[] {
    if (!this.client) return edits.map(() => Promise.resolve());
    // An instrument added since the worklet's song was loaded (a preset added
    // to a stopped song) is not in that song, whose engine would refuse its
    // edit. Nothing is lost by not sending it: the song is stale, and the next
    // load (a Play, a resume, a live reload) is of the editor's bytes, which
    // have the instrument, with every recorded edit applied (`editsToApply`).
    const held = this.loadedSource ? ahxInstrumentCount(this.loadedSource) : Infinity;
    const sent = edits.filter((edit) => edit.instrument <= held);
    const answers = sent.length > 0 ? this.client.replaceInstruments(sent) : [];
    let next = 0;
    return edits.map((edit) => (edit.instrument <= held ? (answers[next++] ?? Promise.resolve()) : Promise.resolve()));
  }

  play(): void {
    this.client?.play();
  }

  pause(): void {
    this.client?.pause();
  }

  /**
   * Move to `row` of order position `position` without stopping the clock:
   * playing carries on from there, paused waits there. See `AhxPlayer.seek`.
   */
  seek(position: number, row: number): void {
    this.client?.seek(position, row);
  }

  /** Silence and rewind to the start of the main song, paused. */
  stop(): void {
    if (!this.client || !this.loadedInfo) return;
    this.client.pause();
    this.client.restart(0);
  }

  onPosition(listener: (p: AhxPosition) => void): () => void {
    this.positionListeners.add(listener);
    return () => this.positionListeners.delete(listener);
  }

  onSongEnd(listener: () => void): () => void {
    this.songEndListeners.add(listener);
    return () => this.songEndListeners.delete(listener);
  }

  onWaveforms(listener: (w: AhxWaveforms) => void): () => void {
    this.waveformListeners.add(listener);
    return () => this.waveformListeners.delete(listener);
  }

  private disposeClient(): void {
    for (const unsub of this.clientUnsubs) unsub();
    this.clientUnsubs = [];
    this.client?.dispose();
    this.client = null;
    this.loadedSource = null;
    this.loadedInfo = null;
  }

  dispose(): void {
    this.disposed = true;
    this.disposeClient();
    this.loadGeneration++;
    this.positionListeners.clear();
    this.songEndListeners.clear();
    this.waveformListeners.clear();
    this.seekKindListeners.clear();
  }
}
