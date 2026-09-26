import type { SidInstrument, SidTableRow } from 'src/audio/tracker/sid-doc';
import type { NoteProgram, ProgramFrame } from './notes';

/**
 * Instruments of a transcription (plan-psid-import.md §3). Notes are grouped
 * in two steps:
 *
 *  1. by timbre: the envelope, whether a pulse sounds, and the frames the note
 *     plays (control byte and whole-semitone pitch per frame); a shorter note
 *     whose frames are the start of a longer one's joins it, and a frame whose
 *     pitch lies between semitones (a vibrato, a slide) matches any pitch;
 *  2. by vibrato: within a timbre, the notes whose pitch swings (the long
 *     notes, in Hubbard's players) and those whose pitch holds become two
 *     instruments sharing the timbre's tables.
 *
 * Each becomes a GoatTracker instrument whose tables replay the timbre's
 * longest note:
 *
 *  - the wave table: one row per frame (waveform byte, gate included, and the
 *    note: relative to the row's note, absolute past the relative range, or
 *    "no change" while a vibrato moves the pitch; a slide as the nearest
 *    notes), a repeating tail as a loop (arpeggios), runs of unchanged frames
 *    as delay rows, a stop once it holds;
 *  - the pulse table: the shape of the width's movement (steady, one sweep,
 *    a triangle between two widths, a sawtooth) in a few rows;
 *  - the instrument vibrato: GoatTracker's calculated speed (the step to the
 *    next note shifted right, what Hubbard's players compute), fitted to the
 *    period and depth of the pitch's swing, with its delay;
 *  - the envelope as the note starts, the first-frame waveform with the gate
 *    off (the row starts a frame before the gate, `grid.ts`), and the hard
 *    restart the frames before its notes show: envelope zeroed (GT's hard
 *    restart), gate off only (no hard restart), or a single frame (no gate-off;
 *    the first-frame waveform takes the gate off).
 */

/** Frames whose pitch lies this close to a whole semitone are that note. */
const PITCH_SNAP = 0.12;
/** The most instruments a song holds. */
export const MAX_TRANSCRIBED_INSTRUMENTS = 63;

/** Semitones from the row's note; `a<n>`: absolute note n (noise, whose pitch does not follow the melody); between semitones; no frequency. */
type PitchClass = number | `a${number}` | 'free' | 'none';

interface Timbre {
  readonly ad: number;
  readonly sr: number;
  readonly pulse: boolean;
  /** Notes that start without a gate-on (`RowNote.legato`). */
  readonly legato: boolean;
  /** For a note that drives the filter: its mode and $D417 as it starts; '' otherwise. */
  readonly filter: string;
  /** Per frame: the control byte and the pitch class. */
  readonly ctrl: readonly number[];
  readonly pitch: readonly PitchClass[];
}

/** Notes of one timbre. */
export interface NoteGroup {
  readonly timbre: Timbre;
  /** The longest member: its frames define the tables. */
  readonly rep: NoteProgram;
  readonly members: NoteProgram[];
}

/** One instrument to build: a timbre, with or without its vibrato. */
export interface InstrumentPlan {
  readonly group: NoteGroup;
  vibrato: VibratoFit | null;
  readonly members: NoteProgram[];
}

/** The pitch class of frame `f` of a note on `base`. */
const pitchClass = (f: ProgramFrame, base: number): PitchClass => {
  if (f.pitch === null) return 'none';
  const k = Math.round(f.pitch);
  if (Math.abs(f.pitch - k) > PITCH_SNAP) return 'free';
  // Noise: its pitch is the drum's, whatever the note.
  if (f.ctrl & 0x80) return `a${Math.max(1, Math.min(95, base + k))}`;
  return k;
};

function timbreOf(p: NoteProgram): Timbre {
  return {
    ad: p.ad,
    sr: p.sr,
    pulse: p.frames.some((f) => f.ctrl & 0x40),
    legato: p.note.legato,
    filter: p.filter && p.frames.length > 0 ? `${p.frames[0]!.mode},${p.frames[0]!.resonance}` : '',
    ctrl: p.frames.map((f) => f.ctrl),
    pitch: p.frames.map((f) => pitchClass(f, p.base)),
  };
}

/** `short` plays the start of what `long` plays (a between-semitones pitch matches any). */
function isPrefix(short: Timbre, long: Timbre): boolean {
  if (short.ad !== long.ad || short.sr !== long.sr || short.pulse !== long.pulse || short.legato !== long.legato || short.filter !== long.filter) return false;
  if (short.ctrl.length > long.ctrl.length) return false;
  for (let i = 0; i < short.ctrl.length; i++) {
    if (short.ctrl[i] !== long.ctrl[i]) return false;
    const a = short.pitch[i];
    const b = long.pitch[i];
    if (a !== b && a !== 'free' && b !== 'free') return false;
  }
  return true;
}

/** How unlike two timbres sound (for merging past the instrument limit). */
function distance(a: Timbre, b: Timbre): number {
  let d = 0;
  if (a.ad !== b.ad) d += 6;
  if (a.sr !== b.sr) d += 6;
  if (a.pulse !== b.pulse) d += 2;
  if (a.legato !== b.legato) d += 20;
  if (a.filter !== b.filter) d += 4;
  // Over the first 12 frames either plays; a frame only one plays differs.
  const n = Math.min(12, Math.max(a.ctrl.length, b.ctrl.length));
  for (let i = 0; i < n; i++) {
    if (a.ctrl[i] !== b.ctrl[i]) d += 1;
    if (a.pitch[i] !== b.pitch[i]) d += 1;
  }
  return d;
}

const vibratoKey = (v: VibratoFit): string => `${v.left},${v.right}`;

/** The instrument plans of `programs`: timbres, split by vibrato; never more than `max` (the least used merge into their nearest). */
export function groupNotes(programs: readonly NoteProgram[], max = MAX_TRANSCRIBED_INSTRUMENTS): InstrumentPlan[] {
  const sorted = [...programs].sort((a, b) => b.frames.length - a.frames.length);
  const groups: NoteGroup[] = [];
  for (const p of sorted) {
    const timbre = timbreOf(p);
    const home = groups.find((g) => isPrefix(timbre, g.timbre));
    if (home !== undefined) home.members.push(p);
    else groups.push({ timbre, rep: p, members: [p] });
  }
  const plans: InstrumentPlan[] = [];
  for (const g of groups) {
    const still: NoteProgram[] = [];
    const swinging: NoteProgram[] = [];
    const fits = new Map<string, { fit: VibratoFit; count: number }>();
    for (const m of g.members) {
      const fit = fitVibrato(m);
      if (fit === null) {
        still.push(m);
        continue;
      }
      swinging.push(m);
      const key = vibratoKey(fit);
      const seen = fits.get(key);
      if (seen === undefined) fits.set(key, { fit, count: 1 });
      else seen.count++;
    }
    if (swinging.length > 0) {
      const best = [...fits.values()].sort((a, b) => b.count - a.count)[0]!.fit;
      const delays = swinging.map((m) => fitVibrato(m)?.delay ?? best.delay).sort((a, b) => a - b);
      plans.push({ group: g, vibrato: { ...best, delay: delays[delays.length >> 1]! }, members: swinging });
    }
    if (still.length > 0) plans.push({ group: g, vibrato: null, members: still });
  }
  while (plans.length > max) {
    plans.sort((a, b) => b.members.length - a.members.length);
    const victim = plans.pop()!;
    let best = plans[0]!;
    let bestD = Infinity;
    for (const p of plans) {
      const d = distance(victim.group.timbre, p.group.timbre) + (p.group === victim.group ? -100 : 0);
      if (d < bestD) [best, bestD] = [p, d];
    }
    best.members.push(...victim.members);
  }
  return plans;
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

/** One table program before it is placed: jump rows (left $FF) hold 1-based targets inside the program (0 = stop). */
export interface TableProgram {
  readonly rows: readonly SidTableRow[];
}

export interface TableSnapshot {
  readonly wave: number;
  readonly pulse: number;
  readonly filter: number;
  readonly speed: number;
  readonly placed: ReadonlyMap<string, number>;
}

/**
 * The four GoatTracker tables being filled, each program placed once: the
 * same rows twice share one copy (jumps are program-relative until placed).
 */
export class TableBuilder {
  readonly wave: SidTableRow[] = [];
  readonly pulse: SidTableRow[] = [];
  readonly filter: SidTableRow[] = [];
  readonly speed: SidTableRow[] = [];
  private readonly placed = new Map<string, number>();

  /** Place `program` in `table`; its 1-based start row. */
  place(table: 'wave' | 'pulse' | 'filter', program: TableProgram): number {
    if (program.rows.length === 0) return 0;
    const key = `${table}:${program.rows.map((r) => `${r.left},${r.right}`).join(';')}`;
    const at = this.placed.get(key);
    if (at !== undefined) return at;
    const rows = this[table];
    const start = rows.length + 1;
    for (const r of program.rows) rows.push(r.left === 0xff && r.right !== 0 ? { left: 0xff, right: r.right + start - 1 } : r);
    this.placed.set(key, start);
    return start;
  }

  /** A speed-table row (left, right); its 1-based row. */
  speedRow(left: number, right: number): number {
    const key = `speed:${left},${right}`;
    const at = this.placed.get(key);
    if (at !== undefined) return at;
    this.speed.push({ left, right });
    this.placed.set(key, this.speed.length);
    return this.speed.length;
  }

  get fits(): boolean {
    return this.wave.length <= 255 && this.pulse.length <= 255 && this.filter.length <= 255 && this.speed.length <= 255;
  }

  /** The tables' state, to go back to with `restore`. */
  snapshot(): TableSnapshot {
    return { wave: this.wave.length, pulse: this.pulse.length, filter: this.filter.length, speed: this.speed.length, placed: new Map(this.placed) };
  }

  restore(s: TableSnapshot): void {
    this.wave.length = s.wave;
    this.pulse.length = s.pulse;
    this.filter.length = s.filter;
    this.speed.length = s.speed;
    this.placed.clear();
    for (const [k, v] of s.placed) this.placed.set(k, v);
  }
}

// ---------------------------------------------------------------------------
// Wave table
// ---------------------------------------------------------------------------

/** The wave-table left byte for control byte `ctrl` (GT: $10-$DF as is, $00-$0F as $E0-$EF); null past $DF. */
function waveLeft(ctrl: number): number | null {
  if (ctrl >= 0x10 && ctrl <= 0xdf) return ctrl;
  if (ctrl < 0x10) return 0xe0 | ctrl;
  return null;
}

/** The wave-table right byte for a note `offset` semitones from the row's note `base` (relative, or absolute past its range). */
function noteRight(base: number, offset: number): number {
  if (offset >= -32 && offset <= 95 && base + offset >= 0 && base + offset <= 95) return offset & 0x7f;
  return 0x80 | Math.max(1, Math.min(95, base + offset));
}

const NO_CHANGE = 0x80;

export interface WaveStep {
  readonly left: number;
  readonly right: number;
  /** A wave-table command row ($F7: set the whole waveform byte). */
  readonly command?: boolean;
}

/** Frames (0-based) of `frames` whose between-semitones pitch belongs to a slide: a monotonic run over half a semitone or more. */
function slideFrames(frames: readonly ProgramFrame[]): Set<number> {
  const out = new Set<number>();
  const free = (f: ProgramFrame): boolean => pitchClass(f, 0) === 'free';
  let i = 0;
  while (i < frames.length) {
    if (!free(frames[i]!)) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < frames.length && free(frames[j + 1]!)) j++;
    const run = frames.slice(Math.max(0, i - 1), Math.min(frames.length, j + 2)).map((f) => f.pitch ?? 0);
    const diffs = run.slice(1).map((p, k) => p - run[k]!);
    const monotonic = diffs.every((d) => d >= -0.01) || diffs.every((d) => d <= 0.01);
    if (monotonic && Math.abs(run[run.length - 1]! - run[0]!) >= 0.5) for (let k = i; k <= j; k++) out.add(k);
    i = j + 1;
  }
  return out;
}

/**
 * The per-frame wave steps of a note (frames 1..n): its waveform and note.
 * `vibratoFrom`: from this frame (1-based) on the pitch is left to the vibrato.
 */
export function waveSteps(rep: NoteProgram, vibratoFrom: number | null): WaveStep[] {
  const steps: WaveStep[] = [];
  let lastNote: number | null = null;
  // Where the vibrato takes over, the note it swings around (the mean of its swing).
  const centre =
    vibratoFrom === null
      ? null
      : Math.round(
          rep.frames.slice(vibratoFrom - 1).reduce((a, f) => a + (f.pitch ?? 0), 0) / Math.max(1, rep.frames.length - vibratoFrom + 1),
        );
  rep.frames.forEach((f, i) => {
    const frame = i + 1;
    const pc = pitchClass(f, rep.base);
    let right = NO_CHANGE;
    const free = vibratoFrom !== null && frame >= vibratoFrom;
    if (free && frame === vibratoFrom && centre !== null && rep.base + centre !== lastNote) {
      // GoatTracker's vibrato swings around the last note set: set the centre as it starts.
      right = noteRight(rep.base, centre);
      lastNote = rep.base + centre;
    }
    if (!free) {
      // The note the frame sounds (absolute index), and how the row says it.
      let target: number | null = null;
      let code = NO_CHANGE;
      if (typeof pc === 'number') {
        target = rep.base + pc;
        code = noteRight(rep.base, pc);
      } else if (typeof pc === 'string' && pc.startsWith('a')) {
        target = Number(pc.slice(1));
        code = 0x80 | target;
      } else if (f.pitch !== null) {
        // Between semitones (a slide, a detuned note): the nearest note GoatTracker's table has.
        target = rep.base + Math.round(f.pitch);
        code = noteRight(rep.base, Math.round(f.pitch));
      }
      if (target !== null && target !== lastNote) {
        right = code;
        lastNote = target;
      }
    }
    const left = waveLeft(f.ctrl);
    if (left === null) {
      // A $F7 row sets the waveform only: the note waits for the next row.
      steps.push({ left: 0xf7, right: f.ctrl, command: true });
      if (right !== NO_CHANGE) lastNote = null;
    } else {
      steps.push({ left, right });
    }
  });
  return steps;
}

const sameStep = (a: WaveStep, b: WaveStep): boolean => a.left === b.left && a.right === b.right && !!a.command === !!b.command;

/**
 * The wave program of `steps`: a repeating tail becomes a loop, a run of
 * frames that change nothing becomes a delay row, and the program stops once
 * nothing changes any more.
 */
export function waveProgram(steps: readonly WaveStep[]): TableProgram {
  if (steps.length === 0) return { rows: [{ left: 0xff, right: 0 }] };
  const n = steps.length;
  // The loop: the smallest period P whose repetition covers the note's end, from the earliest start.
  // The last few frames may break the pattern (the next note's hard restart
  // nearing): a repetition that stops up to 3 frames short still counts.
  let loopStart = -1;
  let period = 0;
  for (let p = 2; p <= Math.min(16, Math.floor(n / 2)); p++) {
    for (let end = n; end >= Math.max(2 * p, n - 3); end--) {
      let s = end - p;
      while (s - 1 >= 0 && sameStep(steps[s - 1]!, steps[s - 1 + p]!)) s--;
      if (end - s < 2 * p) continue;
      const body = steps.slice(s, s + p);
      const changes = body.some((b) => b.right !== NO_CHANGE) || new Set(body.map((b) => b.left)).size > 1;
      if (changes && (loopStart < 0 || s + p < loopStart + period)) {
        loopStart = s;
        period = p;
      }
    }
  }
  let body: WaveStep[];
  if (loopStart >= 0) {
    body = steps.slice(0, loopStart + period);
  } else {
    // Stop after the last frame that changes the waveform or the note.
    let last = 0;
    for (let i = 1; i < n; i++) {
      if (steps[i]!.right !== NO_CHANGE || steps[i]!.left !== steps[i - 1]!.left || steps[i]!.command) last = i;
    }
    body = steps.slice(0, last + 1);
  }
  // Delay rows for runs of frames that change nothing (not inside the loop, whose rows are jumped to).
  const rows: SidTableRow[] = [];
  const rowOfStep: number[] = [];
  const compressTo = loopStart >= 0 ? loopStart : body.length;
  for (let i = 0; i < body.length; ) {
    const s = body[i]!;
    rowOfStep[i] = rows.length;
    rows.push({ left: s.left, right: s.right });
    if (i + 1 < compressTo && !s.command) {
      let j = i + 1;
      while (j < compressTo && !body[j]!.command && body[j]!.right === NO_CHANGE && body[j]!.left === s.left && j - (i + 1) < 16) j++;
      const run = j - (i + 1);
      if (run >= 2) {
        // A delay row of N lasts N + 1 frames.
        rows.push({ left: run - 1, right: NO_CHANGE });
        for (let k = i + 1; k < j; k++) rowOfStep[k] = rows.length - 1;
        i = j;
        continue;
      }
    }
    i++;
  }
  rows.push({ left: 0xff, right: loopStart >= 0 ? rowOfStep[loopStart]! + 1 : 0 });
  return { rows };
}

// ---------------------------------------------------------------------------
// Pulse table
// ---------------------------------------------------------------------------

const median = (values: readonly number[]): number => {
  const s = [...values].sort((a, b) => a - b);
  return s[s.length >> 1]!;
};

/**
 * The pulse program of a note's frames, by the shape of the width's movement:
 * steady (one set row), one sweep, a triangle between two widths (the
 * direction turns), or a sawtooth (the width jumps back). A step is at most
 * 127 a frame (GoatTracker's speed byte); a faster sweep keeps its timing
 * and covers a smaller range. Null: no pulse waveform.
 */
export function pulseProgram(frames: readonly ProgramFrame[]): TableProgram | null {
  if (!frames.some((f) => f.ctrl & 0x40)) return null;
  const pw = frames.map((f) => f.pw & 0xfff);
  const set = (w: number): SidTableRow => ({ left: 0x80 | ((w >> 8) & 0x0f), right: w & 0xff });
  const deltas = pw.slice(1).map((w, i) => w - pw[i]!);
  const moving = deltas.filter((d) => d !== 0);
  if (moving.length === 0) return { rows: [set(pw[0]!), { left: 0xff, right: 0 }] };
  const counts = new Map<number, number>();
  for (const d of moving) counts.set(Math.abs(d), (counts.get(Math.abs(d)) ?? 0) + 1);
  const size = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]![0];
  const step = Math.min(127, size);
  const firstDir = Math.sign(moving[0]!);
  const speed = (dir: number): number => (dir * step) & 0xff;
  const jumps: number[] = [];
  const turns: number[] = [];
  let dir = firstDir;
  deltas.forEach((d, i) => {
    if (d === 0) return;
    if (Math.abs(d) > size * 2.5) jumps.push(i + 1);
    else if (Math.sign(d) !== dir) {
      turns.push(i + 1);
      dir = Math.sign(d);
    }
  });
  const time = (n: number): number => Math.max(1, Math.min(127, Math.round(n)));
  if (jumps.length > 0) {
    const run = jumps.length > 1 ? median(jumps.slice(1).map((j, k) => j - jumps[k]!)) : pw.length - jumps[0]!;
    return {
      rows: [set(pw[0]!), { left: time(jumps[0]! - 1), right: speed(firstDir) }, set(pw[jumps[0]!]!), { left: time(run - 1), right: speed(firstDir) }, { left: 0xff, right: 3 }],
    };
  }
  if (turns.length > 0) {
    const half = turns.length > 1 ? median(turns.slice(1).map((t, k) => t - turns[k]!)) : pw.length - turns[0]!;
    return {
      rows: [set(pw[0]!), { left: time(turns[0]!), right: speed(firstDir) }, { left: time(half), right: speed(-firstDir) }, { left: time(half), right: speed(firstDir) }, { left: 0xff, right: 3 }],
    };
  }
  return { rows: [set(pw[0]!), { left: time(pw.length), right: speed(firstDir) }, { left: 0xff, right: 0 }] };
}

// ---------------------------------------------------------------------------
// Filter table
// ---------------------------------------------------------------------------

/**
 * The filter program of a note that drives the filter: its mode, resonance
 * and routing and its cutoff on the first frame (one frame: GoatTracker runs
 * a set-cutoff row right after a set-mode row), then the cutoff's runs of
 * equal steps (8-bit, as GoatTracker's cutoff is), a step past a signed byte
 * as a set row; a repeating tail loops. Holds after its last row.
 */
export function filterProgram(frames: readonly ProgramFrame[]): TableProgram {
  const first = frames[0]!;
  const rows: SidTableRow[] = [
    { left: 0x80 | ((first.mode & 7) << 4), right: first.resonance },
    { left: 0x00, right: first.cutoff },
  ];
  const cut = frames.map((f) => f.cutoff);
  const segs: [number, number][] = [];
  for (let i = 1; i < cut.length; i++) {
    const d = cut[i]! - cut[i - 1]!;
    const last = segs[segs.length - 1];
    if (last !== undefined && last[0] === d && last[1] < 127) last[1]++;
    else segs.push([d, 1]);
  }
  while (segs.length > 0 && segs[segs.length - 1]![0] === 0) segs.pop();
  let value = first.cutoff;
  for (const [step, n] of segs.slice(0, 8)) {
    if (step >= -128 && step <= 127) rows.push({ left: n, right: step & 0xff });
    else {
      // A jump: set the value it lands on, then the rest of the run.
      value += step;
      rows.push({ left: 0x00, right: value & 0xff });
      if (n > 1) rows.push({ left: n - 1, right: 0 });
      value += step * (n - 1);
      continue;
    }
    value += step * n;
  }
  rows.push({ left: 0xff, right: 0 });
  return { rows };
}

// ---------------------------------------------------------------------------
// Vibrato
// ---------------------------------------------------------------------------

/** GoatTracker's vibrato (player.s `mt_effect_4`) for compare value `speed`: per frame, +1 (add) or -1 (subtract). */
function gtVibratoDirections(speed: number, frames: number): number[] {
  const out: number[] = [];
  let time = 0;
  for (let f = 0; f < frames; f++) {
    let a = time;
    if (a & 0x80 || a <= speed) a = (a + 2) & 0xff;
    else a = ((a ^ 0xff) + 2) & 0xff;
    time = a;
    out.push(a & 1 ? -1 : 1);
  }
  return out;
}

interface VibratoShape {
  readonly period: number;
  /** Peak to peak, in steps. */
  readonly span: number;
}

const VIBRATO_SHAPES: ReadonlyMap<number, VibratoShape> = (() => {
  const m = new Map<number, VibratoShape>();
  for (let s = 1; s <= 30; s++) {
    let pos = 0;
    const path = gtVibratoDirections(s, 200).map((d) => (pos += d));
    const tail = path.slice(100);
    const span = Math.max(...tail) - Math.min(...tail);
    for (let p = 2; p < 64; p++) {
      if (tail.slice(0, 60).every((v, i) => v === tail[i + p])) {
        m.set(s, { period: p, span });
        break;
      }
    }
  }
  return m;
})();

export interface VibratoFit {
  /** Speed-table left byte ($80 | compare value: the depth calculated from the note step) and right (the shift). */
  readonly left: number;
  readonly right: number;
  /** GoatTracker's instrument vibrato delay (1 = at once). */
  readonly delay: number;
  /** The frame (1-based) the vibrato takes the pitch from. */
  readonly from: number;
}

/** A GoatTracker vibrato for the swing of `rep`'s pitch after its gate goes on, or null when it holds still or slides. */
export function fitVibrato(rep: NoteProgram): VibratoFit | null {
  const frames = rep.frames;
  const gateOn = Math.max(0, frames.findIndex((f) => f.ctrl & 1));
  const slides = slideFrames(frames);
  const start = frames.findIndex((f, i) => i > gateOn && pitchClass(f, rep.base) === 'free' && !slides.has(i));
  if (start < 0) return null;
  const pitches = frames.slice(start).map((f) => f.pitch ?? 0);
  if (pitches.length < 6) return null;
  const turns: number[] = [];
  for (let i = 1; i + 1 < pitches.length; i++) {
    if (pitches[i]! - pitches[i - 1]! > 0 && pitches[i + 1]! - pitches[i]! <= 0) turns.push(i);
  }
  if (turns.length < 2) return null;
  const period = median(turns.slice(1).map((t, i) => t - turns[i]!));
  const span = Math.max(...pitches) - Math.min(...pitches);
  if (period < 2 || span < 0.05) return null;
  let speed = 1;
  let bestErr = Infinity;
  for (const [s, shape] of VIBRATO_SHAPES) {
    const err = Math.abs(shape.period - period);
    if (err < bestErr) [speed, bestErr] = [s, err];
  }
  const shape = VIBRATO_SHAPES.get(speed)!;
  // One step of the calculated speed is 1 / 2^shift of the note step.
  const shift = Math.max(0, Math.min(8, Math.round(Math.log2(shape.span / span))));
  const from = start + 1;
  return { left: 0x80 | speed, right: shift, delay: Math.max(1, from - 1), from };
}

// ---------------------------------------------------------------------------
// Instruments
// ---------------------------------------------------------------------------

const mode = <T>(values: readonly T[]): T | undefined => {
  const counts = new Map<T, number>();
  let best: T | undefined;
  let count = 0;
  for (const v of values) {
    const c = (counts.get(v) ?? 0) + 1;
    counts.set(v, c);
    if (c > count) [best, count] = [v, c];
  }
  return best;
};

/**
 * The first-frame waveform of a note that starts with a gate-on, which
 * GoatTracker writes on the row's first tick, after the note's attack/decay
 * and sustain/release; the note's pitch and waveform follow on the next tick
 * (the wave table's first row, the original's gate-on frame). Two ways, and
 * the SID's envelope tells them apart (`NoteProgram.testStartGain`, the
 * members' sum decides):
 *
 *  - the gate on, the test bit holding the oscillator silent ($09): the
 *    envelope starts a frame early, right after the gate-off before it, and
 *    the frame that still has the last note's pitch is silent. After a hard
 *    restart this is the one that sounds: with the gate off here, the note's
 *    own release rate would run the envelope's rate counter for a frame, and
 *    the chip's ADSR delay bug would then hold the attack up to 33 ms (a
 *    one-frame drum hit would never sound);
 *  - the gate off, in the waveform the original had on this frame: the
 *    attack starts on the original's frame. A note whose one frame of
 *    gate-off is this one (`noGateOff`: GoatTracker keeps the gate on up to
 *    here) must have it, or it would never retrigger.
 */
function firstWave(plan: InstrumentPlan): number {
  if (plan.group.timbre.legato) return 0x00;
  if (plan.members.reduce((sum, m) => sum + m.testStartGain, 0) > 0) return 0x09;
  // A waveform GoatTracker takes as one ($00, $FE, $FF are commands), gate off.
  const ok = (w: number): boolean => w >= 0x10 && w !== 0xfe && w !== 0xff && !(w & 1);
  const seen = mode(plan.members.map((m) => m.tick0Ctrl & 0xfe).filter(ok));
  if (seen !== undefined) return seen;
  const own = (plan.group.rep.frames.find((f) => f.ctrl & 1)?.ctrl ?? 0x41) & 0xfe;
  return ok(own) ? own : 0x10;
}

/** How GoatTracker ends and starts notes of `plan`, from what the original did around them. */
function noteTiming(plan: InstrumentPlan, rowFrames: number): Pick<SidInstrument, 'gateTimer' | 'hardRestart' | 'noGateOff'> {
  const members = plan.members;
  const legato = plan.group.timbre.legato;
  // The gap before this instrument's notes decides how GoatTracker ends the note before.
  const gapBefore = mode(members.map((m) => Math.min(m.gapBefore, 9))) ?? 2;
  const hardRestart = members.filter((m) => m.hardRestartBefore).length * 2 > members.length;
  // The gap after its notes decides how early the next row is read (the gate timer): the
  // gate goes off `gapAfter` frames before the next gate-on, GoatTracker's `gateTimer` frames
  // before the next row's first frame, which is 1 + the voice's delay before it.
  const delay = Math.max(0, (mode(members.map((m) => m.note.onset - m.note.tick0)) ?? 1) - 1);
  const gapAfter = mode(members.flatMap((m) => (m.gapAfter !== null && m.gapAfter <= 9 ? [m.gapAfter] : [])));
  const gateTimer = Math.max(1, Math.min(Math.max(1, rowFrames - 1), (gapAfter ?? 2) - 1 - delay));
  // A legato note: no gate-off before it (GoatTracker's $40 gate-timer bit).
  return { gateTimer, hardRestart: hardRestart && !legato, noGateOff: legato || gapBefore <= 1 };
}

/** Rows `programs` take once identical ones share a copy. */
function sharedRows(programs: readonly TableProgram[]): number {
  const seen = new Set<string>();
  let rows = 0;
  for (const p of programs) {
    const key = p.rows.map((r) => `${r.left},${r.right}`).join(';');
    if (seen.has(key)) continue;
    seen.add(key);
    rows += p.rows.length;
  }
  return rows;
}

/** Per step of `plan`'s wave program, how many of its notes play that far. */
function stepUsage(plan: InstrumentPlan, steps: number): number[] {
  const usage = new Array<number>(steps).fill(0);
  for (const m of plan.members) for (let i = 0; i < Math.min(steps, m.frames.length); i++) usage[i]!++;
  return usage;
}

/**
 * The wave programs of `plans`, cut to fit `budget` rows between them: while
 * they do not, the program whose next cut loses the fewest note-frames (its
 * notes that play past the cut; nothing when it still loops) gives up its
 * last frame, which then holds.
 */
function fitWavePrograms(plans: readonly InstrumentPlan[], budget: number): TableProgram[] {
  const steps = plans.map((p) => waveSteps(p.group.rep, p.vibrato?.from ?? null));
  const cuts = steps.map((s) => s.length);
  const usage = plans.map((p, i) => stepUsage(p, steps[i]!.length));
  const programs = steps.map((s) => waveProgram(s));
  const loops = (prog: TableProgram): boolean => {
    const last = prog.rows[prog.rows.length - 1];
    return last !== undefined && last.left === 0xff && last.right !== 0;
  };
  let total = sharedRows(programs);
  while (total > budget) {
    let best = -1;
    let bestCost = Infinity;
    for (let i = 0; i < plans.length; i++) {
      if (cuts[i]! <= 1) continue;
      const next = waveProgram(steps[i]!.slice(0, cuts[i]! - 1));
      // A cut that saves no row yet costs a little (it leads to one that does).
      const lost = loops(next) ? 0 : usage[i]!.slice(cuts[i]! - 1).reduce((a, b) => a + b, 0);
      const cost = lost / Math.max(1, programs[i]!.rows.length - next.rows.length + 0.5);
      if (cost < bestCost) [best, bestCost] = [i, cost];
    }
    if (best < 0) break;
    cuts[best]!--;
    programs[best] = waveProgram(steps[best]!.slice(0, cuts[best]!));
    total = sharedRows(programs);
  }
  return programs;
}

/**
 * The GoatTracker instruments of `plans`, their programs placed in `tables`
 * within GoatTracker's 255 rows a table: wave programs cut where they cost
 * least (`fitWavePrograms`), and when the pulse programs do not fit, the
 * least-used share the most-used one. `rowFrames`: the shortest row, which a
 * gate timer must stay below; `name`: each instrument's name.
 */
export function buildInstruments(
  plans: readonly InstrumentPlan[],
  tables: TableBuilder,
  rowFrames: number,
  name: (plan: InstrumentPlan, n: number) => string,
): SidInstrument[] {
  const waveBudget = 255 - tables.wave.length;
  const wave = fitWavePrograms(plans, waveBudget);
  const pulse = plans.map((p) => pulseProgram(p.group.rep.frames));
  const pulseBudget = 255 - tables.pulse.length;
  const byUse = plans.map((p, i) => [p.members.length, i] as const).sort((a, b) => b[0] - a[0]);
  while (sharedRows(pulse.filter((x): x is TableProgram => x !== null)) > pulseBudget) {
    // The least-used plan with a program of its own takes the most-used one's.
    const donor = byUse.map(([, i]) => pulse[i]).find((x) => x !== null && x !== undefined) ?? null;
    const victim = [...byUse].reverse().find(([, i]) => pulse[i] !== null && pulse[i] !== donor);
    if (victim === undefined || donor === null) break;
    pulse[victim[1]] = donor;
  }
  return plans.map((plan, i) => {
    const rep = plan.group.rep;
    const members = plan.members;
    const vib = plan.vibrato;
    const ad = mode(members.map((m) => m.ad)) ?? rep.ad;
    const sr = mode(members.map((m) => m.sr)) ?? rep.sr;
    const p = pulse[i];
    const timing = noteTiming(plan, rowFrames);
    return {
      name: name(plan, i + 1).slice(0, 16),
      attack: ad >> 4,
      decay: ad & 0x0f,
      sustain: sr >> 4,
      release: sr & 0x0f,
      // A legato note keeps the waveform and gate as they are ($00).
      firstWave: firstWave(plan),
      ...timing,
      vibratoDelay: vib === null ? 0 : Math.min(255, vib.delay),
      wavePtr: tables.place('wave', wave[i]!),
      pulsePtr: p === null || p === undefined ? 0 : tables.place('pulse', p),
      filterPtr: plan.group.timbre.filter !== '' ? tables.place('filter', filterProgram(rep.frames)) : 0,
      speedPtr: vib === null ? 0 : tables.speedRow(vib.left, vib.right),
    };
  });
}
