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
  /**
   * Keyboard-preview mode: the player stops playing the song and is played by
   * `preview_note_on` / `preview_note_off` (one mono voice, the song's own
   * instruments). Renders at once; hi-fi then builds its tables lazily.
   */
  enable_preview(): void;
  /** `false` (nothing changed) outside preview mode or for an instrument the song lacks. */
  preview_note_on(instrument: number, note: number, velocity: number): boolean;
  preview_note_off(): void;
  /**
   * Replace instrument `instrument` (1-based) of the loaded song with the one
   * in `bytes` (its wire form: the 22-byte core and its PList entries in the
   * song's layout, see `serializeAhxInstrument`). Throws the reason, with the
   * song untouched, for bytes that are not one instrument or an instrument the
   * song lacks.
   */
  replace_instrument(instrument: number, bytes: Uint8Array): void;
  /**
   * `replace_instrument` without the hi-fi walk it may owe: the instrument is
   * swapped now, and the walk waits for `finish_instrument_edits`, so a batch
   * of edits costs one walk of the song.
   */
  replace_instrument_deferred(instrument: number, bytes: Uint8Array): void;
  /** Pays the walk the deferred edits owe (nothing when none does). */
  finish_instrument_edits(): void;
  instrument_count(): number;
  /** Ticks a preview note-on's prewarm holds the key down for `instrument` (0 for none). */
  preview_warm_hold_ticks(instrument: number): number;
  /**
   * Preview mode: the PList row the sounding note's voice ran last, `-1` with
   * none (no note, its release over, no row run yet, not a preview). A scalar:
   * the render thread reads it every quantum.
   */
  preview_plist_row(): number;
  /** The instrument (1-based) that row belongs to; `0` with none. */
  preview_plist_instrument(): number;
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
  /** Instrument numbers of a load's `instruments` the engine refused (absent when none was). */
  rejectedInstruments?: number[];
}

/** One instrument to replace: its 1-based number and its wire form. */
export interface AhxInstrumentBytes {
  instrument: number;
  bytes: ArrayBuffer | Uint8Array;
}

/** Main thread -> worklet. */
export type AhxCommand =
  | {
      type: 'load-song';
      /** Monotonic per client; echoed on the `song-loaded` / `error` that answers it. */
      id: number;
      bytes: ArrayBuffer | Uint8Array;
      stereoMode?: number;
      /**
       * Instruments to replace right after the song is parsed, before hi-fi
       * prewarms it (so the tables built are the edited song's): the edits made
       * to the song since it was imported. One the engine refuses is skipped
       * and named in `song-loaded`'s `rejectedInstruments`.
       */
      instruments?: AhxInstrumentBytes[];
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
   * Keyboard-preview worklet: every song loaded from now on is put in preview
   * mode (see `AhxWasmPlayer.enable_preview`) instead of being a song to play,
   * so this instance is a live voice for the song's instruments and the
   * transport commands mean nothing to it. Send it before the load.
   */
  | { type: 'set-preview'; enabled: boolean }
  /**
   * Preview mode: play `instrument` (1-based) at `note` (the AHX note index,
   * 1..=60) with `velocity` (0..=127), retriggering the one voice. Ignored
   * with no preview song loaded.
   */
  | { type: 'preview-note-on'; instrument: number; note: number; velocity: number }
  /** Preview mode: release the note (the instrument's release or hard cut). */
  | { type: 'preview-note-off' }
  /**
   * Wave phase across instrument triggers: on (the default here) keeps it, the
   * 68k behaviour; off restarts it at 0 like the reference replayer, which is
   * what the bit-exact-with-the-C-reference tests need. Like hi-fi it outlives
   * the song: every load starts with the last state set.
   */
  | { type: 'set-continue-phase'; enabled: boolean }
  /**
   * Replace ONE instrument of the loaded song without reloading it: the song
   * player's next trigger of it, and the preview's next note-on, play the new
   * one (a voice already holding it also takes PList and envelope changes at
   * once; see `AhxPlayer::replace_instrument`). The song does not restart and
   * the transport does not move. With hi-fi on, a song player rebuilds the
   * tables the edited song needs before it answers, so this can take a while
   * on a long song; a preview only forgets what it prewarmed for the
   * instrument. Answered with `instrument-replaced` carrying the same `id`.
   */
  | { type: 'replace-instrument'; id: number; instrument: number; bytes: ArrayBuffer | Uint8Array }
  /**
   * Several `replace-instrument`s as one command: every instrument is swapped,
   * then the song is walked once for the hi-fi tables the edited song needs
   * (instead of once per instrument). Each edit is answered with its own
   * `instrument-replaced` (its own `id`), all after the walk.
   */
  | { type: 'replace-instruments'; edits: Array<{ id: number; instrument: number; bytes: ArrayBuffer | Uint8Array }> }
  /** Ask for a `hifi-stats` event: diagnostics, and what the E2E asserts on. */
  | { type: 'get-hifi-stats' }
  /** Ask for a `warm-hold` event: the preview prewarm's hold for one instrument. */
  | { type: 'get-warm-hold'; instrument: number }
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
      /**
       * Only on the report a `seek` answers: 1 when the song's own flow reaches
       * the row (every voice is as if it had played there), 2 when it never does
       * (the row starts cold). The periodic reports leave it out.
       */
      seekKind?: 1 | 2;
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
  /** Answer to `replace-instrument`: `ok`, or why the song was left as it was. */
  | { type: 'instrument-replaced'; id: number; instrument: number; ok: boolean; message?: string }
  /** Answer to `get-warm-hold`: ticks the preview prewarm holds the key for (0: no such instrument). */
  | { type: 'warm-hold'; instrument: number; ticks: number }
  /**
   * The latest waveform of every voice, sent with the position reports while
   * capture is on and the song plays. `data` is `channels` runs of `points`
   * `i16`, voice-major, oldest sample first; the window is the last
   * `AHX_SCOPE_WINDOW_FRAMES` engine frames (the engine's capture ring),
   * full scale `+-AHX_SCOPE_FULL_SCALE`.
   */
  | { type: 'waveforms'; channels: number; points: number; data: Int16Array }
  /**
   * Preview mode: the PList row the sounding note is on, posted when it
   * changes and not otherwise (so at most once per engine tick, and never for
   * a song player). `instrument` is the one the row belongs to (1-based);
   * `instrument: 0, row: -1` says nothing sounds any more.
   */
  | { type: 'plist-row'; instrument: number; row: number }
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

const toBytes = (bytes: ArrayBuffer | Uint8Array): Uint8Array =>
  bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);

export class AhxProcessorCore {
  private player: AhxWasmPlayer | null = null;
  private playing = false;
  private gain = 1;
  private stopAtEnd = false;
  private capture = false;
  private mute = 0;
  private solo = 0;
  private hifi = false;
  private preview = false;
  private continuePhase = CONTINUE_PHASE_ON_TRIGGER;
  private loopPosition = false;
  /** One `waveforms` payload, refilled in place each report (posting clones it). */
  private scopeData = new Int16Array(0);
  private framesSincePosition = 0;
  private lastPosition = -1;
  private lastRow = -1;
  private songEndReported = false;
  /** What the last `plist-row` said: `0, -1` is "nothing sounds", which is also the state a fresh player is in. */
  private lastPlistInstrument = 0;
  private lastPlistRow = -1;
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
        this.loadSong(command.id, command.bytes, command.stereoMode ?? 2, command.instruments ?? []);
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
      case 'set-preview':
        this.preview = command.enabled;
        break;
      case 'preview-note-on':
        this.player?.preview_note_on(command.instrument, command.note, command.velocity);
        break;
      case 'preview-note-off':
        this.player?.preview_note_off();
        break;
      case 'set-continue-phase':
        this.continuePhase = command.enabled;
        this.player?.set_continue_phase_on_trigger(command.enabled);
        break;
      case 'replace-instrument':
        this.replaceInstrument(command.id, command.instrument, command.bytes);
        break;
      case 'replace-instruments':
        this.replaceInstruments(command.edits);
        break;
      case 'get-warm-hold':
        this.post({
          type: 'warm-hold',
          instrument: command.instrument,
          ticks: this.player?.preview_warm_hold_ticks(command.instrument) ?? 0,
        });
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
      if (this.preview) this.reportPListRow(player);
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
    instruments: AhxInstrumentBytes[],
  ): void {
    this.dropPlayer();
    try {
      const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      const player = new this.PlayerCtor(data, this.sampleRate, stereoMode);
      // The edits first: hi-fi below then prewarms the song as it is edited,
      // and the preview mode never sees the unedited instruments.
      const rejected: number[] = [];
      for (const edit of instruments) {
        try {
          player.replace_instrument(edit.instrument, toBytes(edit.bytes));
        } catch {
          rejected.push(edit.instrument);
        }
      }
      player.set_gain(this.gain);
      player.enable_capture(this.capture);
      player.set_mute_solo(this.mute, this.solo);
      // Before hi-fi, which prewarms for a song that a preview never plays.
      if (this.preview) player.enable_preview();
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
          ...(rejected.length > 0 ? { rejectedInstruments: rejected } : {}),
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

  /** `replace-instrument`: an edit of the loaded song, answered either way. */
  private replaceInstrument(
    id: number,
    instrument: number,
    bytes: ArrayBuffer | Uint8Array,
  ): void {
    if (!this.player) {
      this.post({ type: 'instrument-replaced', id, instrument, ok: false, message: 'no song is loaded' });
      return;
    }
    try {
      this.player.replace_instrument(instrument, toBytes(bytes));
      this.post({ type: 'instrument-replaced', id, instrument, ok: true });
    } catch (error) {
      // The engine's `Result<_, String>` arrives as the thrown string; the
      // song is as it was.
      this.post({ type: 'instrument-replaced', id, instrument, ok: false, message: String(error) });
    }
  }

  /** `replace-instruments`: each edit swapped, one hi-fi walk for all, each answered. */
  private replaceInstruments(
    edits: Array<{ id: number; instrument: number; bytes: ArrayBuffer | Uint8Array }>,
  ): void {
    const player = this.player;
    if (!player) {
      for (const { id, instrument } of edits) {
        this.post({ type: 'instrument-replaced', id, instrument, ok: false, message: 'no song is loaded' });
      }
      return;
    }
    const answers: AhxEvent[] = [];
    for (const { id, instrument, bytes } of edits) {
      try {
        player.replace_instrument_deferred(instrument, toBytes(bytes));
        answers.push({ type: 'instrument-replaced', id, instrument, ok: true });
      } catch (error) {
        answers.push({ type: 'instrument-replaced', id, instrument, ok: false, message: String(error) });
      }
    }
    // The walk, once. Answered after it, like a single replace: an `ok` means
    // the tables are built.
    try {
      player.finish_instrument_edits();
    } catch (error) {
      for (const answer of answers) {
        if (answer.type === 'instrument-replaced' && answer.ok) {
          answer.ok = false;
          answer.message = String(error);
        }
      }
    }
    for (const answer of answers) this.post(answer);
  }

  /**
   * The player moves; the reports are re-armed (a seek back to a row already
   * reported must not be swallowed as "no change", and a song-end reported
   * before it is not the end of where it is now) and where it landed is sent
   * at once, since a paused song reports nothing on its own.
   */
  private seek(position: number, row: number): void {
    const player = this.player;
    if (!player) return;
    const kind = player.seek(position, row);
    if (kind === 0) return;
    this.resetReporting();
    this.lastPosition = player.position();
    this.lastRow = player.row();
    this.post({
      type: 'position',
      position: this.lastPosition,
      row: this.lastRow,
      tempo: player.tempo(),
      ticks: player.ticks(),
      seekKind: kind === 1 ? 1 : 2,
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

  /**
   * The previewed note's PList row, posted when it changes. Two scalar reads a
   * quantum and no allocation; a song player never gets here (`preview` is off
   * for it), so it posts none and pays nothing.
   */
  private reportPListRow(player: AhxWasmPlayer): void {
    const row = player.preview_plist_row();
    const instrument = player.preview_plist_instrument();
    if (row === this.lastPlistRow && instrument === this.lastPlistInstrument) return;
    this.lastPlistRow = row;
    this.lastPlistInstrument = instrument;
    this.post({ type: 'plist-row', instrument, row });
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
    this.lastPlistInstrument = 0;
    this.lastPlistRow = -1;
  }

  private dropPlayer(): void {
    this.playing = false;
    // A row already reported belongs to the player that is going: say it is
    // over, or the editor's playhead would sit on it until the next note.
    if (this.lastPlistRow !== -1 || this.lastPlistInstrument !== 0) {
      this.lastPlistRow = -1;
      this.lastPlistInstrument = 0;
      this.post({ type: 'plist-row', instrument: 0, row: -1 });
    }
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
