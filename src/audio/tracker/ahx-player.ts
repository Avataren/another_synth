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
  private pendingLoad: {
    resolve: (info: AhxSongInfo) => void;
    reject: (error: Error) => void;
  } | null = null;
  private disposed = false;
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
  }

  /** The loaded song, or `null` before `loadSong` resolves. */
  get song(): AhxSongInfo | null {
    return this.info;
  }

  /**
   * Parse `bytes` (an AHX or HVL file) in the worklet. Resolves with the song
   * once it is ready to `play()`; rejects with the parser's message for a file
   * the engine cannot read. A load supersedes any previous one.
   */
  loadSong(bytes: ArrayBuffer | Uint8Array, stereoMode = 2): Promise<AhxSongInfo> {
    this.pendingLoad?.reject(new Error('superseded by a newer loadSong'));
    return new Promise<AhxSongInfo>((resolve, reject) => {
      this.pendingLoad = { resolve, reject };
      // Copied: the caller keeps its buffer, and the worklet gets its own.
      const copy = new Uint8Array(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).slice();
      this.send({ type: 'load-song', bytes: copy.buffer, stereoMode }, [copy.buffer]);
    });
  }

  play(): void {
    this.send({ type: 'play' });
  }

  pause(): void {
    this.send({ type: 'pause' });
  }

  /** Rewind to the start of `subsong` (0 = the main song); leaves it paused. */
  restart(subsong = 0): void {
    this.send({ type: 'restart', subsong });
  }

  onPosition(listener: (p: AhxPosition) => void): () => void {
    this.positionListeners.add(listener);
    return () => this.positionListeners.delete(listener);
  }

  /** Fires once when the song first reaches its end (it then keeps looping). */
  onSongEnd(listener: () => void): () => void {
    this.songEndListeners.add(listener);
    return () => this.songEndListeners.delete(listener);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.pendingLoad?.reject(new Error('player disposed'));
    this.pendingLoad = null;
    this.positionListeners.clear();
    this.songEndListeners.clear();
    this.send({ type: 'dispose' });
    this.node.disconnect();
    this.output.disconnect();
    this.node.port.close();
  }

  private send(command: AhxCommand, transfer: Transferable[] = []): void {
    if (this.disposed) return;
    this.node.port.postMessage(command, transfer);
  }

  private onEvent(event: AhxEvent): void {
    switch (event.type) {
      case 'song-loaded':
        this.info = event.info;
        this.pendingLoad?.resolve(event.info);
        this.pendingLoad = null;
        break;
      case 'error':
        if (this.pendingLoad) {
          this.pendingLoad.reject(new Error(event.message));
          this.pendingLoad = null;
        } else {
          console.error(`[AHX] ${event.message}`);
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
