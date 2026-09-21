// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseAhx, ahxPListCommandsFor, normalizeAhxInstrumentForVersion, type AhxInstrument } from '@another-synth/tracker-playback';
import {
  AHX_SIZE_LIMIT,
  ahxInstrumentBytes,
  ahxUsedBytes,
  buildAhxFile,
  formatBytes,
  instrumentGrowthRefusal,
} from 'src/audio/tracker/ahx-doc';
import { ahxEditNotice, clearAhxEditNotice } from 'src/audio/tracker/ahx-edit-notice';
import {
  addAhxPListEntry,
  ahxFxParamMax,
  clearAhxPListEntry,
  defaultAhxInstrument,
  duplicateAhxPListEntry,
  editAhxPListEntry,
  emptyPListEntry,
  removeAhxPListEntry,
  type AhxPListEdit,
} from 'src/audio/tracker/ahx-instrument-edit';
import {
  clearPListCell,
  clearPListRow,
  commitPListEdit,
  countPListJumps,
  createPListGesture,
  deletePListRow,
  duplicatePListRow,
  insertPListRowAfter,
  insertPListRowBefore,
  modifyPListEntry,
  nudgePListEntry,
  plistJumpNotice,
  togglePListFixed,
  writePListNibble,
  type PListEditContext,
  type PListEditHost,
  type PListOpResult,
} from 'src/audio/tracker/plist-edit';
import { ahxCorpus, instrumentsOf, slotsOf } from './helpers/ahx-doc-fixtures';
import { nearFullSong } from './helpers/ahx-near-full';

const AHX: PListEditContext = { format: 'ahx', version: 1 };
const AHX_V0: PListEditContext = { format: 'ahx', version: 0 };
const HVL: PListEditContext = { format: 'hvl' };

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const withRows = (rows: Partial<AhxInstrument['plist']['entries'][number]>[]): AhxInstrument => {
  const ins = defaultAhxInstrument();
  ins.plist.entries = rows.map((row) => ({ ...emptyPListEntry(), ...row }));
  return ins;
};

function ok(r: PListOpResult<{ notice?: string }>): AhxInstrument {
  if (!r.ok) throw new Error(`refused: ${r.reason}`);
  return r.instrument;
}
function reason(r: PListOpResult<object>): string {
  if (r.ok) throw new Error('expected a refusal');
  return r.reason;
}

/** A corpus sample: every k-th instrument that has a PList, 60 of them. */
function corpusSample(): AhxInstrument[] {
  const all: AhxInstrument[] = [];
  for (const file of ahxCorpus()) all.push(...instrumentsOf(slotsOf(parseAhx(file.bytes))));
  const withPList = all.filter((ins) => ins.plist.entries.length > 0);
  const step = Math.floor(withPList.length / 60);
  return Array.from({ length: 60 }, (_, i) => withPList[i * step]!);
}
const sample = corpusSample();

/** The instruments of the size-limited fixtures: an empty list, one row, 254 and 255 rows. */
const listOf = (n: number): AhxInstrument => withRows(Array.from({ length: n }, (_, i) => ({ note: i % 64 })));
const extremes = (): AhxInstrument[] => [listOf(0), listOf(1), listOf(254), listOf(255)];

describe('PList ops: table parity (each op agrees with the primitive on what the primitive handles)', () => {
  it('modify: every field, on the sample and the extremes, first and last row', () => {
    let compared = 0;
    for (const ins of [...sample, ...extremes()]) {
      const last = ins.plist.entries.length - 1;
      for (const row of [...new Set([0, last])].filter((r) => r >= 0 && r <= last)) {
        const edits: AhxPListEdit[] = [
          { field: 'note', value: 0 },
          { field: 'note', value: 41 },
          { field: 'note', value: 63 },
          { field: 'waveform', value: 0 },
          { field: 'waveform', value: 4 },
          { field: 'fixed', value: true },
          { field: 'fixed', value: false },
          ...ahxPListCommandsFor('ahx').flatMap((value): AhxPListEdit[] => [
            { field: 'fx', slot: 0, value },
            { field: 'fx', slot: 1, value },
          ]),
          { field: 'fxParam', slot: 0, value: 0x3c },
          { field: 'fxParam', slot: 1, value: 255 },
        ];
        for (const edit of edits) {
          const r = modifyPListEntry(ins, row, edit, AHX);
          expect(r.ok ? '' : `${JSON.stringify(edit)} row ${row}: ${r.reason}`).toBe('');
          expect(ok(r)).toEqual(editAhxPListEntry(ins, row, edit, 'ahx'));
          compared++;
        }
      }
    }
    expect(compared).toBeGreaterThan(2000);
  });

  it('an unknown row: the primitive silently keeps the instrument, the op says so', () => {
    const empty = listOf(0);
    const edit: AhxPListEdit = { field: 'note', value: 4 };
    expect(editAhxPListEntry(empty, 0, edit)).toEqual(empty);
    expect(reason(modifyPListEntry(empty, 0, edit, AHX))).toBe('This PList has no rows.');
  });

  it('HVL takes the commands its PList holds and refuses none of the sixteen', () => {
    const ins = withRows([{ note: 3 }]);
    for (const command of ahxPListCommandsFor('hvl')) {
      expect(ok(modifyPListEntry(ins, 0, { field: 'fx', slot: 0, value: command }, HVL))).toEqual(
        editAhxPListEntry(ins, 0, { field: 'fx', slot: 0, value: command }, 'hvl'),
      );
    }
  });

  it('inserts, duplicate, delete and clear equal the primitives', () => {
    for (const ins of [...sample, ...extremes()]) {
      const n = ins.plist.entries.length;
      for (const row of [...new Set([0, Math.floor(n / 2), n - 1])].filter((r) => r >= 0 && r < n)) {
        expect(ok(deletePListRow(ins, row, AHX))).toEqual(removeAhxPListEntry(ins, row));
        expect(ok(clearPListRow(ins, row))).toEqual(clearAhxPListEntry(ins, row));
        expect(ok(clearPListRow(ins, row)).plist.entries[row]).toEqual(emptyPListEntry());
        if (n < 255) {
          expect(ok(insertPListRowAfter(ins, row, AHX))).toEqual(addAhxPListEntry(ins, row));
          expect(ok(insertPListRowBefore(ins, row, AHX))).toEqual(addAhxPListEntry(ins, row - 1));
          expect(ok(duplicatePListRow(ins, row, AHX))).toEqual(duplicateAhxPListEntry(ins, row));
          const expected = clone(ins);
          expected.plist.entries.splice(row + 1, 0, clone(ins.plist.entries[row]!));
          expect(ok(duplicatePListRow(ins, row, AHX))).toEqual(expected);
        }
      }
    }
  });

  it('insert-before at row 0 goes to the top, and an empty list takes a row at 0', () => {
    const ins = withRows([{ note: 5 }, { note: 6 }]);
    const top = ok(insertPListRowBefore(ins, 0, AHX));
    expect(top.plist.entries.map((e) => e.note)).toEqual([0, 5, 6]);
    expect(ok(insertPListRowBefore(ins, 2, AHX)).plist.entries.map((e) => e.note)).toEqual([5, 6, 0]);
    expect(ok(insertPListRowBefore(listOf(0), 0, AHX)).plist.entries).toEqual([emptyPListEntry()]);
    expect(ok(insertPListRowAfter(ins, -1, AHX)).plist.entries.map((e) => e.note)).toEqual([0, 5, 6]);
  });

  it('254 rows take one more; deleting the last row leaves a legal empty list', () => {
    expect(ok(insertPListRowBefore(listOf(254), 100, AHX)).plist.entries).toHaveLength(255);
    expect(ok(duplicatePListRow(listOf(254), 253, AHX)).plist.entries).toHaveLength(255);
    expect(ok(deletePListRow(listOf(1), 0, AHX)).plist.entries).toEqual([]);
  });

  it('duplicate keeps fx and fxParam arrays independent of the original', () => {
    const ins = withRows([{ note: 9, fx: [5, 12], fxParam: [3, 0x20] }]);
    const before = clone(ins);
    const dup = ok(duplicatePListRow(ins, 0, AHX));
    dup.plist.entries[1]!.fx[0] = 1;
    dup.plist.entries[1]!.fxParam[1] = 0;
    dup.plist.entries[0]!.fx[1] = 15;
    expect(ins).toEqual(before);
    expect(dup.plist.entries[0]!.fx).not.toBe(dup.plist.entries[1]!.fx);
    expect(dup.plist.entries[1]!.fx).toEqual([1, 12]);
  });
});

describe('PList ops: refusals say why and change nothing', () => {
  const ins = withRows([{ note: 5, fx: [5, 0], fxParam: [0x0a, 0] }, { note: 7 }]);

  it.each<[string, () => PListOpResult<object>, RegExp | string]>([
    ['a command AHX lacks', () => modifyPListEntry(ins, 0, { field: 'fx', slot: 0, value: 9 }, AHX), 'Command 9 is not available in an AHX PList.'],
    ['an HVL-only command in AHX (A)', () => modifyPListEntry(ins, 0, { field: 'fx', slot: 1, value: 10 }, AHX), 'Command A is not available in an AHX PList.'],
    ['a command that is not a digit', () => modifyPListEntry(ins, 0, { field: 'fx', slot: 0, value: 16 }, HVL), 'A PList command is one hex digit (got 16).'],
    ['a note above 63', () => modifyPListEntry(ins, 0, { field: 'note', value: 64 }, AHX), 'A PList note is 0 to 63 (got 64).'],
    ['a negative note', () => modifyPListEntry(ins, 0, { field: 'note', value: -1 }, AHX), 'A PList note is 0 to 63 (got -1).'],
    ['a fractional note', () => modifyPListEntry(ins, 0, { field: 'note', value: 1.5 }, AHX), 'A PList note is 0 to 63 (got 1.5).'],
    ['a waveform above 4', () => modifyPListEntry(ins, 0, { field: 'waveform', value: 5 }, AHX), 'A PList tone is 0 to 4 (got 5).'],
    ['a parameter above FF', () => modifyPListEntry(ins, 0, { field: 'fxParam', slot: 0, value: 256 }, AHX), 'A command parameter is 0 to FF (got 256).'],
    ['an unknown row', () => modifyPListEntry(ins, 2, { field: 'note', value: 1 }, AHX), 'There is no PList row 2: this PList has 2.'],
    ['a negative row', () => deletePListRow(ins, -1, AHX), 'There is no PList row -1: this PList has 2.'],
    ['any row of an empty list', () => clearPListRow(listOf(0), 0), 'This PList has no rows.'],
    ['a row insert at 255', () => insertPListRowBefore(listOf(255), 0, AHX), 'A PList has at most 255 rows.'],
    ['a duplicate at 255', () => duplicatePListRow(listOf(255), 0, AHX), 'A PList has at most 255 rows.'],
    ['an insert-after at 255', () => insertPListRowAfter(listOf(255), 3, AHX), 'A PList has at most 255 rows.'],
    ['a hex digit above F', () => writePListNibble(ins, 0, 0, 2, 16, AHX), 'A hex digit is 0 to F (got 16).'],
    ['a nibble command AHX lacks', () => writePListNibble(ins, 0, 1, 0, 6, AHX), 'Command 6 is not available in an AHX PList.'],
  ])('%s', (_name, run, expected) => {
    const before = clone(ins);
    const r = run();
    expect(r.ok).toBe(false);
    if (typeof expected === 'string') expect(reason(r)).toBe(expected);
    expect(ins).toEqual(before);
  });

  it('version-0 command 4 takes 0..F only, in both directions', () => {
    const four = withRows([{ fx: [4, 0], fxParam: [0x05, 0] }]);
    expect(ahxFxParamMax(4, 'ahx', 0)).toBe(15);
    // The high nibble of a version-0 command 4 parameter cannot be written.
    expect(reason(writePListNibble(four, 0, 0, 1, 3, AHX_V0))).toBe(
      'Command 4 takes a parameter of 0 to F in a version-0 AHX file (got 35).',
    );
    expect(ok(writePListNibble(four, 0, 0, 2, 0xf, AHX_V0)).plist.entries[0]!.fxParam[0]).toBe(0x0f);
    expect(reason(modifyPListEntry(four, 0, { field: 'fxParam', slot: 0, value: 0x10 }, AHX_V0))).toBe(
      'Command 4 takes a parameter of 0 to F in a version-0 AHX file (got 10).',
    );
    // Version 1 has no such limit, and neither has another command in version 0.
    expect(ok(writePListNibble(four, 0, 0, 1, 3, AHX)).plist.entries[0]!.fxParam[0]).toBe(0x35);
    const five = withRows([{ fx: [5, 0], fxParam: [0x50, 0] }]);
    expect(ok(modifyPListEntry(five, 0, { field: 'fxParam', slot: 0, value: 0xff }, AHX_V0)).plist.entries[0]!.fxParam[0]).toBe(0xff);
    // The table's own path (a field write) still refuses a command a big parameter cannot go with.
    expect(reason(modifyPListEntry(five, 0, { field: 'fx', slot: 0, value: 4 }, AHX_V0))).toBe(
      'Command 4 takes a parameter of 0 to F in a version-0 AHX file (got 50).',
    );
  });

  it('typing 4 first on a row whose parameter is above F writes it, cuts the parameter as the load would, and says so', () => {
    const five = withRows([{ fx: [5, 0], fxParam: [0x3c, 0] }]);
    const typed = writePListNibble(five, 0, 0, 0, 4, AHX_V0);
    expect(typed).toMatchObject({
      ok: true,
      changed: true,
      notice: "Command 4 takes a parameter of 0 to F in a version-0 AHX file: this row's 3C became 0C.",
    });
    expect((typed as { instrument: AhxInstrument }).instrument.plist.entries[0]).toMatchObject({ fx: [4, 0], fxParam: [0x0c, 0] });
    // The cut is what the file would do to it at load (nothing else changes).
    expect(normalizeAhxInstrumentForVersion((typed as { instrument: AhxInstrument }).instrument, 'ahx', 0).plist).toEqual(
      (typed as { instrument: AhxInstrument }).instrument.plist,
    );
    // Then the parameter can be typed in either order.
    const c = ok(typed);
    expect(ok(writePListNibble(c, 0, 0, 2, 5, AHX_V0)).plist.entries[0]!.fxParam[0]).toBe(0x05);
    // No notice when nothing has to be cut: another version, another command, or a parameter that fits.
    expect(writePListNibble(five, 0, 0, 0, 4, AHX)).not.toHaveProperty('notice');
    expect(writePListNibble(five, 0, 0, 0, 3, AHX_V0)).not.toHaveProperty('notice');
    expect(writePListNibble(withRows([{ fx: [5, 0], fxParam: [0x05, 0] }]), 0, 0, 0, 4, AHX_V0)).not.toHaveProperty('notice');
    // A command the format lacks is still refused, for the command.
    expect(reason(writePListNibble(five, 0, 0, 0, 9, AHX_V0))).toBe('Command 9 is not available in an AHX PList.');
    // + and - on the command digit reaches 4 the same way.
    const nudged = nudgePListEntry(withRows([{ fx: [3, 0], fxParam: [0x3c, 0] }]), 0, { field: 'nibble', slot: 0, nibble: 0 }, 1, AHX_V0);
    expect(nudged).toMatchObject({ ok: true, instrument: { plist: { entries: [{ fx: [4, 0], fxParam: [0x0c, 0] }] } } });
  });

  it('an op that would change nothing hands back the very same instrument', () => {
    const same = modifyPListEntry(ins, 1, { field: 'note', value: 7 }, AHX);
    expect(same).toEqual({ ok: true, instrument: ins, changed: false });
    if (same.ok) expect(same.instrument).toBe(ins);
    const cleared = clearPListRow(withRows([{}]), 0);
    expect(cleared.ok && cleared.changed).toBe(false);
    const nudge = nudgePListEntry(withRows([{ note: 63 }]), 0, { field: 'note' }, 5, AHX);
    expect(nudge.ok && nudge.changed).toBe(false);
  });

  it('no op mutates its input, accepted or not', () => {
    const before = clone(ins);
    const results = [
      modifyPListEntry(ins, 0, { field: 'note', value: 9 }, AHX),
      togglePListFixed(ins, 0, AHX),
      writePListNibble(ins, 0, 0, 2, 3, AHX),
      nudgePListEntry(ins, 1, { field: 'note' }, 3, AHX),
      clearPListCell(ins, 0, { command: 0 }, AHX),
      insertPListRowBefore(ins, 0, AHX),
      insertPListRowAfter(ins, 0, AHX),
      duplicatePListRow(ins, 0, AHX),
      deletePListRow(ins, 0, AHX),
      clearPListRow(ins, 0),
    ];
    expect(results.every((r) => r.ok)).toBe(true);
    expect(ins).toEqual(before);
    for (const r of results) if (r.ok && r.changed) expect(r.instrument).not.toBe(ins);
  });
});

describe('PList ops: nibbles, nudges and clears', () => {
  it('composes param = hi << 4 | lo, each nibble on its own, and the command nibble alone', () => {
    let cur = withRows([{}]);
    cur = ok(writePListNibble(cur, 0, 0, 0, 5, AHX));
    expect(cur.plist.entries[0]!.fx[0]).toBe(5);
    expect(cur.plist.entries[0]!.fxParam[0]).toBe(0);
    cur = ok(writePListNibble(cur, 0, 0, 1, 0x0, AHX));
    cur = ok(writePListNibble(cur, 0, 0, 2, 0xa, AHX));
    expect(cur.plist.entries[0]!.fxParam[0]).toBe(0x0a); // the `5 0A` sequence
    cur = ok(writePListNibble(cur, 0, 0, 1, 0xc, AHX));
    expect(cur.plist.entries[0]!.fxParam[0]).toBe(0xca);
    cur = ok(writePListNibble(cur, 0, 0, 2, 0x3, AHX));
    expect(cur.plist.entries[0]!.fxParam[0]).toBe(0xc3);
    // The other slot and the command stay put.
    expect(cur.plist.entries[0]!.fx).toEqual([5, 0]);
    expect(cur.plist.entries[0]!.fxParam[1]).toBe(0);
    for (let hi = 0; hi < 16; hi++) {
      for (let lo = 0; lo < 16; lo += 5) {
        const a = ok(writePListNibble(ok(writePListNibble(withRows([{}]), 0, 1, 1, hi, AHX)), 0, 1, 2, lo, AHX));
        expect(a.plist.entries[0]!.fxParam[1]).toBe((hi << 4) | lo);
      }
    }
  });

  it('nudges a note by semitones, the tone through 0..4 and a nibble through 0..F, clamped, no wrap', () => {
    const at = (entry: Partial<AhxInstrument['plist']['entries'][number]>): AhxInstrument => withRows([entry]);
    const entry = (r: PListOpResult<object>) => ok(r).plist.entries[0]!;
    expect(entry(nudgePListEntry(at({ note: 10 }), 0, { field: 'note' }, 12, AHX)).note).toBe(22);
    expect(entry(nudgePListEntry(at({ note: 60 }), 0, { field: 'note' }, 12, AHX)).note).toBe(63);
    expect(entry(nudgePListEntry(at({ note: 2 }), 0, { field: 'note' }, -12, AHX)).note).toBe(0);
    expect(entry(nudgePListEntry(at({ waveform: 4 }), 0, { field: 'waveform' }, 1, AHX)).waveform).toBe(4);
    expect(entry(nudgePListEntry(at({ waveform: 0 }), 0, { field: 'waveform' }, -1, AHX)).waveform).toBe(0);
    expect(entry(nudgePListEntry(at({ waveform: 2 }), 0, { field: 'waveform' }, 1, AHX)).waveform).toBe(3);
    const cmd = at({ fx: [12, 0], fxParam: [0x3f, 0] });
    expect(entry(nudgePListEntry(cmd, 0, { field: 'nibble', slot: 0, nibble: 2 }, 1, AHX)).fxParam[0]).toBe(0x40);
    expect(entry(nudgePListEntry(cmd, 0, { field: 'nibble', slot: 0, nibble: 1 }, 1, AHX)).fxParam[0]).toBe(0x4f);
    expect(entry(nudgePListEntry(at({ fx: [1, 0], fxParam: [0xf8, 0] }), 0, { field: 'nibble', slot: 0, nibble: 1 }, 1, AHX)).fxParam[0]).toBe(0xff);
    expect(entry(nudgePListEntry(at({ fx: [1, 0], fxParam: [0x02, 0] }), 0, { field: 'nibble', slot: 0, nibble: 2 }, -5, AHX)).fxParam[0]).toBe(0);
    // A command nibble steps to the next command; landing on one the format lacks is refused.
    expect(entry(nudgePListEntry(at({ fx: [4, 0] }), 0, { field: 'nibble', slot: 0, nibble: 0 }, 1, AHX)).fx[0]).toBe(5);
    expect(reason(nudgePListEntry(at({ fx: [5, 0] }), 0, { field: 'nibble', slot: 0, nibble: 0 }, 1, AHX))).toBe(
      'Command 6 is not available in an AHX PList.',
    );
    // Version-0 command 4: the parameter stops at F.
    expect(entry(nudgePListEntry(at({ fx: [4, 0], fxParam: [0x0e, 0] }), 0, { field: 'nibble', slot: 0, nibble: 2 }, 9, AHX_V0)).fxParam[0]).toBe(0x0f);
  });

  it('clears a note, a tone, or the whole of one command', () => {
    const ins = withRows([{ note: 9, waveform: 3, fixed: true, fx: [5, 12], fxParam: [4, 0x20] }]);
    const entry = (r: PListOpResult<object>) => ok(r).plist.entries[0]!;
    expect(entry(clearPListCell(ins, 0, 'note', AHX))).toMatchObject({ note: 0, waveform: 3, fx: [5, 12] });
    expect(entry(clearPListCell(ins, 0, 'tone', AHX))).toMatchObject({ note: 9, waveform: 0 });
    expect(entry(clearPListCell(ins, 0, { command: 0 }, AHX))).toMatchObject({ fx: [0, 12], fxParam: [0, 0x20] });
    expect(entry(clearPListCell(ins, 0, { command: 1 }, AHX))).toMatchObject({ fx: [5, 0], fxParam: [4, 0] });
  });

  it('toggles Fixed', () => {
    const ins = withRows([{ note: 5 }]);
    const on = ok(togglePListFixed(ins, 0, AHX));
    expect(on.plist.entries[0]!.fixed).toBe(true);
    expect(ok(togglePListFixed(on, 0, AHX)).plist.entries[0]!.fixed).toBe(false);
  });
});

describe('the Jump notice (§4.7)', () => {
  // Row 1 jumps to 0A (past the end), row 3's second command jumps to 01.
  const jumpy = (): AhxInstrument =>
    withRows([{ note: 1 }, { fx: [5, 0], fxParam: [0x0a, 0] }, { note: 3 }, { fx: [0, 5], fxParam: [0, 0x01] }, { note: 5 }]);

  it('counts the fx === 5 slots', () => {
    expect(countPListJumps(jumpy())).toBe(2);
  });

  it('counts only the Jumps whose target moved: one that aims before the change is not told about', () => {
    const ins = jumpy();
    // Insert at 2: the jump to 0A moves; the jump to 01 aims before the change and stays.
    const r = insertPListRowBefore(ins, 2, AHX);
    expect(r.ok && r.notice).toBe('Rows after 02 moved; 1 Jump command (5xx) still points at its old row number.');
    // Insert at 0 moves both targets.
    const top = insertPListRowBefore(ins, 0, AHX);
    expect(top.ok && top.notice).toBe('Rows after 00 moved; 2 Jump commands (5xx) still point at their old row numbers.');
    // Delete at 0: both.
    const d = deletePListRow(ins, 0, AHX);
    expect(d.ok && d.notice).toBe('Rows after 00 moved; 2 Jump commands (5xx) still point at their old row numbers.');
    // Duplicate row 1 (a copy lands at 2, and it is a Jump to 0A too): the jump to 01 aims before it.
    const dup = duplicatePListRow(ins, 1, AHX);
    expect(dup.ok && dup.notice).toBe('Rows after 02 moved; 2 Jump commands (5xx) still point at their old row numbers.');
    // Insert after row 0 = insert at 1: a Jump to 01 aimed at the row that moved to 02.
    const after = insertPListRowAfter(ins, 0, AHX);
    expect(after.ok && after.notice).toBe('Rows after 01 moved; 2 Jump commands (5xx) still point at their old row numbers.');
  });

  it('is silent when every Jump aims before the change, wherever the Jump itself is', () => {
    // A Jump in row 4 to row 01, and an insert at 3: rows before 3 did not move.
    const ins = withRows([{ note: 1 }, { note: 2 }, { note: 3 }, { note: 4 }, { fx: [5, 0], fxParam: [1, 0] }]);
    const r = insertPListRowBefore(ins, 3, AHX);
    expect(r.ok && r.notice).toBeUndefined();
    const d = deletePListRow(ins, 3, AHX);
    expect(d.ok && d.notice).toBeUndefined();
  });

  it('says it in the singular for one Jump', () => {
    const one = withRows([{ note: 1 }, { fx: [5, 0], fxParam: [1, 0] }, { note: 2 }]);
    const r = insertPListRowBefore(one, 0, AHX);
    expect(r.ok && r.notice).toBe('Rows after 00 moved; 1 Jump command (5xx) still points at its old row number.');
  });

  it('deleting the last row moves nothing, but says so when a Jump aimed at it or past it', () => {
    const ins = jumpy();
    // Row 4 is the last; the jump to 0A aims past the end (it always did) and is now told: it aims at or after 04.
    const lastGone = deletePListRow(ins, 4, AHX);
    expect(lastGone.ok && lastGone.notice).toBe('Row 04 was removed; 1 Jump command (5xx) now points past the end of the list.');
    const both = withRows([{ fx: [5, 0], fxParam: [1, 0] }, { note: 2 }, { fx: [0, 5], fxParam: [0, 2] }]);
    const two = deletePListRow(both, 2, AHX);
    // The Jump that sat in the removed row is gone; the one to row 1 aims before the end.
    expect(two.ok && two.notice).toBeUndefined();
    const aimedAtLast = withRows([{ fx: [5, 0], fxParam: [2, 0] }, { note: 2 }, { note: 3 }]);
    const r = deletePListRow(aimedAtLast, 2, AHX);
    expect(r.ok && r.notice).toBe('Row 02 was removed; 1 Jump command (5xx) now points past the end of the list.');
    const plural = withRows([{ fx: [5, 0], fxParam: [2, 0] }, { fx: [5, 0], fxParam: [3, 0] }, { note: 3 }]);
    const p = deletePListRow(plural, 2, AHX);
    expect(p.ok && p.notice).toBe('Row 02 was removed; 2 Jump commands (5xx) now point past the end of the list.');
  });

  it('changes no entry other than the inserted or removed one, and no Jump parameter', () => {
    const ins = jumpy();
    const inserted = ok(insertPListRowBefore(ins, 2, AHX));
    expect(inserted.plist.entries.filter((_, i) => i !== 2)).toEqual(ins.plist.entries);
    expect(inserted.plist.entries[2]).toEqual(emptyPListEntry());
    const removed = ok(deletePListRow(ins, 2, AHX));
    expect(removed.plist.entries).toEqual(ins.plist.entries.filter((_, i) => i !== 2));
    const dup = ok(duplicatePListRow(ins, 1, AHX));
    expect(dup.plist.entries.filter((_, i) => i !== 2)).toEqual(ins.plist.entries);
    expect(dup.plist.entries[2]).toEqual(ins.plist.entries[1]);
  });

  it('is silent when nothing moved and nothing points past the end, when there is no Jump, and for a clear', () => {
    const ins = jumpy();
    const atEnd = insertPListRowAfter(ins, 4, AHX);
    expect(atEnd.ok && atEnd.notice).toBeUndefined();
    const noJump = insertPListRowBefore(withRows([{ note: 1 }, { note: 2 }]), 0, AHX);
    expect(noJump.ok && noJump.notice).toBeUndefined();
    const noJumpLast = deletePListRow(withRows([{ note: 1 }, { note: 2 }]), 1, AHX);
    expect(noJumpLast.ok && noJumpLast.notice).toBeUndefined();
    expect(clearPListRow(ins, 1)).not.toHaveProperty('notice');
  });

  it('is not given for HVL: the plan keeps the notice to AHX (the canvas prints HVL commands raw)', () => {
    const ins = jumpy();
    const hvl = insertPListRowBefore(ins, 0, HVL);
    expect(hvl.ok && hvl.notice).toBeUndefined();
    expect(plistJumpNotice(ins, 0, HVL, true)).toBeUndefined();
    expect(plistJumpNotice(ins, 4, HVL, false)).toBeUndefined();
  });

  it('a deleted Jump is not counted', () => {
    const ins = jumpy();
    const r = deletePListRow(ins, 1, AHX);
    // The Jump in row 1 is gone with it; the one to 01 aims at the row that was deleted, now the next one.
    expect(r.ok && r.notice).toBe('Rows after 01 moved; 1 Jump command (5xx) still points at its old row number.');
  });
});

describe('committing: guards, once-per-gesture undo, notices', () => {
  afterEach(() => clearAhxEditNotice());

  function fakeHost(over: Partial<PListEditHost> = {}) {
    const calls: string[] = [];
    const host: PListEditHost = {
      canUndo: () => true,
      pushHistory: vi.fn(() => void calls.push('push')),
      discardHistory: vi.fn(() => void calls.push('discard')),
      ahxInstrumentRefusal: vi.fn(() => null),
      updateAhxInstrument: vi.fn(() => {
        calls.push('update');
        return 'applied' as const;
      }),
      ...over,
    };
    return { host, calls };
  }

  it('pushes history once per gesture, before the write; a run of nibble strokes is one step', () => {
    const { host, calls } = fakeHost();
    const gesture = createPListGesture();
    let cur = withRows([{}]);
    for (const [nibble, digit] of [[0, 5], [1, 1], [2, 0xa]] as const) {
      const r = writePListNibble(cur, 0, 0, nibble, digit, AHX);
      if (r.ok) cur = r.instrument;
      expect(commitPListEdit(host, gesture, 1, r, { continues: true }).ok).toBe(true);
    }
    expect(host.pushHistory).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(['push', 'update', 'update', 'update']);
    // The cursor moves: the gesture is closed, the next stroke is a new step.
    gesture.close();
    const r = writePListNibble(cur, 0, 0, 2, 3, AHX);
    commitPListEdit(host, gesture, 1, r, { continues: true });
    expect(host.pushHistory).toHaveBeenCalledTimes(2);
  });

  it('a one-shot edit (a keystroke, a menu pick) closes its own gesture: two picks, two steps', () => {
    const { host } = fakeHost();
    const gesture = createPListGesture();
    const ins = withRows([{ note: 1 }]);
    commitPListEdit(host, gesture, 1, modifyPListEntry(ins, 0, { field: 'note', value: 2 }, AHX));
    commitPListEdit(host, gesture, 1, modifyPListEntry(ins, 0, { field: 'note', value: 3 }, AHX));
    expect(host.pushHistory).toHaveBeenCalledTimes(2);
  });

  it('a write the store turns down after the snapshot takes the snapshot back, and the gesture starts over', () => {
    const { host, calls } = fakeHost({ updateAhxInstrument: vi.fn(() => 'rejected' as const) });
    const gesture = createPListGesture();
    const r = commitPListEdit(host, gesture, 1, modifyPListEntry(withRows([{ note: 1 }]), 0, { field: 'note', value: 2 }, AHX));
    expect(r.ok).toBe(false);
    expect(calls).toEqual(['push', 'discard']);
    expect(gesture.recorded).toBe(false);
    // A rejection later in a gesture that was already recorded keeps the earlier step.
    const good = fakeHost();
    const g2 = createPListGesture();
    commitPListEdit(good.host, g2, 1, modifyPListEntry(withRows([{ note: 1 }]), 0, { field: 'note', value: 2 }, AHX), { continues: true });
    const bad = fakeHost({ updateAhxInstrument: vi.fn(() => 'rejected' as const) });
    commitPListEdit(bad.host, g2, 1, modifyPListEntry(withRows([{ note: 1 }]), 0, { field: 'note', value: 3 }, AHX), { continues: true });
    expect(bad.calls).toEqual([]);
    expect(g2.recorded).toBe(true);
  });

  it('pushes nothing on a refusal (the op’s or the store’s), and says why', () => {
    const { host } = fakeHost({ ahxInstrumentRefusal: vi.fn(() => 'Song is 65,412 of 65,535 bytes; a PList row needs 4.') });
    const gesture = createPListGesture();
    const ins = withRows([{ note: 1 }]);
    const op = commitPListEdit(host, gesture, 1, modifyPListEntry(ins, 0, { field: 'fx', slot: 0, value: 9 }, AHX));
    expect(op).toEqual({ ok: false, reason: 'Command 9 is not available in an AHX PList.' });
    expect(ahxEditNotice.value?.message).toBe('Command 9 is not available in an AHX PList.');
    const store = commitPListEdit(host, gesture, 1, insertPListRowBefore(ins, 0, AHX));
    expect(store).toEqual({ ok: false, reason: 'Song is 65,412 of 65,535 bytes; a PList row needs 4.' });
    expect(ahxEditNotice.value?.message).toBe('Song is 65,412 of 65,535 bytes; a PList row needs 4.');
    expect(host.pushHistory).not.toHaveBeenCalled();
    expect(host.updateAhxInstrument).not.toHaveBeenCalled();
  });

  it('pushes nothing for an op that changed nothing, or on a song without undo', () => {
    const noUndo = fakeHost({ canUndo: () => false });
    const gesture = createPListGesture();
    const ins = withRows([{ note: 1 }]);
    expect(commitPListEdit(noUndo.host, gesture, 1, modifyPListEntry(ins, 0, { field: 'note', value: 4 }, AHX)).ok).toBe(true);
    expect(noUndo.host.pushHistory).not.toHaveBeenCalled();
    expect(noUndo.host.updateAhxInstrument).toHaveBeenCalledTimes(1);
    const same = fakeHost();
    expect(commitPListEdit(same.host, gesture, 1, modifyPListEntry(ins, 0, { field: 'note', value: 1 }, AHX))).toEqual({
      ok: true,
      outcome: 'applied',
      changed: false,
    });
    expect(same.host.pushHistory).not.toHaveBeenCalled();
    expect(same.host.updateAhxInstrument).not.toHaveBeenCalled();
  });

  it('reports the Jump notice after the write, and clears a stale refusal on a plain success', () => {
    const { host } = fakeHost();
    const gesture = createPListGesture();
    const ins = withRows([{ note: 1 }, { fx: [5, 0], fxParam: [0, 0] }, { note: 2 }]);
    commitPListEdit(host, gesture, 1, modifyPListEntry(ins, 0, { field: 'fx', slot: 0, value: 9 }, AHX));
    expect(ahxEditNotice.value).not.toBeNull();
    commitPListEdit(host, gesture, 1, modifyPListEntry(ins, 0, { field: 'note', value: 3 }, AHX));
    expect(ahxEditNotice.value).toBeNull();
    commitPListEdit(host, gesture, 1, insertPListRowBefore(ins, 0, AHX));
    expect(ahxEditNotice.value?.message).toBe('Rows after 00 moved; 1 Jump command (5xx) still points at its old row number.');
  });
});

describe('the size guard, with the module’s own fixtures', () => {
  it('refuses a row insert with the module’s number format; accepts an edit that does not grow it, and one that shrinks it', () => {
    const { doc, slots } = nearFullSong('karma.ahx', 0);
    const bytes = ahxInstrumentBytes(instrumentsOf(slots));
    const remaining = AHX_SIZE_LIMIT - ahxUsedBytes(doc, bytes);
    expect(remaining).toBeGreaterThanOrEqual(0);
    expect(remaining).toBeLessThan(4);

    const victim = slots[0]!.ahxData;
    const used = ahxUsedBytes(doc, bytes);
    const grow = ok(insertPListRowBefore(victim, 0, AHX));
    expect(instrumentGrowthRefusal(doc, bytes, victim, grow)).toBe(
      `Song is ${formatBytes(used)} of ${formatBytes(AHX_SIZE_LIMIT)} bytes; a PList row needs 4.`,
    );
    expect(instrumentGrowthRefusal(doc, bytes, victim, ok(duplicatePListRow(victim, 0, AHX)))).toMatch(/; a PList row needs 4\.$/);
    // Two rows at once are said in rows.
    expect(instrumentGrowthRefusal(doc, bytes, victim, ok(insertPListRowBefore(grow, 0, AHX)))).toMatch(/; 2 PList rows needs 8\.$/);
    // No growth: a field edit, a clear and a delete are never refused.
    expect(instrumentGrowthRefusal(doc, bytes, victim, ok(modifyPListEntry(victim, 0, { field: 'note', value: 9 }, AHX)))).toBeNull();
    expect(instrumentGrowthRefusal(doc, bytes, victim, ok(clearPListRow(victim, 0)))).toBeNull();
    const shrunk = ok(deletePListRow(victim, 0, AHX));
    expect(instrumentGrowthRefusal(doc, bytes, victim, shrunk)).toBeNull();
    // Once it has shrunk, the row goes back in: 4 bytes free is enough, to the byte.
    expect(instrumentGrowthRefusal(doc, bytes - 4, shrunk, victim)).toBeNull();
  });

  it('a song already over the limit can still be edited and shrunk, not grown', () => {
    const { doc, slots } = nearFullSong('karma.ahx', 0);
    const bytes = ahxInstrumentBytes(instrumentsOf(slots)) + 40; // 40 bytes past
    const victim = slots[0]!.ahxData;
    expect(AHX_SIZE_LIMIT - ahxUsedBytes(doc, bytes)).toBeLessThan(0);
    expect(instrumentGrowthRefusal(doc, bytes, victim, ok(modifyPListEntry(victim, 0, { field: 'waveform', value: 2 }, AHX)))).toBeNull();
    expect(instrumentGrowthRefusal(doc, bytes, victim, ok(deletePListRow(victim, 0, AHX)))).toBeNull();
    expect(instrumentGrowthRefusal(doc, bytes, victim, ok(insertPListRowBefore(victim, 0, AHX)))).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Property: whatever the ops and the guard accept serializes, to the byte count the budget says
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('property: 300 random PList op sequences on a near-full song', () => {
  const songs = ['karma.ahx', 'winter_dreams.ahx', 'depressed.ahx', 'outcast.ahx', 'aces_high.ahx', 'running.ahx'];
  it('every accepted result serializes with buildAhxFile and ahxUsedBytes equals the serialized nameOffset', () => {
    let accepted = 0;
    let opRefusals = 0;
    let sizeRefusals = 0;
    let growthsAccepted = 0;
    let nearLimit = 0;
    for (let s = 0; s < 300; s++) {
      const rnd = mulberry32(7000 + s);
      const int = (n: number): number => Math.floor(rnd() * n);
      function pick<T>(xs: readonly T[]): T {
        return xs[int(xs.length)]!;
      }
      const context: PListEditContext = { format: 'ahx', version: s % 7 === 0 ? 0 : 1 };
      const { doc, slots } = nearFullSong(songs[s % songs.length]!, [0, 2, 9, 30][s % 4]!);
      const bytesOf = (): number => ahxInstrumentBytes(instrumentsOf(slots));
      const built = (): number => {
        const file = buildAhxFile({ doc, slots, title: 'x' }).bytes; // must not throw
        return (file[4]! << 8) | file[5]!;
      };
      // The start is a valid file, as every doc reached through the ops is.
      expect(built()).toBe(ahxUsedBytes(doc, bytesOf()));
      expect(AHX_SIZE_LIMIT - ahxUsedBytes(doc, bytesOf())).toBeLessThan(40);

      for (let i = 0; i < 12; i++) {
        const slot = slots[int(slots.length)]!;
        const ins = slot.ahxData;
        const n = ins.plist.entries.length;
        const row = rnd() < 0.08 ? n + int(3) : int(Math.max(1, n));
        const slotIx = int(2) as 0 | 1;
        const ops: (() => PListOpResult<{ notice?: string }>)[] = [
          () => insertPListRowBefore(ins, rnd() < 0.1 ? n + 1 : int(n + 1), context),
          () => insertPListRowAfter(ins, int(n + 1) - 1, context),
          () => insertPListRowBefore(ins, int(n + 1), context),
          () => duplicatePListRow(ins, row, context),
          () => duplicatePListRow(ins, row, context),
          () => deletePListRow(ins, row, context),
          () => clearPListRow(ins, row),
          () => togglePListFixed(ins, row, context),
          () => modifyPListEntry(ins, row, { field: 'note', value: int(70) - 3 }, context),
          () => modifyPListEntry(ins, row, { field: 'waveform', value: int(8) }, context),
          () => modifyPListEntry(ins, row, { field: 'fx', slot: slotIx, value: int(17) }, context),
          () => modifyPListEntry(ins, row, { field: 'fxParam', slot: slotIx, value: int(300) - 20 }, context),
          () => writePListNibble(ins, row, slotIx, int(3) as 0 | 1 | 2, int(17), context),
          () => nudgePListEntry(ins, row, { field: 'nibble', slot: slotIx, nibble: int(3) as 0 | 1 | 2 }, int(5) - 2, context),
          () => nudgePListEntry(ins, row, pick([{ field: 'note' }, { field: 'waveform' }] as const), int(25) - 12, context),
          () => clearPListCell(ins, row, pick(['note', 'tone', { command: 0 }, { command: 1 }] as const), context),
        ];
        const before = JSON.stringify(ins);
        const result = pick(ops)();
        expect(JSON.stringify(ins)).toBe(before); // purity, accepted or not
        if (!result.ok) {
          opRefusals++;
          expect(result.reason.length).toBeGreaterThan(0);
          continue;
        }
        if (!result.changed) {
          expect(result.instrument).toBe(ins);
          continue;
        }
        // What the store does: the growth guard, then the swap.
        const refusal = instrumentGrowthRefusal(doc, bytesOf(), ins, result.instrument);
        if (refusal !== null) {
          sizeRefusals++;
          expect(refusal).toMatch(/^Song is [\d,]+ of 65,535 bytes; (a PList row|\d+ PList rows) needs \d+\.$/);
          expect(JSON.stringify(ins)).toBe(before);
          continue;
        }
        accepted++;
        const grew = result.instrument.plist.entries.length > n;
        slot.ahxData = result.instrument;
        expect(ahxUsedBytes(doc, bytesOf())).toBeLessThanOrEqual(AHX_SIZE_LIMIT);
        expect(built()).toBe(ahxUsedBytes(doc, bytesOf()));
        if (grew) growthsAccepted++;
        if (AHX_SIZE_LIMIT - ahxUsedBytes(doc, bytesOf()) < 4) nearLimit++;
      }
    }
    // The generator must reach both sides of the limit, or the test proves nothing.
    expect(accepted).toBeGreaterThan(1000);
    expect(opRefusals).toBeGreaterThan(300);
    expect(sizeRefusals).toBeGreaterThan(50);
    expect(growthsAccepted).toBeGreaterThan(100);
    expect(nearLimit).toBeGreaterThan(50);
  }, 280_000);
});
