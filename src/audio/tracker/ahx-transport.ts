import {
  createAhxPlayer,
  type AhxPlayerClient,
  type AhxPosition,
  type AhxSongInfo,
  type AhxWaveforms,
} from 'src/audio/tracker/ahx-player';

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
  private readonly positionListeners = new Set<(p: AhxPosition) => void>();
  private readonly songEndListeners = new Set<() => void>();
  private readonly waveformListeners = new Set<(w: AhxWaveforms) => void>();

  constructor(
    private readonly host: AhxTransportHost,
    private readonly createPlayer: (
      ctx: AudioContext,
    ) => Promise<AhxPlayerClient> = createAhxPlayer,
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
    const info = await client.loadSong(bytes);
    this.loadedSource = bytes;
    this.loadedInfo = info;
    return info;
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
    this.positionListeners.clear();
    this.songEndListeners.clear();
    this.waveformListeners.clear();
  }
}
