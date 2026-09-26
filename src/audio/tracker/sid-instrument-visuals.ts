/**
 * Pure render helpers for the SID instrument page's "see the sound" drawings
 * (plan-sid-tracking.md S4), on the `ahx-instrument-visuals.ts` model: ports
 * of the Rust player and chip, not approximations, so a drawing cannot drift
 * from what plays:
 *
 * - waveforms: `waveform_output` and its neighbour-pull pass over combined
 *   waveforms, per model and combination (`rust-wasm/src/sid/waveform.rs`);
 * - the envelope: `Envelope::clock` (`envelope.rs`), event-stepped (the same
 *   state machine, advanced to its next rate tick rather than one cycle at a
 *   time);
 * - the filter maps: `cutoff_hz_for` / `resonance_q_for` (`filter.rs`);
 * - an instrument's first frames: `SidSongPlayer`'s trigger and per-frame
 *   steps for one voice (`player.rs`: vibrato, wave table, pulse table,
 *   filter table, register writes), what its preview voice plays.
 *
 * `src/tests/fixtures/sid-visuals-parity.json` is dumped from the real Rust
 * (`rust-wasm/tests/sid_visuals_parity.rs`), and the parity test holds every
 * port to it. The filter's response curve is the one drawing that is not a
 * port: it is the ideal 2-pole response at the mapped cutoff and Q (the
 * 6581's saturation and the sample-rate warping are not drawn), labelled so.
 */
import { sidTableFreqReg } from '@another-synth/tracker-playback';
import type { SidChipModel, SidDoc, SidTableRow } from 'src/audio/tracker/sid-doc';

// ---------------------------------------------------------------------------
// Waveforms
// ---------------------------------------------------------------------------

export const SID_WAVE_TRIANGLE = 0x10;
export const SID_WAVE_SAWTOOTH = 0x20;
export const SID_WAVE_PULSE = 0x40;
export const SID_WAVE_NOISE = 0x80;
export const SID_CONTROL_TEST = 0x08;
export const SID_CONTROL_RING = 0x04;
export const SID_CONTROL_SYNC = 0x02;

const MSB = 0x80_0000;

const sawtooth = (acc: number): number => (acc >>> 12) & 0xfff;
const triangleFolded = (acc: number, fold: boolean): number => (((fold ? acc ^ 0x7f_ffff : acc) >>> 11) & 0xffe);
const triangle = (acc: number): number => triangleFolded(acc, (acc & MSB) !== 0);
const triangleRing = (acc: number, source: number): number => triangleFolded(acc, ((acc & MSB) !== 0) !== !((source & MSB) !== 0));
const pulse = (acc: number, pw: number): number => (sawtooth(acc) >= (pw & 0xfff) ? 0xfff : 0);

/** Threshold of the S2 6581 neighbour pull (`PULL_THRESHOLD_6581`), for the unfitted 6581 combinations. */
const PULL_THRESHOLD_6581 = 1536;
/** `FITTED_COMBINATIONS`: the combinations with a measured level, in threshold order. */
const FITTED_COMBINATIONS: readonly number[] = [
  SID_WAVE_PULSE | SID_WAVE_SAWTOOTH,
  SID_WAVE_SAWTOOTH | SID_WAVE_TRIANGLE,
  SID_WAVE_PULSE | SID_WAVE_SAWTOOTH | SID_WAVE_TRIANGLE,
];
/** `PULL_THRESHOLDS_8580` / `PULL_THRESHOLDS_6581` (S5.12 R2; DERIVED, disclosure in waveform.rs). */
const PULL_THRESHOLDS: Record<SidChipModel, readonly number[]> = {
  '8580': [1314, 1792, 2031],
  '6581': [167, 1219, 761],
};

/** `neighbour_pull`: bit i of an ideal wired-AND value survives when its pull is below `threshold`. */
function neighbourPull(and: number, threshold: number): number {
  const zeroWeight = (i: number) => (((and >> i) & 1) === 0 ? 1024 : 0);
  const left = new Array<number>(12).fill(0);
  for (let i = 1; i < 12; i++) left[i] = (left[i - 1] as number) / 2 + zeroWeight(i - 1);
  let out = 0;
  let right = 0;
  for (let i = 11; i >= 0; i--) {
    if (((and >> i) & 1) !== 0 && (left[i] as number) + right < threshold) out |= 1 << i;
    right = right / 2 + zeroWeight(i);
  }
  return out;
}
const pullCache = new Map<number, number>();
const pulled = (and: number, threshold: number): number => {
  const key = threshold * 4096 + and;
  let v = pullCache.get(key);
  if (v === undefined) pullCache.set(key, (v = neighbourPull(and, threshold)));
  return v;
};

/**
 * `waveform_output`: the 12-bit DAC input of a voice with control byte
 * `control` at accumulator `acc` (source accumulator `source` for ring mod),
 * without noise (drawn as none); `null` when no waveform bit is set.
 */
export function sidWaveformOutput(model: SidChipModel, control: number, acc: number, pulseWidth: number, source = 0): number | null {
  const sel = control & 0xf0;
  if (sel === 0) return null;
  let out = 0xfff;
  if (sel & SID_WAVE_TRIANGLE) out &= control & SID_CONTROL_RING ? triangleRing(acc, source) : triangle(acc);
  if (sel & SID_WAVE_SAWTOOTH) out &= sawtooth(acc);
  if (sel & SID_WAVE_PULSE) out &= control & SID_CONTROL_TEST ? 0xfff : pulse(acc, pulseWidth);
  if (sel & SID_WAVE_NOISE) out &= 0;
  const bits = [0x10, 0x20, 0x40, 0x80].filter((b) => sel & b).length;
  if (bits < 2) return out;
  const c = FITTED_COMBINATIONS.indexOf(sel);
  if (c >= 0) return pulled(out, PULL_THRESHOLDS[model][c] as number);
  // Pulse+tri and noise combinations: the 8580's plain AND, the 6581's S2 pull.
  return model === '6581' ? pulled(out, PULL_THRESHOLD_6581) : out;
}

/**
 * One cycle of the waveform as `points` 12-bit values (accumulator
 * `i * 2^24 / points`), or `null` for noise (no cycle: the LFSR) and for no
 * waveform at all.
 */
export function sidWaveCycle(model: SidChipModel, control: number, pulseWidth: number, points = 64): number[] | null {
  if ((control & 0xf0) === 0 || control & SID_WAVE_NOISE) return null;
  return Array.from({ length: points }, (_, i) => sidWaveformOutput(model, control, Math.floor((i * 2 ** 24) / points), pulseWidth) ?? 0);
}

/** A stepped outline of 12-bit `values` in a `width` x `height` box, as an SVG path (0 at the bottom). */
export function sidStepPath(values: readonly number[], width: number, height: number, max = 0xfff): string {
  if (values.length === 0) return '';
  const dx = width / values.length;
  const y = (v: number) => (height - (Math.max(0, Math.min(max, v)) / max) * height).toFixed(2);
  let d = `M0,${y(values[0] as number)}`;
  values.forEach((v, i) => {
    d += ` L${(i * dx).toFixed(2)},${y(v)} L${((i + 1) * dx).toFixed(2)},${y(v)}`;
  });
  return d;
}

// ---------------------------------------------------------------------------
// The envelope
// ---------------------------------------------------------------------------

/** `RATE_PERIODS`: rate-counter periods in chip cycles, by nibble. */
export const SID_RATE_PERIODS: readonly number[] = [9, 32, 63, 95, 149, 220, 267, 313, 392, 977, 1954, 3126, 3907, 11720, 19532, 31251];
/** Datasheet attack times (ms) per nibble; decay and release are three times these. */
export const SID_ATTACK_MS: readonly number[] = [2, 8, 16, 24, 38, 56, 68, 80, 100, 250, 500, 800, 1000, 3000, 5000, 8000];
/** The PAL C64 clock (`PAL_CLOCK_HZ`), Hz. */
export const SID_PAL_CLOCK_HZ = 985_248;
/**
 * Chip cycles per player frame at 1x: one PAL vertical blank, 312 lines of
 * 63 (`PAL_FRAME_CYCLES`, GT-parity 0925b; was 50 Hz's 19 705). The parity
 * fixture's step.
 */
export const SID_CYCLES_PER_FRAME = 19_656;

/** Chip cycles per player frame at multispeed `mult`: `frame_cycles`, GT's CIA latch $4CC7 / m + 1 above 1x. */
export function sidFrameCycles(mult: number): number {
  return mult <= 1 ? SID_CYCLES_PER_FRAME : Math.floor(0x4cc7 / mult) + 1;
}

/** `frames` player frames at multispeed `mult`, in milliseconds (50.1245 frames a second at 1x). */
export function sidFramesMs(frames: number, mult = 1): number {
  return (frames * sidFrameCycles(mult) * 1000) / SID_PAL_CLOCK_HZ;
}

/** `exp_period`: the decay/release divider at a level. */
function expPeriod(level: number): number {
  if (level >= 94) return 1;
  if (level >= 55) return 2;
  if (level >= 27) return 4;
  if (level >= 15) return 8;
  if (level >= 7) return 16;
  if (level >= 1) return 30;
  return 1;
}

type Stage = 'attack' | 'decay' | 'release';

/**
 * The envelope level (0..255, ENV3's reading) after each of `frames` frames:
 * gate on from the start, off at frame `gateFrames`. `Envelope::clock`
 * stepped from rate tick to rate tick (the 15-bit counter's wrap included,
 * which is the "ADSR bug" a lowered rate hits).
 */
export function sidEnvelopeLevels(ad: number, sr: number, gateFrames: number, frames: number, cyclesPerFrame = SID_CYCLES_PER_FRAME): number[] {
  const attack = ad >> 4;
  const decay = ad & 0xf;
  const sustain = sr >> 4;
  const release = sr & 0xf;
  let stage: Stage = 'attack';
  let level = 0;
  let rate = 0;
  let exp = 0;
  const period = () => SID_RATE_PERIODS[stage === 'attack' ? attack : stage === 'decay' ? decay : release] as number;
  const tick = () => {
    if (stage === 'attack') {
      exp = 0;
      level = Math.min(255, level + 1);
      if (level === 255) stage = 'decay';
      return;
    }
    exp += 1;
    if (exp < expPeriod(level)) return;
    exp = 0;
    const hold = level === 0 || (stage === 'decay' && level === sustain * 17);
    if (!hold) level -= 1;
  };
  const clock = (cycles: number) => {
    let left = cycles;
    while (left > 0) {
      const p = period();
      const steps = rate < p ? p - rate : 0x8000 - rate + p;
      if (steps > left) {
        rate = (rate + left) & 0x7fff;
        return;
      }
      left -= steps;
      rate = 0;
      tick();
    }
  };
  const levels: number[] = [];
  for (let f = 0; f < frames; f++) {
    if (f === gateFrames) stage = 'release';
    clock(cyclesPerFrame);
    levels.push(level);
  }
  return levels;
}

// ---------------------------------------------------------------------------
// The filter
// ---------------------------------------------------------------------------

type Anchors = readonly (readonly [number, number])[];
/** `CUTOFF_ANCHORS_6581_LO` / `_HI` of the default 6581 profile, `GT_REF` (S5.16: fitted to GoatTracker's playback, `.ai/sid-6581-gt-fit-notes.md`; the high piece is R4AR's). */
const CUTOFF_ANCHORS_6581_LO: Anchors = [
  [0, 219], [0x080, 229], [0x100, 248], [0x140, 266], [0x180, 299], [0x1c0, 339], [0x200, 417],
  [0x240, 550], [0x280, 778], [0x2c0, 1_139], [0x300, 1_628], [0x340, 2_329], [0x380, 3_331], [0x3ff, 6_000],
];
const CUTOFF_ANCHORS_6581_HI: Anchors = [[0x400, 4_600], [0x500, 9_500], [0x600, 14_500], [0x7ff, 18_000]];

/** `log_interp`: log-linear interpolation through `anchors` (`reg` inside their span). */
function logInterp(anchors: Anchors, reg: number): number {
  for (let k = 1; k < anchors.length; k++) {
    const [r0, f0] = anchors[k - 1] as readonly [number, number];
    const [r1, f1] = anchors[k] as readonly [number, number];
    if (reg > r1) continue;
    if (reg === r1) return f1;
    return f0 * (f1 / f0) ** ((reg - r0) / (r1 - r0));
  }
  throw new Error(`reg ${reg} outside the anchor span`);
}

/** `cutoff_hz_for`: the cutoff register's frequency on `model` (6581: `cutoff_hz_6581`, two pieces with the 0x3FF -> 0x400 step down). */
export function sidCutoffHz(model: SidChipModel, reg: number): number {
  const r = reg & 0x7ff;
  if (model === '8580') return 30 + (r * (12_000 - 30)) / 2047;
  return logInterp(r < 0x400 ? CUTOFF_ANCHORS_6581_LO : CUTOFF_ANCHORS_6581_HI, r);
}

/** `resonance_q_for`: the resonance nibble's Q on `model`. */
export function sidResonanceQ(model: SidChipModel, res: number): number {
  return model === '8580' ? 0.707 + (res & 0xf) / 15 : 0.707 + 0.0698 * (res & 0xf);
}

/**
 * The filter's ideal response at `hz` in dB: the state-variable filter's
 * selected outputs (LP 1, BP 2, HP 4) summed, at the mapped cutoff and Q.
 * A display curve, not a port (see the file header).
 */
export function sidFilterResponseDb(model: SidChipModel, cutoffReg: number, res: number, mode: number, hz: number): number {
  const w = hz / sidCutoffHz(model, cutoffReg);
  const k = 1 / sidResonanceQ(model, res);
  // H(s) = N(s) / (s^2 + k s + 1) at s = j w.
  const denRe = 1 - w * w;
  const denIm = k * w;
  let numRe = 0;
  let numIm = 0;
  if (mode & 1) numRe += 1; // LP: 1
  if (mode & 2) numIm += w; // BP: s
  if (mode & 4) numRe -= w * w; // HP: s^2
  const mag = Math.hypot(numRe, numIm) / Math.hypot(denRe, denIm);
  return mag > 0 ? 20 * Math.log10(mag) : -120;
}

// ---------------------------------------------------------------------------
// An instrument's frames (the preview voice's)
// ---------------------------------------------------------------------------

/** What the chip holds after one frame of a note: `[frequency, pulse width, control, cutoff, resonance, mode]`. */
export type SidInstrumentFrame = readonly [number, number, number, number, number, number];

const i8 = (v: number): number => (v << 24) >> 24;

/** What set the waveform byte a frame plays: the instrument's first-frame byte, a wave-table row, or a `$F7` wave-table command. */
export type SidWaveSource =
  | { readonly kind: 'first-frame' }
  | { readonly kind: 'wave-row'; readonly row: number }
  | { readonly kind: 'wave-command'; readonly row: number }
  | { readonly kind: 'none' };

/**
 * Why a frame sounds as it does (the page's frame cursor): the waveform byte
 * before the gate mask and the gate, what set that byte, and the table rows
 * (1-based, 0 = none) the frame's steps read.
 */
export interface SidFrameTrace {
  readonly waveform: number;
  readonly gate: boolean;
  readonly waveSource: SidWaveSource;
  readonly waveRow: number;
  readonly pulseRow: number;
  readonly filterRow: number;
}

/**
 * The first `frames` frames of instrument `instrument` (1-based) of `doc`
 * played at note table index `note` on its own (the page's preview voice:
 * `SidSongPlayer::preview_note_on`, no row commands), as the chip's registers
 * after each frame. A port of the player's trigger and per-frame steps for one
 * voice; `[]` for an instrument the doc lacks.
 */
export function simulateSidInstrument(doc: SidDoc, instrument: number, note: number, frames: number, trace?: SidFrameTrace[]): SidInstrumentFrame[] {
  const ins = doc.instruments[instrument - 1];
  if (!ins) return [];
  const { wave, pulse: pulseTable, filter, speed } = doc.tables;
  const row = (table: readonly SidTableRow[], ptr: number): SidTableRow | undefined => (ptr === 0 ? undefined : table[ptr - 1]);

  // trigger(0, note), on a fresh channel (frequency 0, gate off, waveform 0).
  const base = Math.max(0, Math.min(92, note));
  // GT sets no pitch on a note: the wave table's first step does, a frame
  // later; an instrument with no wave table gets it at once.
  let freq = ins.wavePtr === 0 ? sidTableFreqReg(base) : 0;
  let lastNote = base;
  let gate = true;
  let firstFrame = true;
  const firstWave = ins.firstWave;
  // GT's first-frame byte: $00 keeps waveform and gate (a fresh channel's
  // gate is shut), $FE/$FF set the gate only, else it is the channel's
  // waveform until the table sets one. The player's control byte (S5.9) is
  // then the table's bytes whole, written `& gate mask`.
  let waveform = 0;
  let waveSource: SidWaveSource = { kind: 'none' };
  if (firstWave === 0) gate = false;
  else if (firstWave >= 0xfe) gate = firstWave === 0xff;
  else {
    waveform = firstWave;
    waveSource = { kind: 'first-frame' };
  }
  // The rows this frame's steps read, for `trace`.
  let waveRow = 0;
  let pulseRow = 0;
  let filterRow = 0;
  // A fresh channel's width: GT sets it only from the pulse table.
  let pw = 0;
  let wavePtr = ins.wavePtr;
  let waveWait = 0;
  let pulsePtr = ins.pulsePtr;
  let pulseTime = 0;
  let pulseSpeed = 0;
  let vibDelay = ins.vibratoDelay;
  let vibTime = 0;
  let resFilt = 0;
  let cutoff = 0;
  let mode = 0;
  let filterPtr = ins.filterPtr;
  let filterTime = 0;
  let filterSpeed = 0;

  // vibrato(): GoatTracker's u8 vibtime (gplay.c:615-640); a left of $80 up
  // is the fine mode, the step the gap to the next note shifted by `right`.
  const vibrato = (r: SidTableRow) => {
    let turn = r.left;
    let step = r.right;
    if (turn >= 0x80) {
      turn &= 0x7f;
      const at = (i: number) => (i < 0x80 ? sidTableFreqReg(i) : 0);
      step = r.right >= 32 ? 0 : ((at(lastNote + 1) - at(lastNote)) & 0xffff) >>> r.right;
    }
    if (vibTime < 0x80 && vibTime > turn) vibTime ^= 0xff;
    vibTime = (vibTime + 2) & 0xff;
    freq = (vibTime & 1 ? freq - step : freq + step) & 0xffff;
  };

  // speed(): a slide speed from a speed row; from $8000 up the fine speed
  // (the C64 player's shift: a count of 16 and up is 0).
  const slideSpeed = (ptr: number): number => {
    const r = row(speed, ptr);
    if (!r) return 0;
    const v = (r.left << 8) | r.right;
    if (v < 0x8000) return v;
    const at = (i: number) => (i < 0x80 ? sidTableFreqReg(i) : 0);
    return r.right >= 16 ? 0 : ((at(lastNote + 1) - at(lastNote)) & 0xffff) >>> r.right;
  };

  // tone_porta(): toward the note, wrapping as GT's; arriving restarts the vibrato.
  const tonePorta = (ptr: number) => {
    const target = sidTableFreqReg(base);
    if (ptr === 0) {
      freq = target;
      vibTime = 0;
      return;
    }
    const s = slideSpeed(ptr);
    if (freq < target) {
      freq = (freq + s) & 0xffff;
      if (freq > target) {
        freq = target;
        vibTime = 0;
      }
    }
    if (freq > target) {
      freq = (freq - s) & 0xffff;
      if (freq < target) {
        freq = target;
        vibTime = 0;
      }
    }
  };

  // wave_command(): a wave-table $F0-$FE row, the pattern command for a frame.
  // AD/SR and the volume are not in a frame's registers here.
  const waveCommand = (cmd: number, param: number) => {
    switch (cmd) {
      case 0x1: freq = (freq + slideSpeed(param)) & 0xffff; break;
      case 0x2: freq = (freq - slideSpeed(param)) & 0xffff; break;
      case 0x3: tonePorta(param); break;
      case 0x4: vibrato(row(speed, param) ?? { left: 0, right: 0 }); break;
      case 0x7: waveform = param; waveSource = { kind: 'wave-command', row: waveRow }; break;
      case 0x9: pulsePtr = param; pulseTime = 0; break;
      case 0xa: filterPtr = param; filterTime = 0; break;
      case 0xb: resFilt = param; if (param === 0) filterPtr = 0; break;
      case 0xc: cutoff = param << 3; break;
    }
  };

  // wave_note(): GT's mod-128 note column (gplay.c:714-721); false for $80.
  const waveNote = (right: number): boolean => {
    if (right === 0x80) return false;
    const n = (right < 0x80 ? base + right : right) & 0x7f;
    freq = sidTableFreqReg(n);
    vibTime = 0;
    lastNote = n;
    return true;
  };

  /** wave_step(): `true` when a step set a note (or ran a table command), ending the frame before the tick effects. */
  const waveStep = (): boolean => {
    if (firstFrame) return false;
    let jumped = false;
    let noted = false;
    let command: [number, number] | null = null;
    for (;;) {
      const r = row(wave, wavePtr);
      if (!r) break;
      if (r.left === 0xff) {
        if (jumped || r.right === 0 || r.right > wave.length) {
          wavePtr = 0;
          return false;
        }
        wavePtr = r.right;
        jumped = true;
        continue;
      }
      waveRow = wavePtr;
      if (r.left >= 0x01 && r.left <= 0x0f) {
        // A delayed step: `left` frames of waiting, then its note (S5 pin).
        if (waveWait === 0) waveWait = r.left + 1;
        waveWait -= 1;
        if (waveWait === 0) {
          noted = waveNote(r.right);
          wavePtr = (wavePtr + 1) & 0xff;
        }
      } else {
        if (r.left >= 0x10 && r.left <= 0xdf) waveform = r.left;
        else if (r.left >= 0xe0 && r.left <= 0xef) waveform = r.left & 0x0f;
        if (r.left >= 0x10 && r.left <= 0xef) waveSource = { kind: 'wave-row', row: wavePtr };
        if (r.left >= 0xf0) {
          command = [r.left & 0x0f, r.right];
          noted = true;
        } else {
          noted = waveNote(r.right);
        }
        wavePtr = (wavePtr + 1) & 0xff;
      }
      break;
    }
    if (wavePtr > wave.length) wavePtr = 0;
    if (command) waveCommand(command[0], command[1]);
    return noted;
  };

  // pulse_step(): GT's walk. A jump lands on its target and takes that row as
  // data; a width row sets; 1-$7F modulates from this frame; 0 (or past the
  // stored rows) stalls.
  const pulseStep = () => {
    if (pulsePtr === 0) return;
    const at = (ptr: number): SidTableRow => pulseTable[ptr - 1] ?? { left: 0, right: 0 };
    const jump = at(pulsePtr);
    if (jump.left === 0xff) {
      pulsePtr = jump.right;
      if (pulsePtr === 0) return;
    }
    pulseRow = pulsePtr;
    if (pulseTime === 0) {
      const r = at(pulsePtr);
      if (r.left >= 0x80) {
        pw = ((r.left & 0x0f) << 8) | r.right;
        pulsePtr = (pulsePtr + 1) & 0xff;
      } else {
        pulseTime = r.left;
        pulseSpeed = i8(r.right);
      }
    }
    if (pulseTime > 0) {
      pw = (pw + pulseSpeed) & 0xfff;
      pulseTime -= 1;
      if (pulseTime === 0) pulsePtr = (pulsePtr + 1) & 0xff;
    }
  };

  // filter_step(): GT's walk, at the top of the frame. A jump takes its target
  // as data; $80 up sets mode and $17 (and a cutoff row straight after); 1-$7F
  // steps the cutoff's high byte (wrapping) from this frame; 0 sets it. The
  // table stopping stops a sweep; past the stored rows it stops.
  const filterStep = () => {
    if (filterPtr === 0) return;
    const at = (ptr: number): SidTableRow => (ptr === 0 ? undefined : filter[ptr - 1]) ?? { left: 0, right: 0 };
    const jump = at(filterPtr);
    if (jump.left === 0xff) {
      filterPtr = jump.right;
      if (filterPtr === 0) return;
    }
    if (filterTime === 0) {
      if (filterPtr > filter.length) {
        filterPtr = 0;
        return;
      }
      filterRow = filterPtr;
      const r = at(filterPtr);
      if (r.left >= 0x80) {
        mode = (r.left >> 4) & 0x07;
        resFilt = r.right;
        filterPtr = (filterPtr + 1) & 0xff;
        if (filterPtr !== 0 && at(filterPtr).left === 0x00) {
          cutoff = at(filterPtr).right << 3;
          filterPtr = (filterPtr + 1) & 0xff;
        }
      } else if (r.left !== 0) {
        filterTime = r.left;
        filterSpeed = i8(r.right);
      } else {
        cutoff = r.right << 3;
        filterPtr = (filterPtr + 1) & 0xff;
      }
    }
    if (filterTime > 0) {
      filterRow ||= filterPtr;
      cutoff = ((((cutoff >> 3) + filterSpeed) & 0xff) << 3) | (cutoff & 0x07);
      filterTime -= 1;
      if (filterTime === 0) filterPtr = (filterPtr + 1) & 0xff;
    }
  };

  const out: SidInstrumentFrame[] = [];
  for (let f = 0; f < frames; f++) {
    waveRow = 0;
    pulseRow = 0;
    filterRow = 0;
    // The filter table runs at the top of the frame and its registers are
    // what the frame writes (GT's order): a wave-table filter command lands
    // on the next frame.
    filterStep();
    const filterRegs = [cutoff & 0x7ff, resFilt >> 4, mode & 0x07] as const;
    // The wave table first; a step that set a note ends the frame before
    // continuous(): no command on a preview note, so only the instrument
    // vibrato (command 0's: delay 0 never, above 1 counts down, at 1 swings;
    // the preview voice has no tick 0 to skip).
    const noted = waveStep();
    if (!noted && !firstFrame && ins.speedPtr !== 0 && vibDelay !== 0) {
      if (vibDelay > 1) vibDelay -= 1;
      else vibrato(row(speed, ins.speedPtr) ?? { left: 0, right: 0 });
    }
    // A note's frame ends before the pulse table (GT).
    if (!firstFrame) pulseStep();
    const control = firstFrame && firstWave !== 0 && firstWave < 0xfe ? firstWave : waveform & (gate ? 0xff : 0xfe);
    // The low byte is written with bit 0 clear, as GT does.
    out.push([freq, pw & 0xffe, control, ...filterRegs]);
    if (trace) {
      const own = firstFrame && firstWave !== 0 && firstWave < 0xfe;
      trace.push({
        waveform: own ? firstWave : waveform,
        gate: (control & 0x01) !== 0,
        waveSource: own ? { kind: 'first-frame' } : waveSource,
        waveRow,
        pulseRow,
        filterRow,
      });
    }
    firstFrame = false;
  }
  return out;
}
