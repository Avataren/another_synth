/**
 * The row grid of a transcription (plan-psid-import.md §3): where the rows
 * of the GoatTracker song fall in the trace's frames.
 *
 * Rows are laid over the notes: each starts where a voice's note needs a row
 * (one frame before the gate goes on: GoatTracker writes a note's pitch on
 * the frame after its gate, the wave table's first row, so the transcribed
 * instrument's first-frame waveform has the gate off and its wave table's
 * first row sets waveform, gate and pitch on the original's frame), and
 * between notes the rows keep the tune's current length. A row's length is
 * GoatTracker's tempo: an `F` command wherever it changes (`tempoChanges`).
 * So a steady tempo is one `F`, and Knucklebusters' rows of 9, 9 and 10
 * frames, or Comic Bakery's one short row that shifts its beat, are played
 * frame for frame.
 *
 * A voice whose notes start later in the row than the earliest voice's
 * (Last Ninja's third voice, two frames) keeps that as a delay, played by its
 * instruments' wave tables.
 */

export interface RowGrid {
  /** The first frame of every row, ascending; row `k` is frames [starts[k], starts[k + 1]). May start at -1. */
  readonly starts: readonly number[];
  /** Per voice: its notes' gate goes on at the row's first frame + 1 + delay. */
  readonly delays: readonly number[];
  /** Share of the note starts that land on a row start (the rest are moved or folded into a note). */
  readonly coverage: number;
}

/** Row lengths are 3 or more frames: GoatTracker's shortest `F` tempo. */
export const MIN_ROW_FRAMES = 3;
/** GoatTracker's longest `F` tempo. */
export const MAX_ROW_FRAMES = 127;
const MAX_STEADY_ROW = 64;
/** A steady tempo that places this share of the note starts is taken whole. */
const GOOD_COVERAGE = 0.995;

/** The length of row `k` (past the end: the last row's). */
export function rowLength(g: RowGrid, k: number): number {
  const s = g.starts;
  if (s.length < 2) return 6;
  const i = Math.min(k, s.length - 2);
  return s[i + 1]! - s[i]!;
}

/** The first frame of row `k` (past the end: continued at the last length). */
export function rowStart(g: RowGrid, k: number): number {
  const s = g.starts;
  if (k < s.length) return s[Math.max(0, k)]!;
  return s[s.length - 1]! + (k - s.length + 1) * rowLength(g, s.length - 1);
}

/** The row whose frames contain `frame` (frames before the first row: row 0). */
export function rowOfFrame(g: RowGrid, frame: number): number {
  const s = g.starts;
  if (frame < s[0]!) return 0;
  const last = s[s.length - 1]!;
  if (frame >= last) return s.length - 1 + Math.floor((frame - last) / rowLength(g, s.length - 1));
  let lo = 0;
  let hi = s.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (s[mid]! <= frame) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Per voice, the phase (mod `t`) that puts most onsets on row starts, and how many it puts there. */
function steadyFit(onsets: readonly (readonly number[])[], t: number): { phases: (number | null)[]; hits: number } {
  const phases: (number | null)[] = [];
  let hits = 0;
  for (const list of onsets) {
    if (list.length === 0) {
      phases.push(null);
      continue;
    }
    const counts = new Array<number>(t).fill(0);
    for (const o of list) counts[((o % t) + t) % t]!++;
    let best = 0;
    for (let p = 1; p < t; p++) if (counts[p]! > counts[best]!) best = p;
    phases.push(best);
    hits += counts[best]!;
  }
  return { phases, hits };
}

/** The largest steady length that places `share` of the onsets, with its phases; null if none. */
function steadyTempo(onsets: readonly (readonly number[])[], share: number): { t: number; phases: (number | null)[]; hits: number } | null {
  const total = onsets.reduce((n, l) => n + l.length, 0);
  for (let t = MAX_STEADY_ROW; t >= MIN_ROW_FRAMES; t--) {
    const f = steadyFit(onsets, t);
    if (f.hits >= share * total) return { t, ...f };
  }
  return null;
}

/** Per-voice delays for per-voice phases (mod `t`): after the earliest voice's, smallest worst case. */
function delaysFor(phases: readonly (number | null)[], t: number): { delays: number[]; start: number } {
  let start = 0;
  let bestWorst = Infinity;
  for (let s = 0; s < t; s++) {
    let worst = 0;
    for (const p of phases) if (p !== null) worst = Math.max(worst, (((p - 1 - s) % t) + t) % t);
    if (worst < bestWorst) [bestWorst, start] = [worst, s];
  }
  return { delays: phases.map((p) => (p === null ? 0 : Math.min(MIN_ROW_FRAMES - 1, (((p - 1 - start) % t) + t) % t))), start };
}

/**
 * The most common row length of the tune, window by window (for laying rows
 * between notes). A tune with no steady window (rows of 9, 9 and 10 frames
 * throughout) takes the most common distance between consecutive note starts.
 */
function typicalLength(onsets: readonly (readonly number[])[], frames: number): number {
  const window = 400;
  const votes = new Map<number, number>();
  for (let a = 0; a < frames; a += window) {
    const part = onsets.map((l) => l.filter((o) => o >= a && o < a + window));
    if (part.reduce((n, l) => n + l.length, 0) < 6) continue;
    const s = steadyTempo(part, 0.97);
    if (s !== null) votes.set(s.t, (votes.get(s.t) ?? 0) + 1);
  }
  if (votes.size === 0) {
    const starts = [...new Set(onsets.flat())].sort((a, b) => a - b);
    for (let i = 1; i < starts.length; i++) {
      const gap = starts[i]! - starts[i - 1]!;
      if (gap >= MIN_ROW_FRAMES && gap <= MAX_STEADY_ROW) votes.set(gap, (votes.get(gap) ?? 0) + 1);
    }
  }
  let best = 6;
  let count = 0;
  for (const [t, c] of votes) if (c > count || (c === count && t > best)) [best, count] = [t, c];
  return best;
}

/**
 * Per-voice delays from how the voices' note starts sit against each other:
 * a voice whose notes start a frame or two after another's (where they start
 * together in the music) is that much later in every row. Relative to the
 * voice with most notes; the earliest voice has delay 0.
 */
function pairwiseDelays(onsets: readonly (readonly number[])[]): number[] {
  const n = onsets.length;
  const ref = onsets.reduce((best, l, v) => (l.length > onsets[best]!.length ? v : best), 0);
  const offset = (v: number, u: number): number | null => {
    const a = onsets[v]!;
    const b = onsets[u]!;
    if (a.length === 0 || b.length === 0) return null;
    const counts = new Map<number, number>();
    let close = 0;
    let j = 0;
    for (const o of a) {
      while (j + 1 < b.length && Math.abs(b[j + 1]! - o) <= Math.abs(b[j]! - o)) j++;
      const d = o - b[j]!;
      if (Math.abs(d) <= MIN_ROW_FRAMES - 1) {
        close++;
        counts.set(d, (counts.get(d) ?? 0) + 1);
      }
    }
    if (close < 4) return null;
    const [d, c] = [...counts.entries()].sort((x, y) => y[1] - x[1])[0]!;
    return c >= 0.6 * close ? d : null;
  };
  const rel = Array.from({ length: n }, (_, v) => (v === ref ? 0 : offset(v, ref)));
  // A voice with no clear offset against the reference: via another voice.
  for (let v = 0; v < n; v++) {
    if (rel[v] !== null) continue;
    for (let u = 0; u < n; u++) {
      if (u === v || rel[u] === null || u === ref) continue;
      const d = offset(v, u);
      if (d !== null) {
        rel[v] = d + rel[u]!;
        break;
      }
    }
  }
  const known = rel.map((d) => d ?? 0);
  const min = Math.min(...known);
  return known.map((d) => Math.max(0, Math.min(MIN_ROW_FRAMES - 1, d - min)));
}

/**
 * The grid for per-voice note starts `onsets` (frames, ascending) over a
 * trace of `frames` frames: one steady length when it places 99.5 % of the
 * notes and is the tune's typical row (not a finer grid that happens to fit),
 * else rows laid note by note at the tune's typical length.
 */
export function detectGrid(onsets: readonly (readonly number[])[], frames: number): RowGrid {
  const total = onsets.reduce((n, l) => n + l.length, 0);
  if (total === 0) return steadyGrid(6, -1, frames, onsets.map(() => 0), 1);
  const typical = typicalLength(onsets, frames);
  const steady = steadyTempo(onsets, GOOD_COVERAGE);
  if (steady !== null && steady.t >= typical) {
    const { delays, start } = delaysFor(steady.phases, steady.t);
    const first = Math.min(...onsets.flatMap((l, v) => (l.length > 0 ? [l[0]! - 1 - delays[v]!] : [])));
    let origin = start + Math.floor((first - start) / steady.t) * steady.t;
    if (origin < -1) origin += steady.t;
    return steadyGrid(steady.t, origin, frames, delays, steady.hits / total);
  }
  const delays = pairwiseDelays(onsets);
  const anchors = [...new Set(onsets.flatMap((l, v) => l.map((o) => o - 1 - delays[v]!)))].sort((a, b) => a - b);
  return laidGrid(anchors, typical, frames, delays);
}

function steadyGrid(t: number, origin: number, frames: number, delays: readonly number[], coverage: number): RowGrid {
  const starts: number[] = [];
  for (let r = origin; r < frames; r += t) starts.push(r);
  if (starts.length === 0) starts.push(origin);
  return { starts, delays, coverage };
}

/**
 * Rows laid over `anchors` (the frames rows should start at): each row is
 * the current length, shortened or lengthened by up to two frames to start
 * on the next anchor, or cut short at an anchor that comes early; the
 * current length follows the rows that land on anchors.
 */
function laidGrid(anchors: readonly number[], typical: number, frames: number, delays: readonly number[]): RowGrid {
  const origin = Math.max(-1, anchors[0]! - typical * Math.floor((anchors[0]! + 1) / typical));
  const starts = [origin];
  const recent: number[] = [];
  let length = typical;
  let i = 0;
  let hit = anchors[0] === origin ? 1 : 0;
  let r = origin;
  while (r < frames - 1) {
    while (i < anchors.length && anchors[i]! <= r) i++;
    const a = i < anchors.length ? anchors[i]! : Infinity;
    const next = r + length;
    let end: number;
    if (a < next) {
      if (a - r >= MIN_ROW_FRAMES) end = a;
      else {
        // Too close to this row's start: the note folds into this row.
        i++;
        continue;
      }
    } else if (a < next + MIN_ROW_FRAMES && a - r <= MAX_ROW_FRAMES) {
      end = a;
    } else {
      end = next;
    }
    starts.push(end);
    if (end === a) {
      hit++;
      recent.push(end - r);
      if (recent.length > 12) recent.shift();
      // The current length: the most common of the recent rows that landed on notes.
      const counts = new Map<number, number>();
      for (const x of recent) counts.set(x, (counts.get(x) ?? 0) + 1);
      let best = length;
      let c = 0;
      for (const [x, n] of counts) if (n > c || (n === c && x === length)) [best, c] = [x, n];
      length = best;
    }
    r = end;
  }
  return { starts, delays, coverage: anchors.length === 0 ? 1 : hit / anchors.length };
}

/** Rows whose length differs from the row before (and row 0): GoatTracker needs an `F` command there. */
export function tempoChanges(g: RowGrid, rows: number): { row: number; length: number }[] {
  const out: { row: number; length: number }[] = [];
  let prev = -1;
  for (let k = 0; k < rows; k++) {
    const len = Math.max(MIN_ROW_FRAMES, Math.min(MAX_ROW_FRAMES, rowLength(g, k)));
    if (len !== prev) out.push({ row: k, length: len });
    prev = len;
  }
  return out;
}
