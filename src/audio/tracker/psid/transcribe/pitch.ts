import { GT_NOTE_REGS, nearestNote, pitchOf, type TraceFrames } from './frames';
import { rowOfFrame, rowStart, type RowGrid } from './grid';
import type { RowNote } from './notes';

/**
 * The pitch a note's pattern plays (plan-psid-import.md §3, pitch effects):
 * what the original does to a sounding note's pitch after it starts, as
 * GoatTracker's pattern commands rather than as more notes or instruments.
 *
 *  - a glide that lands on a note: that note with tone portamento (`3xx`)
 *    on the row the glide starts, at the speed that arrives when the
 *    original does, the command held on the rows it spans;
 *  - a bend that does not land on a note (a fall, a slide into the next
 *    note, a long drop from the note's start): portamento up or down
 *    (`1xx`, `2xx`) on the rows it spans;
 *  - a pitch that moves to another note with no glide and no new gate
 *    (a legato line, a tie): that note with `3 00`, which moves the pitch
 *    without retriggering the note or restarting its instrument.
 *
 * A glide inside a note's first row (a drum's pitch drop, a slide into the
 * note) stays the instrument's, as its wave table plays it. The frames whose
 * pitch a pattern command sets are the pattern's, not the instrument's: the
 * note programs leave them free (`PitchPlan.owned`).
 *
 * GoatTracker's tick effects skip each row's first frame (its realtime
 * optimisation, `player.rs` `continuous`), so a speed is the distance over
 * the frames that move, the rows' first frames left out.
 */

/** A pattern cell the pitch plan writes on a voice's row. */
export interface PitchRow {
  readonly row: number;
  /** GoatTracker note index (0-95) to set, or null for the command alone. */
  readonly note: number | null;
  /** 1 portamento up, 2 down, 3 tone portamento (speed 0: a tie). */
  readonly command: 1 | 2 | 3;
  /** The speed in frequency-register units a moving frame (0 = a tie). */
  readonly speed: number;
  /** A row that keeps an effect started on an earlier row running (it may give way to a tempo command). */
  readonly continued: boolean;
}

export interface PitchPlan {
  readonly rows: PitchRow[];
  /** Per frame of the trace: the pattern sets this frame's pitch (the instrument must not). */
  readonly owned: Uint8Array;
  /** Per frame: the note the pattern last set (the base the instrument's wave table counts from), or -1 (the note's own). */
  readonly base: Int16Array;
}

/** A glide moves at least this far (semitones). */
const MIN_GLIDE = 0.6;
/** A glide's end pitch within this of a note lands on it. */
const LANDS = 0.15;
/** Frame-to-frame changes below this are a held pitch. */
const STILL = 0.02;

/** GoatTracker's register for note `n`, on the PAL clock its table plays at. */
const regOf = (n: number): number => GT_NOTE_REGS[Math.max(0, Math.min(95, n))]!;

/** The frames of the note starting at `note.onset` that sound a pitch: the waveform on, the test bit off, no noise. */
function pitchSeries(f: TraceFrames, voice: number, from: number, to: number, tuning: number): Float64Array {
  const vf = f.voices[voice]!;
  const out = new Float64Array(Math.max(0, to - from)).fill(NaN);
  for (let i = from; i < to; i++) {
    const c = vf.ctrl[i]!;
    if (!(c & 0xf0) || c & 0x08 || c & 0x80) continue;
    const p = pitchOf(vf.freq[i]!, f.clockHz) - tuning;
    if (Number.isFinite(p)) out[i - from] = p;
  }
  return out;
}

interface Run {
  /** First moving frame and last (absolute). */
  readonly a: number;
  readonly b: number;
  readonly dir: 1 | -1;
  /** Pitch before the first moving frame and at the last. */
  readonly from: number;
  readonly to: number;
}

/** The monotonic runs of `p` (frames `base`..): consecutive moving frames that keep one direction. */
function monotonicRuns(p: Float64Array, base: number): Run[] {
  const runs: Run[] = [];
  let start = -1;
  let dir = 0;
  const close = (end: number): void => {
    if (start >= 0) runs.push({ a: base + start, b: base + end, dir: dir as 1 | -1, from: p[start - 1]!, to: p[end]! });
    start = -1;
    dir = 0;
  };
  for (let i = 1; i < p.length; i++) {
    const d = p[i]! - p[i - 1]!;
    // A held pitch, or a jump to another note (an arpeggio step, a new note without a gate):
    // neither is part of a glide.
    const jump = Math.abs(d) >= 2.5 || (Math.abs(d) >= 0.75 && Math.abs(d - Math.round(d)) <= 0.1);
    if (!Number.isFinite(d) || Math.abs(d) < STILL || jump) {
      close(i - 1);
      continue;
    }
    const s = Math.sign(d);
    if (start >= 0 && s !== dir) close(i - 1);
    if (start < 0) {
      start = i;
      dir = s;
    }
  }
  close(p.length - 1);
  return runs.filter((r) => r.b >= r.a);
}

/** Whether every step of the run is a whole number of semitones (an arpeggio walking, not a glide). */
function steppedByNotes(p: Float64Array, base: number, r: Run): boolean {
  for (let i = r.a; i <= r.b; i++) {
    const d = p[i - base]! - p[i - base - 1]!;
    if (Math.abs(d - Math.round(d)) > 0.08 || Math.round(d) === 0) return false;
  }
  return true;
}

/** The glides of a note: runs over `MIN_GLIDE` that are not a vibrato's swing or an arpeggio. */
function glides(p: Float64Array, base: number): Run[] {
  const runs = monotonicRuns(p, base);
  const out: Run[] = [];
  runs.forEach((r, k) => {
    const span = Math.abs(r.to - r.from);
    if (span < MIN_GLIDE || !Number.isFinite(span) || steppedByNotes(p, base, r)) return;
    // A glide moves over several frames; one step that makes most of it is a jump (a vibrato's
    // last swing into a new note, say), not a glide.
    let biggest = 0;
    for (let i = r.a; i <= r.b; i++) biggest = Math.max(biggest, Math.abs(p[i - base]! - p[i - base - 1]!));
    if (r.b - r.a + 1 < 3 || biggest > 0.6 * span) return;
    // A swing: a run the other way right before or after, of a like width (a vibrato, however
    // wide, or a trill). A glide into a note that then vibrates is far wider than the vibrato.
    const near = (o: Run | undefined): boolean => {
      if (o === undefined || o.dir === r.dir) return false;
      const gap = o.a > r.a ? o.a - r.b : r.a - o.b;
      const w = Math.abs(o.to - o.from);
      return gap <= 2 && w >= 0.5 * span && w <= 2 * span;
    };
    if (near(runs[k - 1]) || near(runs[k + 1])) return;
    out.push(r);
  });
  return out;
}

interface Effect {
  readonly kind: 'porta' | 'bend';
  /** First and last row it runs on. */
  readonly r: number;
  readonly rb: number;
  /** Its first moving frame (tick 1 of row `r`) and the original's last. */
  readonly s: number;
  readonly b: number;
  readonly note: number | null;
  readonly speed: number;
  readonly command: 1 | 2 | 3;
  /** The pitch the original ends on. */
  readonly to: number;
}

/** Frames that move in [s, e] (absolute): every frame but the rows' first (GoatTracker's tick effects skip it). */
function movingFrames(g: RowGrid, s: number, e: number): number {
  let n = 0;
  for (let i = s; i <= e; i++) if (rowStart(g, rowOfFrame(g, i)) !== i) n++;
  return n;
}

/**
 * `speed` on a 4% geometric grid, so a song's speeds share few speed-table rows
 * (`up`: the grid value at or above it, for a tone portamento, which stops at
 * its note anyway).
 */
export function gridSpeed(speed: number, up = false): number {
  if (speed <= 16) return Math.max(1, Math.round(speed));
  const k = Math.log(speed / 16) / Math.log(1.04);
  const q = Math.round(16 * 1.04 ** (up ? Math.ceil(k - 1e-9) : Math.round(k)));
  return Math.min(0x7fff, q);
}

/** The register value of pitch `p` (GoatTracker note units, the tuning taken off) on GoatTracker's clock. */
const regOfPitch = (p: number): number => regOf(57) * 2 ** ((p - 57) / 12);

/**
 * The pitch plan of one voice: the pattern cells its glides, bends and ties
 * take, and the frames they own. `notes`: the voice's notes on rows (gate-ons);
 * `baseOf`: each note's own note index (the row's note).
 */
export function planPitch(
  f: TraceFrames,
  g: RowGrid,
  notes: readonly RowNote[],
  baseOf: (note: RowNote) => number,
  tuning: number,
): PitchPlan {
  const owned = new Uint8Array(f.frames);
  const base = new Int16Array(f.frames).fill(-1);
  const rows: PitchRow[] = [];
  if (notes.length === 0) return { rows, owned, base };
  const voice = notes[0]!.voice;
  const delay = g.delays[voice] ?? 0;
  const taken = new Set<number>(notes.map((n) => n.row));
  const frameOfTick = (r: number, t: number): number => rowStart(g, r) + t + delay;
  for (const [n, note] of notes.entries()) {
    const from = Math.max(0, note.onset);
    const next = notes[n + 1];
    const to = Math.min(f.frames, next === undefined ? f.frames : next.onset);
    if (to - from < 3) continue;
    const p = pitchSeries(f, voice, from, to, tuning);
    const firstRowEnd = frameOfTick(note.row + 1, 1);
    // Frames from `at` on hold the note the pattern set there (until a later setting).
    const setBase = (at: number, value: number): void => {
      for (let i = Math.max(from, at); i < to; i++) base[i] = value;
    };
    const own = (a: number, b: number): void => {
      for (let i = Math.max(from, a); i <= Math.min(to - 1, b); i++) owned[i] = 1;
    };
    // The glides, as effects on rows (nothing written yet).
    const effects: Effect[] = [];
    let lastEnd = from;
    for (const gl of glides(p, from)) {
      if (gl.a <= lastEnd) continue;
      // Inside the note's first row: the instrument's.
      if (gl.b < firstRowEnd && gl.a - from <= 2) continue;
      // The row whose second frame (tick 1) is at or before the glide's first moving frame.
      const r = Math.max(note.row, rowOfFrame(g, gl.a - 1 - delay));
      const rb = Math.max(r, rowOfFrame(g, gl.b - delay));
      const prevEffect = effects[effects.length - 1];
      if (prevEffect !== undefined && r <= prevEffect.rb) continue;
      let clash = false;
      for (let k = r + 1; k <= rb; k++) if (taken.has(k)) clash = true;
      if (clash) continue;
      // On the note's own row the wave table's first row sets the note on tick 1: the effect moves from tick 2.
      const s = frameOfTick(r, r === note.row ? 2 : 1);
      const lands = Math.abs(gl.to - Math.round(gl.to)) <= LANDS;
      if (lands && r > note.row) {
        const t = nearestNote(gl.to);
        const dist = Math.abs(regOf(t) - regOfPitch(gl.from));
        const speed = gridSpeed(Math.ceil(dist / Math.max(1, movingFrames(g, s, gl.b))), true);
        effects.push({ kind: 'porta', r, rb, s, b: gl.b, note: t, speed, command: 3, to: gl.to });
      } else {
        // A bend: the speed that reaches the end pitch by the end of the last row it spans
        // (the command runs to the row's end); the pitch then stays where it went.
        const endFrame = frameOfTick(rb + 1, 0) - 1;
        const dist = Math.abs(regOfPitch(gl.to) - regOfPitch(gl.from));
        const speed = gridSpeed(dist / Math.max(1, movingFrames(g, s, endFrame)));
        effects.push({ kind: 'bend', r, rb, s, b: gl.b, note: null, speed, command: gl.to > gl.from ? 1 : 2, to: gl.to });
      }
      lastEnd = gl.b;
    }
    // The rows in order: each glide's rows, and on the rows between, a tie where the held
    // pitch moves to another note. After a bend the pitch is the pattern's until a tie or
    // a glide sets a note again.
    let current: number | null = baseOf(note);
    let bentTo = 0;
    let bendFrom = -1;
    const endBend = (at: number): void => {
      if (bendFrom >= 0) own(bendFrom, at - 1);
      bendFrom = -1;
    };
    const lastRow = rowOfFrame(g, to - 1 - delay);
    let ei = 0;
    for (let r = note.row; r <= lastRow; r++) {
      const eff = effects[ei];
      if (eff !== undefined && eff.r === r) {
        ei++;
        if (eff.kind === 'porta') {
          endBend(eff.s);
          rows.push({ row: r, note: eff.note, command: 3, speed: eff.speed, continued: false });
          for (let k = r + 1; k <= eff.rb; k++) rows.push({ row: k, note: null, command: 3, speed: eff.speed, continued: true });
          own(eff.s, eff.b);
          setBase(eff.b + 1, eff.note!);
          current = eff.note;
        } else {
          endBend(eff.s);
          for (let k = r; k <= eff.rb; k++) rows.push({ row: k, note: null, command: eff.command, speed: eff.speed, continued: k > r });
          bendFrom = eff.s;
          bentTo = eff.to;
          current = null;
        }
        for (let k = r; k <= eff.rb; k++) taken.add(k);
        r = eff.rb;
        continue;
      }
      if (r === note.row || taken.has(r)) continue;
      const s = frameOfTick(r, 1);
      const e = Math.min(to, frameOfTick(r + 1, 1));
      if (e - s < 2) continue;
      // Only while the gate stays on: a pitch that changes as the note is let go is its release
      // (the row keeps its note column for the key-off).
      const held: number[] = [];
      const ctrl = f.voices[voice]!.ctrl;
      let released = false;
      for (let i = s; i < e; i++) {
        if (!(ctrl[i]! & 1)) {
          released = true;
          continue;
        }
        const v = p[i - from];
        if (v !== undefined && Number.isFinite(v)) held.push(nearestNote(v));
      }
      if (released) continue;
      if (held.length < 2) continue;
      held.sort((x, y) => x - y);
      if (held[held.length - 1]! - held[0]! > 2) continue;
      const pitch = held[held.length >> 1]!;
      const moved =
        current === null ? pitch !== nearestNote(bentTo) || Math.abs(bentTo - Math.round(bentTo)) > LANDS : pitch !== current;
      if (moved) {
        endBend(s);
        rows.push({ row: r, note: pitch, command: 3, speed: 0, continued: false });
        taken.add(r);
        setBase(s, pitch);
        current = pitch;
      }
    }
    endBend(to);
  }
  return { rows, owned, base };
}
