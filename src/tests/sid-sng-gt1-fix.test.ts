import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { gtSongHintsFromName, importGtSong, type GtSongImport, type SidDoc } from 'src/audio/tracker/sid-doc';

/**
 * The GoatTracker 1 (`GTS!`) conversion against GoatTracker 2's own GT1
 * loader (gsong.c:329-845 and the pre-2.4 pulse pass at gsong.c:816-830), as
 * cross-checked in `.ai/sid-crosscheck-verdict.md`. Every expectation here is
 * worked by hand from that algorithm (facts only: no GT code is carried).
 */

const text = (s: string, n: number) => Array.from({ length: n }, (_, i) => (i < s.length ? s.charCodeAt(i) : 0));

interface Gt1Instrument {
  /** AD, SR, pulse start, pulse speed, low limit, high limit, filter byte. */
  h: number[];
  name?: string;
  wave: number[][];
}

const EMPTY: Gt1Instrument = { h: [0, 0, 0, 0, 0, 0, 0], wave: [[0, 0], [0xff, 0]] };

/** A GTS! file; `filter` rows default to all zero (a missing table when undefined). */
function gt1(instruments: Gt1Instrument[], patterns: number[][][], filter?: Record<number, number[]>): Uint8Array {
  const out: number[] = [...'GTS!'.split('').map((c) => c.charCodeAt(0)), ...text('', 96), 1];
  for (let c = 0; c < 3; c++) out.push(2, 0x00, 0xff, 0x00);
  for (let i = 0; i < 31; i++) {
    const ins = instruments[i] ?? EMPTY;
    out.push(...ins.h, ins.wave.length * 2, ...text(ins.name ?? '', 16), ...ins.wave.flat());
  }
  out.push(patterns.length);
  for (const rows of patterns) {
    out.push((rows.length + 1) * 3);
    for (const r of rows) out.push(...r);
    out.push(0xff, 0, 0);
  }
  if (filter) for (let i = 0; i < 64; i++) out.push(...(filter[i] ?? [0, 0, 0, 0]));
  return Uint8Array.from(out);
}

function ok(r: GtSongImport): Extract<GtSongImport, { ok: true }> {
  if (!r.ok) throw new Error(`refused: ${r.reason}`);
  return r;
}
const kinds = (notes: readonly { kind: string }[]) => notes.map((n) => n.kind);
const row = (note: number, instrument: number, cmd: number, param: number) => [note, (instrument << 3) | cmd, param];
const REST = 0x5f;
const lead = (h: number[] = [0x09, 0x00, 0, 0, 0, 0, 0], name = 'Lead'): Gt1Instrument => ({ h, name, wave: [[0x41, 0x00], [0xff, 0x00]] });
type Tables = SidDoc['tables'];
const slice = (t: Tables[keyof Tables], ptr: number, n: number) => t.slice(ptr - 1, ptr - 1 + n);

describe('GT1 filter table (gsong.c:602-669)', () => {
  it('a set row: byte 1 bits 4-6 are the passband, byte 0 is resonance|channels as is (gsong.c:621-625)', () => {
    const f = { 1: [0xf1, 0x1f, 0x40, 0x00] };
    const { doc, notes } = ok(importGtSong(gt1([lead([0x09, 0, 0, 0, 0, 0, 1])], [[row(0x30, 1, 0, 0)]], f)));
    expect(doc.instruments[0]!.filterPtr).toBe(1);
    expect(doc.tables.filter).toEqual([
      { left: 0x90, right: 0xf1 },
      { left: 0x00, right: 0x40 },
      { left: 0xff, right: 0 },
    ]);
    expect(notes).toEqual([]);
  });

  it('converts rows 1..numfilter in order, falls through on next = c+1, maps all-zero rows to the current end, pads what points there', () => {
    const f = {
      0: [0x00, 0x00, 0x35, 0x12], // never converted; byte 3 still counts for numfilter (18)
      1: [0xc1, 0x3f, 0x00, 0x02], // set LP+HP, no cutoff row (byte 2 is 0), falls through to 2
      2: [0x00, 0x05, 0x02, 0x02], // 5 frames at +2, loops on itself
      3: [0x00, 0x00, 0x00, 0x00], // nothing
      4: [0x80, 0x0f, 0x20, 0x04], // set, cutoff $20, loops on itself
      5: [0x00, 0xff, 0xfe, 0x00], // 255 frames: 127 + 127 + 1, then stop
      6: [0x00, 0x00, 0x10, 0x07], // zero time: no rows, and 7 follows, so no jump either
    };
    const song = gt1(
      [lead([0x09, 0, 0, 0, 0, 0, 1])],
      [[row(0x30, 1, 0, 0), row(REST, 0, 5, 6), row(REST, 0, 5, 0), row(REST, 0, 5, 3), row(REST, 0, 5, 4)]],
      f,
    );
    const { doc, notes } = ok(importGtSong(song));
    expect(doc.tables.filter).toEqual([
      { left: 0xb0, right: 0xc1 },
      { left: 0x05, right: 0x02 },
      { left: 0xff, right: 2 },
      { left: 0x80, right: 0x80 },
      { left: 0x00, right: 0x20 },
      { left: 0xff, right: 4 },
      { left: 0x7f, right: 0xfe },
      { left: 0x7f, right: 0xfe },
      { left: 0x01, right: 0xfe },
      { left: 0xff, right: 0 },
      // Rows 6-18 lay nothing: they all map to row 11, GoatTracker's blank row past the end.
      { left: 0x00, right: 0x00 },
    ]);
    expect(doc.instruments[0]!.filterPtr).toBe(1);
    expect(doc.patterns[0]!.rows.slice(1).map((r) => [r.command, r.param])).toEqual([
      [0xa, 11],
      [0xa, 0],
      [0xa, 4],
      [0xa, 4],
    ]);
    // A zero-time modulation is no longer a converted still frame (gsong.c:637-647).
    expect(notes).toEqual([]);
  });

  it('a zero-time modulation that jumps elsewhere is its jump row alone', () => {
    const f = { 1: [0x80, 0x0f, 0x30, 0x02], 2: [0x00, 0x00, 0x05, 0x01] };
    const { doc, notes } = ok(importGtSong(gt1([lead([0x09, 0, 0, 0, 0, 0, 1])], [[row(0x30, 1, 0, 0)]], f)));
    expect(doc.tables.filter).toEqual([
      { left: 0x80, right: 0x80 },
      { left: 0x00, right: 0x30 },
      { left: 0xff, right: 1 },
    ]);
    expect(notes).toEqual([]);
  });

  it('reports master volume and voice-3-off bits a set row drops', () => {
    const f = { 1: [0x11, 0x9a, 0x40, 0x00] };
    const { doc, notes } = ok(importGtSong(gt1([lead([0x09, 0, 0, 0, 0, 0, 1])], [[row(0x30, 1, 0, 0)]], f)));
    expect(doc.tables.filter[0]).toEqual({ left: 0x90, right: 0x11 });
    expect(kinds(notes)).toEqual(['gt1-dropped']);
  });

  it('guards the reads GoatTracker makes out of bounds: a pointer or next row past 63 is 0, reported', () => {
    const f = { 1: [0x80, 0x0f, 0x30, 0x70] };
    const song = gt1([lead([0x09, 0, 0, 0, 0, 0, 0x50]), lead([0x09, 0, 0, 0, 0, 0, 1], 'B')], [[row(0x30, 1, 0, 0), row(0x30, 2, 5, 0x41)]], f);
    const { doc, notes } = ok(importGtSong(song));
    expect(doc.instruments.map((i) => i.filterPtr)).toEqual([0, 1]);
    expect(doc.tables.filter).toEqual([
      { left: 0x80, right: 0x80 },
      { left: 0x00, right: 0x30 },
      { left: 0xff, right: 0 },
    ]);
    expect(doc.patterns[0]!.rows[1]).toMatchObject({ command: 0xa, param: 0 });
    expect(kinds(notes)).toEqual(['gt1-dropped', 'gt1-dropped', 'gt1-dropped']);
  });

  it('without a filter table, a zero filter pointer is still A00; a non-zero one is dropped and reported', () => {
    const { doc, notes } = ok(importGtSong(gt1([lead([0x09, 0, 0, 0, 0, 0, 2])], [[row(0x30, 1, 5, 0), row(REST, 0, 5, 3)]])));
    expect(doc.instruments[0]!.filterPtr).toBe(0);
    expect(doc.patterns[0]!.rows.map((r) => [r.command, r.param])).toEqual([
      [0xa, 0],
      [0, 0],
    ]);
    expect(kinds(notes)).toEqual(['gt1-dropped', 'gt1-dropped']);
  });
});

describe('GT1 commands 6 and 7 (gsong.c:574-590, 694-699)', () => {
  it('keeps command 6 (set SR) with its parameter', () => {
    const { doc, notes } = ok(importGtSong(gt1([lead()], [[row(0x30, 1, 6, 0x00), row(REST, 0, 6, 0x3a)]])));
    expect(doc.patterns[0]!.rows.map((r) => [r.command, r.param])).toEqual([
      [6, 0x00],
      [6, 0x3a],
    ]);
    expect(notes).toEqual([]);
  });

  it('command 7: below $F0 tempo, $F0 up master volume, 00 funktempo from filter row 0 bytes 2-3', () => {
    const f = { 0: [0x00, 0x00, 0x35, 0x12] };
    const song = gt1([lead()], [[row(0x30, 1, 7, 0x85), row(REST, 0, 7, 0xf7), row(REST, 0, 7, 0x00), row(REST, 0, 7, 0xef)]], f);
    const { doc, notes } = ok(importGtSong(song));
    expect(doc.patterns[0]!.rows.map((r) => [r.command, r.param])).toEqual([
      [0xf, 0x85],
      [0xd, 0x07],
      [0xe, 1],
      [0xf, 0xef],
    ]);
    // makespeedtable MST_FUNKTEMPO (gtable.c:876-878): left = bits 4-7 of (b2<<4 | b3&15), i.e. b2's LOW nibble.
    expect(doc.tables.speed).toEqual([{ left: 0x05, right: 0x02 }]);
    expect(notes).toEqual([]);
  });

  it('command 7 00 with no filter table (or zero bytes) is E00', () => {
    const { doc } = ok(importGtSong(gt1([lead()], [[row(0x30, 1, 7, 0x00)]])));
    expect(doc.patterns[0]!.rows[0]).toMatchObject({ command: 0xe, param: 0 });
    expect(doc.tables.speed).toEqual([]);
  });
});

describe('GT1 arpeggio (gsong.c:700-803)', () => {
  const wavy: Gt1Instrument = { h: [0x09, 0, 0, 0, 0, 0, 0], name: 'Lead', wave: [[0x41, 0x05], [0x21, 0x80], [0xff, 0x01]] };
  const bare: Gt1Instrument = { h: [0x0a, 0, 0, 0, 0, 0, 0], name: 'Bass', wave: [[0x00, 0x00], [0xff, 0x00]] };

  it('clones the instrument per (instrument, param): its wave lefts, then X, Y, 0 looping; bit 7 is a 1-frame delay per step', () => {
    const song = gt1(
      [wavy, bare],
      [
        [
          row(0x30, 1, 0, 0x37), // new pair (1, $37): clone 3
          row(REST, 0, 0, 0x37), // no note: param cleared
          row(0x32, 0, 0, 0x37), // running instrument 1: clone 3 again
          row(0x30, 2, 0, 0xb7), // new pair (2, $B7): clone 4, half speed
          row(0x30, 0, 0, 0x37), // new pair (2, $37): clone 5
          row(0x5e, 0, 0, 0x12), // key off: param cleared
        ],
        [row(0x30, 0, 0, 0x25)], // no instrument yet in this pattern: cleared
      ],
    );
    const { doc } = ok(importGtSong(song));
    const r = doc.patterns[0]!.rows.map((x) => [x.note, x.instrument, x.command, x.param]);
    expect(r).toEqual([
      [0x31, 3, 0, 0],
      [0, 0, 0, 0],
      [0x33, 3, 0, 0],
      [0x31, 4, 0, 0],
      [0x31, 5, 0, 0],
      [126, 0, 0, 0],
    ]);
    expect(doc.patterns[1]!.rows[0]).toEqual({ note: 0x31, instrument: 0, command: 0, param: 0 });
    expect(doc.instruments.map((i) => i.name)).toEqual(['Lead', 'Bass', 'Lead037', 'Bass037', 'Bass037']);
    const [c3, c4, c5] = doc.instruments.slice(2);
    // The prefix copies the LEFT bytes only (gsong.c:740): the right bytes stay GT's blank 0.
    expect(slice(doc.tables.wave, c3!.wavePtr, 6)).toEqual([
      { left: 0x41, right: 0 },
      { left: 0x21, right: 0 },
      { left: 0, right: 3 },
      { left: 0, right: 7 },
      { left: 0, right: 0 },
      { left: 0xff, right: c3!.wavePtr + 2 },
    ]);
    // An instrument without a wave program (one blank row + stop, gsong.c:407-416) has no prefix.
    expect(slice(doc.tables.wave, c4!.wavePtr, 4)).toEqual([
      { left: 1, right: 3 },
      { left: 1, right: 7 },
      { left: 1, right: 0 },
      { left: 0xff, right: c4!.wavePtr },
    ]);
    expect(slice(doc.tables.wave, c5!.wavePtr, 4)).toEqual([
      { left: 0, right: 3 },
      { left: 0, right: 7 },
      { left: 0, right: 0 },
      { left: 0xff, right: c5!.wavePtr },
    ]);
    // A clone is the instrument otherwise.
    expect({ ...c3!, name: '', wavePtr: 0 }).toEqual({ ...doc.instruments[0]!, name: '', wavePtr: 0 });
  });

  it('a name of 13+ characters is not extended (gsong.c:769)', () => {
    const { doc } = ok(importGtSong(gt1([{ ...wavy, name: 'ThirteenChars' }], [[row(0x30, 1, 0, 0x04)]])));
    expect(doc.instruments.map((i) => i.name)).toEqual(['ThirteenChars', 'ThirteenChars']);
  });

  it('clones start after the highest instrument a pattern uses, overwriting an unused one (gsong.c:598, 763-766)', () => {
    const { doc, notes } = ok(importGtSong(gt1([wavy, { ...bare, name: 'Unused' }], [[row(0x30, 1, 0, 0x04)]])));
    expect(doc.instruments.map((i) => i.name)).toEqual(['Lead', 'Lead004']);
    expect(notes.filter((n) => n.message.includes('Unused'))).toHaveLength(1);
  });

  it('when the 63 instrument slots run out, the row gets command 8 with the program', () => {
    const rows = [row(0x30, 31, 0, 0)];
    for (let p = 1; p <= 33; p++) rows.push(row(0x30, 1, 0, p));
    const { doc } = ok(importGtSong(gt1([wavy], [rows])));
    expect(doc.instruments).toHaveLength(63);
    const r = doc.patterns[0]!.rows;
    expect(r.slice(1, 33).map((x) => x.instrument)).toEqual(Array.from({ length: 32 }, (_, k) => 32 + k));
    expect(r[33]).toMatchObject({ instrument: 1, command: 8 });
    expect(slice(doc.tables.wave, r[33]!.param, 6).map((x) => x.left)).toEqual([0x41, 0x21, 0, 0, 0, 0xff]);
    expect(slice(doc.tables.wave, r[33]!.param + 2, 2).map((x) => x.right)).toEqual([2, 1]);
  });

  it('when the wave table cannot hold the program, the row is left as command 0 param 0 and reported', () => {
    const long = (base: number): Gt1Instrument => ({ h: [0x09, 0, 0, 0, 0, 0, 0], name: 'Long', wave: [...Array.from({ length: 124 }, (_, k) => [0x41, base + k]), [0xff, 0]] });
    const song = gt1([long(0), long(1)], [[row(0x30, 1, 0, 0x37), row(0x30, 2, 0, 0), row(0x30, 1, 0, 0x37)]]);
    const { doc, notes } = ok(importGtSong(song));
    expect(doc.patterns[0]!.rows.map((x) => [x.instrument, x.command, x.param])).toEqual([
      [1, 0, 0],
      [2, 0, 0],
      [1, 0, 0],
    ]);
    expect(doc.instruments).toHaveLength(2);
    expect(kinds(notes)).toEqual(['gt1-dropped', 'gt1-dropped']);
  });
});

describe('GT1 pulse (gsong.c:379-538, 816-830)', () => {
  const pulse = (bytes: number[]) => {
    const { doc, notes } = ok(importGtSong(gt1([lead([0x09, 0x00, ...bytes, 0])], [[row(0x30, 1, 0, 0)]])));
    const ins = doc.instruments[0]!;
    return { ins, table: doc.tables.pulse, notes };
  };

  it('bit 0 of the start byte is "no hard restart", and not part of the width', () => {
    const { ins, table } = pulse([0x81, 0x00, 0x00, 0x00]);
    expect(ins.hardRestart).toBe(false);
    expect(table).toEqual([{ left: 0x88, right: 0x00 }, { left: 0xff, right: 0 }]);
    expect(pulse([0x83, 0x00, 0x00, 0x00]).table[0]).toEqual({ left: 0x88, right: 0x20 });
    expect(pulse([0x80, 0x00, 0x00, 0x00]).ins.hardRestart).toBe(true);
  });

  it('a zero start width makes no program, whatever the speed', () => {
    const { ins, table } = pulse([0x01, 0x20, 0x10, 0x80]);
    expect([ins.pulsePtr, ins.hardRestart]).toEqual([0, false]);
    expect(table).toEqual([]);
  });

  it('floors the sweep times, doubles the halved speed (odd bit lost), and loops back to the start when it lies above the low turn', () => {
    // start $300, limits $100-$700, speed 37: up 27 frames (to $6E7), down 40 (to $11F), up 13 (to $300), jump to row 2.
    const { table, notes } = pulse([0x30, 0x25, 0x10, 0x70]);
    expect(table).toEqual([
      { left: 0x83, right: 0x00 },
      { left: 27, right: 36 },
      { left: 40, right: 0x100 - 36 },
      { left: 13, right: 36 },
      { left: 0xff, right: 2 },
    ]);
    expect(kinds(notes)).toEqual(['gt1-convert']);
  });

  it('otherwise sweeps up to the high limit and jumps to the first down row (hlpos + 1)', () => {
    const { table, notes } = pulse([0x20, 0x18, 0x20, 0x80]);
    expect(table).toEqual([
      { left: 0x82, right: 0x00 },
      { left: 64, right: 24 },
      { left: 64, right: 0x100 - 24 },
      { left: 64, right: 24 },
      { left: 0xff, right: 3 },
    ]);
    expect(notes).toEqual([]);
  });

  it('splits sweeps longer than 127 frames', () => {
    // start $100, limits $100-$F00, speed 8: up 448 frames = 127+127+127+67.
    const { table } = pulse([0x10, 0x08, 0x10, 0xf0]);
    expect(table.slice(0, 5)).toEqual([
      { left: 0x81, right: 0x00 },
      { left: 127, right: 8 },
      { left: 127, right: 8 },
      { left: 127, right: 8 },
      { left: 67, right: 8 },
    ]);
  });

  it('clamps a doubled speed to +127/-128 (the odd-looking corpus bytes are GT\'s own math)', () => {
    // start $100 above high $F0: no rise; down 1 frame at -240 -> -128; nothing back up; jump to the down row.
    const { table, notes } = pulse([0x10, 0xf0, 0x01, 0x0f]);
    expect(table).toEqual([
      { left: 0x81, right: 0x00 },
      { left: 1, right: 0x80 },
      { left: 0xff, right: 2 },
    ]);
    expect(kinds(notes)).toEqual(['gt1-convert']);
  });

  it('speed 1 halves to a timed no-op, not doubled', () => {
    const { table } = pulse([0x20, 0x01, 0x20, 0x21]);
    expect(table).toEqual([
      { left: 0x82, right: 0x00 },
      { left: 16, right: 0 },
      { left: 16, right: 0 },
      { left: 16, right: 0 },
      { left: 0xff, right: 3 },
    ]);
  });

  it('speed 0 holds the width', () => {
    expect(pulse([0x40, 0x00, 0x10, 0x80]).table).toEqual([{ left: 0x84, right: 0x00 }, { left: 0xff, right: 0 }]);
  });
});

describe('GT1 notes and wavetable bytes', () => {
  it('rests note bytes $5D and $60-$9E silently, as GoatTracker does (gsong.c:559-560)', () => {
    const { doc, notes } = ok(importGtSong(gt1([lead()], [[row(0x5d, 1, 0, 0), row(0x60, 0, 0, 0), row(0x9e, 0, 0, 0)]])));
    expect(doc.patterns[0]!.rows.map((r) => r.note)).toEqual([0, 0, 0]);
    expect(notes).toEqual([]);
  });

  it('rests $9F-$FE too, reporting that GoatTracker wraps them to non-notes', () => {
    const { doc, notes } = ok(importGtSong(gt1([lead()], [[row(0x9f, 1, 0, 0), row(0xa0, 0, 0, 0), row(0xfe, 0, 0, 0)]])));
    expect(doc.patterns[0]!.rows.map((r) => r.note)).toEqual([0, 0, 0]);
    expect(kinds(notes)).toEqual(['gt1-convert', 'gt1-convert', 'gt1-convert']);
  });

  it('ORs wavetable lefts $08-$0F with $E0 (pre-2.18 delays, gsong.c:396-397)', () => {
    const ins = { h: [0x09, 0, 0, 0, 0, 0, 0], name: 'W', wave: [[0x07, 0], [0x08, 1], [0x0f, 2], [0x10, 3], [0xff, 0]] };
    const { doc } = ok(importGtSong(gt1([ins], [[row(0x30, 1, 0, 0)]])));
    expect(slice(doc.tables.wave, doc.instruments[0]!.wavePtr, 4).map((r) => r.left)).toEqual([0x07, 0xe8, 0xef, 0x10]);
  });
});

describe('GT1 conversion on the corpus', () => {
  const ROOT = resolve(__dirname, 'fixtures/gt-songs');
  const load = (name: string) => ok(importGtSong(new Uint8Array(readFileSync(resolve(ROOT, name))), gtSongHintsFromName(name)));

  it('the 16 "no hard restart" instruments (pulse bit 0) of three files import with hard restart off', () => {
    const off = (name: string) => load(name).doc.instruments.filter((i) => !i.hardRestart).length;
    // Arpeggio clones copy the flag, so a file can hold more than its 31 slots showed.
    expect(off('cadaver/galwaytest.sng')).toBeGreaterThanOrEqual(2);
    expect(off('shinobi/wod.sng')).toBeGreaterThanOrEqual(5);
    expect(off('yehar/b_o_f_h_ingame_death_victory.sng')).toBeGreaterThanOrEqual(9);
    expect(off('cadaver/tarantula.sng')).toBe(0);
  });

  it('the two command-6 rows keep command 6 00', () => {
    expect(load('aeuk/metal_warrior_4_streets.sng').doc.patterns[40]!.rows[0]).toMatchObject({ command: 6, param: 0 });
    expect(load('cadaver/tarantula.sng').doc.patterns[2]!.rows[0]).toMatchObject({ command: 6, param: 0 });
  });
});
