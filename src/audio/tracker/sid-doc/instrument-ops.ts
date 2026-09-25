import { makeSidDoc, sidDocProblem } from './doc';
import {
  SID_MAX_INSTRUMENTS,
  SID_MAX_TABLE_ROWS,
  SID_TABLE_NAMES,
  type SidDoc,
  type SidDocPattern,
  type SidDocRow,
  type SidInstrument,
  type SidOpResult,
  type SidTableName,
  type SidTableRow,
} from './types';

/**
 * Instrument delete and clone (plan-sid-authoring.md phase 2). Pure, like
 * `ops.ts`: each returns a new doc sharing what it did not touch, or the true
 * reason it cannot be made; the instrument page hands the result to the
 * store's `editSidDoc`, one undo step. An instrument that goes away takes no
 * reference with it: every row naming a later one is renumbered, as
 * `sid-table-rows.ts` does for table rows.
 */

function result(fields: SidDoc): SidOpResult {
  const problem = sidDocProblem(fields);
  return problem === null ? { ok: true, doc: makeSidDoc(fields) } : { ok: false, reason: `That edit would break the song: ${problem}.` };
}

/** Where an instrument is named: a row of a pattern. */
export interface SidInstrumentUse {
  readonly pattern: number;
  readonly row: number;
}

/** Every pattern row that names instrument `n` (1-based). */
export function sidInstrumentUses(doc: SidDoc, n: number): SidInstrumentUse[] {
  const uses: SidInstrumentUse[] = [];
  doc.patterns.forEach((pattern, p) => pattern.rows.forEach((row, r) => row.instrument === n && uses.push({ pattern: p, row: r })));
  return uses;
}

/** Every row of every pattern through `edit`, sharing the patterns and rows it leaves alone. */
function mapRows(doc: SidDoc, edit: (row: SidDocRow) => SidDocRow): SidDocPattern[] {
  return doc.patterns.map((pattern) => {
    let changed = false;
    const rows = pattern.rows.map((row) => {
      const next = edit(row);
      if (next !== row) changed = true;
      return next;
    });
    return changed ? { rows } : pattern;
  });
}

/**
 * Deletes instrument `n` (1-based). The instruments after it move down one,
 * and every row naming one of them follows it. Rows that name `n` itself
 * refuse the delete, unless `clearUses`: then they name no instrument (the
 * voice keeps the one it had). Its table rows stay (they are shared tables;
 * another instrument or command may reach them).
 */
export function deleteSidInstrument(doc: SidDoc, n: number, options: { clearUses?: boolean } = {}): SidOpResult {
  if (doc.instruments[n - 1] === undefined) return { ok: false, reason: `There is no instrument ${n}.` };
  const uses = sidInstrumentUses(doc, n);
  if (uses.length > 0 && options.clearUses !== true) {
    const first = uses[0] as SidInstrumentUse;
    return {
      ok: false,
      reason: `Instrument ${n} is named on ${uses.length} row${uses.length === 1 ? '' : 's'} (the first: pattern ${first.pattern} row ${first.row}).`,
    };
  }
  const instruments = [...doc.instruments.slice(0, n - 1), ...doc.instruments.slice(n)];
  const patterns = mapRows(doc, (row) =>
    row.instrument === n ? { ...row, instrument: 0 } : row.instrument > n ? { ...row, instrument: row.instrument - 1 } : row,
  );
  return result({ ...doc, instruments, patterns });
}

const TABLE_POINTER: Record<SidTableName, 'wavePtr' | 'pulsePtr' | 'filterPtr' | 'speedPtr'> = {
  wave: 'wavePtr',
  pulse: 'pulsePtr',
  filter: 'filterPtr',
  speed: 'speedPtr',
};

/**
 * The contiguous rows (1-based, inclusive) a table plays from `ptr`: forward
 * to the first jump or stop (`FF xx`), or the table's end. The speed table is
 * not stepped: an instrument names one row of it.
 */
function chainOf(rows: readonly SidTableRow[], table: SidTableName, ptr: number): [number, number] {
  if (table === 'speed') return [ptr, ptr];
  let end = ptr;
  while (end < rows.length && (rows[end - 1] as SidTableRow).left !== 0xff) end += 1;
  return [ptr, end];
}

/**
 * Appends a copy of instrument `n` (1-based): number `instruments.length`.
 * Its table rows are copied too (appended to each table, jumps inside the
 * copy moved with it, jumps out of it kept), so editing the copy never
 * changes the original. Wave-table commands keep naming the rows they named.
 */
export function cloneSidInstrument(doc: SidDoc, n: number): SidOpResult {
  const source = doc.instruments[n - 1];
  if (source === undefined) return { ok: false, reason: `There is no instrument ${n}.` };
  if (doc.instruments.length >= SID_MAX_INSTRUMENTS) return { ok: false, reason: `The song has ${SID_MAX_INSTRUMENTS} instruments, GoatTracker's most.` };
  const tables = { ...doc.tables };
  const clone: { -readonly [K in keyof SidInstrument]: SidInstrument[K] } = { ...source };
  for (const table of SID_TABLE_NAMES) {
    const key = TABLE_POINTER[table];
    const ptr = source[key];
    const rows = doc.tables[table];
    if (ptr === 0 || ptr > rows.length) continue;
    const [from, to] = chainOf(rows, table, ptr);
    const base = rows.length;
    if (base + (to - from + 1) > SID_MAX_TABLE_ROWS) {
      return { ok: false, reason: `The ${table} table has no room for a copy of instrument ${n}'s ${to - from + 1} row${to === from ? '' : 's'} (${SID_MAX_TABLE_ROWS} at most).` };
    }
    const moved = (r: number): number => base + r - from + 1;
    const copy = rows.slice(from - 1, to).map((row): SidTableRow =>
      table !== 'speed' && row.left === 0xff && row.right >= from && row.right <= to ? { left: 0xff, right: moved(row.right) } : { left: row.left, right: row.right },
    );
    tables[table] = [...rows, ...copy];
    clone[key] = moved(ptr);
  }
  return result({ ...doc, instruments: [...doc.instruments, clone], tables });
}
