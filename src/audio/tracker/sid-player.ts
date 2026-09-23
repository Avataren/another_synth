import type { SidCommand, SidEvent, SidSongInfo } from 'src/audio/worklets/sid-core';

export type { SidSongInfo } from 'src/audio/worklets/sid-core';

/** Where the SID song is, as the worklet last reported it (about 25 Hz). */
export interface SidPosition {
  /** The song row, counted from the top (it keeps counting as the song plays on past its end). */
  row: number;
  /** Ticks per row. */
  tempo: number;
  /** Set on the report a `seek` answers. */
  seek?: true;
}

/** The SID worklet's outputs: 0 the mix (stereo), 1..3 the three voices. */
export const SID_WORKLET_OUTPUTS = 4;
export const SID_VOICE_OUTPUTS = [1, 2, 3] as const;

/**
 * The main-thread handle on the SID worklet (plan-sid-tracking.md S4): one
 * `AudioWorkletNode` running the Rust `SidPlayer`, plus the command/event
 * protocol around it (`sid-core.ts`). The player owns the sequencer, so
 * nothing is scheduled from here: this loads a song, starts, stops and seeks
 * it, and hears back where it is.
 *
 * `output` carries the mix; the three voices leave the node on their own
 * outputs, which `connectVoiceTaps` routes into whatever the tracker
 * analyses per track (the song bank's track monitors).
 */
export class SidPlayerClient {
  /** Master gain after the worklet: route it wherever the song should be heard. */
  readonly output: GainNode;

  private positionListeners = new Set<(p: SidPosition) => void>();
  private songEndListeners = new Set<() => void>();
  private errorListeners = new Set<(error: Error) => void>();
  private pendingLoad: { id: number; resolve: (info: SidSongInfo) => void; reject: (error: Error) => void } | null = null;
  private nextLoadId = 0;
  private disposed = false;
  private unusable: Error | null = null;
  private info: SidSongInfo | null = null;
  /** What each voice output is connected to now (`null`: nothing). */
  private tapTargets: (AudioNode | null)[] = [null, null, null];

  /** Use `createSidPlayer`; the node must already be past the wasm handshake. */
  constructor(
    readonly audioContext: BaseAudioContext,
    private readonly node: AudioWorkletNode,
  ) {
    this.output = audioContext.createGain();
    node.connect(this.output, 0);
    node.port.onmessage = (event: MessageEvent) => this.onEvent(event.data as SidEvent);
    node.onprocessorerror = () => this.fail(new Error('SID worklet processor error'));
  }

  /** The loaded song, or `null` before `loadSong` resolves and after a render failure. */
  get song(): SidSongInfo | null {
    return this.info;
  }

  /**
   * Route voice `i`'s output to `targets[i]` (`null`: nowhere). Reconnects only
   * what changed, so it is cheap to call on every load.
   */
  connectVoiceTaps(targets: ReadonlyArray<AudioNode | null>): void {
    if (this.disposed) return;
    SID_VOICE_OUTPUTS.forEach((output, voice) => {
      const next = targets[voice] ?? null;
      const current = this.tapTargets[voice] ?? null;
      if (next === current) return;
      if (current) {
        try {
          this.node.disconnect(current, output);
        } catch {
          // Already gone (a monitor the bank dropped).
        }
      }
      if (next) this.node.connect(next, output);
      this.tapTargets[voice] = next;
    });
  }

  /** What the voice outputs are connected to (tests, diagnostics). */
  get voiceTapTargets(): ReadonlyArray<AudioNode | null> {
    return this.tapTargets;
  }

  /**
   * Parse `bytes` (a SID song file, `serializeSidFile`) in the worklet.
   * Resolves once it can `play()`; rejects with the parser's reason. A load
   * supersedes the previous one; only the newest one's answer settles.
   */
  loadSong(bytes: Uint8Array): Promise<SidSongInfo> {
    if (this.unusable) return Promise.reject(this.unusable);
    this.pendingLoad?.reject(new Error('superseded by a newer loadSong'));
    const id = this.nextLoadId++;
    return new Promise<SidSongInfo>((resolve, reject) => {
      this.pendingLoad = { id, resolve, reject };
      // Copied: the caller keeps its buffer, and the worklet gets its own.
      const copy = bytes.slice();
      this.send({ type: 'load-song', id, bytes: copy.buffer }, [copy.buffer]);
    });
  }

  play(): void {
    this.send({ type: 'play' });
  }

  pause(): void {
    this.send({ type: 'pause' });
  }

  /** Start of song row `row`, keeping play/pause; answered with a position report. */
  seek(row: number): void {
    this.send({ type: 'seek', row });
  }

  /** Loop song rows `start..end` (`end <= start`: no loop). Outlives the song. */
  setLoopRows(start: number, end: number): void {
    this.send({ type: 'set-loop-rows', start, end });
  }

  setStopAtEnd(enabled: boolean): void {
    this.send({ type: 'set-stop-at-end', enabled });
  }

  setMuteSolo(mute: number, solo: number): void {
    this.send({ type: 'set-mute-solo', mute: mute >>> 0, solo: solo >>> 0 });
  }

  setGain(gain: number): void {
    this.send({ type: 'set-gain', gain });
  }

  /** Make this worklet a preview voice: songs loaded from now on are played by keys. Before the load. */
  setPreview(enabled: boolean): void {
    this.send({ type: 'set-preview', enabled });
  }

  /** Preview: `instrument` (1-based) at note table index `note` (0 = C-0). */
  previewNoteOn(instrument: number, note: number): void {
    this.send({ type: 'preview-note-on', instrument, note });
  }

  previewNoteOff(): void {
    this.send({ type: 'preview-note-off' });
  }

  onPosition(listener: (p: SidPosition) => void): () => void {
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
    this.disposed = true;
    this.unusable ??= new Error('player disposed');
    this.pendingLoad?.reject(new Error('player disposed'));
    this.pendingLoad = null;
    this.positionListeners.clear();
    this.songEndListeners.clear();
    this.errorListeners.clear();
    this.node.port.postMessage({ type: 'dispose' } satisfies SidCommand);
    this.node.disconnect();
    this.output.disconnect();
    this.tapTargets = [null, null, null];
    this.node.port.close();
  }

  private send(command: SidCommand, transfer: Transferable[] = []): void {
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
      console.error(`[SID] ${error.message}`);
      return;
    }
    for (const listener of this.errorListeners) listener(error);
  }

  private onEvent(event: SidEvent): void {
    switch (event.type) {
      case 'song-loaded':
        if (event.id !== this.pendingLoad?.id) break;
        this.info = event.info;
        this.pendingLoad.resolve(event.info);
        this.pendingLoad = null;
        break;
      case 'error':
        if (event.id !== undefined && event.id === this.pendingLoad?.id) {
          this.pendingLoad.reject(new Error(event.message));
          this.pendingLoad = null;
        } else if (event.id === undefined) {
          this.info = null;
          this.notifyError(new Error(event.message));
        }
        break;
      case 'position': {
        const position: SidPosition = { row: event.row, tempo: event.tempo, ...(event.seek ? { seek: true as const } : {}) };
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
 * Create the SID worklet node and run its wasm handshake (the AHX worklet's:
 * `ready` -> the wasm bytes -> `wasm-ready`). No timeout, on purpose: a
 * suspended context does not run the render thread yet.
 */
export async function createSidPlayer(audioContext: BaseAudioContext): Promise<SidPlayerClient> {
  await audioContext.audioWorklet.addModule(`${import.meta.env.BASE_URL}worklets/sid-worklet.js`);
  const node = new AudioWorkletNode(audioContext, 'sid-audio-processor', {
    numberOfInputs: 0,
    numberOfOutputs: SID_WORKLET_OUTPUTS,
    outputChannelCount: [2, 1, 1, 1],
  });
  await new Promise<void>((resolve, reject) => {
    const fail = (error: Error) => {
      node.port.onmessage = null;
      node.port.close();
      reject(error);
    };
    node.onprocessorerror = () => fail(new Error('SID worklet processor error'));
    node.port.onmessage = async (event: MessageEvent) => {
      const data = event.data as SidEvent | { type: 'ready' | 'wasm-ready' };
      if (data.type === 'ready') {
        try {
          const response = await fetch(`${import.meta.env.BASE_URL}wasm/audio_processor_bg.wasm`, { cache: 'no-cache' });
          if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
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
  return new SidPlayerClient(audioContext, node);
}
