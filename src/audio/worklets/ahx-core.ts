/**
 * The render-thread logic of the AHX/HVL worklet, kept apart from the
 * `AudioWorkletProcessor` shell (`ahx-worklet.ts`) so it can be unit-tested
 * against the real wasm in node: the shell only exists inside an
 * `AudioWorkletGlobalScope`, this does not need one.
 *
 * The Rust `AhxEngine` owns the whole transport (ticks, rows, Bxx/Dxx/Fxx,
 * note delay, the four voices), bit-exact against the C reference; this core
 * is deliberately thin. It feeds the worklet's output buffers from
 * `AhxPlayer.render`, obeys a handful of commands and reports where the
 * engine is. Nothing here interprets pattern data.
 */

/** The slice of the wasm `AhxPlayer` class this core uses. */
export interface AhxWasmPlayer {
  play(): void;
  pause(): void;
  restart(subsong: number): boolean;
  set_gain(gain: number): void;
  render(left: Float32Array, right: Float32Array): number;
  position(): number;
  row(): number;
  tempo(): number;
  ticks(): number;
  song_end_reached(): boolean;
  song_name(): string;
  position_count(): number;
  track_length(): number;
  channels(): number;
  dropped_channels(): number;
  free(): void;
}

export type AhxWasmPlayerCtor = new (
  bytes: Uint8Array,
  sampleRate: number,
  stereoMode: number,
) => AhxWasmPlayer;

export interface AhxSongInfo {
  name: string;
  positionCount: number;
  trackLength: number;
  /** Channels the engine plays (the fixed-4 engine constant, or fewer). */
  channels: number;
  /** Song channels beyond the fixed-4 engine that are not played. */
  droppedChannels: number;
  sampleRate: number;
}

/** Main thread -> worklet. */
export type AhxCommand =
  | { type: 'load-song'; bytes: ArrayBuffer | Uint8Array; stereoMode?: number }
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'restart'; subsong?: number }
  | { type: 'set-gain'; gain: number }
  | { type: 'dispose' };

/** Worklet -> main thread. */
export type AhxEvent =
  | { type: 'song-loaded'; info: AhxSongInfo }
  | {
      type: 'position';
      position: number;
      row: number;
      tempo: number;
      ticks: number;
    }
  | { type: 'song-end' }
  | { type: 'error'; message: string };

/** How often `position` events go out while playing (about 25 per second). */
const POSITION_INTERVAL_SECONDS = 0.04;

export class AhxProcessorCore {
  private player: AhxWasmPlayer | null = null;
  private playing = false;
  private gain = 1;
  private framesSincePosition = 0;
  private lastPosition = -1;
  private lastRow = -1;
  private songEndReported = false;
  private scratch = new Float32Array(0);

  constructor(
    private readonly PlayerCtor: AhxWasmPlayerCtor,
    private readonly sampleRate: number,
    private readonly post: (event: AhxEvent) => void,
  ) {}

  handle(command: AhxCommand): void {
    switch (command.type) {
      case 'load-song':
        this.loadSong(command.bytes, command.stereoMode ?? 2);
        break;
      case 'play':
        this.player?.play();
        this.playing = this.player !== null;
        break;
      case 'pause':
        this.player?.pause();
        this.playing = false;
        break;
      case 'restart':
        if (this.player?.restart(command.subsong ?? 0)) {
          this.playing = false;
          this.resetReporting();
        }
        break;
      case 'set-gain':
        this.gain = command.gain;
        this.player?.set_gain(command.gain);
        break;
      case 'dispose':
        this.dropPlayer();
        break;
    }
  }

  /**
   * Fills one render quantum. `right` may be absent (a mono output), in which
   * case the two engine channels are averaged into `left`.
   */
  process(left: Float32Array, right?: Float32Array): void {
    const player = this.player;
    if (!player) {
      left.fill(0);
      right?.fill(0);
      return;
    }
    try {
      let target = right;
      if (!target) {
        if (this.scratch.length < left.length) {
          this.scratch = new Float32Array(left.length);
        }
        target = this.scratch.subarray(0, left.length);
      }
      player.render(left, target);
      if (!right) {
        for (let i = 0; i < left.length; i++) {
          left[i] = ((left[i] ?? 0) + (target[i] ?? 0)) * 0.5;
        }
      }
      if (this.playing) this.report(player, left.length);
    } catch (error) {
      // A wasm trap leaves the instance unusable; go silent rather than
      // throw into the render thread.
      this.dropPlayer();
      left.fill(0);
      right?.fill(0);
      this.post({ type: 'error', message: `AHX render failed: ${String(error)}` });
    }
  }

  private loadSong(bytes: ArrayBuffer | Uint8Array, stereoMode: number): void {
    this.dropPlayer();
    try {
      const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      const player = new this.PlayerCtor(data, this.sampleRate, stereoMode);
      player.set_gain(this.gain);
      this.player = player;
      this.resetReporting();
      this.post({
        type: 'song-loaded',
        info: {
          name: player.song_name(),
          positionCount: player.position_count(),
          trackLength: player.track_length(),
          channels: player.channels(),
          droppedChannels: player.dropped_channels(),
          sampleRate: this.sampleRate,
        },
      });
    } catch (error) {
      // The constructor's `Result<_, String>` arrives as the thrown string.
      this.post({ type: 'error', message: `AHX load failed: ${String(error)}` });
    }
  }

  private report(player: AhxWasmPlayer, frames: number): void {
    if (player.song_end_reached()) {
      if (!this.songEndReported) {
        this.songEndReported = true;
        this.post({ type: 'song-end' });
      }
    }
    this.framesSincePosition += frames;
    if (this.framesSincePosition < this.sampleRate * POSITION_INTERVAL_SECONDS) {
      return;
    }
    this.framesSincePosition = 0;
    const position = player.position();
    const row = player.row();
    if (position === this.lastPosition && row === this.lastRow) return;
    this.lastPosition = position;
    this.lastRow = row;
    this.post({
      type: 'position',
      position,
      row,
      tempo: player.tempo(),
      ticks: player.ticks(),
    });
  }

  private resetReporting(): void {
    this.framesSincePosition = 0;
    this.lastPosition = -1;
    this.lastRow = -1;
    this.songEndReported = false;
  }

  private dropPlayer(): void {
    this.playing = false;
    if (this.player) {
      try {
        this.player.free();
      } catch {
        // already dead
      }
      this.player = null;
    }
  }
}
