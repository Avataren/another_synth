/**
 * Pure render helpers for the AHX editor's "see the sound" drawings (editor
 * plan E5, E8, E9): waveform shapes, the vibrato curve, and the square and
 * filter sweep traces. Ports of the replayer, not approximations, so a drawing
 * cannot drift from what plays:
 *
 * - shapes: `gen_triangle` / `gen_sawtooth` / `gen_square` (`waveform.rs`) and the
 *   `calc_square` row pick (`voice.rs:675-693`);
 * - vibrato: `VIB_TAB` and the vibrato block (`voice.rs:34-39,528-536`);
 * - sweeps: `FilterSweep::trigger/toggle/step` (`filter_sweep.rs:64-138`) and
 *   `SquareSweep::trigger/toggle/step` (`voice.rs:105-171`).
 *
 * `src/tests/fixtures/ahx-visuals-parity.json` is dumped from the real Rust
 * (`ahx-visuals-parity.gen.sh.txt` is the dumper). The filtered waveform
 * variants are NOT reproduced (they need the 2790-entry filter table): callers
 * label a shape "before filtering" instead.
 */
import type { AhxInstrument, AhxSongFormat } from '@another-synth/tracker-playback';
import type { AhxWaveformKind } from 'src/audio/tracker/ahx-instrument-display';

// ---------------------------------------------------------------------------
// Waveform shapes (E5)
// ---------------------------------------------------------------------------

/** Waveform field values of a PList row (`vc_Waveform` is this minus 1). */
export const AHX_WAVE_TRIANGLE = 1;
export const AHX_WAVE_SAWTOOTH = 2;
export const AHX_WAVE_SQUARE = 3;
export const AHX_WAVE_NOISE = 4;

/** `(x << 24) >> 24`: Rust's `as i8`. */
const wrapI8 = (x: number): number => (x << 24) >> 24;

const clampWaveLength = (waveLength: number): number => Math.max(0, Math.min(5, waveLength));

/** `hvl_GenSawtooth`: a ramp from -128 with the truncated step `256 / (len - 1)`. */
function genSawtooth(len: number): number[] {
  const add = Math.trunc(256 / (len - 1));
  let value = -128;
  const out: number[] = [];
  for (let i = 0; i < len; i++) {
    out.push(wrapI8(value));
    value += add;
  }
  return out;
}

/** `hvl_GenTriangle`: rise to 0x7f, fall to the first half's mirror image. */
function genTriangle(len: number): number[] {
  const d5 = len >> 2;
  const d1 = Math.trunc(128 / d5);
  const out: number[] = [];
  let value = 0;
  for (let i = 0; i < d5; i++) {
    out.push(wrapI8(value));
    value += d1;
  }
  out.push(0x7f);
  if (d5 !== 1) {
    value = 128;
    for (let i = 0; i < d5 - 1; i++) {
      value -= d1;
      out.push(wrapI8(value));
    }
  }
  const half = d5 * 2;
  for (let i = 0; i < half; i++) {
    const c0 = out[i]!;
    out.push(c0 === 0x7f ? -128 : (0 - c0) | 0);
  }
  return out;
}

/**
 * Which of the 32 square rows a square position picks (`calc_square`,
 * `voice.rs:675-693`): the position is scaled by the wave length, mirrored
 * above 0x20 (a square's duty peaks at 50%), and row `x - 1` is read (0 reads row 0).
 */
export function ahxSquareRow(pos: number, waveLength: number): number {
  const shift = Math.max(5 - clampWaveLength(waveLength), 0);
  let x = pos << shift;
  if (x > 0x20) x = 0x40 - x;
  return x > 0 ? x - 1 : 0;
}

/** The fraction of a square cycle that is high at position `pos`: row `r` has `r + 1` of 64 (`gen_square`). Never above 1/2. */
export function ahxSquareDuty(pos: number, waveLength: number): number {
  return (ahxSquareRow(pos, waveLength) + 1) / 64;
}

/**
 * The `4 << waveLength` samples (signed bytes) one cycle of `kind` is made of,
 * before any filtering. A square needs its position (its pulse width). Noise
 * has no shape: the engine draws a new burst every tick, so it is `null`.
 */
export function ahxWaveShape(
  kind: AhxWaveformKind,
  waveLength: number,
  squarePos = 0,
): number[] | null {
  const wl = clampWaveLength(waveLength);
  const len = 4 << wl;
  switch (kind) {
    case 'triangle':
      return genTriangle(len);
    case 'sawtooth':
      return genSawtooth(len);
    case 'square': {
      const row = ahxSquareRow(squarePos, wl);
      const delta = 32 >> wl;
      const lows = (63 - row) * 2;
      return Array.from({ length: len }, (_, i) => (i * delta < lows ? -128 : 127));
    }
    default:
      return null;
  }
}

/** A stepped outline (one flat step per sample) of `samples` in a `width` x `height` box, as an SVG path. */
export function ahxShapePath(samples: readonly number[], width: number, height: number): string {
  if (samples.length === 0) return '';
  const step = width / samples.length;
  const y = (v: number): string => (((127 - v) / 255) * height).toFixed(1);
  const parts: string[] = [];
  samples.forEach((v, i) => {
    const x0 = (i * step).toFixed(1);
    const x1 = ((i + 1) * step).toFixed(1);
    parts.push(i === 0 ? `M${x0} ${y(v)}` : `L${x0} ${y(v)}`, `L${x1} ${y(v)}`);
  });
  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// Vibrato (E9)
// ---------------------------------------------------------------------------

/** `vib_tab[64]` (`hvl_tables.c:11-17`, `waveform.rs`): `trunc(255 * sin(2 pi i / 64))`. */
export const AHX_VIB_TAB: readonly number[] = [
  0, 24, 49, 74, 97, 120, 141, 161, 180, 197, 212, 224, 235, 244, 250, 253,
  255, 253, 250, 244, 235, 224, 212, 197, 180, 161, 141, 120, 97, 74, 49, 24,
  0, -24, -49, -74, -97, -120, -141, -161, -180, -197, -212, -224, -235, -244, -250, -253,
  -255, -253, -250, -244, -235, -224, -212, -197, -180, -161, -141, -120, -97, -74, -49, -24,
];

/** The largest upward swing a vibrato depth gives, in period units: `255 * depth >> 7`. */
export const ahxVibratoAmplitude = (depth: number): number => (255 * depth) >> 7;

/**
 * The largest downward swing, as a positive number. The shift floors, so it is
 * often one more than the upward swing (`-255 * depth >> 7`): depth 1 swings
 * +1 up but -2 down.
 */
export const ahxVibratoTrough = (depth: number): number => -((-255 * depth) >> 7);

/**
 * How the vibrato's table index really moves: `(cur + speed) & 0x3f` (`voice.rs:532`),
 * so only `speed & 63` counts. Returns that step, the equivalent forward step (33-63
 * walk backwards, like 64 minus it) and whether every step lands on a zero of the
 * table (0 and 32 do, so nothing wobbles).
 */
export function ahxVibratoStep(speed: number): { step: number; forward: number; backwards: boolean; still: boolean } {
  const step = speed & 0x3f;
  return { step, forward: step > 32 ? 64 - step : step, backwards: step > 32, still: step === 0 || step === 32 };
}

/**
 * The pitch offset (period units) of each frame from the trigger: 0 while the
 * delay counts down, then `VIB_TAB[cur] * depth >> 7` with `cur` advancing by
 * `speed` (`voice.rs:528-536`). Depth 0 is off and stays 0.
 */
export function simulateAhxVibrato(
  delay: number,
  speed: number,
  depth: number,
  frames: number,
): number[] {
  const out: number[] = [];
  let wait = delay;
  let current = 0;
  for (let frame = 0; frame < frames; frame++) {
    if (depth === 0 || wait > 0) {
      out.push(0);
      if (depth !== 0) wait--;
    } else {
      out.push((AHX_VIB_TAB[current]! * depth) >> 7);
      current = (current + speed) & 0x3f;
    }
  }
  return out;
}

/** Frames worth drawing for a vibrato: its delay, then two full wobbles (64 table steps each), capped. */
export function ahxVibratoWindow(delay: number, speed: number): number {
  const { forward } = ahxVibratoStep(speed);
  const cycle = forward > 0 ? Math.ceil(64 / forward) : 32;
  return Math.min(400, Math.max(48, delay + cycle * 2 + 8));
}

// ---------------------------------------------------------------------------
// Sweeps (E8)
// ---------------------------------------------------------------------------

export type AhxSweepKind = 'filter' | 'square';

export interface AhxSweepBounds {
  lower: number;
  upper: number;
}

/**
 * The pulse widths a square sweep passes through: the smallest and largest duty
 * over every position between its bounds. Not just the duty at the two limits:
 * the duty mirrors past position 0x20, so a sweep that crosses it reaches 50%.
 */
export function ahxSquareDutyRange(ins: AhxInstrument): { min: number; max: number } {
  const { lower, upper } = ahxSquareBounds(ins);
  let min = Infinity;
  let max = -Infinity;
  for (let pos = lower; pos <= upper; pos++) {
    const duty = ahxSquareDuty(pos, ins.waveLength);
    if (duty < min) min = duty;
    if (duty > max) max = duty;
  }
  return { min, max };
}

/** The engine's own bounds for a filter sweep: the two limits, swapped if lower > upper (`filter_sweep.rs:77-79`). */
export function ahxFilterBounds(ins: AhxInstrument): AhxSweepBounds {
  const a = ins.filterLowerLimit & 0x7f;
  const b = ins.filterUpperLimit & 0x7f;
  return a > b ? { lower: b, upper: a } : { lower: a, upper: b };
}

/** The square sweep's bounds in the engine's position units: both limits shifted by `5 - waveLength`, swapped if needed (`voice.rs:137-148`). */
export function ahxSquareBounds(ins: AhxInstrument): AhxSweepBounds {
  const shift = Math.max(5 - clampWaveLength(ins.waveLength), 0);
  const a = ins.squareLowerLimit >> shift;
  const b = ins.squareUpperLimit >> shift;
  return a > b ? { lower: b, upper: a } : { lower: a, upper: b };
}

/** `bound_bounce_step` (`filter_sweep.rs:27-36`): hit a bound, flip the direction (the first arrival after `init` only slides in). */
function boundBounce(
  state: { sign: number; slidingIn: boolean },
  pos: number,
  lower: number,
  upper: number,
): number {
  if (lower === pos || upper === pos) {
    if (state.slidingIn) state.slidingIn = false;
    else state.sign = -state.sign;
  }
  return pos + state.sign;
}

/**
 * The filter position after each frame from the trigger (index 0 is the start,
 * 32 = neutral), with the sweep turned on at frame 0 heading `sign`
 * (`FilterSweep::trigger/toggle/step`, `filter_sweep.rs:64-138`).
 */
export function simulateFilterSweep(ins: AhxInstrument, frames: number, sign: 1 | -1 = 1): number[] {
  const { lower, upper } = ahxFilterBounds(ins);
  const speed = ins.filterSpeed;
  const state = { sign, slidingIn: false };
  let init = true;
  let wait = 0;
  let pos = 32;
  const out = [pos];
  for (let frame = 0; frame < frames; frame++) {
    wait -= 1;
    if (wait <= 0) {
      if (init) {
        init = false;
        if (pos <= lower) {
          state.slidingIn = true;
          state.sign = 1;
        } else if (pos >= upper) {
          state.slidingIn = true;
          state.sign = -1;
        }
      }
      const steps = speed < 4 ? 5 - speed : 1;
      for (let i = 0; i < steps; i++) pos = boundBounce(state, pos, lower, upper);
      pos = Math.max(1, Math.min(63, pos));
      wait = Math.max(speed - 3, 1);
    }
    out.push(pos);
  }
  return out;
}

/**
 * The square position after each frame from the trigger (index 0 is `startPos`),
 * with the sweep on at frame 0 (`SquareSweep::trigger/toggle/step`,
 * `voice.rs:128-176`). Positions are in the engine's units; `ahxSquareDuty`
 * turns one into a pulse width.
 */
export function simulateSquareSweep(
  ins: AhxInstrument,
  frames: number,
  startPos = 0,
  sign: 1 | -1 = 1,
): number[] {
  const { lower, upper } = ahxSquareBounds(ins);
  const speed = ins.squareSpeed;
  const state = { sign, slidingIn: false };
  let init = true;
  let wait = 0;
  let pos = startPos;
  const out = [pos];
  for (let frame = 0; frame < frames; frame++) {
    wait -= 1;
    if (wait <= 0) {
      if (init) {
        init = false;
        if (pos <= lower) {
          state.slidingIn = true;
          state.sign = 1;
        } else if (pos >= upper) {
          state.slidingIn = true;
          state.sign = -1;
        }
      }
      pos = boundBounce(state, pos, lower, upper);
      wait = speed;
    }
    out.push(pos);
  }
  return out;
}

/** Ticks between two steps of a sweep, and steps taken per step (filter walks several positions a tick at low speeds). */
export function ahxSweepRate(kind: AhxSweepKind, speed: number): { every: number; steps: number } {
  if (kind === 'square') return { every: Math.max(speed, 1), steps: 1 };
  return { every: Math.max(speed - 3, 1), steps: speed < 4 ? 5 - speed : 1 };
}

/** Frames worth drawing for a sweep: a couple of full there-and-back trips, kept between 60 and 300. */
export function ahxSweepWindow(kind: AhxSweepKind, bounds: AhxSweepBounds, speed: number): number {
  const range = Math.max(bounds.upper - bounds.lower, 1);
  const { every, steps } = ahxSweepRate(kind, speed);
  const trip = Math.ceil((2 * range * every) / steps);
  return Math.min(300, Math.max(60, trip * 2 + 10));
}

/** How a sweep is (or is not) turned on by the PList (`plist.rs:47-65`, `voice.rs:583`). */
export interface AhxSweepSetup {
  /** A PList command 4 that toggles this sweep exists. */
  toggled: boolean;
  /** The row of the first such toggle. */
  row: number | null;
  /** The direction it starts in: command 4's nibble 0xf heads down. */
  sign: 1 | -1;
  /** Square only: a row selects the square wave (the sweep only runs while it is the waveform). */
  hasSquareWave: boolean;
  /** Square only: the position PList command 3 sets, in engine units (else `null`). */
  startPos: number | null;
  /** Filter only: this file cannot toggle the filter (a version-0 AHX file drops the high nibble). */
  unavailable: boolean;
}

export interface AhxSweepContext {
  format: AhxSongFormat;
  version: number;
}

/**
 * Known limitation (review L7, follow-up): command 4 TOGGLES, but this reads the
 * first toggle row only. A second toggle, or a jump loop that runs back over the
 * toggle row, turns the sweep off again while the lane keeps drawing it "on"
 * (its caption says the lane does not follow that); and
 * the trace starts at tick 0 even when the toggle sits in a later row or the
 * square tone is only selected later. Tracking that needs a PList walk.
 */
export function ahxSweepSetup(
  ins: AhxInstrument,
  kind: AhxSweepKind,
  context: AhxSweepContext = { format: 'ahx', version: 1 },
): AhxSweepSetup {
  const filterDropped = context.format === 'ahx' && context.version === 0;
  const shift = Math.max(5 - clampWaveLength(ins.waveLength), 0);
  const setup: AhxSweepSetup = {
    toggled: false,
    row: null,
    sign: 1,
    hasSquareWave: ins.plist.entries.some((e) => e.waveform === AHX_WAVE_SQUARE),
    startPos: null,
    unavailable: kind === 'filter' && filterDropped,
  };
  ins.plist.entries.forEach((entry, row) => {
    entry.fx.forEach((fx, slot) => {
      const param = entry.fxParam[slot] ?? 0;
      if (fx === 3 && kind === 'square' && setup.startPos === null) setup.startPos = param >> shift;
      if (fx !== 4 || setup.toggled) return;
      if (kind === 'square') {
        if (param === 0 || (param & 0x0f) !== 0) {
          setup.toggled = true;
          setup.row = row;
          setup.sign = param !== 0 && (param & 0x0f) === 0x0f ? -1 : 1;
        }
      } else if (!filterDropped && (param & 0xf0) !== 0) {
        setup.toggled = true;
        setup.row = row;
        setup.sign = (param & 0xf0) === 0xf0 ? -1 : 1;
      }
    });
  });
  return setup;
}

export type AhxSweepState = 'on' | 'no-toggle' | 'no-square-row' | 'unavailable';

/** Whether the sweep runs at all, and if not why: the lane's "sweep is off" state. */
export function ahxSweepState(setup: AhxSweepSetup, kind: AhxSweepKind): AhxSweepState {
  if (setup.unavailable) return 'unavailable';
  if (!setup.toggled) return 'no-toggle';
  if (kind === 'square' && !setup.hasSquareWave) return 'no-square-row';
  return 'on';
}

/** Whether "Turn on at row 0" can be done: row 0 has (or can be given) a free command slot. */
export function canEnableAhxSweep(
  ins: AhxInstrument,
  kind: AhxSweepKind,
  context: AhxSweepContext = { format: 'ahx', version: 1 },
): boolean {
  if (kind === 'filter' && context.format === 'ahx' && context.version === 0) return false;
  const entry = ins.plist.entries[0];
  if (!entry) return true;
  return entry.fx.some((fx, i) => fx === 0 && (entry.fxParam[i] ?? 0) === 0);
}

/** The sweep's toggle command and parameter: square is 4/0x00, filter 4/0x10 (both heading up). */
export const AHX_SWEEP_PARAM: Readonly<Record<AhxSweepKind, number>> = { square: 0x00, filter: 0x10 };

/**
 * Whether the tone is filtered while it plays: a PList row sets a filter position
 * other than "untouched" (1-63 but 32), or the filter sweep is switched on. The
 * shape drawings are labelled "before filtering" when this is true.
 */
export function ahxUsesFilter(
  ins: AhxInstrument,
  context: AhxSweepContext = { format: 'ahx', version: 1 },
): boolean {
  const positioned = ins.plist.entries.some((entry) =>
    entry.fx.some((fx, i) => {
      const param = entry.fxParam[i] ?? 0;
      return fx === 0 && param >= 1 && param <= 63 && param !== 32;
    }),
  );
  return positioned || ahxSweepSetup(ins, 'filter', context).toggled;
}
