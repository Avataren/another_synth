/**
 * Pure render helpers for the SID instrument page's "see the sound" drawings
 * (plan-sid-tracking.md S4), on the `ahx-instrument-visuals.ts` model: ports
 * of the Rust player and chip, not approximations, so a drawing cannot drift
 * from what plays:
 *
 * - waveforms: `waveform_output` and the 6581's `combined_6581` pass
 *   (`rust-wasm/src/sid/waveform.rs`);
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
import { sidNoteFreqReg } from '@another-synth/tracker-playback';
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

/** Threshold of the 6581 neighbour pull (`PULL_THRESHOLD_6581`). */
const PULL_THRESHOLD_6581 = 1536;

/** `combined_6581`: the 6581's pull-down pass over an ideal wired-AND value. */
function combined6581(and: number): number {
  let out = 0;
  for (let i = 0; i < 12; i++) {
    if (((and >> i) & 1) === 0) continue;
    let pull = 0;
    for (let j = 0; j < 12; j++) {
      if (j !== i && ((and >> j) & 1) === 0) pull += 1 << (11 - Math.abs(i - j));
    }
    if (pull < PULL_THRESHOLD_6581) out |= 1 << i;
  }
  return out;
}
const combinedCache = new Map<number, number>();
const combined = (and: number): number => {
  let v = combinedCache.get(and);
  if (v === undefined) combinedCache.set(and, (v = combined6581(and)));
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
  return model === '6581' && bits >= 2 ? combined(out) : out;
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
/** PAL chip cycles per 50 Hz frame, rounded (the parity fixture's step). */
export const SID_CYCLES_PER_FRAME = 19_705;

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

const sigmoid = (u: number): number => 1 / (1 + Math.exp(-u));

/** `cutoff_hz_for`: the cutoff register's frequency on `model`. */
export function sidCutoffHz(model: SidChipModel, reg: number): number {
  const r = reg & 0x7ff;
  if (model === '8580') return 30 + (r * (12_000 - 30)) / 2047;
  const k = 7;
  const x = r / 2047;
  const lo = sigmoid(-k / 2);
  const hi = sigmoid(k / 2);
  const s = Math.max(0, Math.min(1, (sigmoid(k * (x - 0.5)) - lo) / (hi - lo)));
  return 220 * (18_000 / 220) ** s;
}

/** `resonance_q_for`: the resonance nibble's Q on `model`. */
export function sidResonanceQ(model: SidChipModel, res: number): number {
  return 0.707 * 2 ** ((res & 0xf) / (model === '8580' ? 8 : 12));
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
const noteReg = (index: number): number => sidNoteFreqReg(Math.max(0, Math.min(92, index)));

/**
 * The first `frames` frames of instrument `instrument` (1-based) of `doc`
 * played at note table index `note` on its own (the page's preview voice:
 * `SidSongPlayer::preview_note_on`, no row commands), as the chip's registers
 * after each frame. A port of the player's trigger and per-frame steps for one
 * voice; `[]` for an instrument the doc lacks.
 */
export function simulateSidInstrument(doc: SidDoc, instrument: number, note: number, frames: number): SidInstrumentFrame[] {
  const ins = doc.instruments[instrument - 1];
  if (!ins) return [];
  const { wave, pulse: pulseTable, filter, speed } = doc.tables;
  const row = (table: readonly SidTableRow[], ptr: number): SidTableRow | undefined => (ptr === 0 ? undefined : table[ptr - 1]);

  // trigger(0, note)
  const base = Math.max(0, Math.min(92, note));
  let freq = noteReg(base);
  const gate = true;
  let firstFrame = true;
  const firstWave = ins.firstWave;
  // The player's control byte (S5.9): the instrument's gate-clear waveform
  // with the gate bit set, then the table's bytes whole; written `& gate mask`.
  let waveform = ins.waveform | 0x01;
  let pw = ins.pulseWidth;
  let wavePtr = ins.wavePtr;
  let waveWait = 0;
  let pulsePtr = ins.pulsePtr;
  let pulseTime = 0;
  let pulseSpeed = 0;
  let vibDelay = ins.vibratoDelay;
  let vibCount = 0;
  let vibUp = true;
  let vibOffset = 0;
  let resFilt = ins.filter.enabled ? 0x01 : 0;
  let cutoff = 0;
  let mode = 0;
  let filterPtr = 0;
  let filterTime = 0;
  let filterSpeed = 0;
  if (ins.filterPtr > 0) {
    filterPtr = ins.filterPtr;
  } else if (ins.filter.enabled) {
    cutoff = ins.filter.cutoff;
    resFilt = (ins.filter.resonance << 4) | (resFilt & 0x0f);
    mode = ins.filter.mode;
  }

  const vibrato = (speedLeft: number, depth: number) => {
    const half = Math.max(1, speedLeft);
    if (vibCount === 0 && vibOffset === 0 && vibUp) vibCount = half >> 1;
    vibOffset += vibUp ? depth : -depth;
    vibCount += 1;
    if (vibCount >= half) {
      vibCount = 0;
      vibUp = !vibUp;
    }
  };

  const waveStep = () => {
    if (firstFrame && firstWave !== 0) return;
    let jumped = false;
    for (;;) {
      const r = row(wave, wavePtr);
      if (!r) break;
      if (r.left === 0xff) {
        if (jumped || r.right === 0 || r.right > wave.length) {
          wavePtr = 0;
          return;
        }
        wavePtr = r.right;
        jumped = true;
        continue;
      }
      if (r.left >= 0x01 && r.left <= 0x0f) {
        if (waveWait === 0) waveWait = r.left;
        waveWait -= 1;
        if (waveWait === 0) wavePtr = (wavePtr + 1) & 0xff;
      } else {
        if (r.left >= 0x10 && r.left <= 0xdf) waveform = r.left;
        else if (r.left >= 0xe0 && r.left <= 0xef) waveform = r.left & 0x0f;
        let n: number | undefined;
        if (r.right === 0x80) n = undefined;
        else if (r.right <= 0x5f) n = base + r.right;
        else if (r.right <= 0x7f) n = base + r.right - 0x80;
        else n = r.right & 0x7f;
        if (n !== undefined) freq = noteReg(n);
        wavePtr = (wavePtr + 1) & 0xff;
      }
      break;
    }
    if (wavePtr > wave.length) wavePtr = 0;
  };

  const pulseStep = () => {
    if (pulseTime > 0) {
      pw = (pw + pulseSpeed) & 0xfff;
      pulseTime -= 1;
      return;
    }
    let jumped = false;
    for (;;) {
      const r = row(pulseTable, pulsePtr);
      if (!r) break;
      if (r.left === 0xff) {
        if (jumped || r.right === 0 || r.right > pulseTable.length) {
          pulsePtr = 0;
          return;
        }
        pulsePtr = r.right;
        jumped = true;
        continue;
      }
      if (r.left >= 0x80) {
        pw = ((r.left & 0x0f) << 8) | r.right;
      } else if (r.left >= 0x01) {
        pulseTime = r.left;
        pulseSpeed = i8(r.right);
        pw = (pw + pulseSpeed) & 0xfff;
        pulseTime -= 1;
      }
      pulsePtr = (pulsePtr + 1) & 0xff;
      break;
    }
    if (pulsePtr > pulseTable.length) pulsePtr = 0;
  };

  const bump = (value: number, by: number) => Math.max(0, Math.min(0x7ff, value + (by << 3)));
  const filterStep = () => {
    if (filterTime > 0) {
      cutoff = bump(cutoff, filterSpeed);
      filterTime -= 1;
      return;
    }
    let jumped = false;
    for (;;) {
      const r = row(filter, filterPtr);
      if (!r) break;
      if (r.left === 0xff) {
        if (jumped || r.right === 0 || r.right > filter.length) {
          filterPtr = 0;
          return;
        }
        filterPtr = r.right;
        jumped = true;
        continue;
      }
      if (r.left === 0x00) {
        cutoff = r.right << 3;
      } else if (r.left <= 0x7f) {
        filterTime = r.left - 1;
        filterSpeed = i8(r.right);
        cutoff = bump(cutoff, filterSpeed);
      } else if (r.left <= 0xf0) {
        mode = (r.left >> 4) & 0x07;
        resFilt = r.right;
      }
      filterPtr = (filterPtr + 1) & 0xff;
      break;
    }
    if (filterPtr > filter.length) filterPtr = 0;
  };

  const out: SidInstrumentFrame[] = [];
  for (let f = 0; f < frames; f++) {
    // continuous(): no command on a preview note, so only the instrument vibrato.
    if (!firstFrame) {
      const vib = row(speed, ins.speedPtr);
      if (vib) {
        if (vibDelay > 0) vibDelay -= 1;
        else vibrato(vib.left, vib.right);
      }
    }
    waveStep();
    pulseStep();
    filterStep();
    const written = Math.max(0, Math.min(0xffff, freq + vibOffset));
    const control = firstFrame && firstWave !== 0 ? firstWave : waveform & (gate ? 0xff : 0xfe);
    out.push([written, pw & 0xfff, control, cutoff & 0x7ff, resFilt >> 4, mode & 0x07]);
    firstFrame = false;
  }
  return out;
}
