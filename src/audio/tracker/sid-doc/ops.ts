import { makeSidDoc, sidDocProblem, sidRowsEqual } from './doc';
import type {
  SidChipModel,
  SidDoc,
  SidDocRow,
  SidInstrument,
  SidOpResult,
  SidOrderEntry,
  SidTableName,
  SidTableRow,
} from './types';

/**
 * The edits of a SID doc. Each returns a new doc that shares everything it did
 * not touch (a row edit copies one pattern's row array and the pattern list,
 * nothing else), or the reason it cannot be made. The editor UI that calls them
 * is S4; S3 uses them to prove edit -> save -> load round-trips.
 */

function result(fields: SidDoc): SidOpResult {
  const problem = sidDocProblem(fields);
  return problem === null ? { ok: true, doc: makeSidDoc(fields) } : { ok: false, reason: `That edit would break the song: ${problem}.` };
}

/** Writes `next` into row `row` of pattern `pattern`. An unchanged row returns the same doc. */
export function setSidRow(doc: SidDoc, pattern: number, row: number, next: SidDocRow): SidOpResult {
  const target = doc.patterns[pattern];
  const current = target?.rows[row];
  if (target === undefined || current === undefined) return { ok: false, reason: `Pattern ${pattern} has no row ${row}.` };
  if (sidRowsEqual(current, next)) return { ok: true, doc };
  const rows = target.rows.slice();
  rows[row] = Object.freeze({ note: next.note, instrument: next.instrument, command: next.command, param: next.param });
  const patterns = doc.patterns.slice();
  patterns[pattern] = { rows };
  return result({ ...doc, patterns });
}

/**
 * Writes `rows` into pattern `pattern` from row `offset` on: what a grid cell
 * edit is (`grid.ts`, the edit mapping). One doc for the whole slice; a slice
 * that changes nothing returns the same doc.
 */
export function setSidPatternSlice(doc: SidDoc, pattern: number, offset: number, rows: readonly SidDocRow[]): SidOpResult {
  const target = doc.patterns[pattern];
  if (target === undefined || !Number.isInteger(offset) || offset < 0 || offset + rows.length > target.rows.length) {
    return { ok: false, reason: `Pattern ${pattern} has no rows ${offset}-${offset + rows.length - 1}.` };
  }
  if (rows.every((row, i) => sidRowsEqual(target.rows[offset + i] as SidDocRow, row))) return { ok: true, doc };
  const next = target.rows.slice();
  rows.forEach((row, i) => {
    const current = next[offset + i] as SidDocRow;
    if (!sidRowsEqual(current, row)) {
      next[offset + i] = Object.freeze({ note: row.note, instrument: row.instrument, command: row.command, param: row.param });
    }
  });
  const patterns = doc.patterns.slice();
  patterns[pattern] = { rows: next };
  return result({ ...doc, patterns });
}

/** Replaces instrument `n` (1-based). */
export function setSidInstrument(doc: SidDoc, n: number, next: SidInstrument): SidOpResult {
  if (doc.instruments[n - 1] === undefined) return { ok: false, reason: `There is no instrument ${n}.` };
  const instruments = doc.instruments.slice();
  instruments[n - 1] = { ...next, filter: { ...next.filter } };
  return result({ ...doc, instruments });
}

/** Appends an instrument; the new one is number `instruments.length`. */
export function addSidInstrument(doc: SidDoc, next: SidInstrument): SidOpResult {
  return result({ ...doc, instruments: [...doc.instruments, { ...next, filter: { ...next.filter } }] });
}

/** Writes row `index` (0-based) of a table, or appends one when `index` is the table's length. */
export function setSidTableRow(doc: SidDoc, table: SidTableName, index: number, next: SidTableRow): SidOpResult {
  const rows = doc.tables[table];
  if (!Number.isInteger(index) || index < 0 || index > rows.length) return { ok: false, reason: `The ${table} table has no row ${index + 1}.` };
  const copy = rows.slice();
  copy[index] = { left: next.left, right: next.right };
  return result({ ...doc, tables: { ...doc.tables, [table]: copy } });
}

/** Replaces entry `index` of a channel's orderlist in `subsong`. */
export function setSidOrderEntry(doc: SidDoc, subsong: number, channel: number, index: number, next: SidOrderEntry): SidOpResult {
  const song = doc.subsongs[subsong];
  const list = song?.orderlists[channel];
  if (song === undefined || list === undefined || list.entries[index] === undefined) {
    return { ok: false, reason: `Subsong ${subsong} channel ${channel + 1} has no entry ${index}.` };
  }
  const entries = list.entries.slice();
  entries[index] = { pattern: next.pattern, transpose: next.transpose, repeat: next.repeat };
  const orderlists = song.orderlists.slice();
  orderlists[channel] = { entries, restart: list.restart };
  const subsongs = doc.subsongs.slice();
  subsongs[subsong] = { orderlists };
  return result({ ...doc, subsongs });
}

/** Switches the song's chip model (the Rust player builds a chip of that model). */
export function setSidChipModel(doc: SidDoc, chipModel: SidChipModel): SidOpResult {
  return doc.chipModel === chipModel ? { ok: true, doc } : result({ ...doc, chipModel });
}

/** Sets the song's start tempo (ticks per row) and multispeed. */
export function setSidTiming(doc: SidDoc, tempo: number, speedMultiplier: number): SidOpResult {
  if (doc.tempo === tempo && doc.speedMultiplier === speedMultiplier) return { ok: true, doc };
  return result({ ...doc, tempo, speedMultiplier });
}

/** Sets the song's name, author and copyright texts. */
export function setSidSongTexts(doc: SidDoc, texts: Partial<Pick<SidDoc, 'songName' | 'author' | 'copyright'>>): SidOpResult {
  return result({ ...doc, ...texts });
}
