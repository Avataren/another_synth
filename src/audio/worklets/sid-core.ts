/**
 * The render-thread logic of the SID worklet (plan-sid-tracking.md S4), kept
 * apart from the `AudioWorkletProcessor` shell (`sid-worklet.ts`) so it can be
 * unit-tested against the real wasm in node, as `ahx-core.ts` is.
 *
 * The Rust `SidPlayer` (`rust-wasm/src/sid/wasm.rs`) owns the song: the
 * sequencer, the tables, the chip. This core feeds the worklet's outputs from
 * it, obeys a handful of commands and reports where the song is. It
 * interprets no song data.
 *
 * Outputs: 0 is the mix, stereo (the chip is mono: both sides carry it);
 * 1..3 are the three voices' own signals, mono (`Chip::render_taps`: before
 * the filter), what the tracker's per-track scopes and spectrum analyse.
 */

/** The slice of the wasm `SidPlayer` class this core uses. */
export interface SidWasmPlayer {
  play(): void;
  pause(): void;
  is_playing(): boolean;
  /** Start of song row `row` (counted from the top), keeping play/pause. */
  seek_row(row: number): void;
  set_loop_rows(start: number, end: number): void;
  clear_loop_rows(): void;
  set_gain(gain: number): void;
  set_mute_solo(mute: number, solo: number): void;
  /** Mix into `out`, voice taps into `v0..v2`; silence while paused. Returns frames. */
  render(out: Float32Array, v0: Float32Array, v1: Float32Array, v2: Float32Array): number;
  song_row(): number;
  song_rows(): number;
  song_end_reached(): boolean;
  tempo(): number;
  channels(): number;
  chip_model(): string;
  instrument_count(): number;
  /** A voice tap's level for a full voice at VOL 15 (`Chip::tap_full_scale`). */
  tap_full_scale(): number;
  enable_preview(): void;
  preview_note_on(instrument: number, note: number): boolean;
  preview_note_off(): void;
  free(): void;
}

export type SidWasmPlayerCtor = new (bytes: Uint8Array, sampleRate: number) => SidWasmPlayer;

export interface SidSongInfo {
  /** The song's length in rows (the longest voice's first pass): the grid's length. */
  songRows: number;
  channels: number;
  chipModel: string;
  instrumentCount: number;
  sampleRate: number;
  /**
   * What a full-swing voice at full envelope and VOL 15 reaches in its tap
   * (outputs 1..3): each voice at its share of the mix, well below 1.0. The
   * per-track scopes divide by it to draw such a voice at full height.
   */
  voiceFullScale: number;
}

/** Main thread -> worklet. */
export type SidCommand =
  | {
      type: 'load-song';
      /** Monotonic per client; echoed on the `song-loaded` / `error` that answers it. */
      id: number;
      /** A SID song file (`serializeSidFile`), what the Rust `SidSong::parse` reads. */
      bytes: ArrayBuffer | Uint8Array;
    }
  | { type: 'play' }
  | { type: 'pause' }
  /** Move to song row `row` without stopping the clock; answered with a `position` report. */
  | { type: 'seek'; row: number }
  /**
   * Loop song rows `start..end` (`end` exclusive; `end <= start` clears it):
   * the tracker's "play pattern". Outlives the song, like the AHX worklet's.
   */
  | { type: 'set-loop-rows'; start: number; end: number }
  | { type: 'set-gain'; gain: number }
  /** Pause at the song's end instead of playing on (the jukebox). */
  | { type: 'set-stop-at-end'; enabled: boolean }
  /** Bit masks, bit `i` = voice `i`. Outlives the song. */
  | { type: 'set-mute-solo'; mute: number; solo: number }
  /** Keyboard-preview worklet: every song loaded from now on is a preview voice. Send it before the load. */
  | { type: 'set-preview'; enabled: boolean }
  /** Preview: `instrument` (1-based) at note table index `note` (0 = C-0 .. 92 = G#7). */
  | { type: 'preview-note-on'; instrument: number; note: number }
  | { type: 'preview-note-off' }
  | { type: 'dispose' };

/** Worklet -> main thread. */
export type SidEvent =
  | { type: 'song-loaded'; id: number; info: SidSongInfo }
  /** `row` counts from the top of the song (past `songRows` once it plays on). `seek` marks a seek's answer. */
  | { type: 'position'; row: number; tempo: number; seek?: true }
  | { type: 'song-end' }
  /** `id` is set when the error answers a `load-song`; a render failure has none. */
  | { type: 'error'; message: string; id?: number };

/** How often `position` events go out while playing (about 25 per second). */
const POSITION_INTERVAL_SECONDS = 0.04;
/** Frames faded out at the end of the quantum a stop-at-end pause lands in. */
const END_FADE_FRAMES = 32;

function fadeOutTail(buffer: Float32Array): void {
  const n = Math.min(END_FADE_FRAMES, buffer.length);
  const start = buffer.length - n;
  for (let i = 0; i < n; i++) buffer[start + i] = (buffer[start + i] ?? 0) * (1 - (i + 1) / n);
}

export class SidProcessorCore {
  private player: SidWasmPlayer | null = null;
  private gain = 1;
  private stopAtEnd = false;
  private mute = 0;
  private solo = 0;
  private preview = false;
  private loop: { start: number; end: number } | null = null;
  private framesSincePosition = 0;
  private lastRow = -1;
  private songEndReported = false;
  private lastLoadId = -1;
  private disposedFlag = false;
  /** Scratch for outputs the node was not given (a mono or tap-less host). */
  private scratch: Float32Array[] = [];

  constructor(
    private readonly PlayerCtor: SidWasmPlayerCtor,
    private readonly sampleRate: number,
    private readonly post: (event: SidEvent) => void,
  ) {}

  get disposed(): boolean {
    return this.disposedFlag;
  }

  handle(command: SidCommand): void {
    if (this.disposedFlag) return;
    switch (command.type) {
      case 'load-song':
        if (command.id <= this.lastLoadId) break;
        this.lastLoadId = command.id;
        this.loadSong(command.id, command.bytes);
        break;
      case 'play':
        this.player?.play();
        break;
      case 'pause':
        this.player?.pause();
        break;
      case 'seek':
        this.seek(command.row);
        break;
      case 'set-loop-rows':
        this.loop = command.end > command.start ? { start: command.start, end: command.end } : null;
        this.applyLoop();
        break;
      case 'set-gain':
        this.gain = command.gain;
        this.player?.set_gain(command.gain);
        break;
      case 'set-stop-at-end':
        this.stopAtEnd = command.enabled;
        break;
      case 'set-mute-solo':
        this.mute = command.mute >>> 0;
        this.solo = command.solo >>> 0;
        this.player?.set_mute_solo(this.mute, this.solo);
        break;
      case 'set-preview':
        this.preview = command.enabled;
        break;
      case 'preview-note-on':
        this.player?.preview_note_on(command.instrument, command.note);
        break;
      case 'preview-note-off':
        this.player?.preview_note_off();
        break;
      case 'dispose':
        this.disposedFlag = true;
        this.dropPlayer();
        break;
    }
  }

  /**
   * Fills one render quantum: `mix` (and `right`, a copy of it, when the
   * output is stereo) and the three voice taps (any may be absent).
   */
  process(mix: Float32Array, right: Float32Array | undefined, taps: ReadonlyArray<Float32Array | undefined>): void {
    const player = this.player;
    const n = mix.length;
    if (!player) {
      mix.fill(0);
      right?.fill(0);
      for (const tap of taps) tap?.fill(0);
      return;
    }
    try {
      const t = [0, 1, 2].map((i) => {
        const given = taps[i];
        if (given && given.length === n) return given;
        if ((this.scratch[i]?.length ?? 0) < n) this.scratch[i] = new Float32Array(n);
        return (this.scratch[i] as Float32Array).subarray(0, n);
      }) as [Float32Array, Float32Array, Float32Array];
      player.render(mix, t[0], t[1], t[2]);
      if (!this.preview && player.is_playing() && this.report(player, n)) {
        fadeOutTail(mix);
        for (const tap of t) fadeOutTail(tap);
      }
      right?.set(mix);
    } catch (error) {
      // A wasm trap leaves the instance unusable: go silent, say so.
      this.dropPlayer();
      mix.fill(0);
      right?.fill(0);
      for (const tap of taps) tap?.fill(0);
      this.post({ type: 'error', message: `SID render failed: ${String(error)}` });
    }
  }

  private loadSong(id: number, bytes: ArrayBuffer | Uint8Array): void {
    this.dropPlayer();
    try {
      const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      const player = new this.PlayerCtor(data, this.sampleRate);
      player.set_gain(this.gain);
      player.set_mute_solo(this.mute, this.solo);
      if (this.preview) player.enable_preview();
      this.player = player;
      this.applyLoop();
      this.resetReporting();
      this.post({
        type: 'song-loaded',
        id,
        info: {
          songRows: player.song_rows(),
          channels: player.channels(),
          chipModel: player.chip_model(),
          instrumentCount: player.instrument_count(),
          sampleRate: this.sampleRate,
          voiceFullScale: player.tap_full_scale(),
        },
      });
    } catch (error) {
      // The constructor's `Result<_, String>` arrives as the thrown string.
      this.post({ type: 'error', id, message: `SID load failed: ${String(error)}` });
    }
  }

  private applyLoop(): void {
    if (!this.player) return;
    if (this.loop) this.player.set_loop_rows(this.loop.start, this.loop.end);
    else this.player.clear_loop_rows();
  }

  private seek(row: number): void {
    const player = this.player;
    if (!player) return;
    player.seek_row(Math.max(0, Math.floor(row)));
    this.resetReporting();
    this.lastRow = player.song_row();
    this.post({ type: 'position', row: this.lastRow, tempo: player.tempo(), seek: true });
  }

  /** Returns true when this quantum ended the song and the player was paused. */
  private report(player: SidWasmPlayer, frames: number): boolean {
    if (player.song_end_reached() && !this.songEndReported) {
      this.songEndReported = true;
      this.post({ type: 'song-end' });
      if (this.stopAtEnd) {
        player.pause();
        return true;
      }
    }
    this.framesSincePosition += frames;
    if (this.framesSincePosition < this.sampleRate * POSITION_INTERVAL_SECONDS) return false;
    this.framesSincePosition = 0;
    const row = player.song_row();
    if (row === this.lastRow) return false;
    this.lastRow = row;
    this.post({ type: 'position', row, tempo: player.tempo() });
    return false;
  }

  private resetReporting(): void {
    this.framesSincePosition = 0;
    this.lastRow = -1;
    this.songEndReported = false;
  }

  private dropPlayer(): void {
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
