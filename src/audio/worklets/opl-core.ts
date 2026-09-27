/**
 * The render-thread logic of the OPL worklet (.ai/plan-opl.md O2), kept
 * apart from the `AudioWorkletProcessor` shell (`opl-worklet.ts`) so it can
 * be unit-tested against the real wasm in node, as `sid-core.ts` is.
 *
 * Unlike the SID and AHX worklets this plays no song. The Rust
 * `OplRenderer` (`rust-wasm/src/opl/wasm.rs`) is a register-stream chip:
 * whoever plays the music sends register writes stamped with AudioContext
 * times, the way notes are scheduled, and this core turns each stamp into a
 * frame on the renderer's own clock and queues it there. The renderer
 * applies it on the native chip sample it belongs to.
 *
 * Output 0 is stereo: an OPL3 pans per channel, and OPL2 music comes out
 * centred on both sides.
 *
 * Song mode (O7): `load-a2m` hands the worklet an Adlib Tracker II module,
 * which the Rust `A2Player` (`rust-wasm/src/opl/a2/player.rs`) plays with
 * its own chip, as the SID and AHX worklets play theirs. While a song is
 * loaded, register writes are ignored; `unload-song` returns to the
 * register stream. The song commands and events mirror `sid-core.ts`.
 */

/** The slice of the wasm `OplRenderer` class this core uses. */
export interface OplWasmRenderer {
  write(reg: number, val: number): void;
  /** Queue a write for output frame `frame` of the renderer's own clock. */
  write_at(frame: number, reg: number, val: number): void;
  render(left: Float32Array, right: Float32Array): number;
  frames_rendered(): number;
  late_writes(): number;
  queued_writes(): number;
  set_gain(gain: number): void;
  set_channel_mask(mask: number): void;
  /** Record per-channel scope taps during `render` (off by default). */
  set_taps_enabled(enabled: boolean): void;
  /** Channel `ch`'s tap from the last `render` (±1: one operator's full swing). */
  read_tap(ch: number, out: Float32Array): void;
  /** Drop queued writes and key everything off at the fastest release. */
  panic(): void;
  free(): void;
}

export type OplWasmRendererCtor = new (sampleRate: number) => OplWasmRenderer;

/** The slice of the wasm `A2Player` class (an Adlib Tracker II song) this core uses. */
export interface A2WasmPlayer {
  play(): void;
  pause(): void;
  is_playing(): boolean;
  set_gain(gain: number): void;
  render(left: Float32Array, right: Float32Array): number;
  /** Start of `row` in order position `order`; false when it had to jump there. */
  seek(order: number, row: number): boolean;
  /** Keep playing one order position (`-1`: play the song on). */
  set_loop_order(order: number): void;
  song_end_reached(): boolean;
  /** Bit masks over tracks. */
  set_mute_solo(mute: number, solo: number): void;
  set_taps_enabled(enabled: boolean): void;
  read_tap(ch: number, out: Float32Array): void;
  track_channel(track: number): number;
  track_count(): number;
  order_count(): number;
  order_entry(index: number): number;
  rows_per_pattern(): number;
  order(): number;
  pattern(): number;
  row(): number;
  refresh(): number;
  song_name(): string;
  composer(): string;
  version(): number;
  instrument_count(): number;
  instrument_name(index: number): string;
  /** Pattern `pattern`'s cells, 6 bytes each, row-major over rows and tracks (`A2mPatternCells`). */
  pattern_cells(pattern: number): Uint8Array;
  free(): void;
}

/** Throws the refusal (a string) for a module it will not play. */
export type A2WasmPlayerCtor = new (bytes: Uint8Array, sampleRate: number) => A2WasmPlayer;

export interface A2mSongInfo {
  name: string;
  composer: string;
  /** File format version (1..14). */
  version: number;
  /** Tracks the song plays. */
  tracks: number;
  /** OPL channel (0..17, the tap output `1 + ch`) of each track. */
  trackChannels: number[];
  /** Raw order entries up to the first jump marker (pattern numbers). */
  orders: number[];
  rowsPerPattern: number;
  instrumentNames: string[];
  /** Timer rate at the start (Hz). */
  refresh: number;
  sampleRate: number;
  /**
   * The cells of every pattern `orders` names, once each, as the engine
   * plays them (old effect numbers mapped to the v9+ set): the grid's
   * display. Tracks and rows as `tracks` and `rowsPerPattern`.
   */
  patterns: A2mPatternCells[];
}

/**
 * One pattern's cells: `cells[(row * tracks + track) * 6 + k]` for k = note
 * (0 none, 1..96 C-0.., 255 key off), instrument (1-based, 0 none), effect,
 * param, effect 2, param 2.
 */
export interface A2mPatternCells {
  pattern: number;
  cells: Uint8Array;
}

/** Main thread -> worklet. */
export type OplCommand =
  /**
   * Register writes as (time, reg, val) triples: `time` in seconds on the
   * AudioContext clock, `reg` 0x000..0x1FF, `val` a byte. A time already
   * past applies at once and counts as late.
   */
  | { type: 'writes'; writes: Float64Array | number[] }
  | { type: 'set-gain'; gain: number }
  /** Bit per channel (0..17): 1 plays, 0 mutes. The chip keeps running. */
  | { type: 'set-channel-mask'; mask: number }
  /** Per-channel scope outputs (`OPL_TAP_OUTPUTS`) on or off; off is flat. */
  | { type: 'set-taps'; enabled: boolean }
  /** Stop: drop queued writes, key everything off (transport stop, seek). */
  | { type: 'panic' }
  /** Song mode: play this `.a2m`; answered with `song-loaded` or `error` carrying `id`. */
  | { type: 'load-a2m'; id: number; bytes: ArrayBuffer | Uint8Array }
  /** Leave song mode (back to the register stream). */
  | { type: 'unload-song' }
  | { type: 'play' }
  | { type: 'pause' }
  /** Start of `row` in order position `order`; answered with a `position`. */
  | { type: 'seek'; order: number; row: number }
  /** Keep playing order position `order` (the tracker's "play pattern"); -1 plays on. Outlives the song. */
  | { type: 'set-loop-order'; order: number }
  /** Bit masks over tracks. Outlives the song. */
  | { type: 'set-mute-solo'; mute: number; solo: number }
  /** Pause at the song's end instead of playing on. */
  | { type: 'set-stop-at-end'; enabled: boolean }
  /**
   * The Sound Blaster output low-pass (`SbOutputFilter`). `preset` sets
   * cutoff, order and on/off; `cutoffHz`, `order` and `enabled` then
   * override it. Fields left out keep their current value.
   */
  | {
      type: 'set-filter';
      enabled?: boolean;
      preset?: SbFilterPreset;
      cutoffHz?: number;
      order?: 1 | 2;
    }
  | { type: 'dispose' };

/** Worklet -> main thread. */
export type OplEvent =
  /** Writes applied after their time since the worklet started (a late batch). */
  | { type: 'late-writes'; total: number }
  | { type: 'song-loaded'; id: number; info: A2mSongInfo }
  /** Song mode: the row playing. `seek` marks a seek's answer. */
  | { type: 'position'; order: number; pattern: number; row: number; seek?: true }
  | { type: 'song-end' }
  /** `id` is set when the error answers a `load-a2m`. */
  | { type: 'error'; message: string; id?: number };

/**
 * Per-channel scope outputs after the stereo mix (output 0): output `1 + ch`
 * is OPL channel `ch`, mono, ±1 for one operator's full swing.
 */
export const OPL_TAP_OUTPUTS = 18;

/** The card whose OPL output stage the filter models. */
export type SbFilterPreset = 'sb1' | 'sb2' | 'sbpro1' | 'sbpro2' | 'sb16' | 'none';

/**
 * dosbox-staging's `configure_opl_filter_for_model()` (soundblaster.cpp):
 * a Butterworth low-pass on the OPL channel, tuned against real hardware
 * recordings. SB16-era cards have no analog OPL low-pass. See
 * .ai/notes-opl-sb-filter.md.
 */
export const SB_FILTER_PRESETS: Readonly<Record<SbFilterPreset, { enabled: boolean; cutoffHz: number; order: 1 | 2 }>> = {
  sb1: { enabled: true, cutoffHz: 12000, order: 1 },
  sb2: { enabled: true, cutoffHz: 12000, order: 1 },
  sbpro1: { enabled: true, cutoffHz: 8000, order: 1 },
  sbpro2: { enabled: true, cutoffHz: 8000, order: 1 },
  sb16: { enabled: false, cutoffHz: 8000, order: 1 },
  none: { enabled: false, cutoffHz: 8000, order: 1 },
};

/** The worklet's default: Scream Tracker 3's AdLib channels played on an SB Pro 2. */
export const SB_FILTER_DEFAULT_PRESET: SbFilterPreset = 'sbpro2';

/** One channel's filter memory: `z1`, `z2` (transposed direct form II) and the last output. */
interface SbFilterState {
  z1: number;
  z2: number;
  last: number;
}

/**
 * The analog low-pass after a Sound Blaster's OPL output: Butterworth,
 * 1st or 2nd order, bilinear-transformed as dosbox-staging's
 * `Iir::Butterworth` is, -3 dB at the cutoff, with its own state per stereo side so it
 * runs on across quanta. A reconfiguration seeds the state as if the last
 * output had been held forever, so switching cutoff, order or bypass does
 * not click.
 */
export class SbOutputFilter {
  private enabledFlag: boolean;
  private cutoff: number;
  private orderValue: 1 | 2;
  // Transposed direct form II; the 1st order has b2 = a2 = 0.
  private b0 = 0;
  private b1 = 0;
  private b2 = 0;
  private a1 = 0;
  private a2 = 0;
  private readonly states: [SbFilterState, SbFilterState] = [
    { z1: 0, z2: 0, last: 0 },
    { z1: 0, z2: 0, last: 0 },
  ];

  constructor(
    private readonly sampleRate: number,
    preset: SbFilterPreset = SB_FILTER_DEFAULT_PRESET,
  ) {
    const p = SB_FILTER_PRESETS[preset];
    this.enabledFlag = p.enabled;
    this.cutoff = p.cutoffHz;
    this.orderValue = p.order;
    this.update();
  }

  get enabled(): boolean {
    return this.enabledFlag;
  }

  get cutoffHz(): number {
    return this.cutoff;
  }

  get order(): 1 | 2 {
    return this.orderValue;
  }

  configure(options: { enabled?: boolean; preset?: SbFilterPreset; cutoffHz?: number; order?: 1 | 2 }): void {
    const p = options.preset !== undefined ? SB_FILTER_PRESETS[options.preset] : undefined;
    if (p) {
      this.enabledFlag = p.enabled;
      this.cutoff = p.cutoffHz;
      this.orderValue = p.order;
    }
    if (options.cutoffHz !== undefined && Number.isFinite(options.cutoffHz) && options.cutoffHz > 0) {
      this.cutoff = options.cutoffHz;
    }
    if (options.order === 1 || options.order === 2) this.orderValue = options.order;
    if (options.enabled !== undefined) this.enabledFlag = options.enabled;
    this.update();
  }

  /** Filters `left` (and `right`, when given) in place. */
  process(left: Float32Array, right?: Float32Array): void {
    this.run(left, this.states[0]);
    if (right) this.run(right, this.states[1]);
  }

  private run(x: Float32Array, s: SbFilterState): void {
    const n = x.length;
    if (n === 0) return;
    if (!this.enabledFlag) {
      s.last = x[n - 1] ?? 0;
      return;
    }
    const { b0, b1, b2, a1, a2 } = this;
    let { z1, z2 } = s;
    let y = 0;
    for (let i = 0; i < n; i++) {
      const v = x[i] ?? 0;
      y = b0 * v + z1;
      z1 = b1 * v - a1 * y + z2;
      z2 = b2 * v - a2 * y;
      x[i] = y;
    }
    s.z1 = z1;
    s.z2 = z2;
    s.last = y;
  }

  private update(): void {
    // Below Nyquist, as dosbox-staging's `clamp_filter_cutoff_freq` keeps it.
    const fc = Math.min(Math.max(this.cutoff, 1), this.sampleRate * 0.45);
    const k = Math.tan((Math.PI * fc) / this.sampleRate);
    if (this.orderValue === 1) {
      // a0 = K / (K + 1) on x and its last value: the zero at Nyquist puts
      // -3 dB at fc, as `Iir::Butterworth::LowPass<1>` does.
      this.b0 = k / (k + 1);
      this.b1 = this.b0;
      this.b2 = 0;
      this.a1 = (k - 1) / (k + 1);
      this.a2 = 0;
    } else {
      const norm = 1 / (1 + Math.SQRT2 * k + k * k);
      this.b0 = k * k * norm;
      this.b1 = 2 * this.b0;
      this.b2 = this.b0;
      this.a1 = 2 * (k * k - 1) * norm;
      this.a2 = (1 - Math.SQRT2 * k + k * k) * norm;
    }
    // Steady state at the last output (unity DC gain): no step on the switch.
    for (const s of this.states) {
      const v = s.last;
      s.z2 = (this.b2 - this.a2) * v;
      s.z1 = (this.b1 - this.a1) * v + s.z2;
    }
  }
}

/** How often a changed late-write count is reported, at most. */
const LATE_REPORT_SECONDS = 0.5;
/** How often song `position` events go out while playing (about 25 per second). */
const POSITION_INTERVAL_SECONDS = 0.04;

export class OplProcessorCore {
  private renderer: OplWasmRenderer | null;
  /** Context frame minus renderer frame; constant while every quantum renders. */
  private frameOffset: number;
  private lateReported = 0;
  private framesSinceReport = 0;
  private disposedFlag = false;
  private tapsEnabled = false;
  private song: A2WasmPlayer | null = null;
  private gain = 1;
  private loopOrder = -1;
  private mute = 0;
  private solo = 0;
  private stopAtEnd = false;
  private lastLoadId = -1;
  private framesSincePosition = 0;
  private lastPosition = '';
  private songEndReported = false;
  /** The output stage on the stereo mix (never the taps); SB Pro 2 by default. */
  private readonly filter: SbOutputFilter;

  /**
   * `contextFrame` is the AudioContext frame at construction (the worklet's
   * `currentFrame`), so writes that arrive before the first quantum map too.
   */
  constructor(
    RendererCtor: OplWasmRendererCtor,
    private readonly sampleRate: number,
    contextFrame: number,
    private readonly post: (event: OplEvent) => void,
    private readonly SongCtor?: A2WasmPlayerCtor,
  ) {
    this.renderer = new RendererCtor(sampleRate);
    this.frameOffset = contextFrame;
    this.filter = new SbOutputFilter(sampleRate);
  }

  get disposed(): boolean {
    return this.disposedFlag;
  }

  handle(command: OplCommand): void {
    if (this.disposedFlag) return;
    const renderer = this.renderer;
    switch (command.type) {
      case 'writes': {
        if (!renderer || this.song) return;
        const w = command.writes;
        for (let i = 0; i + 2 < w.length; i += 3) {
          const frame = (w[i] as number) * this.sampleRate - this.frameOffset;
          renderer.write_at(frame, (w[i + 1] as number) & 0x1ff, (w[i + 2] as number) & 0xff);
        }
        break;
      }
      case 'set-gain':
        this.gain = command.gain;
        renderer?.set_gain(command.gain);
        this.song?.set_gain(command.gain);
        break;
      case 'set-channel-mask':
        renderer?.set_channel_mask(command.mask >>> 0);
        break;
      case 'set-taps':
        this.tapsEnabled = command.enabled;
        renderer?.set_taps_enabled(command.enabled);
        this.song?.set_taps_enabled(command.enabled);
        break;
      case 'panic':
        renderer?.panic();
        this.song?.pause();
        break;
      case 'load-a2m':
        if (command.id <= this.lastLoadId) break;
        this.lastLoadId = command.id;
        this.loadSong(command.id, command.bytes);
        break;
      case 'unload-song':
        this.dropSong();
        break;
      case 'play':
        this.song?.play();
        break;
      case 'pause':
        this.song?.pause();
        break;
      case 'seek':
        this.seek(command.order, command.row);
        break;
      case 'set-loop-order':
        this.loopOrder = command.order;
        this.song?.set_loop_order(command.order);
        break;
      case 'set-mute-solo':
        this.mute = command.mute >>> 0;
        this.solo = command.solo >>> 0;
        this.song?.set_mute_solo(this.mute, this.solo);
        break;
      case 'set-stop-at-end':
        this.stopAtEnd = command.enabled;
        break;
      case 'set-filter':
        this.filter.configure(command);
        break;
      case 'dispose':
        this.disposedFlag = true;
        this.drop();
        this.dropSong();
        break;
    }
  }

  private loadSong(id: number, bytes: ArrayBuffer | Uint8Array): void {
    this.dropSong();
    if (!this.SongCtor) {
      this.post({ type: 'error', id, message: 'This OPL worklet cannot play songs' });
      return;
    }
    try {
      const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      const song = new this.SongCtor(data, this.sampleRate);
      song.set_gain(this.gain);
      song.set_mute_solo(this.mute, this.solo);
      song.set_loop_order(this.loopOrder);
      song.set_taps_enabled(this.tapsEnabled);
      this.song = song;
      this.resetReporting();
      const tracks = song.track_count();
      const orders: number[] = [];
      for (let i = 0; i < song.order_count(); i++) orders.push(song.order_entry(i));
      const instrumentNames: string[] = [];
      for (let i = 0; i < song.instrument_count(); i++) instrumentNames.push(song.instrument_name(i));
      const patterns: A2mPatternCells[] = [...new Set(orders)].map((pattern) => ({
        pattern,
        cells: song.pattern_cells(pattern),
      }));
      this.post({
        type: 'song-loaded',
        id,
        info: {
          name: song.song_name(),
          composer: song.composer(),
          version: song.version(),
          tracks,
          trackChannels: Array.from({ length: tracks }, (_, t) => song.track_channel(t)),
          orders,
          rowsPerPattern: song.rows_per_pattern(),
          instrumentNames,
          refresh: song.refresh(),
          sampleRate: this.sampleRate,
          patterns,
        },
      });
    } catch (error) {
      // The constructor's `Result<_, String>` arrives as the thrown string:
      // the refusal, one sentence.
      this.post({ type: 'error', id, message: String(error) });
    }
  }

  private seek(order: number, row: number): void {
    const song = this.song;
    if (!song) return;
    song.seek(Math.max(0, Math.floor(order)), Math.max(0, Math.floor(row)));
    this.resetReporting();
    this.lastPosition = `${song.order()}:${song.row()}`;
    this.post({ type: 'position', order: song.order(), pattern: song.pattern(), row: song.row(), seek: true });
  }

  /** Returns true when this quantum ended the song and it was paused. */
  private reportSong(song: A2WasmPlayer, frames: number): boolean {
    if (song.song_end_reached() && !this.songEndReported) {
      this.songEndReported = true;
      this.post({ type: 'song-end' });
      if (this.stopAtEnd) {
        song.pause();
        return true;
      }
    }
    this.framesSincePosition += frames;
    if (this.framesSincePosition < this.sampleRate * POSITION_INTERVAL_SECONDS) return false;
    this.framesSincePosition = 0;
    const key = `${song.order()}:${song.row()}`;
    if (key === this.lastPosition) return false;
    this.lastPosition = key;
    this.post({ type: 'position', order: song.order(), pattern: song.pattern(), row: song.row() });
    return false;
  }

  private resetReporting(): void {
    this.framesSincePosition = 0;
    this.lastPosition = '';
    this.songEndReported = false;
  }

  private dropSong(): void {
    if (!this.song) return;
    try {
      this.song.free();
    } catch {
      // already dead
    }
    this.song = null;
  }

  /**
   * Fills one render quantum starting at AudioContext frame `contextFrame`
   * (the worklet's `currentFrame`). `right` may be absent on a mono output.
   * `taps[ch]`, when given, receives channel `ch`'s scope tap (flat while
   * taps are off).
   */
  process(
    left: Float32Array,
    right: Float32Array | undefined,
    contextFrame: number,
    taps?: ReadonlyArray<Float32Array | undefined>,
  ): void {
    const song = this.song;
    if (song) {
      try {
        const r = right && right.length === left.length ? right : new Float32Array(left.length);
        song.render(left, r);
        if (taps && this.tapsEnabled) {
          for (let ch = 0; ch < taps.length; ch++) {
            const out = taps[ch];
            if (out) song.read_tap(ch, out);
          }
        }
        if (song.is_playing() && this.reportSong(song, left.length)) {
          const n = Math.min(32, left.length);
          for (let i = 0; i < n; i++) {
            const k = left.length - n + i;
            const g = 1 - (i + 1) / n;
            left[k] = (left[k] ?? 0) * g;
            if (right) right[k] = (right[k] ?? 0) * g;
          }
        }
        // After the end fade, so the filter carries on from the faded tail.
        this.filter.process(left, right);
      } catch (error) {
        this.dropSong();
        left.fill(0);
        right?.fill(0);
        this.post({ type: 'error', message: `A2M render failed: ${String(error)}` });
      }
      return;
    }
    const renderer = this.renderer;
    if (!renderer) {
      left.fill(0);
      right?.fill(0);
      return;
    }
    try {
      this.frameOffset = contextFrame - renderer.frames_rendered();
      if (right && right.length === left.length) {
        renderer.render(left, right);
      } else {
        const scratch = new Float32Array(left.length);
        renderer.render(left, scratch);
      }
      this.filter.process(left, right);
      // Outputs are zeroed by the browser each quantum: off, nothing to do.
      if (taps && this.tapsEnabled) {
        for (let ch = 0; ch < taps.length; ch++) {
          const out = taps[ch];
          if (out) renderer.read_tap(ch, out);
        }
      }
      this.reportLate(renderer, left.length);
    } catch (error) {
      // A wasm trap leaves the instance unusable: go silent, say so.
      this.drop();
      left.fill(0);
      right?.fill(0);
      this.post({ type: 'error', message: `OPL render failed: ${String(error)}` });
    }
  }

  private reportLate(renderer: OplWasmRenderer, frames: number): void {
    this.framesSinceReport += frames;
    if (this.framesSinceReport < this.sampleRate * LATE_REPORT_SECONDS) return;
    this.framesSinceReport = 0;
    const total = renderer.late_writes();
    if (total === this.lateReported) return;
    this.lateReported = total;
    this.post({ type: 'late-writes', total });
  }

  private drop(): void {
    if (!this.renderer) return;
    try {
      this.renderer.free();
    } catch {
      // already dead
    }
    this.renderer = null;
  }
}
