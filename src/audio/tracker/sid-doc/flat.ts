import { BLANK_SID_ROW, makeSidDoc, sidDocProblem } from './doc';
import { GT_MAX_ORDERLIST_BYTES, GT_MAX_TRANSPOSE, GT_MIN_TRANSPOSE } from './gt-sng-common';
import { gtOrderlistByteLength } from './gt-sng-write';
import {
  SID_MAX_PATTERN_ROWS,
  SID_MAX_PATTERNS,
  SID_MAX_REPEAT,
  SID_MAX_SUBSONGS,
  SID_MIN_PATTERN_ROWS,
  type SidDoc,
  type SidDocPattern,
  type SidDocRow,
  type SidOpResult,
  type SidOrderEntry,
  type SidOrderlist,
} from './types';

/**
 * The flat SID song (plan-sid-authoring.md phase 2, as agreed with Morten
 * 2026-09-25): what the editor edits. The same shape as every other song in
 * the tracker, a sequence of song-wide patterns, so the one sequence editor
 * and grid serve it; GoatTracker's per-voice structure is compiled from it
 * (`compileSidFlatSong`) whenever it changes, and that doc is what plays and
 * what every export writes.
 *
 *  - A flat pattern holds, per voice, one cell: the voice's raw rows and the
 *    transpose they play under. Raw rows, not the grid's entries: the grid
 *    cannot show a key-on or a note its display clamps, and they must survive.
 *    The grid shows notes as they sound (`sidRowToEntry(row, r, transpose)`).
 *  - Every voice changes pattern at every position, so compiling cuts each
 *    voice at every position boundary; identical cells become one GT pattern
 *    and consecutive identical entries a repeat. So compile then flatten gives
 *    the same positions back (pattern ids aside).
 *  - `restarts`: per voice, the sequence index its orderlist loops back to
 *    (metadata; a native song has no loop point). An imported song whose
 *    voices drift keeps looping exactly as in GoatTracker (`flattenSidDoc`).
 */

/**
 * One voice of a flat pattern: its rows (as many as the pattern's), the
 * transpose they play under, and whether the voice starts a GoatTracker
 * pattern here. That is audible: GT's playroutine skips a voice's pulse-table
 * step on the frame it starts a pattern (gplay.c:853, `optimizepulse`, on in
 * every GT build and in `player.rs`), so an imported song keeps its voices'
 * pattern starts and compile cuts exactly there.
 */
export interface SidFlatCell {
  readonly transpose: number;
  readonly rows: readonly SidDocRow[];
  /** The voice starts a GoatTracker pattern at this position (a new position: true). */
  readonly start: boolean;
}

/** A song-wide pattern: `rows` rows, one cell per voice. */
export interface SidFlatPattern {
  readonly rows: number;
  readonly cells: readonly SidFlatCell[];
}

/** One subsong, flat: patterns by id, the sequence of ids, the per-voice loop points. */
export interface SidFlatSubsong {
  readonly patterns: Readonly<Record<string, SidFlatPattern>>;
  readonly sequence: readonly string[];
  /** Per voice, the sequence index it loops back to after the last. */
  readonly restarts: readonly number[];
}

/** The id flatten gives position `index` (stable across a re-flatten). */
export const sidFlatPatternId = (index: number): string => `sid-pos-${index}`;

/** A cell of `rows` blank rows. */
export const blankSidFlatCell = (rows: number): SidFlatCell => ({ transpose: 0, rows: Array.from({ length: rows }, () => BLANK_SID_ROW), start: true });

/** `cell` cut or padded (blank rows) to `rows` rows. */
export function resizeSidFlatCell(cell: SidFlatCell, rows: number): SidFlatCell {
  if (cell.rows.length === rows) return cell;
  const next = cell.rows.length > rows ? cell.rows.slice(0, rows) : [...cell.rows, ...Array.from({ length: rows - cell.rows.length }, () => BLANK_SID_ROW)];
  return { ...cell, rows: next };
}

// ---------------------------------------------------------------------------
// GoatTracker -> flat
// ---------------------------------------------------------------------------

interface Segment {
  readonly start: number;
  readonly pattern: number;
  readonly transpose: number;
  readonly length: number;
}

/** A voice's orderlist in rows: the first pass, then round from `restart` until `total`. */
function timeline(doc: SidDoc, list: SidOrderlist, total: number): Segment[] {
  const segments: Segment[] = [];
  let at = 0;
  const push = (index: number) => {
    const entry = list.entries[index] as SidOrderEntry;
    const length = (doc.patterns[entry.pattern] as SidDocPattern).rows.length;
    for (let r = 0; r < entry.repeat; r++) {
      segments.push({ start: at, pattern: entry.pattern, transpose: entry.transpose, length });
      at += length;
    }
  };
  list.entries.forEach((_, i) => push(i));
  while (at < total) for (let i = list.restart; i < list.entries.length && at < total; i++) push(i);
  return segments;
}

/** A voice's loop in rows: where its first pass's patterns start, where its loop starts, and its length. */
interface VoiceLoop {
  readonly starts: ReadonlySet<number>;
  readonly loopStart: number;
  readonly firstPass: number;
}

function voiceLoop(doc: SidDoc, list: SidOrderlist): VoiceLoop {
  const starts = new Set<number>();
  let at = 0;
  let loopStart = 0;
  list.entries.forEach((e, i) => {
    if (i === list.restart) loopStart = at;
    for (let r = 0; r < e.repeat; r++) {
      starts.add(at);
      at += (doc.patterns[e.pattern] as SidDocPattern).rows.length;
    }
  });
  return { starts, loopStart, firstPass: at };
}

/** Where, in its first pass, a voice is at song row `t` (it loops from its restart). */
const phaseOf = (v: VoiceLoop, t: number): number => (t < v.firstPass ? t : v.loopStart + ((t - v.loopStart) % (v.firstPass - v.loopStart)));

/**
 * How long subsong `subsong` is as a flat song. At least the longest voice's
 * first pass; `exact` looks further, up to 64 times that, for the first row
 * where every voice is at the start of one of its patterns. A voice then
 * loops back to a pattern start of its own, which a GT orderlist can do; at
 * any other length a voice that loops back into the middle of a pattern gets
 * a pattern cut there, and GoatTracker skips that voice's pulse step on the
 * frame it plays the cut (gplay.c:853).
 */
function flatLength(loops: readonly VoiceLoop[], exact: boolean): number {
  const first = Math.max(...loops.map((v) => v.firstPass));
  if (!exact) return first;
  const aligned = (t: number) => loops.every((v) => v.starts.has(phaseOf(v, t)));
  for (let t = first; t <= first * 64; t++) if (aligned(t)) return t;
  return first;
}

/**
 * Subsong `subsong` of `doc` as a flat song, `exact` (the default) or at the
 * longest voice's first pass (`flatLength`). A shorter voice is laid out
 * round its loop until the end, as it plays. A position starts wherever any
 * voice starts a pattern, and where a voice must loop back to: the row whose
 * place in that voice's loop is the end's, so looping from it plays on as
 * GoatTracker does, for ever. A voice's cell there starts a pattern (an
 * orderlist loops to an entry).
 */
export function flattenSidSubsong(doc: SidDoc, subsong: number, exact = true): SidFlatSubsong {
  const lists = (doc.subsongs[subsong] ?? doc.subsongs[0])!.orderlists;
  const loops = lists.map((list) => voiceLoop(doc, list));
  const total = flatLength(loops, exact);
  const lines = lists.map((list) => timeline(doc, list, total));
  // The row each voice loops back to: where its loop is when the song ends.
  const restartRows = loops.map((v) => phaseOf(v, total));
  const bounds = new Set<number>(restartRows);
  for (const line of lines) for (const s of line) if (s.start < total) bounds.add(s.start);
  const starts = [...bounds].sort((a, b) => a - b);
  const cursor = lines.map(() => 0);
  const patterns: Record<string, SidFlatPattern> = {};
  const sequence: string[] = [];
  starts.forEach((start, index) => {
    const end = starts[index + 1] ?? total;
    const cells = lines.map((line, c): SidFlatCell => {
      let k = cursor[c] as number;
      while (k + 1 < line.length && (line[k + 1] as Segment).start <= start) k += 1;
      cursor[c] = k;
      const seg = line[k] as Segment;
      const rows = (doc.patterns[seg.pattern] as SidDocPattern).rows;
      const offset = start - seg.start;
      return { transpose: seg.transpose, rows: rows.slice(offset, offset + end - start), start: offset === 0 || start === restartRows[c] };
    });
    const id = sidFlatPatternId(index);
    patterns[id] = { rows: end - start, cells };
    sequence.push(id);
  });
  return { patterns, sequence, restarts: restartRows.map((row) => starts.indexOf(row)) };
}

/**
 * Every subsong of `doc`, flat: exact loops where the song then still fits
 * GoatTracker (compiled), else every subsong at its first pass.
 */
export function flattenSidDoc(doc: SidDoc): SidFlatSubsong[] {
  const exact = doc.subsongs.map((_, s) => flattenSidSubsong(doc, s, true));
  if (compileSidFlatSong(doc, exact).ok) return exact;
  return doc.subsongs.map((_, s) => flattenSidSubsong(doc, s, false));
}

// ---------------------------------------------------------------------------
// flat -> GoatTracker
// ---------------------------------------------------------------------------

const rowKey = (rows: readonly SidDocRow[]): string => rows.map((r) => `${r.note},${r.instrument},${r.command},${r.param}`).join(';');

/**
 * Why subsong `s` of a flat song cannot be compiled, before anything is built
 * (an empty sequence, a missing pattern, a pattern or cell of the wrong size,
 * a transpose GoatTracker cannot hold), or null.
 */
function flatSubsongProblem(flat: SidFlatSubsong, s: number, channels: number): string | null {
  const where = s === 0 ? '' : ` (subsong ${s})`;
  if (flat.sequence.length === 0) return `The song needs at least one pattern in its sequence${where}.`;
  for (const id of flat.sequence) {
    const pattern = flat.patterns[id];
    if (pattern === undefined) return `The sequence names a pattern the song does not have${where}.`;
    if (!Number.isInteger(pattern.rows) || pattern.rows < SID_MIN_PATTERN_ROWS || pattern.rows > SID_MAX_PATTERN_ROWS) {
      return `A SID pattern has ${SID_MIN_PATTERN_ROWS}-${SID_MAX_PATTERN_ROWS} rows (one has ${pattern.rows})${where}.`;
    }
    if (pattern.cells.length !== channels) return `A SID pattern has ${channels} voices${where}.`;
    for (const cell of pattern.cells) {
      if (cell.rows.length !== pattern.rows) return `A voice of a pattern has not the pattern's ${pattern.rows} rows${where}.`;
      if (!Number.isInteger(cell.transpose) || cell.transpose < GT_MIN_TRANSPOSE || cell.transpose > GT_MAX_TRANSPOSE) {
        return `A GoatTracker orderlist transposes ${GT_MIN_TRANSPOSE}..+${GT_MAX_TRANSPOSE} semitones, not ${cell.transpose}${where}.`;
      }
    }
  }
  return null;
}

/** One voice's run of positions compiled as one GT pattern: its rows (concatenated), transpose, first position. */
interface Piece {
  rows: SidDocRow[];
  transpose: number;
  first: number;
}

/**
 * The GoatTracker doc of a flat song: `base`'s everything (texts, chip,
 * speed, instruments, tables) with its patterns and orderlists built from
 * `subsongs`.
 *
 * Each voice is cut into GT patterns where its cells say it starts one
 * (`SidFlatCell.start`), and also at the first position, at its restart (an
 * orderlist loops to an entry), where the transpose changes, and where a
 * pattern would pass 128 rows. Identical patterns are one (shared across
 * voices and subsongs); consecutive identical entries are one repeated entry
 * (never across the restart). For a flattened import that rebuilds the song's
 * own pattern starts, so both players play it as before, frame for frame.
 *
 * Refused, with the true reason, when the song does not fit GoatTracker:
 * more than 208 distinct voice patterns, or an orderlist over 254 bytes.
 */
export function compileSidFlatSong(base: SidDoc, subsongs: readonly SidFlatSubsong[]): SidOpResult {
  if (subsongs.length < 1 || subsongs.length > SID_MAX_SUBSONGS) return { ok: false, reason: `A song has 1-${SID_MAX_SUBSONGS} subsongs.` };
  const channels = base.channels;
  for (const [s, flat] of subsongs.entries()) {
    const problem = flatSubsongProblem(flat, s, channels);
    if (problem !== null) return { ok: false, reason: problem };
  }
  const cellOf = (flat: SidFlatSubsong, i: number, c: number) => (flat.patterns[flat.sequence[i] as string] as SidFlatPattern).cells[c] as SidFlatCell;
  // Per subsong, per voice: its GT patterns in order.
  const pieces: Piece[][][] = subsongs.map((flat) => {
    const n = flat.sequence.length;
    return Array.from({ length: channels }, (_, c) => {
      const restart = Math.max(0, Math.min(n - 1, flat.restarts[c] ?? 0));
      const out: Piece[] = [];
      let open: Piece | null = null;
      for (let i = 0; i < n; i++) {
        const cell = cellOf(flat, i, c);
        if (open !== null && !cell.start && i !== restart && open.transpose === cell.transpose && open.rows.length + cell.rows.length <= SID_MAX_PATTERN_ROWS) {
          open.rows.push(...cell.rows);
          continue;
        }
        open = { rows: cell.rows.slice(), transpose: cell.transpose, first: i };
        out.push(open);
      }
      return out;
    });
  });

  const pool = new Map<string, number>();
  const patterns: SidDocPattern[] = [];
  const built = [];
  for (const [s, flat] of subsongs.entries()) {
    const orderlists: SidOrderlist[] = [];
    for (let c = 0; c < channels; c++) {
      const restart = Math.max(0, Math.min(flat.sequence.length - 1, flat.restarts[c] ?? 0));
      const entries: SidOrderEntry[] = [];
      let restartEntry = 0;
      for (const piece of (pieces[s] as Piece[][])[c] as Piece[]) {
        const key = rowKey(piece.rows);
        let index = pool.get(key);
        if (index === undefined) {
          index = patterns.length;
          pool.set(key, index);
          patterns.push({ rows: piece.rows });
        }
        const last = entries[entries.length - 1];
        if (last !== undefined && piece.first !== restart && last.pattern === index && last.transpose === piece.transpose && last.repeat < SID_MAX_REPEAT) {
          entries[entries.length - 1] = { ...last, repeat: last.repeat + 1 };
          continue;
        }
        if (piece.first === restart) restartEntry = entries.length;
        entries.push({ pattern: index, transpose: piece.transpose, repeat: 1 });
      }
      const list: SidOrderlist = { entries, restart: restartEntry };
      const bytes = gtOrderlistByteLength(list);
      if (bytes > GT_MAX_ORDERLIST_BYTES) {
        const where = subsongs.length > 1 ? ` in subsong ${s}` : '';
        return {
          ok: false,
          reason: `Voice ${c + 1}'s GoatTracker orderlist${where} would take ${bytes} bytes; GoatTracker's holds ${GT_MAX_ORDERLIST_BYTES}. Use fewer or longer patterns.`,
        };
      }
      orderlists.push(list);
    }
    built.push({ orderlists });
  }
  if (patterns.length > SID_MAX_PATTERNS) {
    return {
      ok: false,
      reason: `The song needs ${patterns.length} different voice patterns; GoatTracker holds ${SID_MAX_PATTERNS}. Reuse patterns, or make them longer.`,
    };
  }
  const fields: SidDoc = { ...base, patterns, subsongs: built };
  const problem = sidDocProblem(fields);
  return problem === null ? { ok: true, doc: makeSidDoc(fields) } : { ok: false, reason: `That edit would break the song: ${problem}.` };
}

const subsongDocs = new WeakMap<SidDoc, Map<number, SidDoc>>();

/**
 * `doc` with subsong `subsong` as its only one: what the player is handed to
 * play that subsong (it plays subsong 0). Everything else is `doc`'s own
 * objects. The same doc for the same `(doc, subsong)`, so a transport can
 * tell by identity whether it holds it; `doc` itself for subsong 0 of a
 * one-subsong song.
 */
export function sidDocForSubsong(doc: SidDoc, subsong: number): SidDoc {
  const s = Math.max(0, Math.min(doc.subsongs.length - 1, subsong));
  if (s === 0 && doc.subsongs.length === 1) return doc;
  let byDoc = subsongDocs.get(doc);
  if (byDoc === undefined) subsongDocs.set(doc, (byDoc = new Map()));
  let one = byDoc.get(s);
  if (one === undefined) byDoc.set(s, (one = makeSidDoc({ ...doc, subsongs: [doc.subsongs[s]!] })));
  return one;
}

// ---------------------------------------------------------------------------
// Song settings on the flat song: tempo (D6), multispeed, subsongs
// ---------------------------------------------------------------------------

export type SidFlatEdit =
  | { readonly ok: true; readonly doc: SidDoc; readonly subsongs: readonly SidFlatSubsong[] }
  | { readonly ok: false; readonly reason: string };

const hexDigits = (v: number, digits: number): string => v.toString(16).toUpperCase().padStart(digits, '0');

/**
 * The frames per row every subsong starts at, with no F command: the doc's
 * tempo (always 6 in a doc the app writes, D6) per 1x, which is GoatTracker's
 * 6 frames per row per 1x; or instrument 63's AD byte when instrument 63 has
 * no wave table and an AD of 2 or more (gplay.c:207-221, GT's hidden song
 * tempo). The Rust player starts at the same (`SidSongPlayer::start_tempo`,
 * sid_decisions.md §4).
 */
export function sidImpliedTempo(doc: SidDoc): number {
  const last = doc.instruments[62];
  if (last !== undefined && last.wavePtr === 0) {
    const ad = (last.attack << 4) | last.decay;
    if (ad >= 2) return ad;
  }
  return Math.min(255, doc.tempo * doc.speedMultiplier);
}

/** The lowest start tempo GoatTracker plays the song at: above every instrument's gate timer, and 3 at least. */
export function sidMinTempo(doc: SidDoc): number {
  return Math.max(3, ...doc.instruments.map((ins) => ins.gateTimer + 1));
}

/** Row 0 of voice 1 of the subsong's first position: where its start tempo is written (D6). */
function tempoCellOf(flat: SidFlatSubsong): { id: string; cell: SidFlatCell } | null {
  const id = flat.sequence[0];
  const cell = id === undefined ? undefined : flat.patterns[id]?.cells[0];
  return id === undefined || cell === undefined ? null : { id, cell };
}

/**
 * A subsong's start tempo in frames per row at the song's multispeed rate:
 * the F command on row 0 of voice 1 of its first position, or GoatTracker's
 * implied start (`sidImpliedTempo`). `null` when that row holds an F the
 * setting cannot show (funktempo F00-F02, or a one-voice tempo F80+).
 */
export function sidFlatTempo(doc: SidDoc, flat: SidFlatSubsong): number | null {
  const at = tempoCellOf(flat);
  const row = at?.cell.rows[0];
  if (row === undefined || row.command !== 0xf) return sidImpliedTempo(doc);
  return row.param >= 3 && row.param <= 127 ? row.param : null;
}

/** `flat` with row 0 of voice 1 of its first position replaced by `row`. */
function withTempoRow(flat: SidFlatSubsong, row: SidDocRow): SidFlatSubsong {
  const at = tempoCellOf(flat) as { id: string; cell: SidFlatCell };
  const pattern = flat.patterns[at.id] as SidFlatPattern;
  const rows = at.cell.rows.slice();
  rows[0] = row;
  const cells = pattern.cells.slice();
  cells[0] = { ...at.cell, rows };
  return { ...flat, patterns: { ...flat.patterns, [at.id]: { ...pattern, cells } } };
}

/**
 * Sets subsong `subsong`'s start tempo (frames per row at the multispeed
 * rate), GoatTracker's way (D6): an F command on row 0 of voice 1 of its first
 * position, which sets every voice before any plays a row. `doc.tempo` stays
 * 6. At 1x, tempo 6 (GT's own start) removes the command; at multispeed it is
 * always written, so GT and our player start alike (sid_decisions.md §4).
 * Refused when that row has another command, and below `sidMinTempo`:
 * GoatTracker stops a song when voice 1 plays an instrument whose gate timer
 * is not shorter than a row (gplay.c:333).
 */
export function setSidFlatTempo(doc: SidDoc, subsongs: readonly SidFlatSubsong[], subsong: number, tempo: number): SidFlatEdit {
  const flat = subsongs[subsong];
  const at = flat === undefined ? null : tempoCellOf(flat);
  if (flat === undefined || at === null) return { ok: false, reason: `There is no subsong ${subsong}.` };
  if (!Number.isInteger(tempo) || tempo < 3 || tempo > 127) return { ok: false, reason: 'A tempo is 3-127 frames per row (GoatTracker\'s F command).' };
  const worst = doc.instruments.reduce((best, ins, i) => (ins.gateTimer >= tempo && (best < 0 || ins.gateTimer > (doc.instruments[best] as SidDoc['instruments'][number]).gateTimer) ? i : best), -1);
  if (worst >= 0) {
    const gate = (doc.instruments[worst] as SidDoc['instruments'][number]).gateTimer;
    return {
      ok: false,
      reason: `Tempo ${tempo} is too low: instrument ${worst + 1}'s gate timer is ${gate} frames, and GoatTracker stops the song when voice 1 plays an instrument whose gate timer is not shorter than a row. The lowest tempo is ${sidMinTempo(doc)}.`,
    };
  }
  const row = at.cell.rows[0] as SidDocRow;
  if (row.command !== 0 && row.command !== 0xf) {
    return {
      ok: false,
      reason: `The start tempo is an F command on the first row of voice 1, and that row already has command ${hexDigits(row.command, 1)}${hexDigits(row.param, 2)}.`,
    };
  }
  const implied = doc.speedMultiplier === 1 && tempo === 6 && sidImpliedTempo(doc) === 6;
  const next: SidDocRow = implied ? { ...row, command: 0, param: 0 } : { ...row, command: 0xf, param: tempo };
  if (next.command === row.command && next.param === row.param) return { ok: true, doc, subsongs };
  const out = subsongs.slice();
  out[subsong] = withTempoRow(flat, next);
  return { ok: true, doc, subsongs: out };
}

/**
 * Sets the multispeed (1-16 player ticks per frame). An F command keeps its
 * frames per row, as in GoatTracker (the rows get shorter); a subsong with no
 * F starts at GT's implied 6 per 1x, which at multispeed is written as one
 * (D6), so both players start alike. Refused when that row holds another
 * command.
 */
export function setSidFlatSpeed(doc: SidDoc, subsongs: readonly SidFlatSubsong[], speedMultiplier: number): SidFlatEdit {
  if (!Number.isInteger(speedMultiplier) || speedMultiplier < 1 || speedMultiplier > 16) return { ok: false, reason: 'The speed is 1-16x.' };
  if (speedMultiplier === doc.speedMultiplier) return { ok: true, doc, subsongs };
  const next: SidDoc = makeSidDoc({ ...doc, speedMultiplier });
  if (speedMultiplier === 1) return { ok: true, doc: next, subsongs };
  const tempo = sidImpliedTempo(next);
  const out = subsongs.slice();
  for (const [s, flat] of subsongs.entries()) {
    const at = tempoCellOf(flat);
    const row = at?.cell.rows[0];
    if (row === undefined || row.command === 0xf) continue;
    if (row.command !== 0) {
      return {
        ok: false,
        reason: `At ${speedMultiplier}x ${subsongs.length > 1 ? `subsong ${s}` : 'the song'} needs its start tempo as an F command on the first row of voice 1, and that row already has command ${hexDigits(row.command, 1)}${hexDigits(row.param, 2)}.`,
      };
    }
    out[s] = withTempoRow(flat, { ...row, command: 0xf, param: tempo });
  }
  return { ok: true, doc: next, subsongs: out };
}

/**
 * A new subsong, appended: one blank position as long as subsong 0's first,
 * starting at subsong 0's tempo (an F command when that is not GT's implied
 * 6 at 1x). `id` is its pattern's id.
 */
export function addSidFlatSubsong(doc: SidDoc, subsongs: readonly SidFlatSubsong[], id: string): SidFlatEdit {
  if (subsongs.length >= SID_MAX_SUBSONGS) return { ok: false, reason: `The song has ${SID_MAX_SUBSONGS} subsongs, GoatTracker's most.` };
  const first = subsongs[0];
  const firstId = first?.sequence[0];
  const rows = (firstId === undefined ? undefined : first?.patterns[firstId]?.rows) ?? 64;
  let flat: SidFlatSubsong = {
    patterns: { [id]: { rows, cells: Array.from({ length: doc.channels }, () => blankSidFlatCell(rows)) } },
    sequence: [id],
    restarts: Array.from({ length: doc.channels }, () => 0),
  };
  const tempo = (first === undefined ? null : sidFlatTempo(doc, first)) ?? sidImpliedTempo(doc);
  if (doc.speedMultiplier !== 1 || tempo !== sidImpliedTempo(doc)) {
    flat = withTempoRow(flat, { ...BLANK_SID_ROW, command: 0xf, param: tempo });
  }
  return { ok: true, doc, subsongs: [...subsongs, flat] };
}
