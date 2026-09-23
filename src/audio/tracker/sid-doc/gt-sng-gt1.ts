import {
  GT_INSTRUMENT_NAME_LENGTH,
  GT_SUBTUNE_COUNT_OFFSET,
  GtFormatError,
  GtReader,
  decodeGtOrderlist,
  gtText,
  hex,
  readGtOrderlists,
  type GtImportNote,
} from './gt-sng-common';
import {
  SID_MAX_PATTERN_ROWS,
  SID_MAX_PATTERNS,
  SID_MAX_SUBSONGS,
  SID_MAX_TABLE_ROWS,
  SID_NOTE_KEY_OFF,
  SID_NOTE_NONE,
  type SidDoc,
  type SidDocPattern,
  type SidDocRow,
  type SidInstrument,
  type SidSubsong,
  type SidTableRow,
} from './types';

/**
 * GoatTracker 1 (`GTS!`) -> `SidDoc`. The GT2 readme documents only GTS5; its
 * §1.2 says GT2 loads v1.xx songs and converts them ("some subtleties ... will
 * not play back exactly like in v1.xx", the arpeggio command becomes
 * wavetable programs) and §3.4.4 gives the old-parameter conversions for
 * vibrato ($34 -> speed 03, depth 40) and portamento (4 x the old value).
 * Everything else here is INFERRED from the 22 corpus files' bytes (the D-log
 * lists each inference); no GoatTracker source was read.
 *
 * Layout (measured, every corpus GTS! file consumes exactly):
 *   +0 'GTS!', +4/+36/+68 name/author/copyright (32 each), +100 subtunes,
 *   +101 orderlists (as GTS5); then exactly 31 instruments, each 8 bytes +
 *   16-byte name + (byte 7 / 2) wavetable (left, right) pairs inline; then a
 *   pattern count and patterns of (length in BYTES, 3-byte rows: note,
 *   instrument<<3 | command, parameter), the last row $FF; then an optional
 *   256-byte filter table (64 rows x 4 bytes; absent in 5 of 22 files).
 */

export const GT1_INSTRUMENTS = 31;
const GT1_INSTRUMENT_HEADER = 8;
const GT1_FILTER_TABLE_BYTES = 256;
const GT1_FILTER_ROWS = 64;
/** Measured GT1 note bytes: $00-$5C notes C-0..G#7 (INFERRED: GT2's $60-$BC less $60), $5E key off, $5F rest, $FF end. */
const GT1_NOTE_LAST = 0x5c;
const GT1_NOTE_KEY_OFF = 0x5e;
const GT1_NOTE_REST = 0x5f;
const GT1_PATTERN_END = 0xff;
/** A table jump row (all four tables use left $FF, right = 1-based row, 0 = stop). */
const JUMP = 0xff;

/** A step table under construction: programs appended once each, identical ones shared. */
class TableBuilder {
  readonly rows: SidTableRow[] = [];
  private readonly seen = new Map<string, number>();
  constructor(readonly name: string) {}
  /**
   * Appends `program` (its jump targets 1-based within itself, 0 = stop) and
   * returns its first row, 1-based. An identical program already added is reused.
   */
  add(program: readonly SidTableRow[]): number {
    const key = program.map((r) => `${r.left},${r.right}`).join(';');
    const found = this.seen.get(key);
    if (found !== undefined) return found;
    const start = this.rows.length + 1;
    for (const row of program) {
      this.rows.push(row.left === JUMP && row.right !== 0 ? { left: JUMP, right: start + row.right - 1 } : row);
    }
    this.check();
    this.seen.set(key, start);
    return start;
  }
  check(): void {
    if (this.rows.length > SID_MAX_TABLE_ROWS) {
      throw new GtFormatError(`converted to GoatTracker 2 tables, its ${this.name} table needs ${this.rows.length} rows; a table holds ${SID_MAX_TABLE_ROWS}`);
    }
  }
}

/** Splits a modulation of `time` frames at `speed` into rows of at most $7F frames (GT2's time range). */
function timedRows(time: number, speed: number): SidTableRow[] {
  const out: SidTableRow[] = [];
  for (let left = time; left > 0; left -= 0x7f) out.push({ left: Math.min(left, 0x7f), right: speed & 0xff });
  return out;
}

interface Gt1Instrument {
  header: Uint8Array;
  name: string;
  wave: SidTableRow[];
  empty: boolean;
}

export function readGt1Song(
  bytes: Uint8Array,
  notes: GtImportNote[],
  header: Omit<SidDoc, 'subsongs' | 'patterns' | 'instruments' | 'tables'>,
): SidDoc {
  const r = new GtReader(bytes, GT_SUBTUNE_COUNT_OFFSET);
  const subtunes = r.byte('the song header');
  if (subtunes < 1 || subtunes > SID_MAX_SUBSONGS) throw new GtFormatError(`it declares ${subtunes} subtunes; a song has 1-${SID_MAX_SUBSONGS}`);
  const rawLists = readGtOrderlists(r, subtunes);

  const raw: Gt1Instrument[] = [];
  for (let i = 0; i < GT1_INSTRUMENTS; i++) {
    const h = r.take(GT1_INSTRUMENT_HEADER, `instrument ${i + 1}`);
    const name = gtText(r.take(GT_INSTRUMENT_NAME_LENGTH, `instrument ${i + 1}`));
    const pairs = h[7]! >> 1;
    const w = r.take(pairs * 2, `instrument ${i + 1}'s wavetable`);
    const wave = Array.from({ length: pairs }, (_, k) => ({ left: w[k * 2]!, right: w[k * 2 + 1]! }));
    const empty = name === '' && h.subarray(0, 7).every((b) => b === 0) && wave.every((row) => row.left === 0 || (row.left === JUMP && row.right === 0));
    raw.push({ header: h, name, wave, empty });
  }

  const patternCount = r.byte('the pattern count');
  if (patternCount < 1 || patternCount > SID_MAX_PATTERNS) throw new GtFormatError(`it declares ${patternCount} patterns; a song has 1-${SID_MAX_PATTERNS}`);
  const rawPatterns: Uint8Array[] = [];
  for (let p = 0; p < patternCount; p++) {
    const len = r.byte(`pattern ${p}`);
    if (len % 3 !== 0) throw new GtFormatError(`pattern ${p} is ${len} bytes long, not a whole number of 3-byte rows`);
    rawPatterns.push(r.take(len, `pattern ${p}`));
  }
  // The trailing filter table is optional on disk (measured: 5 of 22 corpus files end here).
  let filterTable: Uint8Array | null = null;
  if (r.left === GT1_FILTER_TABLE_BYTES) filterTable = r.take(GT1_FILTER_TABLE_BYTES, 'the filter table');
  else if (r.left !== 0) {
    throw new GtFormatError(`${r.left} bytes follow the last pattern; a GoatTracker 1 song ends there or after a ${GT1_FILTER_TABLE_BYTES}-byte filter table`);
  }

  const wave = new TableBuilder('wave');
  const pulse = new TableBuilder('pulse');
  const filter = new TableBuilder('filter');
  const speed = new TableBuilder('speed');
  const convert = (message: string) => notes.push({ kind: 'gt1-convert', message });
  const drop = (message: string) => notes.push({ kind: 'gt1-dropped', message });

  // --- The filter table: 64 rows of (control, resonance|volume or time, cutoff or speed, next row). INFERRED.
  const filterStart = new Map<number, number>();
  const filterRow = (i: number): number => {
    const known = filterStart.get(i);
    if (known !== undefined) return known;
    if (filterTable === null) throw new Error('no filter table');
    // Lay the chain from row i out in order: each GT1 row becomes its GT2
    // rows, then falls through to its `next` when that is laid out right
    // after it, or jumps there.
    const program: { row: number; rows: SidTableRow[] }[] = [];
    const start = filter.rows.length + 1;
    let at = start;
    let row = i;
    for (;;) {
      filterStart.set(row, at);
      const [ctl, b1, b2, next] = [filterTable[row * 4]!, filterTable[row * 4 + 1]!, filterTable[row * 4 + 2]!, filterTable[row * 4 + 3]!];
      let rows: SidTableRow[];
      if (ctl !== 0) {
        // Set: control bits 0-2 = passband (1 LP, 2 BP, 4 HP), bits 4-6 =
        // channels 1-3; b1 = resonance<<4 | volume. GT2: "set filter
        // parameters" then "set cutoff" (readme §3.4.3).
        rows = [
          { left: 0x80 | ((ctl & 0x07) << 4), right: (b1 & 0xf0) | ((ctl >> 4) & 0x07) },
          { left: 0x00, right: b2 },
        ];
        if ((b1 & 0x0f) !== 0x0f) drop(`filter table row ${row}: master volume ${b1 & 0x0f} has no filter-table equivalent`);
      } else {
        rows = timedRows(b1, b2);
        if (rows.length === 0) {
          convert(`filter table row ${row}: a modulation of 0 frames becomes one still frame`);
          rows = [{ left: 0x01, right: 0x00 }];
        }
      }
      at += rows.length;
      const target = next % GT1_FILTER_ROWS;
      const laid = filterStart.get(target);
      if (laid === undefined) {
        program.push({ row, rows });
        row = target;
        continue;
      }
      // A set row that loops onto itself holds its setting: stop there.
      const selfSet = target === row && ctl !== 0;
      rows = [...rows, { left: JUMP, right: selfSet ? 0 : laid }];
      at += 1;
      program.push({ row, rows });
      break;
    }
    for (const part of program) filter.rows.push(...part.rows);
    filter.check();
    return start;
  };

  // --- Instruments.
  let usedInstruments = 0;
  for (const data of rawPatterns) for (let k = 0; k + 2 < data.length; k += 3) if (data[k] !== GT1_PATTERN_END) usedInstruments = Math.max(usedInstruments, data[k + 1]! >> 3);
  let count = GT1_INSTRUMENTS;
  while (count > usedInstruments && raw[count - 1]!.empty) count -= 1;

  const instruments: SidInstrument[] = raw.slice(0, count).map((ins, i) => {
    const h = ins.header;
    const where = `instrument ${i + 1}`;
    // Wave: GT2's wavetable encoding (readme §3.4.1) fits every corpus byte
    // (INFERRED); jumps are 1-based within the instrument's own program.
    const program = ins.wave.map((row) => {
      if (row.left === JUMP && row.right > ins.wave.length) {
        drop(`${where}: its wavetable jumps to row ${row.right} of ${ins.wave.length}; the jump stops instead`);
        return { left: JUMP, right: 0 };
      }
      return row;
    });
    if (program.at(-1)?.left !== JUMP) {
      convert(`${where}: its wavetable has no end jump; one is added`);
      program.push({ left: JUMP, right: 0 });
    }
    // Pulse: +2 start, +3 speed, +4/+5 low/high limit, the limits and start
    // the width's top 8 bits (INFERRED). GT1's limit-based sweep becomes GT2
    // time-based steps (readme §3.6.1). The speed is taken as GT2's own unit
    // (INFERRED): every corpus speed ($10-$50) is then inside GT2's signed
    // range and the GTS5 corpus's measured one; doubling it, as readme §1.1
    // note 9 does for pre-2.4 GT2 songs, would overflow $7F for 43 of them.
    const [pw, pspeed, plo, phi] = [h[2]! << 4, h[3]!, h[4]! << 4, h[5]! << 4];
    let pulsePtr = 0;
    if (pw !== 0 || pspeed !== 0) {
      const steps: SidTableRow[] = [{ left: 0x80 | (pw >> 8), right: pw & 0xff }];
      const s = Math.min(0x7f, pspeed);
      if (pspeed > 0x7f) convert(`${where}: pulse speed $${hex(pspeed)} exceeds $7F; clamped`);
      if (s === 0 || phi <= plo) {
        if (s !== 0) drop(`${where}: pulse limits $${hex(plo >> 4)}-$${hex(phi >> 4)} leave no sweep; the width holds`);
        steps.push({ left: JUMP, right: 0 });
      } else {
        const span = Math.ceil((phi - plo) / s);
        steps.push(...timedRows(Math.max(0, Math.ceil((phi - pw) / s)), s));
        const loop = steps.length + 1;
        steps.push(...timedRows(span, -s), ...timedRows(span, s), { left: JUMP, right: loop });
      }
      pulsePtr = pulse.add(steps);
    }
    // Filter: +6 is a filter-table row. INFERRED; without a filter table
    // there is nothing it can point at.
    let filterPtr = 0;
    const f = h[6]!;
    if (f !== 0) {
      if (filterTable !== null && f < GT1_FILTER_ROWS) filterPtr = filterRow(f);
      else drop(`${where}: filter byte $${hex(f)} ${filterTable === null ? 'with no filter table in the file' : 'is past the filter table'}; dropped`);
    }
    return {
      name: ins.name,
      attack: h[0]! >> 4,
      decay: h[0]! & 0x0f,
      sustain: h[1]! >> 4,
      release: h[1]! & 0x0f,
      waveform: 0,
      pulseWidth: 0,
      filter: { enabled: false, cutoff: 0, resonance: 0, mode: 0 },
      // A GT1 instrument has no first-wave, gate-timer or hard-restart byte:
      // GT2's defaults for a new instrument (readme §3.3/§3.7: $09, 2). INFERRED.
      firstWave: 0x09,
      gateTimer: 2,
      hardRestart: true,
      vibratoDelay: 0,
      wavePtr: wave.add(program),
      pulsePtr,
      filterPtr,
      speedPtr: 0,
    };
  });

  // --- Patterns.
  const speedRow = (left: number, right: number) => speed.add([{ left, right }]);
  const arpeggios = new Map<number, number>();
  const patterns: SidDocPattern[] = rawPatterns.map((data, p) => {
    const n = data.length / 3;
    if (n < 2 || data[(n - 1) * 3] !== GT1_PATTERN_END) throw new GtFormatError(`pattern ${p} does not end with the pattern-end row`);
    if (n - 1 > SID_MAX_PATTERN_ROWS) throw new GtFormatError(`pattern ${p} has ${n - 1} rows; a pattern has at most ${SID_MAX_PATTERN_ROWS}`);
    const rows: SidDocRow[] = [];
    for (let i = 0; i < n - 1; i++) {
      const where = `pattern ${p} row ${i}`;
      const [nb, packed, param] = [data[i * 3]!, data[i * 3 + 1]!, data[i * 3 + 2]!];
      let note: number;
      if (nb <= GT1_NOTE_LAST) note = nb + 1;
      else if (nb === GT1_NOTE_KEY_OFF) note = SID_NOTE_KEY_OFF;
      else if (nb === GT1_NOTE_REST) note = SID_NOTE_NONE;
      else throw new GtFormatError(`${where}: note byte $${hex(nb)} is not a GoatTracker 1 note`);
      const instrument = packed >> 3;
      const cmd = packed & 0x07;
      let command = 0;
      let out = 0;
      switch (cmd) {
        case 0:
          // Arpeggio (GT1 only; readme §1.2: GT2 turns it into wavetable
          // programs). X (bit 3 masked off, INFERRED a flag) and Y are the
          // semitones over the note: a looping 0, X, Y wave program, started
          // with command 8.
          if (param !== 0) {
            let ptr = arpeggios.get(param);
            if (ptr === undefined) {
              ptr = wave.add([
                { left: 0x00, right: 0x00 },
                { left: 0x00, right: (param >> 4) & 0x07 },
                { left: 0x00, right: param & 0x0f },
                { left: JUMP, right: 1 },
              ]);
              arpeggios.set(param, ptr);
              convert(`arpeggio $${hex(param)} became wave program ${ptr} (command 8)`);
            }
            command = 0x8;
            out = ptr;
          }
          break;
        case 1:
        case 2:
        case 3:
          // Portamento speed: 4 x the old parameter (readme §3.4.4); 3 with 0 is tie-note.
          command = cmd;
          if (param !== 0) {
            const v = param * 4;
            out = speedRow(v >> 8, v & 0xff);
          }
          break;
        case 4:
          // Vibrato: old $XY -> speed X, depth Y<<4 (readme §3.4.4's "$34" example).
          command = 0x4;
          if (param !== 0) out = speedRow(param >> 4, (param & 0x0f) << 4);
          break;
        case 5:
          // Filter-table pointer (INFERRED): GT2's AXY.
          if (filterTable !== null && param < GT1_FILTER_ROWS) {
            command = 0xa;
            out = filterRow(param);
          } else {
            drop(`${where}: filter pointer $${hex(param)} ${filterTable === null ? 'with no filter table' : 'past the filter table'}; dropped`);
          }
          break;
        case 7:
          // Tempo, GT2's FXY with the same parameter (INFERRED).
          command = 0xf;
          out = param;
          break;
        default:
          drop(`${where}: command 6 ($${hex(param)}) has no known meaning; dropped`);
      }
      rows.push({ note, instrument, command, param: out });
    }
    return { rows };
  });

  const subsongs: SidSubsong[] = rawLists.map((lists, sub) => ({
    orderlists: lists.map((data, c) => {
      const { list, loopDiffers } = decodeGtOrderlist(data, `subtune ${sub} channel ${c + 1}`, patterns.length);
      if (loopDiffers) {
        notes.push({ kind: 'loop-transpose', message: `subtune ${sub} channel ${c + 1}: its loop replays with a running transpose/repeat the doc cannot hold; the first pass's is kept` });
      }
      return list;
    }),
  }));

  return {
    ...header,
    subsongs,
    patterns,
    instruments,
    tables: { wave: wave.rows, pulse: pulse.rows, filter: filter.rows, speed: speed.rows },
  };
}
