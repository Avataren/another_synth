import { describe, expect, it } from 'vitest';
import { setSidInstrument, setSidRow, setSidTableRow, type SidDoc, type SidOpResult } from 'src/audio/tracker/sid-doc';
import { sidWaveTargetByte, toggleSidWaveTargetBit } from 'src/audio/tracker/sid-instrument-edit';
import { simulateSidInstrument, type SidFrameTrace } from 'src/audio/tracker/sid-instrument-visuals';
import {
  appendSidTableTemplate,
  clearSidTableRow,
  deleteSidTableRow,
  describeSidTableRow,
  insertSidTableRow,
  sidControlName,
  sidNoteName,
  sidTableUsers,
  sidWaveClass,
} from 'src/audio/tracker/sid-table-rows';
import { buildSidChainSong } from './helpers/sid-chain-song';

/**
 * The SID page's row words and row edits (`sid-table-rows.ts`), the waveform
 * boxes' edit target (`sid-instrument-edit.ts`) and the simulator's trace
 * (`sid-instrument-visuals.ts`), on S3's chain song: wave rows 1-4 an
 * arpeggio looping to 1 (instrument 2), pulse 1-4 (instrument 2), filter 1-4
 * (instrument 3), speed row 1 the vibrato of instrument 4 and row 2 the
 * porta speed pattern 0 row 28's command 1 reads.
 */

function must(result: SidOpResult): SidDoc {
  if (!result.ok) throw new Error(result.reason);
  return result.doc;
}

describe('SID table rows: words', () => {
  it('names notes and control bytes as GoatTracker does', () => {
    expect(sidNoteName(0)).toBe('C-0');
    expect(sidNoteName(57)).toBe('A-4');
    expect(sidControlName(0x41)).toBe('Pulse, gate on');
    expect(sidControlName(0x15)).toBe('Tri, ring, gate on');
    expect(sidControlName(0x08)).toBe('no waveform, test, gate off');
    expect(sidWaveClass(0x41)).toBe('pulse');
    expect(sidWaveClass(0x61)).toBe('mixed');
    expect(sidWaveClass(0x09)).toBe('none');
  });

  it('says what a row does, table by table', () => {
    expect(describeSidTableRow('wave', { left: 0x41, right: 0x0c }, 4)).toBe('Pulse, gate on, note +12');
    expect(describeSidTableRow('wave', { left: 0x02, right: 0x80 }, 4)).toBe('Wait 2 frames, then same note');
    expect(describeSidTableRow('wave', { left: 0x81, right: 0xbc }, 4)).toBe('Noise, gate on, note C-5 (fixed)');
    expect(describeSidTableRow('wave', { left: 0xe8, right: 0 }, 4)).toBe('no waveform, test, gate off, note +0');
    expect(describeSidTableRow('wave', { left: 0xf9, right: 3 }, 4)).toBe('Command 9: pulse table from row 03');
    // GT's illegal wave commands (gplay.c:534-538 stops the song on them).
    for (const left of [0xf0, 0xf8, 0xfe]) {
      expect(describeSidTableRow('wave', { left, right: 1 }, 4)).toContain('illegal in GoatTracker');
    }
    expect(describeSidTableRow('wave', { left: 0xff, right: 0 }, 4)).toBe('Stop (the table ends here)');
    expect(describeSidTableRow('wave', { left: 0xff, right: 9 }, 4)).toContain('does not exist');
    expect(describeSidTableRow('pulse', { left: 0x88, right: 0x00 }, 4)).toBe('Set width 800 (50.0 %)');
    expect(describeSidTableRow('pulse', { left: 0x20, right: 0xf0 }, 4)).toBe('Sweep -16 a frame for 32 frames');
    expect(describeSidTableRow('filter', { left: 0x90, right: 0xc4 }, 4)).toBe('Mode LP, resonance 12, filtered voices 3');
    expect(describeSidTableRow('filter', { left: 0x00, right: 0x20 }, 4, '8580')).toMatch(/^Set cutoff 20 \(\d+ Hz\)$/);
    expect(describeSidTableRow('speed', { left: 0x04, right: 0x28 }, 2)).toBe('vibrato speed 4, depth 40 · or slide speed 0428');
  });

  it('knows which instruments reach which rows', () => {
    const users = sidTableUsers(buildSidChainSong(), 'wave');
    expect([...users.keys()].sort()).toEqual([1, 2, 3, 4, 5, 6]);
    expect(users.get(1)).toEqual([2]);
    expect(users.get(5)).toEqual([4]);
    expect(sidTableUsers(buildSidChainSong(), 'speed').get(1)).toEqual([4]);
  });
});

describe('SID table rows: insert, delete, clear', () => {
  it('insert moves pointers, jumps, wave-table and pattern commands with their rows', () => {
    let doc = buildSidChainSong();
    // A wave-table command naming pulse row 2, and a pattern command 9 naming pulse row 3.
    doc = must(setSidTableRow(doc, 'wave', 4, { left: 0xf9, right: 2 }));
    doc = must(setSidRow(doc, 1, 0, { note: 0, instrument: 0, command: 0x9, param: 3 }));
    const next = must(insertSidTableRow(doc, 'pulse', 2, { left: 0x88, right: 0 }));
    expect(next.tables.pulse).toHaveLength(5);
    expect(next.tables.pulse[1]).toEqual({ left: 0x88, right: 0 });
    // Arp pulse started at row 1: before the insert, unmoved.
    expect(next.instruments[1]!.pulsePtr).toBe(1);
    // The loop FF 02 now jumps to 03, where its row went.
    expect(next.tables.pulse[4]).toEqual({ left: 0xff, right: 3 });
    expect(next.tables.wave[4]).toEqual({ left: 0xf9, right: 3 });
    expect(next.patterns[1]!.rows[0]).toMatchObject({ command: 0x9, param: 4 });
    // Other tables untouched, by identity.
    expect(next.tables.filter).toBe(doc.tables.filter);
    expect(next.patterns[0]).toBe(doc.patterns[0]);
  });

  it('delete is insert undone; a pointer to the deleted row names its successor', () => {
    const doc = buildSidChainSong();
    const inserted = must(insertSidTableRow(doc, 'speed', 1));
    expect(inserted.instruments[3]!.speedPtr).toBe(2);
    expect(inserted.patterns[0]!.rows[28]).toMatchObject({ command: 1, param: 3 });
    const back = must(deleteSidTableRow(inserted, 'speed', 1));
    expect(back.tables).toEqual(doc.tables);
    expect(back.instruments).toEqual(doc.instruments);
    expect(back.patterns).toEqual(doc.patterns);
    // Deleting filter row 1, where Filt saw starts: it starts on what was row 2.
    const cut = must(deleteSidTableRow(doc, 'filter', 1));
    expect(cut.instruments[2]!.filterPtr).toBe(1);
    expect(cut.tables.filter[0]).toEqual(doc.tables.filter[1]);
    // Deleting a table's last row pulls a pointer to it back in range.
    let one = must(setSidInstrument(doc, 1, { ...doc.instruments[0]!, speedPtr: 2 }));
    one = must(deleteSidTableRow(one, 'speed', 2));
    expect(one.instruments[0]!.speedPtr).toBe(1);
    const empty = must(deleteSidTableRow(must(deleteSidTableRow(doc, 'speed', 2)), 'speed', 1));
    expect(empty.tables.speed).toEqual([]);
    expect(empty.instruments[3]!.speedPtr).toBe(0);
  });

  it('refuses rows that do not exist and a full table', () => {
    const doc = buildSidChainSong();
    expect(insertSidTableRow(doc, 'wave', 8).ok).toBe(false);
    expect(deleteSidTableRow(doc, 'wave', 7).ok).toBe(false);
    expect(clearSidTableRow(doc, 'wave', 0).ok).toBe(false);
    let full = doc;
    while (full.tables.speed.length < 255) full = must(insertSidTableRow(full, 'speed', full.tables.speed.length + 1));
    expect(insertSidTableRow(full, 'speed', 1)).toMatchObject({ ok: false, reason: expect.stringContaining('full') });
  });

  it('clear writes 00 00', () => {
    expect(must(clearSidTableRow(buildSidChainSong(), 'pulse', 2)).tables.pulse[1]).toEqual({ left: 0, right: 0 });
  });
});

describe('SID table rows: starter sequences', () => {
  it('appends and points the instrument at the first new row', () => {
    const doc = buildSidChainSong();
    const next = must(appendSidTableTemplate(doc, 'pulse', 'sweep', 1));
    expect(next.instruments[0]!.pulsePtr).toBe(5);
    expect(next.tables.pulse.slice(4)).toEqual([
      { left: 0x84, right: 0 },
      { left: 0x40, right: 0x20 },
      { left: 0x40, right: 0xe0 },
      { left: 0xff, right: 6 },
    ]);
    // What it plays: a fresh channel's width 0 on the note's frame (GT sets
    // it only from the table), row 5's 0x400 on the next, then the sweep up.
    const widths = simulateSidInstrument(next, 1, 48, 4).map((f) => f[1]);
    expect(widths).toEqual([0, 0x400, 0x420, 0x440]);
    expect(appendSidTableTemplate(doc, 'wave', 'nope', 1).ok).toBe(false);
    expect(appendSidTableTemplate(doc, 'wave', 'major', 9).ok).toBe(false);
  });

  it('a wave sequence uses the instrument\'s waveform, gated; a drum ends released', () => {
    const doc = buildSidChainSong();
    // "Filt saw" has no wave table: its first-frame byte ($21) is its waveform.
    const hold = must(appendSidTableTemplate(doc, 'wave', 'hold', 3));
    expect(hold.tables.wave[6]).toEqual({ left: 0x21, right: 0 });
    const drum = must(appendSidTableTemplate(doc, 'wave', 'drum', 1));
    const trace: SidFrameTrace[] = [];
    simulateSidInstrument(drum, 1, 48, 8, trace);
    // The note's frame plays the first-frame byte; the noise hit is frame 1.
    expect(trace[1]!.waveform).toBe(0x81);
    expect(trace[7]!.gate).toBe(false);
  });
});

describe('SID waveform boxes: the byte they edit', () => {
  it('a wave row keeps its row kind: no waveform is spelled E0-EF, past DF is refused', () => {
    const doc = buildSidChainSong();
    const row = { kind: 'wave-row', row: 1 } as const;
    expect(sidWaveTargetByte(doc, 2, row)).toBe(0x41);
    const off = must(toggleSidWaveTargetBit(doc, 2, row, 0x40));
    expect(off.tables.wave[0]).toEqual({ left: 0xe1, right: 0 });
    expect(sidWaveTargetByte(off, 2, row)).toBe(0x01);
    const back = must(toggleSidWaveTargetBit(off, 2, row, 0x40));
    expect(back.tables.wave[0]).toEqual({ left: 0x41, right: 0 });
    // Noise+pulse+saw would be E1: a table command, not a waveform.
    const ps = must(toggleSidWaveTargetBit(doc, 2, row, 0x20));
    expect(toggleSidWaveTargetBit(ps, 2, row, 0x80)).toMatchObject({ ok: false, reason: expect.stringContaining('F7') });
  });

  it('the first-frame byte stays one', () => {
    const doc = buildSidChainSong();
    const first = { kind: 'first-frame' } as const;
    expect(must(toggleSidWaveTargetBit(doc, 4, first, 0x40)).instruments[3]!.firstWave).toBe(0x49);
    // 09 without test and gate would be 00, "none".
    const noTest = must(toggleSidWaveTargetBit(doc, 4, first, 0x08));
    expect(toggleSidWaveTargetBit(noTest, 4, first, 0x01).ok).toBe(false);
    const cmd = must(setSidTableRow(doc, 'wave', 4, { left: 0xf7, right: 0x21 }));
    expect(must(toggleSidWaveTargetBit(cmd, 1, { kind: 'wave-command', row: 5 }, 0x40)).tables.wave[4]).toEqual({ left: 0xf7, right: 0x61 });
  });
});

describe('SID simulator trace', () => {
  it('never changes the frames (the parity-held output)', () => {
    const doc = buildSidChainSong();
    for (let n = 1; n <= doc.instruments.length; n++) {
      const trace: SidFrameTrace[] = [];
      expect(simulateSidInstrument(doc, n, 48, 96, trace)).toEqual(simulateSidInstrument(doc, n, 48, 96));
      expect(trace).toHaveLength(96);
    }
  });

  it('says what set each frame\'s waveform and which rows the frame read', () => {
    const doc = buildSidChainSong();
    const trace: SidFrameTrace[] = [];
    simulateSidInstrument(doc, 2, 48, 6, trace);
    // Arp pulse: the first-frame byte ($41) on the note's frame, then its
    // wave table: rows 1, 2, 3, then the jump to 1.
    expect(trace.map((t) => t.waveRow)).toEqual([0, 1, 2, 3, 1, 2]);
    expect(trace.map((t) => t.waveSource)).toEqual([{ kind: 'first-frame' }, ...[1, 2, 3, 1, 2].map((row) => ({ kind: 'wave-row', row }))]);
    // The pulse table from frame 1: row 1 sets the width, then row 2 sweeps.
    expect(trace.map((t) => t.pulseRow)).toEqual([0, 1, 2, 2, 2, 2]);
    const tri: SidFrameTrace[] = [];
    simulateSidInstrument(doc, 1, 48, 2, tri);
    // Tri lead: no wave table, so its first-frame byte plays on.
    expect(tri[1]).toEqual({ waveform: 0x11, gate: true, waveSource: { kind: 'first-frame' }, waveRow: 0, pulseRow: 0, filterRow: 0 });
    const vib: SidFrameTrace[] = [];
    simulateSidInstrument(doc, 4, 48, 2, vib);
    expect(vib[0]).toMatchObject({ waveform: 0x09, waveSource: { kind: 'first-frame' } });
    expect(vib[1]).toMatchObject({ waveform: 0x11, waveSource: { kind: 'wave-row', row: 5 } });
    const filt: SidFrameTrace[] = [];
    simulateSidInstrument(doc, 3, 48, 3, filt);
    expect(filt.map((t) => t.filterRow)).toEqual([1, 3, 3]);
  });
});
