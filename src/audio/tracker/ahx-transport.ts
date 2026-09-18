import {
  createAhxPlayer,
  type AhxPlayerClient,
  type AhxPosition,
  type AhxSongInfo,
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
  private readonly positionListeners = new Set<(p: AhxPosition) => void>();
  private readonly songEndListeners = new Set<() => void>();

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
        client.output.connect(this.host.output);
        this.clientUnsubs = [
          client.onPosition((p) => {
            for (const listener of this.positionListeners) listener(p);
          }),
          client.onSongEnd(() => {
            for (const listener of this.songEndListeners) listener();
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
   * Hand the file to the worklet. Loading the bytes already loaded is a no-op
   * (the tracker's load and its first play both ask), except that it leaves
   * the song at the top, paused.
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

  private disposeClient(): void {
    for (const unsub of this.clientUnsubs) unsub();
    this.clientUnsubs = [];
    this.client?.dispose();
    this.client = null;
    this.loadedSource = null;
    this.loadedInfo = null;
  }

  dispose(): void {
    this.disposeClient();
    this.positionListeners.clear();
    this.songEndListeners.clear();
  }
}
