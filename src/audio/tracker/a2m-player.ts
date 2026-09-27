import type { A2mSongInfo, OplCommand, OplEvent } from 'src/audio/worklets/opl-core';
import { OPL_TAP_OUTPUTS } from 'src/audio/worklets/opl-core';
import { createOplNode } from 'src/audio/tracker/opl-output';

export type { A2mPatternCells, A2mSongInfo } from 'src/audio/worklets/opl-core';

/** Where the A2M song is, as the worklet last reported it (about 25 Hz). */
export interface A2mPosition {
  /** Order position (the grid's sequence index). */
  order: number;
  pattern: number;
  row: number;
  /** Set on the report a `seek` answers. */
  seek?: true;
}

/** Builds the OPL worklet node, past its wasm handshake. Injectable for tests. */
export type A2mNodeFactory = (audioContext: BaseAudioContext) => Promise<AudioWorkletNode>;

/**
 * The main-thread handle on an OPL worklet in song mode (.ai/plan-opl.md O7):
 * the Rust `A2Player` plays an Adlib Tracker II module with its own chip, so
 * nothing is scheduled from here. This loads a module, starts, stops and
 * seeks it, and hears back where it is, as `SidPlayerClient` does for SID.
 *
 * `output` carries the stereo mix. The chip's 18 channels leave the node on
 * outputs `1 + ch`; `connectTrackTaps` routes each track's channel into
 * whatever the tracker analyses per track (`info.trackChannels`), and the
 * worklet records taps only while one is connected.
 */
export class A2mPlayerClient {
  /** Master gain after the worklet: route it wherever the song should be heard. */
  readonly output: GainNode;

  private positionListeners = new Set<(p: A2mPosition) => void>();
  private songEndListeners = new Set<() => void>();
  private errorListeners = new Set<(error: Error) => void>();
  private pendingLoad: { id: number; resolve: (info: A2mSongInfo) => void; reject: (error: Error) => void } | null = null;
  private nextLoadId = 1;
  private disposed = false;
  private unusable: Error | null = null;
  private info: A2mSongInfo | null = null;
  /** Channel output -> the taps it feeds now. */
  private tapEdges = new Map<number, Set<AudioNode>>();

  /** Use `createA2mPlayer`; the node must already be past the wasm handshake. */
  constructor(
    readonly audioContext: BaseAudioContext,
    private readonly node: AudioWorkletNode,
  ) {
    this.output = audioContext.createGain();
    node.connect(this.output, 0);
    node.port.onmessage = (event: MessageEvent) => this.onEvent(event.data as OplEvent);
    node.onprocessorerror = () => this.fail(new Error('OPL worklet processor error'));
  }

  /** The loaded song, or `null` before `loadSong` resolves and after a render failure. */
  get song(): A2mSongInfo | null {
    return this.info;
  }

  /**
   * Parse and load `bytes` (an `.a2m` file) in the worklet. Resolves with the
   * song once it can `play()`; rejects with the player's refusal (one
   * sentence). A load supersedes the previous one.
   */
  loadSong(bytes: Uint8Array): Promise<A2mSongInfo> {
    if (this.unusable) return Promise.reject(this.unusable);
    this.pendingLoad?.reject(new Error('superseded by a newer loadSong'));
    const id = this.nextLoadId++;
    this.info = null;
    return new Promise<A2mSongInfo>((resolve, reject) => {
      this.pendingLoad = { id, resolve, reject };
      const copy = bytes.slice();
      this.send({ type: 'load-a2m', id, bytes: copy.buffer }, [copy.buffer]);
    });
  }

  play(): void {
    this.send({ type: 'play' });
  }

  pause(): void {
    this.send({ type: 'pause' });
  }

  /** Start of `row` in order position `order`, keeping play/pause; answered with a position report. */
  seek(order: number, row: number): void {
    this.send({ type: 'seek', order, row });
  }

  /** Keep playing order position `order` (the tracker's "play pattern"); -1 plays the song on. Outlives the song. */
  setLoopOrder(order: number): void {
    this.send({ type: 'set-loop-order', order });
  }

  setStopAtEnd(enabled: boolean): void {
    this.send({ type: 'set-stop-at-end', enabled });
  }

  /** Bit masks over tracks. Outlives the song. */
  setMuteSolo(mute: number, solo: number): void {
    this.send({ type: 'set-mute-solo', mute: mute >>> 0, solo: solo >>> 0 });
  }

  setGain(gain: number): void {
    this.send({ type: 'set-gain', gain });
  }

  /**
   * Feed each track's OPL channel into `targets[track]` (`null`: nowhere).
   * Two tracks on one channel (percussion) share its tap. Reconnects only
   * what changed; taps run in the worklet only while something is connected.
   */
  connectTrackTaps(targets: ReadonlyArray<AudioNode | null>): void {
    if (this.disposed) return;
    const channels = this.info?.trackChannels ?? [];
    const wanted = new Map<number, Set<AudioNode>>();
    targets.forEach((tap, track) => {
      const ch = channels[track];
      if (!tap || ch === undefined || ch < 0 || ch >= OPL_TAP_OUTPUTS) return;
      let set = wanted.get(ch);
      if (!set) wanted.set(ch, (set = new Set()));
      set.add(tap);
    });
    for (const [ch, taps] of this.tapEdges) {
      for (const tap of taps) {
        if (wanted.get(ch)?.has(tap)) continue;
        try {
          this.node.disconnect(tap, 1 + ch);
        } catch {
          // Already gone (a monitor the bank dropped).
        }
      }
    }
    for (const [ch, taps] of wanted) {
      for (const tap of taps) {
        if (!this.tapEdges.get(ch)?.has(tap)) this.node.connect(tap, 1 + ch);
      }
    }
    const wasOn = [...this.tapEdges.values()].some((s) => s.size > 0);
    const isOn = [...wanted.values()].some((s) => s.size > 0);
    this.tapEdges = wanted;
    if (wasOn !== isOn) this.send({ type: 'set-taps', enabled: isOn });
  }

  onPosition(listener: (p: A2mPosition) => void): () => void {
    this.positionListeners.add(listener);
    return () => this.positionListeners.delete(listener);
  }

  onSongEnd(listener: () => void): () => void {
    this.songEndListeners.add(listener);
    return () => this.songEndListeners.delete(listener);
  }

  onError(listener: (error: Error) => void): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  dispose(): void {
    if (this.disposed) return;
    this.send({ type: 'dispose' });
    this.disposed = true;
    this.unusable ??= new Error('player disposed');
    this.pendingLoad?.reject(new Error('player disposed'));
    this.pendingLoad = null;
    this.positionListeners.clear();
    this.songEndListeners.clear();
    this.errorListeners.clear();
    this.node.disconnect();
    this.output.disconnect();
    this.tapEdges.clear();
    this.node.port.close();
  }

  private send(command: OplCommand, transfer: Transferable[] = []): void {
    if (this.disposed) return;
    this.node.port.postMessage(command, transfer);
  }

  private fail(error: Error): void {
    this.unusable ??= error;
    this.pendingLoad?.reject(error);
    this.pendingLoad = null;
    this.notifyError(error);
  }

  private notifyError(error: Error): void {
    if (this.errorListeners.size === 0) {
      console.error(`[A2M] ${error.message}`);
      return;
    }
    for (const listener of this.errorListeners) listener(error);
  }

  private onEvent(event: OplEvent): void {
    switch (event.type) {
      case 'song-loaded':
        if (event.id !== this.pendingLoad?.id) break;
        this.info = event.info;
        this.pendingLoad.resolve(event.info);
        this.pendingLoad = null;
        break;
      case 'error':
        if (event.id !== undefined) {
          if (event.id === this.pendingLoad?.id) {
            this.pendingLoad.reject(new Error(event.message));
            this.pendingLoad = null;
          }
        } else {
          this.info = null;
          this.notifyError(new Error(event.message));
        }
        break;
      case 'position': {
        const position: A2mPosition = {
          order: event.order,
          pattern: event.pattern,
          row: event.row,
          ...(event.seek ? { seek: true as const } : {}),
        };
        for (const listener of this.positionListeners) listener(position);
        break;
      }
      case 'song-end':
        for (const listener of this.songEndListeners) listener();
        break;
      case 'late-writes':
        break;
    }
  }
}

/**
 * Create an OPL worklet node for song playback (`createOplNode`: the wasm
 * handshake, no timeout, since a suspended context does not run the render
 * thread yet) and wrap it.
 */
export async function createA2mPlayer(
  audioContext: BaseAudioContext,
  createNode: A2mNodeFactory = createOplNode,
): Promise<A2mPlayerClient> {
  return new A2mPlayerClient(audioContext, await createNode(audioContext));
}
