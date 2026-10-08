import type { SidWasmPlayer } from '../../worklets/sid-core';
import type { PsidFile } from './psid-file';
import { PsidRunner } from './psid-runner';

/**
 * A `.sid` played as the C64 would play it, behind the interface the SID
 * worklet already drives (`SidWasmPlayer`, .ai/plan-psid-playback.md): the
 * tune's code runs on the emulated C64 (`PsidRunner`), and the writes it makes
 * go to a bare chip (`SidChipPlayer`, rust-wasm/src/sid/stream.rs) at the
 * cycles they were made on. Gain, mute/solo, the 6581 revision and the three
 * voice taps are the chip's, so the tracker's scopes and spectrum work on it as
 * on any SID song.
 *
 * The song has no rows. `song_row()` is the whole seconds played, which the
 * worklet reports (about 25 times a second, when it changes) as its position;
 * `song_rows()` is 0: the tune has no length (nearly all loop for ever).
 */

/** The slice of the wasm `SidChipPlayer` class this uses. */
export interface SidChipWasm {
  write_after(delay: number, reg: number, value: number): void;
  set_gain(gain: number): void;
  set_mute_solo(mute: number, solo: number): void;
  set_revision(name: string): boolean;
  set_chip_model(model8580: boolean): void;
  render(out: Float32Array, v0: Float32Array, v1: Float32Array, v2: Float32Array): number;
  chip_model(): string;
  tap_full_scale(): number;
  free(): void;
}

export type SidChipWasmCtor = new (model8580: boolean, sampleRate: number, clockHz: number) => SidChipWasm;

export type PsidPlaybackCreate =
  | { readonly ok: true; readonly player: PsidPlayback }
  | { readonly ok: false; readonly reason: string };

export class PsidPlayback implements SidWasmPlayer {
  private playing = false;
  /** Chip cycles rendered so far (the runner's clock, from the start of playback). */
  private cycle = 0;
  private frac = 0;
  private frames = 0;
  private readonly cyclesPerSample: number;

  private constructor(
    private readonly runner: PsidRunner,
    private readonly chip: SidChipWasm,
    private readonly sampleRate: number,
  ) {
    this.cyclesPerSample = runner.clockHz / sampleRate;
  }

  /** Subsong `subsong` (0-based) of `file` on `model` (or the file's chip), paused. */
  static create(
    file: PsidFile,
    subsong: number,
    Chip: SidChipWasmCtor,
    sampleRate: number,
    /** The chip to play on; the file's own when absent. */
    model?: '6581' | '8580',
  ): PsidPlaybackCreate {
    const made = PsidRunner.create(file, subsong);
    if (!made.ok) return made;
    let chip: SidChipWasm;
    try {
      // A file that does not say is played on a 6581, as the players of HVSC do.
      chip = new Chip((model ?? file.sidModel) === '8580', sampleRate, made.runner.clockHz);
    } catch (error) {
      return { ok: false, reason: String(error) };
    }
    return { ok: true, player: new PsidPlayback(made.runner, chip, sampleRate) };
  }

  /** Why the tune stopped (its code jammed the CPU or ran away), or null. */
  get ended(): string | null {
    return this.runner.ended;
  }

  play(): void {
    this.playing = true;
  }

  pause(): void {
    this.playing = false;
  }

  is_playing(): boolean {
    return this.playing;
  }

  set_gain(gain: number): void {
    this.chip.set_gain(gain);
  }

  set_mute_solo(mute: number, solo: number): void {
    this.chip.set_mute_solo(mute, solo);
  }

  set_revision(name: string): boolean {
    return this.chip.set_revision(name);
  }

  set_chip_model(model8580: boolean): void {
    this.chip.set_chip_model(model8580);
  }

  render(out: Float32Array, v0: Float32Array, v1: Float32Array, v2: Float32Array): number {
    const n = Math.min(out.length, v0.length, v1.length, v2.length);
    if (!this.playing) {
      out.fill(0, 0, n);
      v0.fill(0, 0, n);
      v1.fill(0, 0, n);
      v2.fill(0, 0, n);
      return n;
    }
    // The chip clocks each sample by the same fractional count of cycles; do
    // the sum the same way so the two never drift apart.
    let total = 0;
    for (let i = 0; i < n; i++) {
      this.frac += this.cyclesPerSample;
      const whole = Math.floor(this.frac);
      this.frac -= whole;
      total += whole;
    }
    const start = this.cycle;
    const end = start + total;
    this.runner.advance(end);
    this.runner.drain(end, (cycle, reg, value) => this.chip.write_after(Math.max(0, cycle - start), reg, value));
    this.cycle = end;
    this.frames += n;
    return this.chip.render(out.subarray(0, n), v0.subarray(0, n), v1.subarray(0, n), v2.subarray(0, n));
  }

  /** Whole seconds played. */
  song_row(): number {
    return Math.floor(this.frames / this.sampleRate);
  }

  song_rows(): number {
    return 0;
  }

  /** True once the tune's code has stopped (it jammed the CPU or ran away): the worklet reports it as the song's end. */
  song_end_reached(): boolean {
    return this.runner.ended !== null;
  }

  tempo(): number {
    return 0;
  }

  channels(): number {
    return 3;
  }

  chip_model(): string {
    return this.chip.chip_model();
  }

  instrument_count(): number {
    return 0;
  }

  tap_full_scale(): number {
    return this.chip.tap_full_scale();
  }

  // A tune has no rows to move to, loop or preview: these are the song player's.
  seek_row(_row: number): void {}
  set_loop_rows(_start: number, _end: number): void {}
  clear_loop_rows(): void {}
  enable_preview(): void {}
  preview_note_on(_instrument: number, _note: number): boolean {
    return false;
  }
  preview_note_off(): void {}

  free(): void {
    this.chip.free();
  }
}
