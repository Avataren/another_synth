import { applyEnvelopeFrame, SidEnvelope, type EnvelopeFrame } from '../envelope';
import { SID_EVENT_GATE_LOW, SID_EVENT_GATE_ON } from '../sid-capture';
import { nearestNote, pitchOf, type TraceFrames, type VoiceFrames } from './frames';
import { rowLength, rowOfFrame, rowStart, type RowGrid } from './grid';
import type { PitchPlan } from './pitch';

/**
 * The notes of a transcription (plan-psid-import.md §3): every gate-on of the
 * trace becomes a note on a row of the grid, or, when its row already has
 * one (a retrigger inside the row), part of that note's sound. Each note
 * carries its frames as a program relative to its row's first frame, what
 * a GoatTracker instrument must play for it.
 */

/** Longest stretch of a note the instrument tables describe; the rest holds. */
export const MAX_PROGRAM_FRAMES = 48;
/** A gate-off this close before the next note is the hard restart's, not the instrument's. */
export const MAX_HARD_RESTART_GAP = 8;

export interface RowNote {
  readonly voice: number;
  readonly row: number;
  /** The frame of the row's first frame (GoatTracker's tick 0). */
  readonly tick0: number;
  /** The frame the original's gate goes on. */
  readonly onset: number;
  /** The frame of the next note's tick 0 on this voice, or the trace's end. */
  end: number;
  /** Retriggers folded into this note. */
  folded: number;
  /** The note starts without a gate-on: the pitch moves on while the note sounds (a tie, a legato line). */
  readonly legato: boolean;
}

/** One frame of a note's program, relative to its tick 0 (index 1 = the wave table's first row). */
export interface ProgramFrame {
  /** The control byte (waveform, gate, sync, ring, test). */
  readonly ctrl: number;
  /** Pitch relative to the note's base, in semitones (fractional); null: no frequency (0). */
  readonly pitch: number | null;
  /** The pattern sets this frame's pitch (a glide, a bend: `pitch.ts`); the instrument leaves it. */
  readonly owned?: boolean;
  readonly pw: number;
  /** The (global) filter in that frame: cutoff high byte, $D417 (resonance, routing), mode bits (LP 1, BP 2, HP 4). */
  readonly cutoff: number;
  readonly resonance: number;
  readonly mode: number;
}

export interface NoteProgram {
  readonly note: RowNote;
  /** GoatTracker note index (0-95) the row plays: the pitch at the gate-on. */
  readonly base: number;
  /** Envelope at the gate-on frame. */
  readonly ad: number;
  readonly sr: number;
  /** The control byte on tick 0 (the frame before the note's own frames). */
  readonly tick0Ctrl: number;
  /**
   * How much closer the note's envelope comes to the original's (summed
   * level difference over its start) when GoatTracker starts it with the
   * gate on and the test bit on tick 0 ($09) rather than with the gate off
   * there: positive favours $09. 0 for a legato note.
   */
  readonly testStartGain: number;
  /** Frames 1..n of the program: up to the hard-restart tail or `MAX_PROGRAM_FRAMES`. */
  readonly frames: readonly ProgramFrame[];
  /** Frames from the last gate-on frame to the next note's gate-on, when the next note cut it (the hard-restart gap). */
  readonly gapAfter: number | null;
  /** The envelope was zeroed (a hard restart) in the frames before this note's gate-on. */
  readonly hardRestartBefore: boolean;
  /** Frames of gate-off right before this note's gate-on. */
  readonly gapBefore: number;
  /** This note's voice drives the filter (`filterDriver`): its instrument plays the filter's program. */
  filter: boolean;
  /**
   * The frame (relative to tick 0) the note's gate went off for good, when
   * that is later than its first few frames: a key-off in the pattern, not
   * part of the instrument (its frames are kept gated from there).
   */
  readonly keyOff: number | null;
  /** Frames of the held line this note starts (the legato notes after it, `splitLines`); 0 for none. */
  readonly lineFrames: number;
  /**
   * The pulse width from frame 1 on, up to the next note (at most
   * `MAX_PULSE_FRAMES`), with each frame's place in its row: `k` frames after
   * the row's first, of a row `rowLength` long (GoatTracker skips the pulse
   * table's step on one frame of every row, `pulseProgram`).
   */
  readonly pulse: readonly PulseFrame[];
}

export interface PulseFrame {
  readonly pw: number;
  readonly k: number;
  readonly rowLength: number;
  /** A legato note of the line starts on this frame (its tick 0): GoatTracker skips the pulse table's step there. */
  readonly noteStart?: boolean;
}

/** Longest stretch of a note's pulse width the pulse table follows (a slow sweep's whole cycle). */
export const MAX_PULSE_FRAMES = 256;

/** A gate-off within this many frames of the gate going on is the instrument's (a pluck), not a key-off. */
const EARLY_GATE_OFF = 4;

/**
 * The voice whose notes drive the filter, or null: routed through it in most
 * of its gated frames, and the cutoff moves as its notes start (within the
 * two frames after the gate goes on) in most of them.
 */
export function filterDriver(f: TraceFrames, onsets: readonly (readonly number[])[]): number | null {
  let best: number | null = null;
  let bestScore = 0.3;
  for (let v = 0; v < 3; v++) {
    const vf = f.voices[v]!;
    let gated = 0;
    let routed = 0;
    for (let i = 0; i < f.frames; i++) {
      if (!(vf.ctrl[i]! & 1)) continue;
      gated++;
      if (f.resonance[i]! & (1 << v)) routed++;
    }
    const list = onsets[v]!;
    if (gated === 0 || list.length === 0) continue;
    let restarts = 0;
    for (const o of list) {
      const before = f.cutoff[Math.max(0, o - 1)]!;
      for (let k = o; k <= Math.min(f.frames - 1, o + 2); k++) {
        if (Math.abs(f.cutoff[k]! - before) >= 16) {
          restarts++;
          break;
        }
      }
    }
    const score = (routed / gated) * (restarts / list.length);
    if (score > bestScore) [best, bestScore] = [v, score];
  }
  return best;
}

/** Per voice, the frames where the gate goes on. */
export function onsetsOf(f: TraceFrames): number[][] {
  return f.voices.map((v) => {
    const out: number[] = [];
    for (let i = 0; i < f.frames; i++) if (v.events[i]! & SID_EVENT_GATE_ON) out.push(i);
    return out;
  });
}

/** The row nearest to `frame` (as a note's tick 0). */
function nearestRowTo(g: RowGrid, frame: number): number {
  const k = rowOfFrame(g, frame);
  const here = rowStart(g, k);
  const next = rowStart(g, k + 1);
  return frame - here <= next - frame ? k : k + 1;
}

/** Per voice, the notes on rows; a gate-on whose row already has a note is folded into the note sounding then. */
export function placeNotes(f: TraceFrames, g: RowGrid, onsets: readonly (readonly number[])[]): RowNote[][] {
  return onsets.map((list, voice) => {
    const notes: RowNote[] = [];
    const delay = g.delays[voice] ?? 0;
    for (const onset of list) {
      const k = Math.max(0, nearestRowTo(g, onset - 1 - delay));
      const last = notes[notes.length - 1];
      if (last !== undefined && last.row >= k) {
        last.folded++;
        continue;
      }
      notes.push({ voice, row: k, tick0: rowStart(g, k), onset, end: f.frames, folded: 0, legato: false });
    }
    for (let i = 0; i + 1 < notes.length; i++) notes[i]!.end = notes[i + 1]!.tick0;
    return notes;
  });
}

/** A held row plays notes further apart than this: no tie (one note a row) can play it. */
const LINE_SPREAD = 2;
/** A frame this close to a whole semitone plays that note. */
const ON_NOTE = 0.15;

/**
 * Per voice, the notes with every held line split where a tie cannot play it:
 * a row, under a gate that stays on, that plays several notes further apart
 * than `LINE_SPREAD`, moving at least twice (Hubbard's bass: three notes to a row, each an octave
 * down on its first frame) and not the ones the row before played (a chord's
 * arpeggio goes on as it is) starts a legato note, which plays its row from
 * its own wave table. Without it the line stops where the first note's
 * program does (`MAX_PROGRAM_FRAMES`).
 */
export function splitLines(f: TraceFrames, g: RowGrid, voices: readonly RowNote[][], tuning: number): RowNote[][] {
  return voices.map((notes, voice) => {
    const vf = f.voices[voice]!;
    const delay = g.delays[voice] ?? 0;
    // A row's notes (sorted, distinct) and whether it is a held line's: every frame gated and on a note.
    const rowNotes = (s: number, e: number): { set: string; line: boolean } => {
      const ns: number[] = [];
      let line = e - s >= 3;
      let moves = 0;
      for (let i = s; i < e; i++) {
        const c = vf.ctrl[i]!;
        const p = pitchOf(vf.freq[i]!, f.clockHz) - tuning;
        const on = (c & 1) !== 0 && (c & 0xf0) !== 0 && !(c & 0x88) && Number.isFinite(p) && Math.abs(p - Math.round(p)) <= ON_NOTE;
        if (on) {
          if (ns.length > 0 && ns[ns.length - 1] !== Math.round(p)) moves++;
          ns.push(Math.round(p));
        } else line = false;
      }
      const set = [...new Set(ns)].sort((a, b) => a - b);
      // One move inside the row is a tie off the row's start; a line moves on within it.
      return { set: set.join(','), line: line && moves >= 2 && set[set.length - 1]! - set[0]! > LINE_SPREAD };
    };
    const out: RowNote[] = [];
    for (const note of notes) {
      out.push(note);
      const end = note.end;
      let prev: string | null = null;
      const lastRow = rowOfFrame(g, end - 1 - delay);
      for (let r = note.row; r <= lastRow; r++) {
        const tick0 = rowStart(g, r);
        const s = Math.max(note.onset, tick0 + 1 + delay);
        const e = Math.min(end, rowStart(g, r + 1) + 1 + delay);
        if (e <= s) continue;
        const row = rowNotes(s, e);
        if (r > note.row && row.line && row.set !== prev) {
          out[out.length - 1]!.end = tick0;
          out.push({ voice, row: r, tick0, onset: tick0 + 1 + delay, end, folded: 0, legato: true });
        }
        prev = row.set;
      }
    }
    return out;
  });
}

/** Frames of gate-off right before `frame` on voice `v` (up to `max`). */
function gateOffRun(f: TraceFrames, v: number, frame: number, max: number): number {
  const ctrl = f.voices[v]!.ctrl;
  let n = 0;
  while (n < max && frame - n - 1 >= 0 && !(ctrl[frame - n - 1]! & 1)) n++;
  return n;
}

/**
 * The note a note is on: the pitch its gated frames hold most (a grace note
 * or a slide into it is then relative to it), but the pitch it starts on
 * when that is nearly as common (an arpeggio's first note).
 */
function baseNote(f: TraceFrames, voice: number, from: number, to: number, tuning: number): number {
  const vf = f.voices[voice]!;
  const counts = new Map<number, number>();
  for (let i = from; i < Math.max(from + 1, to); i++) {
    if (!(vf.ctrl[i]! & 1) && i !== from) continue;
    const p = pitchOf(vf.freq[i]!, f.clockHz) - tuning;
    if (!Number.isFinite(p)) continue;
    const n = nearestNote(p);
    counts.set(n, (counts.get(n) ?? 0) + 1);
  }
  const start = pitchOf(vf.freq[from]!, f.clockHz) - tuning;
  const first = Number.isFinite(start) ? nearestNote(start) : 0;
  let best = first;
  let bestCount = counts.get(first) ?? 0;
  for (const [n, c] of counts) if (c > bestCount) [best, bestCount] = [n, c];
  return (counts.get(first) ?? 0) >= 0.6 * bestCount ? first : best;
}

/**
 * The note a note's row plays (`baseNote` over its first row, at least 4
 * frames, at most 24): what its first row holds, not where a later tie or
 * glide takes it.
 */
export function noteBase(f: TraceFrames, g: RowGrid, note: RowNote, tuning: number): number {
  const onset = Math.max(0, Math.min(f.frames - 1, note.onset));
  const firstRowEnd = rowStart(g, note.row + 1) + 1 + (g.delays[note.voice] ?? 0);
  const to = Math.min(note.end, onset + 24, Math.max(firstRowEnd, onset + 4));
  return baseNote(f, note.voice, onset, to, tuning);
}

/** Frames after a note's gate-on over which its two possible starts are weighed. */
const START_WINDOW = 16;

/** Voice frame `i` as the envelope takes it. */
const envelopeFrame = (vf: VoiceFrames, i: number): EnvelopeFrame => ({
  ad: vf.ad[i]!,
  sr: vf.sr[i]!,
  ctrl: vf.ctrl[i]!,
  gateLow: (vf.events[i]! & SID_EVENT_GATE_LOW) !== 0,
});

interface StartContext {
  readonly vf: VoiceFrames;
  /** The original's envelope level per frame. */
  readonly levels: Uint8Array;
  readonly cycles: number;
}

/**
 * The summed difference from the original's envelope levels over frames
 * [`from`, `to`) of a note GoatTracker plays: gate off from `from` (its gate
 * timer; with a hard restart, attack/decay $0F and sustain/release $00, else
 * the envelope the original had), on tick 0 the note's envelope with the gate
 * on (`test`, $09) or off, then the note's frames. `state`: the original's
 * envelope as frame `from` starts.
 */
function startError(ctx: StartContext, state: SidEnvelope, p: Omit<NoteProgram, 'testStartGain'>, from: number, to: number, test: boolean): number {
  const env = state.clone();
  const tick0 = p.note.tick0;
  let err = 0;
  for (let i = from; i < to; i++) {
    let frame: EnvelopeFrame;
    if (i < tick0) {
      frame = p.hardRestartBefore ? { ad: 0x0f, sr: 0x00, ctrl: 0, gateLow: true } : { ...envelopeFrame(ctx.vf, i), ctrl: 0, gateLow: true };
    } else if (i === tick0) {
      frame = { ad: p.ad, sr: p.sr, ctrl: test ? 1 : 0, gateLow: false };
    } else {
      const k = i - tick0 - 1;
      frame = { ad: p.ad, sr: p.sr, ctrl: k < p.frames.length ? p.frames[k]!.ctrl : ctx.vf.ctrl[i]!, gateLow: false };
    }
    applyEnvelopeFrame(env, frame, ctx.cycles);
    err += Math.abs(env.level - ctx.levels[i]!);
  }
  return err;
}

/**
 * The program of every note of `notes` (one voice). `tuning`: the tune's
 * offset from GoatTracker's note table (`estimateTuning`), taken off every
 * pitch before it is snapped to a note.
 */
export function notePrograms(f: TraceFrames, notes: readonly RowNote[], tuning = 0, g?: RowGrid, plan?: PitchPlan): NoteProgram[] {
  const out: NoteProgram[] = [];
  if (notes.length === 0) return out;
  // The original's envelope, and its state where each note's start is weighed from: where
  // its gate went off before the note (GoatTracker's gate timer turns it off there too).
  const vf0 = f.voices[notes[0]!.voice]!;
  const cycles = Math.round(f.clockHz / f.rateHz);
  const clamp = (i: number): number => Math.max(0, Math.min(f.frames - 1, i));
  const startFrom = notes.map((note) => {
    const onset = clamp(note.onset);
    return Math.max(0, Math.min(note.tick0, onset - Math.max(1, gateOffRun(f, note.voice, onset, MAX_HARD_RESTART_GAP))));
  });
  const wanted = new Set(startFrom);
  const states = new Map<number, SidEnvelope>();
  const levels = new Uint8Array(f.frames);
  const env = new SidEnvelope();
  for (let i = 0; i < f.frames; i++) {
    if (wanted.has(i)) states.set(i, env.clone());
    applyEnvelopeFrame(env, envelopeFrame(vf0, i), cycles);
    levels[i] = env.level;
  }
  const ctx: StartContext = { vf: vf0, levels, cycles };
  for (const [n, note] of notes.entries()) {
    const vf = f.voices[note.voice]!;
    const at = (i: number): number => Math.max(0, Math.min(f.frames - 1, i));
    const onset = at(note.onset);
    const base = g === undefined ? baseNote(f, note.voice, onset, Math.min(note.end, onset + 24), tuning) : noteBase(f, g, note, tuning);
    const next = notes[n + 1];
    // The hard-restart tail: gate off in the frames before the next note's gate-on.
    const gapAfter = next === undefined ? null : gateOffRun(f, note.voice, next.onset, MAX_HARD_RESTART_GAP + 1);
    const tailStart = next === undefined || gapAfter === null || gapAfter > MAX_HARD_RESTART_GAP ? note.end : next.onset - gapAfter;
    // The note's own frames: tick 0 + 1 up to the tail (a quantized early gate-on shifts to tick 0 + 1).
    const shift = Math.max(0, note.tick0 + 1 - note.onset);
    const count = Math.min(MAX_PROGRAM_FRAMES, Math.max(1, tailStart - note.tick0 - 1 + shift));
    const frames: ProgramFrame[] = [];
    for (let i = 1; i <= count; i++) {
      const src = at(note.tick0 + i - shift);
      const p = pitchOf(vf.freq[src]!, f.clockHz) - tuning;
      // After a tie or a glide the wave table counts from the note the pattern set.
      const rel = plan !== undefined && plan.base[src]! >= 0 ? plan.base[src]! : base;
      frames.push({
        ctrl: vf.ctrl[src]!,
        pitch: Number.isFinite(p) ? p - rel : null,
        // The first frame sets the note (the wave table's first row), whatever moves it after.
        ...(plan !== undefined && plan.owned[src] && i > 1 ? { owned: true } : {}),
        pw: vf.pw[src]!,
        cutoff: f.cutoff[src]! >> 3,
        resonance: f.resonance[src]!,
        mode: (f.modeVolume[src]! >> 4) & 7,
      });
    }
    // A late gate-off that holds to the end: a key-off; the instrument sustains.
    let keyOff: number | null = null;
    const on = frames.findIndex((x) => x.ctrl & 1);
    if (on >= 0) {
      let j = frames.length;
      while (j > 0 && !(frames[j - 1]!.ctrl & 1)) j--;
      const heldOn = frames.slice(on, j).every((x) => x.ctrl & 1);
      if (heldOn && j < frames.length && j - on > EARLY_GATE_OFF) {
        keyOff = j + 1;
        for (let k = j; k < frames.length; k++) frames[k] = { ...frames[k]!, ctrl: frames[k]!.ctrl | 1 };
      } else if (heldOn && j === frames.length && count === MAX_PROGRAM_FRAMES) {
        // Held past the frames the instrument describes: the gate-off, if any, is further on
        // (a long note, or a legato line of ties); a key-off where it holds to the note's end.
        let off = -1;
        for (let src = note.tick0 + count + 1 - shift; src < tailStart; src++) {
          if (!(vf.ctrl[at(src)]! & 1)) {
            if (off < 0) off = src;
          } else off = -1;
        }
        if (off >= 0) keyOff = off - note.tick0 + shift;
      }
    }
    const gapBefore = gateOffRun(f, note.voice, onset, 40);
    let hardRestartBefore = false;
    for (let k = 1; k <= Math.min(gapBefore, MAX_HARD_RESTART_GAP); k++) {
      const i = onset - k;
      if (i >= 0 && vf.ad[i] === 0 && (vf.sr[i]! & 0x0f) === 0) hardRestartBefore = true;
    }
    // The width as the note goes on, each frame's place in its row.
    const pulse: PulseFrame[] = [];
    // Through a held line's legato notes: their instruments leave the pulse table running.
    const cut = notes.slice(n + 1).find((x) => !x.legato);
    const line = notes.slice(n + 1, cut === undefined ? undefined : notes.indexOf(cut));
    const lineStarts = new Set(line.map((x) => x.tick0));
    const pulseEnd = Math.min(f.frames, cut === undefined ? f.frames : cut.onset, note.tick0 + 1 - shift + MAX_PULSE_FRAMES);
    for (let src = Math.max(0, note.tick0 + 1 - shift); src < pulseEnd; src++) {
      const t = src + shift;
      const r = g === undefined ? note.row : rowOfFrame(g, t);
      pulse.push({
        pw: vf.pw[src]! & 0xfff,
        k: g === undefined ? -1 : t - rowStart(g, r),
        rowLength: g === undefined ? 0 : rowLength(g, r),
        ...(lineStarts.has(t) ? { noteStart: true } : {}),
      });
    }
    const program = {
      note,
      base,
      pulse,
      ad: vf.ad[onset]!,
      sr: vf.sr[onset]!,
      tick0Ctrl: vf.ctrl[at(note.tick0)]!,
      frames,
      gapAfter,
      hardRestartBefore,
      gapBefore,
      keyOff,
      lineFrames: note.legato || line.length === 0 ? 0 : line[line.length - 1]!.end - line[0]!.tick0,
      filter: false,
    };
    let testStartGain = 0;
    if (!note.legato) {
      const from = startFrom[n]!;
      const to = Math.min(f.frames, onset + START_WINDOW, next === undefined ? Infinity : startFrom[n + 1]!);
      const state = states.get(from)!;
      testStartGain = startError(ctx, state, program, from, to, false) - startError(ctx, state, program, from, to, true);
    }
    out.push({ ...program, testStartGain });
  }
  return out;
}
