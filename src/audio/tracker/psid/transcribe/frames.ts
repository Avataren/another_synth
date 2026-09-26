import { sidTableFreqReg } from '@another-synth/tracker-playback';
import { SID_EVENT_GATE_ON, type SidTrace } from '../sid-capture';

/**
 * The register trace as the transcriber reads it (plan-psid-import.md §3):
 * per voice per frame, the frequency, pulse width, control byte, envelope and
 * the in-frame gate events; the filter and volume per frame.
 *
 * A "frame" here is one player tick at the rate the music really changes:
 * a player called more often than it writes (Defender of the Crown's is
 * called at ~394 Hz and writes on every 4th call) is decimated to the calls
 * that write, so a frame is a player step, what a GoatTracker tick becomes.
 */

export interface VoiceFrames {
  readonly freq: Uint16Array;
  readonly pw: Uint16Array;
  readonly ctrl: Uint8Array;
  readonly ad: Uint8Array;
  readonly sr: Uint8Array;
  /** `SID_EVENT_*` bits of the frame. */
  readonly events: Uint8Array;
}

export interface TraceFrames {
  readonly frames: number;
  readonly voices: readonly VoiceFrames[];
  /** 11-bit cutoff. */
  readonly cutoff: Uint16Array;
  /** $D417: resonance << 4 | routing. */
  readonly resonance: Uint8Array;
  /** $D418: mode << 4 | volume. */
  readonly modeVolume: Uint8Array;
  /** Frames per second. */
  readonly rateHz: number;
  /** The clock the frequency registers count in (Hz). */
  readonly clockHz: number;
  /** Trace ticks per frame (1, or the decimation). */
  readonly decimation: number;
  /** The frame the music continues with after the last (an exact loop), or null. */
  readonly loopFrame: number | null;
}

/** A decimated player still steps at least this often: a 50 Hz tune that writes on even frames only is still 50 Hz. */
const MIN_DECIMATED_HZ = 45;

/**
 * The ticks-per-frame divisor at which every register change of the trace
 * falls on one residue, or 1; never below `MIN_DECIMATED_HZ` (the rates
 * GoatTracker plays start at the video frame's).
 */
export function traceDecimation(trace: SidTrace): { readonly step: number; readonly phase: number } {
  const maxStep = Math.min(16, Math.floor(trace.clockHz / trace.tickCycles / MIN_DECIMATED_HZ));
  if (maxStep < 2) return { step: 1, phase: 0 };
  const regs = trace.regs;
  const changed: number[] = [];
  for (let t = 1; t < trace.ticks; t++) {
    const a = (t - 1) * 25;
    const b = t * 25;
    for (let r = 0; r < 25; r++) {
      if (regs[a + r] !== regs[b + r]) {
        changed.push(t);
        break;
      }
    }
  }
  if (changed.length < 8) return { step: 1, phase: 0 };
  for (let step = maxStep; step >= 2; step--) {
    const phase = changed[0]! % step;
    if (changed.every((t) => t % step === phase)) return { step, phase };
  }
  return { step: 1, phase: 0 };
}

/** `trace` as frames: decimated where the player writes on every n-th call only. */
export function traceFrames(trace: SidTrace): TraceFrames {
  const { step, phase } = traceDecimation(trace);
  const picks: number[] = [];
  for (let t = step === 1 ? 0 : phase; t < trace.ticks; t += step) picks.push(t);
  const n = picks.length;
  const voices: VoiceFrames[] = [];
  for (let v = 0; v < 3; v++) {
    const o = v * 7;
    const freq = new Uint16Array(n);
    const pw = new Uint16Array(n);
    const ctrl = new Uint8Array(n);
    const ad = new Uint8Array(n);
    const sr = new Uint8Array(n);
    const events = new Uint8Array(n);
    picks.forEach((t, i) => {
      const r = t * 25 + o;
      freq[i] = trace.regs[r]! | (trace.regs[r + 1]! << 8);
      pw[i] = (trace.regs[r + 2]! | (trace.regs[r + 3]! << 8)) & 0xfff;
      ctrl[i] = trace.regs[r + 4]!;
      ad[i] = trace.regs[r + 5]!;
      sr[i] = trace.regs[r + 6]!;
      // A decimated frame carries the events of the calls it stands for.
      let e = 0;
      for (let k = Math.max(0, t - step + 1); k <= t; k++) e |= trace.voiceEvents[k * 3 + v]!;
      events[i] = e;
    });
    voices.push({ freq, pw, ctrl, ad, sr, events });
  }
  const cutoff = new Uint16Array(n);
  const resonance = new Uint8Array(n);
  const modeVolume = new Uint8Array(n);
  picks.forEach((t, i) => {
    const r = t * 25;
    cutoff[i] = (trace.regs[r + 0x15]! & 7) | (trace.regs[r + 0x16]! << 3);
    resonance[i] = trace.regs[r + 0x17]!;
    modeVolume[i] = trace.regs[r + 0x18]!;
  });
  const loopFrame =
    trace.loopTick === null ? null : Math.max(0, Math.min(n - 1, Math.round((trace.loopTick - (step === 1 ? 0 : phase)) / step)));
  return {
    frames: n,
    voices,
    cutoff,
    resonance,
    modeVolume,
    rateHz: trace.clockHz / (trace.tickCycles * step),
    clockHz: trace.clockHz,
    decimation: step,
    loopFrame,
  };
}

/** Whether voice `v` of `f` starts a note (a gate-on edge) in frame `i`. */
export const gateOnAt = (f: TraceFrames, v: number, i: number): boolean => (f.voices[v]!.events[i]! & SID_EVENT_GATE_ON) !== 0;

// ---------------------------------------------------------------------------
// Pitch
// ---------------------------------------------------------------------------

/** The PAL clock GoatTracker's exports run at, and its note table's reference. */
const PAL_HZ = 985248;
/** GoatTracker's A-4 register (index 57), unrounded, on its table's own clock. */
const GT_A4 = (440 * 16777216) / 985000;

/** GoatTracker's note table: index 0 (C-0) to 95 (B-7). */
export const GT_NOTE_REGS: readonly number[] = Array.from({ length: 96 }, (_, i) => sidTableFreqReg(i));

/**
 * The pitch of frequency register `freq` (counting at `clockHz`) in
 * GoatTracker note units: 0 = C-0, 57 = A-4, fractional between notes, as
 * the note GoatTracker's PAL table plays nearest to it. -Infinity for 0.
 */
export function pitchOf(freq: number, clockHz: number): number {
  if (freq <= 0) return -Infinity;
  const pal = (freq * clockHz) / PAL_HZ;
  return 57 + 12 * Math.log2(pal / GT_A4);
}

/** The nearest note index of GoatTracker's table (0-95) for a pitch. */
export const nearestNote = (pitch: number): number => Math.max(0, Math.min(95, Math.round(pitch)));

/**
 * How far the tune's own note table sits from GoatTracker's, in semitones
 * (-0.5..0.5): the most common fractional part of the pitches its voices
 * hold while gated (Galway's table is about 26 cents flat of GT's). Pitches
 * are snapped to notes after taking it off; the song then plays in GT's
 * tuning, which is the one thing a GoatTracker song cannot change.
 */
export function estimateTuning(f: TraceFrames): number {
  const bins = new Array<number>(100).fill(0);
  for (const v of f.voices) {
    for (let i = 1; i < f.frames; i++) {
      // A pitch held for two frames with the gate on: a note, not a slide.
      if (!(v.ctrl[i]! & 1) || v.freq[i] !== v.freq[i - 1] || v.freq[i] === 0) continue;
      const p = pitchOf(v.freq[i]!, f.clockHz);
      const frac = p - Math.round(p);
      bins[Math.min(99, Math.max(0, Math.floor((frac + 0.5) * 100)))]!++;
    }
  }
  // The densest 9-cent window (circular), its weighted centre.
  let best = 0;
  let bestSum = -1;
  for (let c = 0; c < 100; c++) {
    let sum = 0;
    for (let k = -4; k <= 4; k++) sum += bins[(c + k + 100) % 100]!;
    if (sum > bestSum) [best, bestSum] = [c, sum];
  }
  if (bestSum <= 0) return 0;
  let acc = 0;
  for (let k = -4; k <= 4; k++) acc += k * bins[(best + k + 100) % 100]!;
  const centre = (best + acc / bestSum + 0.5) / 100 - 0.5;
  return centre > 0.5 ? centre - 1 : centre < -0.5 ? centre + 1 : centre;
}
