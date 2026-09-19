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
  /**
   * Move to `row` of order position `position`, keeping the play/pause state.
   * 0: out of range (nothing changed); 1: the song's own flow reaches it, so
   * every voice is exactly as if the song had played there; 2: it never does
   * and the row starts cold.
   */
  seek(position: number, row: number): number;
  /** Loop the current order position instead of moving on from it. */
  set_loop_position(on: boolean): void;
  /**
   * Keep each voice's wave phase across instrument triggers instead of
   * restarting it at 0 (the 68k behaviour, see `AhxPlayer::set_continue_phase_on_trigger`).
   */
  set_continue_phase_on_trigger(on: boolean): void;
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
  enable_capture(on: boolean): void;
  /** Bit masks, bit `i` = voice `i`: muted voices, and (when non-zero) the only voices heard. */
  set_mute_solo(mute: number, solo: number): void;
  /**
   * Band-limited oscillators instead of the reference's aliasing ones; off is
   * the reference render byte for byte. Turning it on prewarms every table the
   * song needs before it returns (see `AhxPlayer::set_hifi`), so the render
   * path never builds one.
   */
  set_hifi(on: boolean): void;
  hifi_enabled(): boolean;
  /** True once the song's tables are built and the render path is barred from building. */
  hifi_locked(): boolean;
  hifi_table_count(): number;
  /** Render-path lookups the exact table could not serve since the prewarm. */
  hifi_miss_count(): number;
  /** Fills `out` with the voice's latest waveform; returns the points written (0: capture off). */
  read_channel_snapshot(voice: number, out: Int16Array): number;
  free(): void;
}

/**
 * Shipped playback starts with phase-continue on. The reference replayer
 * (Hively) restarts the wave read pointer at every instrument trigger
 * (`hvl_replay.c:893`), so each new note begins at wave[0], the worst-case
 * step for a saw or square. The 68k player never touches it: AUDxLC is written
 * once at init and Paula free-runs over the 640-byte buffer
 * (`.ai/ahx/68k-investigation.md` sections 2a/4). The Rust default stays off
 * so the bit-exact goldens keep proving the reference.
 */
const CONTINUE_PHASE_ON_TRIGGER = true;

export type AhxWasmPlayerCtor = new (
  bytes: Uint8Array,
  sampleRate: number,
  stereoMode: number,
) => AhxWasmPlayer;

export interface AhxSongInfo {
  name: string;
  positionCount: number;
  trackLength: number;
  /** Channels the engine plays: 4 for AHX, the song's native count for HVL. */
  channels: number;
  /** Song channels not played: 0 unless the song exceeds the engine's 16 voices. */
  droppedChannels: number;
  sampleRate: number;
}

/** Main thread -> worklet. */
export type AhxCommand =
  | {
      type: 'load-song';
      /** Monotonic per client; echoed on the `song-loaded` / `error` that answers it. */
      id: number;
      bytes: ArrayBuffer | Uint8Array;
      stereoMode?: number;
    }
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'restart'; subsong?: number }
  /**
   * Jump to `row` of order position `position` without stopping the clock: a
   * playing song carries on from there, a paused one waits there (see
   * `AhxPlayer.seek`). Answered with a `position` event, playing or not.
   */
  | { type: 'seek'; position: number; row: number }
  /**
   * Loop the order position the song is on instead of moving on from it
   * ("play pattern"): at its last row it starts over at row 0 on the same
   * running clock. Like capture it outlives the song: every load starts with
   * the last state set.
   */
  | { type: 'set-loop-position'; enabled: boolean }
  | { type: 'set-gain'; gain: number }
  /**
   * Pause at the song's end instead of looping on. The engine sets its
   * end flag one tick before the intro's first notes sound; a stop that had to
   * come back from the main thread (a round trip through a possibly busy
   * thread) would let them through, so the render thread does it itself.
   */
  | { type: 'set-stop-at-end'; enabled: boolean }
  /**
   * Record each voice's waveform for oscilloscopes and report it with the
   * position reports. Off by default (the engine then runs no capture code);
   * it outlives the song, so it applies to every load until changed.
   */
  | { type: 'set-capture'; enabled: boolean }
  /**
   * Live per-voice mute and solo, as bit masks (bit `i` = voice `i`): a muted
   * voice contributes nothing to the mix, and while `solo` is non-zero only
   * its voices are heard. Like capture it outlives the song: every load
   * starts with the last state set. Scopes see it too (a silenced voice's
   * waveform is flat).
   */
  | { type: 'set-mute-solo'; mute: number; solo: number }
  /**
   * Band-limited ("hi-fi") oscillators: the reference's sound minus the
   * partials that fold back past Nyquist. Off (the default) is the reference
   * render byte for byte. Like capture it outlives the song: every load
   * starts with the last state set. Turning it on (or loading a song with it
   * on) builds every table the song will need first, on this thread but
   * before playback: a load answers `song-loaded` only once that is done.
   */
  | { type: 'set-hifi'; enabled: boolean }
  /**
   * Wave phase across instrument triggers: on (the default here) keeps it, the
   * 68k behaviour; off restarts it at 0 like the reference replayer, which is
   * what the bit-exact-with-the-C-reference tests need. Like hi-fi it outlives
   * the song: every load starts with the last state set.
   */
  | { type: 'set-continue-phase'; enabled: boolean }
  /** Ask for a `hifi-stats` event: diagnostics, and what the E2E asserts on. */
  | { type: 'get-hifi-stats' }
  | { type: 'dispose' };

/** Worklet -> main thread. */
export type AhxEvent =
  | { type: 'song-loaded'; id: number; info: AhxSongInfo }
  | {
      type: 'position';
      position: number;
      row: number;
      tempo: number;
      ticks: number;
    }
  | { type: 'song-end' }
  /**
   * Answer to `get-hifi-stats`. `misses` counts render-path lookups since the
   * prewarm that were not served by the exact table (a duller stand-in, or the
   * reference for that tick): zero means the render thread neither built a
   * table nor degraded one. All zero with no song loaded.
   */
  | {
      type: 'hifi-stats';
      enabled: boolean;
      locked: boolean;
      tables: number;
      misses: number;
    }
  /**
   * The latest waveform of every voice, sent with the position reports while
   * capture is on and the song plays. `data` is `channels` runs of `points`
   * `i16`, voice-major, oldest sample first; the window is the last
   * `AHX_SCOPE_WINDOW_FRAMES` engine frames (the engine's capture ring),
   * full scale `+-AHX_SCOPE_FULL_SCALE`.
   */
  | { type: 'waveforms'; channels: number; points: number; data: Int16Array }
  /** `id` is set when the error answers a `load-song`; a render failure has none. */
  | { type: 'error'; message: string; id?: number };

/** How often `position` events go out while playing (about 25 per second). */
const POSITION_INTERVAL_SECONDS = 0.04;

/** Points per voice in a `waveforms` event: the 2048-frame capture ring decimated 8:1. */
export const AHX_SCOPE_POINTS = 256;

/** Engine frames a `waveforms` snapshot spans (`CAPTURE_FRAMES` in `engine.rs`). */
export const AHX_SCOPE_WINDOW_FRAMES = 2048;

/** A voice's full-scale sample: an `i8` waveform at volume 64. */
export const AHX_SCOPE_FULL_SCALE = 8192;

/** Frames faded out at the end of the quantum a stop-at-end pause lands in. */
const END_FADE_FRAMES = 32;

/** Linear fade to silence over the last `END_FADE_FRAMES` of `buffer`. */
function fadeOutTail(buffer: Float32Array): void {
  const n = Math.min(END_FADE_FRAMES, buffer.length);
  const start = buffer.length - n;
  for (let i = 0; i < n; i++) {
    buffer[start + i] = (buffer[start + i] ?? 0) * (1 - (i + 1) / n);
  }
}

export class AhxProcessorCore {
  private player: AhxWasmPlayer | null = null;
  private playing = false;
  private gain = 1;
  private stopAtEnd = false;
  private capture = false;
  private mute = 0;
  private solo = 0;
  private hifi = false;
  private continuePhase = CONTINUE_PHASE_ON_TRIGGER;
  private loopPosition = false;
  /** One `waveforms` payload, refilled in place each report (posting clones it). */
  private scopeData = new Int16Array(0);
  private framesSincePosition = 0;
  private lastPosition = -1;
  private lastRow = -1;
  private songEndReported = false;
  private scratch = new Float32Array(0);
  private lastLoadId = -1;
  private disposedFlag = false;

  constructor(
    private readonly PlayerCtor: AhxWasmPlayerCtor,
    private readonly sampleRate: number,
    private readonly post: (event: AhxEvent) => void,
  ) {}

  /** True once `dispose` has been handled; the shell stops calling `process`. */
  get disposed(): boolean {
    return this.disposedFlag;
  }

  handle(command: AhxCommand): void {
    if (this.disposedFlag) return;
    switch (command.type) {
      case 'load-song':
        // Ids only grow; a load older than one already handled is stale.
        if (command.id <= this.lastLoadId) break;
        this.lastLoadId = command.id;
        this.loadSong(command.id, command.bytes, command.stereoMode ?? 2);
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
      case 'seek':
        this.seek(command.position, command.row);
        break;
      case 'set-loop-position':
        this.loopPosition = command.enabled;
        this.player?.set_loop_position(command.enabled);
        break;
      case 'set-gain':
        this.gain = command.gain;
        this.player?.set_gain(command.gain);
        break;
      case 'set-stop-at-end':
        this.stopAtEnd = command.enabled;
        break;
      case 'set-capture':
        this.capture = command.enabled;
        this.player?.enable_capture(command.enabled);
        break;
      case 'set-mute-solo':
        this.mute = command.mute >>> 0;
        this.solo = command.solo >>> 0;
        this.player?.set_mute_solo(this.mute, this.solo);
        break;
      case 'set-hifi':
        this.hifi = command.enabled;
        this.player?.set_hifi(command.enabled);
        break;
      case 'set-continue-phase':
        this.continuePhase = command.enabled;
        this.player?.set_continue_phase_on_trigger(command.enabled);
        break;
      case 'get-hifi-stats': {
        const p = this.player;
        this.post({
          type: 'hifi-stats',
          enabled: p?.hifi_enabled() ?? false,
          locked: p?.hifi_locked() ?? false,
          tables: p?.hifi_table_count() ?? 0,
          misses: p?.hifi_miss_count() ?? 0,
        });
        break;
      }
      case 'dispose':
        this.disposedFlag = true;
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
      if (this.playing && this.report(player, left.length)) {
        // Paused at the song's end, mid-tick: the cut would click.
        fadeOutTail(left);
        if (right) fadeOutTail(right);
      }
    } catch (error) {
      // A wasm trap leaves the instance unusable; go silent rather than
      // throw into the render thread.
      this.dropPlayer();
      left.fill(0);
      right?.fill(0);
      this.post({ type: 'error', message: `AHX render failed: ${String(error)}` });
    }
  }

  private loadSong(
    id: number,
    bytes: ArrayBuffer | Uint8Array,
    stereoMode: number,
  ): void {
    this.dropPlayer();
    try {
      const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      const player = new this.PlayerCtor(data, this.sampleRate, stereoMode);
      player.set_gain(this.gain);
      player.enable_capture(this.capture);
      player.set_mute_solo(this.mute, this.solo);
      player.set_hifi(this.hifi);
      player.set_loop_position(this.loopPosition);
      player.set_continue_phase_on_trigger(this.continuePhase);
      this.player = player;
      this.resetReporting();
      this.post({
        type: 'song-loaded',
        id,
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
      this.post({
        type: 'error',
        id,
        message: `AHX load failed: ${String(error)}`,
      });
    }
  }

  /**
   * The player moves; the reports are re-armed (a seek back to a row already
   * reported must not be swallowed as "no change", and a song-end reported
   * before it is not the end of where it is now) and where it landed is sent
   * at once, since a paused song reports nothing on its own.
   */
  private seek(position: number, row: number): void {
    const player = this.player;
    if (!player || player.seek(position, row) === 0) return;
    this.resetReporting();
    this.lastPosition = player.position();
    this.lastRow = player.row();
    this.post({
      type: 'position',
      position: this.lastPosition,
      row: this.lastRow,
      tempo: player.tempo(),
      ticks: player.ticks(),
    });
  }

  /** Returns true when this quantum ended the song and the player was paused. */
  private report(player: AhxWasmPlayer, frames: number): boolean {
    if (player.song_end_reached()) {
      if (!this.songEndReported) {
        this.songEndReported = true;
        this.post({ type: 'song-end' });
        if (this.stopAtEnd) {
          // The flag is raised one tick (20 ms at the default rate) before
          // the wrapped-to intro is played, and a quantum is 3 ms: pausing
          // here is always ahead of it.
          player.pause();
          this.playing = false;
          return true;
        }
      }
    }
    this.framesSincePosition += frames;
    if (this.framesSincePosition < this.sampleRate * POSITION_INTERVAL_SECONDS) {
      return false;
    }
    this.framesSincePosition = 0;
    if (this.capture) this.postWaveforms(player);
    const position = player.position();
    const row = player.row();
    if (position === this.lastPosition && row === this.lastRow) return false;
    this.lastPosition = position;
    this.lastRow = row;
    this.post({
      type: 'position',
      position,
      row,
      tempo: player.tempo(),
      ticks: player.ticks(),
    });
    return false;
  }

  /** Snapshots every voice into the reused buffer and posts it. Allocates nothing per report. */
  private postWaveforms(player: AhxWasmPlayer): void {
    const channels = player.channels();
    const points = AHX_SCOPE_POINTS;
    if (this.scopeData.length !== channels * points) {
      this.scopeData = new Int16Array(channels * points);
    }
    for (let voice = 0; voice < channels; voice++) {
      const run = this.scopeData.subarray(voice * points, (voice + 1) * points);
      if (player.read_channel_snapshot(voice, run) !== points) return;
    }
    this.post({ type: 'waveforms', channels, points, data: this.scopeData });
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
