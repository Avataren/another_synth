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
  SID_MAX_INSTRUMENT_NAME_LENGTH,
  SID_MAX_INSTRUMENTS,
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
 * The conversion follows GT2's own GT1 loader, gsong.c:329-845 (read for its
 * facts only; the file:line cites below point there): its tables, commands
 * and arpeggio instruments, byte for byte, except where GT reads memory it
 * never wrote (each such place says what stands in instead). Our tables
 * share identical programs where GT lays copies.
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
/** GT1 note bytes: $00-$5C notes C-0..G#7 (GT2's $60-$BC less $60, gsong.c:559), $5E key off, $5F rest, $FF end (gcommon.h:44-54). */
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
      this.rows.push(
        row.left === JUMP && row.right !== 0
          ? { left: JUMP, right: start + row.right - 1 }
          : row,
      );
    }
    this.check();
    this.seen.set(key, start);
    return start;
  }
  check(): void {
    if (this.rows.length > SID_MAX_TABLE_ROWS) {
      throw new GtFormatError(
        `converted to GoatTracker 2 tables, its ${this.name} table needs ${this.rows.length} rows; a table holds ${SID_MAX_TABLE_ROWS}`,
      );
    }
  }
}

/** Splits a modulation of `time` frames at `speed` into rows of at most $7F frames (GT2's time range). */
function timedRows(time: number, speed: number): SidTableRow[] {
  const out: SidTableRow[] = [];
  for (let left = time; left > 0; left -= 0x7f)
    out.push({ left: Math.min(left, 0x7f), right: speed & 0xff });
  return out;
}

interface Gt1Instrument {
  header: Uint8Array;
  name: string;
  wave: SidTableRow[];
  empty: boolean;
  /** GT2 takes the program back: the instrument has no wave pointer there (gsong.c:407-416). */
  noWave: boolean;
}

export function readGt1Song(
  bytes: Uint8Array,
  notes: GtImportNote[],
  header: Omit<SidDoc, 'subsongs' | 'patterns' | 'instruments' | 'tables'>,
): SidDoc {
  const r = new GtReader(bytes, GT_SUBTUNE_COUNT_OFFSET);
  const subtunes = r.byte('the song header');
  if (subtunes < 1 || subtunes > SID_MAX_SUBSONGS)
    throw new GtFormatError(
      `it declares ${subtunes} subtunes; a song has 1-${SID_MAX_SUBSONGS}`,
    );
  const rawLists = readGtOrderlists(r, subtunes);

  const raw: Gt1Instrument[] = [];
  // How many wave rows GT2's own loader has laid (gsong.c:385-416): it lays
  // every instrument's rows, no two shared, while the table has room, and
  // takes back a program of one blank row and its end. The arpeggio programs
  // it adds later fit or not by this count (gsong.c:738, 747), whatever our
  // de-duplicated table holds.
  let gtWaveRows = 0;
  for (let i = 0; i < GT1_INSTRUMENTS; i++) {
    const h = r.take(GT1_INSTRUMENT_HEADER, `instrument ${i + 1}`);
    const name = gtText(
      r.take(GT_INSTRUMENT_NAME_LENGTH, `instrument ${i + 1}`),
    );
    const pairs = h[7]! >> 1;
    const w = r.take(pairs * 2, `instrument ${i + 1}'s wavetable`);
    const wave = Array.from({ length: pairs }, (_, k) => ({
      left: w[k * 2]!,
      right: w[k * 2 + 1]!,
    }));
    const empty =
      name === '' &&
      h.subarray(0, 7).every((b) => b === 0) &&
      wave.every(
        (row) => row.left === 0 || (row.left === JUMP && row.right === 0),
      );
    gtWaveRows = Math.min(SID_MAX_TABLE_ROWS, gtWaveRows + pairs);
    const noWave = pairs === 2 && wave[0]!.left === 0 && wave[0]!.right === 0;
    if (noWave) gtWaveRows -= 2;
    raw.push({ header: h, name, wave, empty, noWave });
  }

  const patternCount = r.byte('the pattern count');
  if (patternCount < 1 || patternCount > SID_MAX_PATTERNS)
    throw new GtFormatError(
      `it declares ${patternCount} patterns; a song has 1-${SID_MAX_PATTERNS}`,
    );
  const rawPatterns: Uint8Array[] = [];
  for (let p = 0; p < patternCount; p++) {
    const len = r.byte(`pattern ${p}`);
    if (len % 3 !== 0)
      throw new GtFormatError(
        `pattern ${p} is ${len} bytes long, not a whole number of 3-byte rows`,
      );
    rawPatterns.push(r.take(len, `pattern ${p}`));
  }
  // The trailing filter table is optional on disk (measured: 5 of 22 corpus files end here).
  let filterTable: Uint8Array | null = null;
  if (r.left === GT1_FILTER_TABLE_BYTES)
    filterTable = r.take(GT1_FILTER_TABLE_BYTES, 'the filter table');
  else if (r.left !== 0) {
    throw new GtFormatError(
      `${r.left} bytes follow the last pattern; a GoatTracker 1 song ends there or after a ${GT1_FILTER_TABLE_BYTES}-byte filter table`,
    );
  }

  const wave = new TableBuilder('wave');
  const pulse = new TableBuilder('pulse');
  const speed = new TableBuilder('speed');
  const convert = (message: string) =>
    notes.push({ kind: 'gt1-convert', message });
  const drop = (message: string) =>
    notes.push({ kind: 'gt1-dropped', message });

  // --- The filter table: 64 rows of (b0, b1, b2, next row), converted as
  // GT2's loader does (gsong.c:602-669). Rows 1..n are laid out in order,
  // where n is the highest row anything names: an instrument filter byte
  // (gsong.c:380), a command-5 parameter (gsong.c:578, every row read, the
  // end row too) or any row's `next` byte, row 0's included (gsong.c:609);
  // at most 63 (gsong.c:612). Row 0 is never laid: its bytes 2-3 are the
  // funktempo (command 7 00).
  let filterRowCount = 0;
  for (const ins of raw)
    filterRowCount = Math.max(filterRowCount, ins.header[6]!);
  for (const data of rawPatterns) {
    for (let k = 0; k + 2 < data.length; k += 3)
      if ((data[k + 1]! & 0x07) === 5)
        filterRowCount = Math.max(filterRowCount, data[k + 2]!);
  }
  const filterRows: SidTableRow[] = [];
  /** GT1 row -> 1-based GT2 row (gsong.c:616); 0 stays 0. */
  const filterMap = new Array<number>(GT1_FILTER_ROWS).fill(0);
  if (filterTable !== null) {
    for (let c = 0; c < GT1_FILTER_ROWS; c++)
      filterRowCount = Math.max(filterRowCount, filterTable[c * 4 + 3]!);
    filterRowCount = Math.min(filterRowCount, GT1_FILTER_ROWS - 1);
    const jumps: { at: number; to: number }[] = [];
    for (let c = 1; c <= filterRowCount; c++) {
      // Every row maps to where the output stands, an all-zero one (which
      // lays nothing) to whatever is laid next.
      filterMap[c] = filterRows.length + 1;
      const [b0, b1, b2, next] = [
        filterTable[c * 4]!,
        filterTable[c * 4 + 1]!,
        filterTable[c * 4 + 2]!,
        filterTable[c * 4 + 3]!,
      ];
      if ((b0 | b1 | b2 | next) === 0) continue;
      if (b0 !== 0) {
        // Set (gsong.c:621-631): b0 is SID $D417 as is (resonance<<4 |
        // channels), b1 is $D418 (bits 4-6 the passband, bit 7 voice 3 off,
        // bits 0-3 the master volume). GT2 keeps the passband, then sets the
        // cutoff b2 when it is not 0.
        filterRows.push({ left: 0x80 | (b1 & 0x70), right: b0 });
        if (b2 !== 0) filterRows.push({ left: 0x00, right: b2 });
        const lost = [
          (b1 & 0x0f) !== 0x0f ? `master volume ${b1 & 0x0f}` : '',
          (b1 & 0x80) !== 0 ? 'voice 3 off' : '',
        ].filter(Boolean);
        if (lost.length > 0)
          drop(
            `filter table row ${c}: ${lost.join(' and ')} has no filter-table equivalent`,
          );
      } else {
        // Modulation (gsong.c:633-647): b1 frames at signed b2, in rows of at
        // most 127 frames. 0 frames lays no row.
        filterRows.push(...timedRows(b1, b2));
      }
      // Falls through when `next` is the row after it (gsong.c:650).
      if (next !== c + 1) {
        let to = next;
        if (to >= GT1_FILTER_ROWS) {
          // GT indexes its 64-entry map with it (gsong.c:664): out of bounds.
          drop(
            `filter table row ${c}: next row $${hex(next)} is past the table; the jump stops instead`,
          );
          to = 0;
        }
        jumps.push({ at: filterRows.length, to });
        filterRows.push({ left: JUMP, right: 0 });
      }
    }
    for (const { at, to } of jumps)
      filterRows[at] = { left: JUMP, right: filterMap[to]! };
    if (filterRows.length > SID_MAX_TABLE_ROWS) {
      throw new GtFormatError(
        `converted to GoatTracker 2 tables, its filter table needs ${filterRows.length} rows; a table holds ${SID_MAX_TABLE_ROWS}`,
      );
    }
  }
  /**
   * A GT1 filter row an instrument or command 5 names -> its GT2 row
   * (gsong.c:667-669, 690-692). Without a filter table GT maps through a
   * table it built from 256 uninitialised stack bytes (gsong.c:341, 602),
   * which nothing can reproduce: a non-zero pointer is dropped then.
   */
  const mapFilter = (ptr: number, where: string): number | null => {
    if (ptr === 0) return 0;
    if (filterTable === null) {
      drop(
        `${where}: filter pointer $${hex(ptr)} with no filter table in the file; dropped`,
      );
      return null;
    }
    if (ptr >= GT1_FILTER_ROWS) {
      drop(
        `${where}: filter pointer $${hex(ptr)} is past the filter table; dropped`,
      );
      return 0;
    }
    return filterMap[ptr]!;
  };

  // --- Instruments.
  let usedInstruments = 0;
  for (const data of rawPatterns)
    for (let k = 0; k + 2 < data.length; k += 3)
      if (data[k] !== GT1_PATTERN_END)
        usedInstruments = Math.max(usedInstruments, data[k + 1]! >> 3);
  let count = GT1_INSTRUMENTS;
  while (count > usedInstruments && raw[count - 1]!.empty) count -= 1;

  /** Each instrument's wave rows up to its first jump, lefts only: an arpeggio program's head (gsong.c:731-744). */
  const arpeggioHeads: SidTableRow[][] = [];
  const instruments: SidInstrument[] = raw.slice(0, count).map((ins, i) => {
    const h = ins.header;
    const where = `instrument ${i + 1}`;
    // Wave: GT2's wavetable encoding (readme §3.4.1) fits every corpus byte
    // (INFERRED); jumps are 1-based within the instrument's own program.
    const program = ins.wave.map((row) => {
      if (row.left === JUMP && row.right > ins.wave.length) {
        drop(
          `${where}: its wavetable jumps to row ${row.right} of ${ins.wave.length}; the jump stops instead`,
        );
        return { left: JUMP, right: 0 };
      }
      // Lefts $08-$0F are pre-2.18 delays, GT2's $E8-$EF (gsong.c:396-397).
      if (row.left >= 0x08 && row.left <= 0x0f)
        return { left: row.left | 0xe0, right: row.right };
      return row;
    });
    if (program.at(-1)?.left !== JUMP) {
      convert(`${where}: its wavetable has no end jump; one is added`);
      program.push({ left: JUMP, right: 0 });
    }
    // GT copies the left bytes and leaves the right ones blank (gsong.c:740).
    const head = program.findIndex((row) => row.left === JUMP);
    arpeggioHeads.push(
      ins.noWave
        ? []
        : program.slice(0, head).map((row) => ({ left: row.left, right: 0 })),
    );
    // Pulse (gsong.c:375-382, 418-538): +2 start, +3 speed, +4/+5 low/high
    // limit, the width's top 8 bits. Bit 0 of the start is GT1's "no hard
    // restart" flag, not width (gsong.c:381-382); a start of 0 makes no
    // program. GT2 turns the limit-based sweep into timed steps: a rise to
    // the high limit, a fall to the low one, then a rise back either to the
    // start (when it lies between the two turns; the loop then restarts at
    // the first rise) or to the high limit (the loop restarts at the fall).
    // Each leg lasts floor(distance / speed) frames at speed/2, which the
    // pre-2.4 pass doubles and clamps to +127/-128 (gsong.c:816-830; a row
    // of speed 0 is not doubled). That math applies to every GTS! file:
    // gsong.c:330 is the one GTS! branch, with no sub-version switch
    // (betaconv.c reads GTS2 only, betaconv.c:83), so the corpus's odd-looking
    // bytes (limits $01-$0F, speeds $80-$F0 in maximum_rastertime_test,
    // b.o.f.h. and wod) are converted by it, clamps included.
    const noHardRestart = (h[2]! & 0x01) !== 0;
    const start = h[2]! & 0xfe;
    const [add, low, high] = [h[3]!, h[4]! << 4, h[5]! << 4];
    let pulsePtr = 0;
    if (start !== 0) {
      const steps: SidTableRow[] = [
        { left: 0x80 | (start >> 4), right: (start << 4) & 0xff },
      ];
      if (add === 0) steps.push({ left: JUMP, right: 0 });
      else {
        const twice = (add >> 1) * 2;
        const [up, down] = [Math.min(0x7f, twice), -Math.min(0x80, twice)];
        if (twice !== add || twice > 0x7f)
          convert(
            `${where}: pulse speed $${hex(add)} becomes +${up}/${down} per frame (GoatTracker halves and doubles it)`,
          );
        /** A leg of `dist` (> 0) at `speed`; the distance it covers. */
        const leg = (dist: number, speed: number): number => {
          const time = Math.floor(dist / add);
          steps.push(...timedRows(time, speed));
          return time * add;
        };
        const from = start << 4;
        let at = from;
        if (high > at) at += leg(high - at, up);
        const fall = steps.length + 1;
        if (at > low) at -= leg(at - low, down);
        if (from < high && from > at) {
          leg(from - at, up);
          steps.push({ left: JUMP, right: 2 });
        } else {
          if (high > at) leg(high - at, up);
          steps.push({ left: JUMP, right: fall });
        }
      }
      pulsePtr = pulse.add(steps);
    }
    // Filter: +6 is a filter-table row (gsong.c:379).
    const filterPtr = mapFilter(h[6]!, where) ?? 0;
    return {
      name: ins.name,
      attack: h[0]! >> 4,
      decay: h[0]! & 0x0f,
      sustain: h[1]! >> 4,
      release: h[1]! & 0x0f,
      // A GT1 instrument has no first-wave or gate-timer byte: GT2's
      // defaults for a new instrument (ginstr.c:210-221: $09, 2 at speed 1).
      firstWave: 0x09,
      gateTimer: 2,
      hardRestart: !noHardRestart,
      noGateOff: false,
      vibratoDelay: 0,
      wavePtr: wave.add(program),
      pulsePtr,
      filterPtr,
      speedPtr: 0,
    };
  });

  // --- Patterns.
  const speedRow = (left: number, right: number) =>
    speed.add([{ left, right }]);
  /**
   * Funktempo's speed row (gsong.c:698): GT packs filter row 0's bytes 2-3
   * as b2<<4 | (b3 & 15) and splits that as bits 4-7 / 0-3 (gtable.c:876-878),
   * so the row is (b2 & 15, b3 & 15); a packed 0 is no row (gtable.c:862).
   * Without a filter table GT reads uninitialised stack bytes (gsong.c:341);
   * zeros stand in for them.
   */
  const funktempo = (): number => {
    const [b2, b3] =
      filterTable === null ? [0, 0] : [filterTable[2]!, filterTable[3]!];
    if (((b2 << 4) | (b3 & 0x0f)) === 0) return 0;
    return speedRow(b2 & 0x0f, b3 & 0x0f);
  };
  /**
   * GT2's arpeggio conversion (gsong.c:709-797), once per (instrument,
   * parameter): a wave program of the instrument's head, then the steps X, Y
   * and 0 semitones (bit 7 of the parameter the steps' left byte, a 1-frame
   * delay each: half speed), looping on X (gsong.c:746-760). The instrument
   * is then cloned onto that program, into the slots after the highest one a
   * pattern names (gsong.c:598, 762-776), and the row plays the clone; with
   * no slot left, the row starts the program with command 8 (gsong.c:777-780).
   * `null`: the wave table has no room, and the row keeps command 0 00.
   */
  const arpeggios = new Map<string, { clone: boolean; value: number } | null>();
  let nextSlot = usedInstruments + 1;
  const arpeggio = (
    ins: number,
    param: number,
    where: string,
  ): { clone: boolean; value: number } | null => {
    const key = `${ins},${param}`;
    let arp = arpeggios.get(key);
    if (arp === undefined) {
      const head = arpeggioHeads[ins - 1]!;
      gtWaveRows = Math.min(SID_MAX_TABLE_ROWS, gtWaveRows + head.length);
      if (gtWaveRows >= SID_MAX_TABLE_ROWS - 3) arp = null;
      else {
        gtWaveRows += 4;
        const delay = param >> 7;
        const ptr = wave.add([
          ...head,
          { left: delay, right: (param >> 4) & 0x07 },
          { left: delay, right: param & 0x0f },
          { left: delay, right: 0x00 },
          { left: JUMP, right: head.length + 1 },
        ]);
        const source = instruments[ins - 1]!;
        if (nextSlot <= SID_MAX_INSTRUMENTS) {
          const slot = nextSlot++;
          const replaced = instruments[slot - 1];
          if (replaced !== undefined && !raw[slot - 1]!.empty) {
            convert(
              `instrument ${slot} ("${replaced.name}"), which no pattern plays, is replaced by an arpeggio instrument (as GoatTracker does)`,
            );
          }
          // GT appends "0XY" when the name has room (gsong.c:769-774).
          const name =
            source.name.length < SID_MAX_INSTRUMENT_NAME_LENGTH - 3
              ? `${source.name}0${hex(param & 0x7f)}`
              : source.name;
          instruments[slot - 1] = { ...source, name, wavePtr: ptr };
          arp = { clone: true, value: slot };
          convert(
            `arpeggio $${hex(param)} of instrument ${ins} became wave program ${ptr}, played by instrument ${slot}`,
          );
        } else {
          arp = { clone: false, value: ptr };
          convert(
            `arpeggio $${hex(param)} of instrument ${ins} became wave program ${ptr} (command 8: no instrument slot left)`,
          );
        }
      }
      arpeggios.set(key, arp);
    }
    if (arp === null)
      drop(
        `${where}: arpeggio $${hex(param)} of instrument ${ins} does not fit the wave table; dropped`,
      );
    return arp;
  };
  const patterns: SidDocPattern[] = rawPatterns.map((data, p) => {
    const n = data.length / 3;
    if (n < 2 || data[(n - 1) * 3] !== GT1_PATTERN_END)
      throw new GtFormatError(
        `pattern ${p} does not end with the pattern-end row`,
      );
    if (n - 1 > SID_MAX_PATTERN_ROWS)
      throw new GtFormatError(
        `pattern ${p} has ${n - 1} rows; a pattern has at most ${SID_MAX_PATTERN_ROWS}`,
      );
    const rows: SidDocRow[] = [];
    // The instrument the pattern last named (gsong.c:675, 678).
    let current = 0;
    for (let i = 0; i < n - 1; i++) {
      const where = `pattern ${p} row ${i}`;
      const [nb, packed, param] = [
        data[i * 3]!,
        data[i * 3 + 1]!,
        data[i * 3 + 2]!,
      ];
      let note: number;
      if (nb <= GT1_NOTE_LAST) note = nb + 1;
      else if (nb === GT1_NOTE_KEY_OFF) note = SID_NOTE_KEY_OFF;
      else if (nb === GT1_NOTE_REST) note = SID_NOTE_NONE;
      else if (nb === GT1_PATTERN_END)
        throw new GtFormatError(
          `${where}: note byte $${hex(nb)} is not a GoatTracker 1 note`,
        );
      else {
        // Any other byte is a rest: GT adds GT2's first note, $60, and rests
        // what lands past its last, $BC (gsong.c:559-560). Its note byte is 8
        // bits: $9F lands on its pattern end and from $A0 the sum wraps below
        // its first note. Not a note either way: rested here, and reported.
        note = SID_NOTE_NONE;
        const wrapped = (nb + 0x60) & 0xff;
        if (nb + 0x60 >= GT1_PATTERN_END)
          convert(
            `${where}: note byte $${hex(nb)} becomes GoatTracker 2's $${hex(wrapped)}, ${wrapped === GT1_PATTERN_END ? 'its pattern end' : 'no note'}; rested`,
          );
      }
      let instrument = packed >> 3;
      if (instrument !== 0) current = instrument;
      const cmd = packed & 0x07;
      let command = 0;
      let out = 0;
      switch (cmd) {
        case 0:
          if (param !== 0) {
            // Arpeggio: GT2 converts it only on a note, and only once the
            // pattern has named an instrument (gsong.c:701-707); anywhere else
            // the parameter is cleared (gsong.c:800-802). The program the note
            // starts loops on, so a later row's clearing loses nothing.
            if (nb > GT1_NOTE_LAST) break;
            if (current === 0) {
              drop(
                `${where}: arpeggio $${hex(param)} before the pattern names an instrument; dropped`,
              );
              break;
            }
            const arp = arpeggio(current, param, where);
            if (arp === null) break;
            if (arp.clone) instrument = arp.value;
            else {
              command = 0x8;
              out = arp.value;
            }
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
          // Filter-table pointer: GT2's AXY (gsong.c:576-578, 690-692).
          {
            const ptr = mapFilter(param, where);
            if (ptr !== null) {
              command = 0xa;
              out = ptr;
            }
          }
          break;
        case 6:
          // Set SR: GT2's own command 6, kept as is (gsong.c:574-590 has no case for it).
          command = 0x6;
          out = param;
          break;
        default:
          // Tempo (gsong.c:581-589, 694-699): below $F0 GT2's FXY with the
          // same parameter, $F0 up master volume DXY with the low nibble, 00
          // funktempo EXY.
          if (param >= 0xf0) {
            command = 0xd;
            out = param & 0x0f;
          } else if (param !== 0) {
            command = 0xf;
            out = param;
          } else {
            command = 0xe;
            out = funktempo();
          }
      }
      rows.push({ note, instrument, command, param: out });
    }
    return { rows };
  });

  const subsongs: SidSubsong[] = rawLists.map((lists, sub) => ({
    orderlists: lists.map((data, c) => {
      const { list, loopDiffers } = decodeGtOrderlist(
        data,
        `subtune ${sub} channel ${c + 1}`,
        patterns.length,
      );
      if (loopDiffers) {
        notes.push({
          kind: 'loop-transpose',
          message: `subtune ${sub} channel ${c + 1}: its loop replays with a running transpose/repeat the doc cannot hold; the first pass's is kept`,
        });
      }
      return list;
    }),
  }));

  // An all-zero last row maps one past what was laid: GT2's table is 255
  // rows, blank past its content, so the doc gets that blank row.
  let filterEnd = Math.max(
    0,
    ...instruments.map((ins) => ins.filterPtr),
    ...filterRows.map((row) => (row.left === JUMP ? row.right : 0)),
  );
  for (const pattern of patterns)
    for (const row of pattern.rows)
      if (row.command === 0xa) filterEnd = Math.max(filterEnd, row.param);
  while (filterRows.length < filterEnd) filterRows.push({ left: 0, right: 0 });

  return {
    ...header,
    subsongs,
    patterns,
    instruments,
    tables: {
      wave: wave.rows,
      pulse: pulse.rows,
      filter: filterRows,
      speed: speed.rows,
    },
  };
}
