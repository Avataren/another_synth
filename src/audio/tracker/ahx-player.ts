import type {
  AhxCommand,
  AhxEvent,
  AhxSongInfo,
} from 'src/audio/worklets/ahx-core';
import { DEMO_BASE_URL } from 'src/composables/useDemoManifest';

export type { AhxSongInfo } from 'src/audio/worklets/ahx-core';

/** Where the engine is, as last reported by the worklet (about 25 Hz). */
export interface AhxPosition {
  /** Index into the song's position list; also the pattern index in the
   * row model `buildAhxTrackerPatterns` produces (one pattern per position). */
  position: number;
  row: number;
  /** Ticks per row. */
  tempo: number;
  ticks: number;
}

/**
 * One snapshot of every voice's waveform (about 25 per second while capture is
 * on and the song plays): `channels` runs of `points` `i16`, voice-major,
 * oldest first. The array is this event's own copy, safe to keep.
 */
export interface AhxWaveforms {
  channels: number;
  points: number;
  data: Int16Array;
}

/**
 * The main-thread handle on the AHX worklet: one `AudioWorkletNode` running
 * the Rust `AhxEngine`, plus the small command/event protocol around it.
 *
 * The engine owns the transport, so unlike the sampler formats nothing is
 * scheduled from here: this loads a song, starts and stops it, and hears back
 * where it is. Route `output` wherever the song should be heard.
 */
export class AhxPlayerClient {
  /** Master gain after the worklet; `AhxTrackerSink.setMasterVolume` drives it. */
  readonly output: GainNode;

  private positionListeners = new Set<(p: AhxPosition) => void>();
  private songEndListeners = new Set<() => void>();
  private waveformListeners = new Set<(w: AhxWaveforms) => void>();
  private errorListeners = new Set<(error: Error) => void>();
  private pendingLoad: {
    id: number;
    resolve: (info: AhxSongInfo) => void;
    reject: (error: Error) => void;
  } | null = null;
  private nextLoadId = 0;
  private disposed = false;
  /** Set once the client can no longer talk to the worklet (disposed, or the processor died). */
  private unusable: Error | null = null;
  private info: AhxSongInfo | null = null;

  /** Use `createAhxPlayer`; the node must already be past the wasm handshake. */
  constructor(
    readonly audioContext: AudioContext,
    private readonly node: AudioWorkletNode,
  ) {
    this.output = audioContext.createGain();
    node.connect(this.output);
    node.port.onmessage = (event: MessageEvent) =>
      this.onEvent(event.data as AhxEvent);
    // The handshake's own handler is spent by now and would close the port.
    node.onprocessorerror = () =>
      this.fail(new Error('AHX worklet processor error'));
  }

  /**
   * The loaded song, or `null` before `loadSong` resolves and again after a
   * render failure (the worklet drops its player then, so the song is gone).
   */
  get song(): AhxSongInfo | null {
    return this.info;
  }

  /**
   * Parse `bytes` (an AHX or HVL file) in the worklet. Resolves with the song
   * once it is ready to `play()`; rejects with the parser's message for a file
   * the engine cannot read. A load supersedes any previous one; the worklet
   * still runs both, but only the newest one's answer settles anything. Rejects
   * at once on a disposed client or one whose processor has died.
   */
  loadSong(bytes: ArrayBuffer | Uint8Array, stereoMode = 2): Promise<AhxSongInfo> {
    if (this.unusable) return Promise.reject(this.unusable);
    this.pendingLoad?.reject(new Error('superseded by a newer loadSong'));
    const id = this.nextLoadId++;
    return new Promise<AhxSongInfo>((resolve, reject) => {
      this.pendingLoad = { id, resolve, reject };
      // Copied: the caller keeps its buffer, and the worklet gets its own.
      const copy = new Uint8Array(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).slice();
      this.send({ type: 'load-song', id, bytes: copy.buffer, stereoMode }, [copy.buffer]);
    });
  }

  /**
   * Start the song. With no song loaded (never loaded, or lost to a render
   * failure) the worklet would ignore this, so it is reported through
   * `onError` instead of vanishing. A `play()` right after an unawaited
   * `loadSong` is fine: commands are ordered on the port.
   */
  play(): void {
    if (!this.disposed && !this.info && !this.pendingLoad) {
      this.notifyError(
        new Error('AHX play() ignored: no song is loaded (none yet, or it was lost to a render failure)'),
      );
      return;
    }
    this.send({ type: 'play' });
  }

  pause(): void {
    this.send({ type: 'pause' });
  }

  /** Rewind to the start of `subsong` (0 = the main song); leaves it paused. */
  restart(subsong = 0): void {
    this.send({ type: 'restart', subsong });
  }

  /**
   * Have the worklet pause itself when the song reaches its end, rather than
   * looping into the intro until the main thread gets round to pausing it.
   * `song-end` is still reported either way. Off by default; it outlives the
   * song, so it applies to every load until changed.
   */
  setStopAtEnd(enabled: boolean): void {
    this.send({ type: 'set-stop-at-end', enabled });
  }

  /**
   * Record each voice's waveform in the worklet and get it back as
   * `onWaveforms` events. Off by default (the engine then does no capture
   * work); it outlives the song, so it applies to every load until changed.
   */
  setCapture(enabled: boolean): void {
    this.send({ type: 'set-capture', enabled });
  }

  onPosition(listener: (p: AhxPosition) => void): () => void {
    this.positionListeners.add(listener);
    return () => this.positionListeners.delete(listener);
  }

  /** Per-voice waveform snapshots; silent unless `setCapture(true)`. */
  onWaveforms(listener: (w: AhxWaveforms) => void): () => void {
    this.waveformListeners.add(listener);
    return () => this.waveformListeners.delete(listener);
  }

  /** Fires once when the song first reaches its end (it then keeps looping). */
  onSongEnd(listener: () => void): () => void {
    this.songEndListeners.add(listener);
    return () => this.songEndListeners.delete(listener);
  }

  /**
   * Failures that no `loadSong` promise carries: a render trap in the worklet,
   * or the processor dying (after which the client is unusable). With no
   * listener they are logged.
   */
  onError(listener: (error: Error) => void): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unusable ??= new Error('player disposed');
    this.pendingLoad?.reject(new Error('player disposed'));
    this.pendingLoad = null;
    this.positionListeners.clear();
    this.songEndListeners.clear();
    this.waveformListeners.clear();
    this.errorListeners.clear();
    this.send({ type: 'dispose' });
    this.node.disconnect();
    this.output.disconnect();
    this.node.port.close();
  }

  private send(command: AhxCommand, transfer: Transferable[] = []): void {
    if (this.disposed) return;
    this.node.port.postMessage(command, transfer);
  }

  /** The processor is gone: settle what is waiting, tell listeners, refuse new loads. */
  private fail(error: Error): void {
    this.unusable ??= error;
    this.pendingLoad?.reject(error);
    this.pendingLoad = null;
    this.notifyError(error);
  }

  private notifyError(error: Error): void {
    if (this.errorListeners.size === 0) {
      console.error(`[AHX] ${error.message}`);
      return;
    }
    for (const listener of this.errorListeners) listener(error);
  }

  private onEvent(event: AhxEvent): void {
    switch (event.type) {
      case 'song-loaded':
        // An answer to a load that a newer one superseded: not the current song.
        if (event.id !== this.pendingLoad?.id) break;
        this.info = event.info;
        this.pendingLoad.resolve(event.info);
        this.pendingLoad = null;
        break;
      case 'error':
        // Only a load's own error (matching id) rejects it; a stale load's
        // error, or one with no id (a render trap), must not.
        if (event.id !== undefined && event.id === this.pendingLoad?.id) {
          this.pendingLoad.reject(new Error(event.message));
          this.pendingLoad = null;
        } else if (event.id === undefined) {
          // A render failure: the worklet has dropped its player, so the
          // song we last reported is no longer playable.
          this.info = null;
          this.notifyError(new Error(event.message));
        }
        break;
      case 'position': {
        const position: AhxPosition = {
          position: event.position,
          row: event.row,
          tempo: event.tempo,
          ticks: event.ticks,
        };
        for (const listener of this.positionListeners) listener(position);
        break;
      }
      case 'waveforms': {
        const waveforms: AhxWaveforms = {
          channels: event.channels,
          points: event.points,
          data: event.data,
        };
        for (const listener of this.waveformListeners) listener(waveforms);
        break;
      }
      case 'song-end':
        for (const listener of this.songEndListeners) listener();
        break;
    }
  }
}

/**
 * Create the AHX worklet node and run its wasm handshake.
 *
 * No handshake timeout, on purpose: a context that is still suspended (no user
 * gesture yet) does not run the render thread, so the worklet cannot answer
 * yet and a timer would fire on a healthy player. Failures that do arrive
 * (`processorerror`, a wasm init error) reject.
 */
export async function createAhxPlayer(
  audioContext: AudioContext,
): Promise<AhxPlayerClient> {
  await audioContext.audioWorklet.addModule(
    `${import.meta.env.BASE_URL}worklets/ahx-worklet.js`,
  );
  const node = new AudioWorkletNode(audioContext, 'ahx-audio-processor', {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [2],
  });

  await new Promise<void>((resolve, reject) => {
    const fail = (error: Error) => {
      node.port.onmessage = null;
      node.port.close();
      reject(error);
    };
    node.onprocessorerror = () => fail(new Error('AHX worklet processor error'));
    node.port.onmessage = async (event: MessageEvent) => {
      const data = event.data as AhxEvent | { type: 'ready' | 'wasm-ready' };
      if (data.type === 'ready') {
        try {
          const response = await fetch(
            `${import.meta.env.BASE_URL}wasm/audio_processor_bg.wasm`,
          );
          if (!response.ok) {
            throw new Error(`${response.status} ${response.statusText}`);
          }
          const wasmBytes = await response.arrayBuffer();
          node.port.postMessage({ type: 'wasm-binary', wasmBytes }, [wasmBytes]);
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      } else if (data.type === 'wasm-ready') {
        resolve();
      } else if (data.type === 'error') {
        fail(new Error(data.message));
      }
    };
  });

  return new AhxPlayerClient(audioContext, node);
}

/** URL of a bundled AHX/HVL demo, e.g. `ahxDemoUrl('karma.ahx')`. */
export function ahxDemoUrl(file: string): string {
  return `${DEMO_BASE_URL}/ahx/${file}`;
}

/** Fetch an AHX/HVL file and load it into `player`. */
export async function loadAhxSongFromUrl(
  player: AhxPlayerClient,
  url: string,
): Promise<AhxSongInfo> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText} for ${url}`);
  }
  return player.loadSong(await response.arrayBuffer());
}
