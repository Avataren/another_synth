// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { isProxy, reactive } from 'vue';
import {
  BLANK_SID_ROW,
  DEFAULT_SID_INSTRUMENT,
  SID_CHANNELS,
  SID_FILE_VERSION,
  SID_NOTE_KEY_OFF,
  addSidInstrument,
  createNewSidDoc,
  decodeSidFile,
  encodeSidFile,
  makeSidDoc,
  parseSidFile,
  projectSidPatterns,
  serializeSidFile,
  setSidChipModel,
  setSidInstrument,
  setSidOrderEntry,
  setSidRow,
  setSidSongTexts,
  setSidTableRow,
  setSidTiming,
  sidDocProblem,
  sidDocTiming,
  type SidDoc,
} from 'src/audio/tracker/sid-doc';
import { buildSidChainSong } from './helpers/sid-chain-song';

/**
 * plan-sid-tracking.md S3: the SID song model (`sid-doc`), its file codec and
 * its grid projection. The store chain, the format profile and the file the
 * Rust player reads are `sid-format-chain.test.ts`.
 */

const must = (r: { ok: true; doc: SidDoc } | { ok: false; reason: string }): SidDoc => {
  if (!r.ok) throw new Error(r.reason);
  return r.doc;
};

/** A doc at every limit the codec has: widest texts, most of everything, every flag. */
function limitsDoc(): SidDoc {
  const base = buildSidChainSong();
  const rows = Array.from({ length: 128 }, (_, i) => ({ note: i % 2 ? 93 : SID_NOTE_KEY_OFF, instrument: 63, command: 0xf, param: 0xff }));
  const instruments = Array.from({ length: 63 }, (_, i) => ({
    ...DEFAULT_SID_INSTRUMENT,
    name: 'ÿ'.repeat(16),
    attack: 15,
    decay: i % 16,
    sustain: 15,
    release: 15,
    firstWave: 0xff,
    gateTimer: 63,
    hardRestart: true,
    noGateOff: i % 3 === 0,
    vibratoDelay: 0xff,
    wavePtr: 255,
    pulsePtr: 255,
    filterPtr: 255,
    speedPtr: 255,
  }));
  const table = Array.from({ length: 255 }, (_, i) => ({ left: i, right: 255 - i }));
  const entries = Array.from({ length: 254 }, (_, i) => ({ pattern: i % 208, transpose: i % 2 ? 63 : -64, repeat: 16 }));
  return makeSidDoc({
    ...base,
    songName: ' '.repeat(31) + 'ÿ',
    author: 'a'.repeat(32),
    copyright: '',
    chipModel: '6581',
    speedMultiplier: 16,
    tempo: 127,
    subsongs: Array.from({ length: 32 }, () => ({ orderlists: [0, 1, 2].map(() => ({ entries, restart: 253 })) })),
    patterns: Array.from({ length: 208 }, () => ({ rows })),
    instruments,
    tables: { wave: table, pulse: table, filter: table, speed: table },
  });
}

describe('the doc', () => {
  it('is raw, frozen, and never made reactive', () => {
    const doc = createNewSidDoc();
    expect(Object.isFrozen(doc)).toBe(true);
    // markRaw: a reactive holder hands back the doc itself, not a Proxy of it.
    const held = reactive({ doc }).doc;
    expect(isProxy(held)).toBe(false);
    expect(held).toBe(doc);
    expect(() => {
      (doc as { tempo: number }).tempo = 3;
    }).toThrow();
  });

  it('a new song: three voices, each its own blank pattern, one plain instrument, empty tables', () => {
    const doc = createNewSidDoc({ songName: 'x', patternRows: 16 });
    expect(doc.channels).toBe(SID_CHANNELS);
    expect(doc.chipModel).toBe('6581');
    expect(doc.tempo).toBe(6);
    expect(doc.speedMultiplier).toBe(1);
    expect(doc.version).toBe(SID_FILE_VERSION);
    expect(doc.subsongs).toHaveLength(1);
    expect(doc.subsongs[0]!.orderlists.map((l) => l.entries[0]!.pattern)).toEqual([0, 1, 2]);
    expect(doc.patterns.every((p) => p.rows.length === 16 && p.rows.every((r) => r === BLANK_SID_ROW))).toBe(true);
    // GoatTracker's new instrument on its own wave and pulse rows: a plain pulse.
    expect(doc.instruments).toEqual([{ ...DEFAULT_SID_INSTRUMENT, wavePtr: 1, pulsePtr: 1 }]);
    expect(doc.tables).toEqual({ wave: [{ left: 0x41, right: 0 }, { left: 0xff, right: 0 }], pulse: [{ left: 0x88, right: 0 }, { left: 0xff, right: 0 }], filter: [], speed: [] });
  });

  it('refuses to exist when it breaks a rule of the model', () => {
    const good = createNewSidDoc();
    const bad: Array<[Partial<SidDoc>, RegExp]> = [
      [{ channels: 6 }, /3 channels/],
      [{ chipModel: '6582' as SidDoc['chipModel'] }, /chip model/],
      [{ tempo: 0 }, /tempo/],
      [{ speedMultiplier: 17 }, /speed multiplier/],
      [{ songName: 'x'.repeat(33) }, /longer than 32/],
      [{ author: '€' }, /latin-1/],
      [{ patterns: [] }, /patterns/],
      [{ patterns: [{ rows: [] }, ...good.patterns.slice(1)] }, /pattern 0/],
      [{ patterns: [{ rows: [{ note: 94, instrument: 0, command: 0, param: 0 }] }, ...good.patterns.slice(1)] }, /not a note/],
      [{ patterns: [{ rows: [{ note: 1, instrument: 2, command: 0, param: 0 }] }, ...good.patterns.slice(1)] }, /instrument 2 does not exist/],
      [{ instruments: [{ ...DEFAULT_SID_INSTRUMENT, gateTimer: 64 }] }, /gate timer/],
      [{ instruments: [{ ...DEFAULT_SID_INSTRUMENT, wavePtr: 3 }] }, /past the wave table/],
      [{ subsongs: [{ orderlists: good.subsongs[0]!.orderlists.slice(0, 2) }] }, /one orderlist per channel/],
      [{ subsongs: [{ orderlists: good.subsongs[0]!.orderlists.map((l) => ({ ...l, restart: 1 })) }] }, /restart/],
      [{ tables: { ...good.tables, speed: [{ left: 256, right: 0 }] } }, /two bytes/],
    ];
    for (const [fields, reason] of bad) {
      expect(sidDocProblem({ ...good, ...fields })).toMatch(reason);
      expect(() => makeSidDoc({ ...good, ...fields })).toThrow(reason);
    }
    expect(sidDocProblem(good)).toBeNull();
  });
});

describe('ops', () => {
  it('a row edit copies that pattern and the pattern list, and shares everything else', () => {
    const doc = buildSidChainSong();
    const next = must(setSidRow(doc, 1, 3, { note: 50, instrument: 2, command: 0, param: 0 }));
    expect(next).not.toBe(doc);
    expect(Object.isFrozen(next)).toBe(true);
    expect(next.patterns[1]!.rows[3]).toEqual({ note: 50, instrument: 2, command: 0, param: 0 });
    expect(doc.patterns[1]!.rows[3]).toBe(BLANK_SID_ROW);
    expect(next.patterns[0]).toBe(doc.patterns[0]);
    expect(next.patterns[2]).toBe(doc.patterns[2]);
    expect(next.patterns[1]!.rows[4]).toBe(doc.patterns[1]!.rows[4]);
    expect(next.instruments).toBe(doc.instruments);
    expect(next.tables).toBe(doc.tables);
    expect(next.subsongs).toBe(doc.subsongs);
    // The same row again is the same doc.
    expect(must(setSidRow(next, 1, 3, { note: 50, instrument: 2, command: 0, param: 0 }))).toBe(next);
  });

  it('every op refuses, with a reason, what would break the song, and leaves the doc as it was', () => {
    const doc = buildSidChainSong();
    const refusals = [
      setSidRow(doc, 9, 0, BLANK_SID_ROW),
      setSidRow(doc, 0, 32, BLANK_SID_ROW),
      setSidRow(doc, 0, 0, { note: 1, instrument: 5, command: 0, param: 0 }),
      setSidInstrument(doc, 5, DEFAULT_SID_INSTRUMENT),
      setSidInstrument(doc, 1, { ...DEFAULT_SID_INSTRUMENT, firstWave: 0x100 }),
      setSidTableRow(doc, 'wave', 9, { left: 0, right: 0 }),
      setSidTableRow(doc, 'wave', 0, { left: -1, right: 0 }),
      setSidOrderEntry(doc, 0, 0, 0, { pattern: 3, transpose: 0, repeat: 1 }),
      setSidOrderEntry(doc, 0, 0, 0, { pattern: 0, transpose: 64, repeat: 1 }),
      setSidTiming(doc, 128, 1),
      setSidSongTexts(doc, { songName: 'Ā' }),
    ];
    for (const r of refusals) {
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason.length).toBeGreaterThan(0);
    }
    expect(doc).toEqual(buildSidChainSong());
  });

  it('instrument, table, orderlist, model, timing and text edits land where they say', () => {
    let doc = buildSidChainSong();
    doc = must(setSidInstrument(doc, 2, { ...doc.instruments[1]!, attack: 7 }));
    expect(doc.instruments[1]!.attack).toBe(7);
    doc = must(addSidInstrument(doc, { ...DEFAULT_SID_INSTRUMENT, name: 'five' }));
    expect(doc.instruments).toHaveLength(5);
    doc = must(setSidTableRow(doc, 'pulse', 0, { left: 0x88, right: 0x01 }));
    expect(doc.tables.pulse[0]).toEqual({ left: 0x88, right: 0x01 });
    doc = must(setSidOrderEntry(doc, 1, 2, 0, { pattern: 1, transpose: -3, repeat: 4 }));
    expect(doc.subsongs[1]!.orderlists[2]!.entries[0]).toEqual({ pattern: 1, transpose: -3, repeat: 4 });
    expect(must(setSidChipModel(doc, '6581'))).toBe(doc);
    doc = must(setSidChipModel(doc, '8580'));
    expect(doc.chipModel).toBe('8580');
    doc = must(setSidTiming(doc, 3, 4));
    expect([doc.tempo, doc.speedMultiplier]).toEqual([3, 4]);
    doc = must(setSidSongTexts(doc, { author: '  spaced  ' }));
    expect(doc.author).toBe('  spaced  ');
  });
});

describe('the file (round-trip gate)', () => {
  it('doc -> file -> doc is the doc, and file -> doc -> file is byte-exact (chain song)', () => {
    const doc = buildSidChainSong();
    const bytes = serializeSidFile(doc);
    const back = parseSidFile(bytes);
    expect(back).toEqual(doc);
    expect(serializeSidFile(back)).toEqual(bytes);
    // A fixed header: magic, version, 6581, 3 voices, 50 Hz, tempo 6.
    expect([...bytes.subarray(0, 9)]).toEqual([0x41, 0x53, 0x49, 0x44, 2, 1, 3, 1, 6]);
  });

  it('holds at every limit of every field (and after every kind of edit)', () => {
    const doc = limitsDoc();
    const bytes = serializeSidFile(doc);
    expect(parseSidFile(bytes)).toEqual(doc);
    expect(serializeSidFile(parseSidFile(bytes))).toEqual(bytes);
    const edited = must(setSidRow(must(setSidTiming(doc, 1, 1)), 207, 127, BLANK_SID_ROW));
    expect(parseSidFile(serializeSidFile(edited))).toEqual(edited);
  });

  it('refuses a file that is not canonical, with the reason', () => {
    const bytes = serializeSidFile(buildSidChainSong());
    const refuse = (b: Uint8Array, reason: RegExp) => expect(() => parseSidFile(b)).toThrow(reason);
    refuse(Uint8Array.from([...bytes, 0]), /1 bytes follow the song/);
    refuse(bytes.subarray(0, bytes.length - 1), /the file ends inside/);
    const magic = bytes.slice();
    magic[0] = 0x42;
    refuse(magic, /no ASID magic/);
    const version = bytes.slice();
    // Version 1 (instruments with a waveform, pulse width and filter of
    // their own) is not read (plan-sid-authoring.md D1).
    version[4] = 1;
    refuse(version, /version 1/);
    const chip = bytes.slice();
    chip[5] = 9;
    refuse(chip, /chip model 9/);
    const tempo = bytes.slice();
    tempo[8] = 0;
    refuse(tempo, /tempo/);
  });

  it('rides a .cmod as base64, and a bad text is refused, never thrown', () => {
    const doc = buildSidChainSong();
    const decoded = decodeSidFile(encodeSidFile(doc));
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.doc).toEqual(doc);
      expect(decoded.bytes).toEqual(serializeSidFile(doc));
    }
    expect(decodeSidFile(42)).toEqual({ ok: false, reason: 'it is not text' });
    expect(decodeSidFile('abc')).toEqual({ ok: false, reason: 'it is not valid base64' });
    expect(decodeSidFile('A'.repeat(512 * 1024 + 4))).toMatchObject({ ok: false, reason: expect.stringMatching(/512 KiB/) });
    expect(decodeSidFile(btoa('ASIDxx'))).toMatchObject({ ok: false, reason: expect.stringMatching(/not a readable SID song/) });
  });
});

describe('the grid projection', () => {
  it('lays the three orderlists out in rows, cutting a position wherever any voice starts a pattern', () => {
    const grid = projectSidPatterns(buildSidChainSong());
    // Voices 1-2 play one 32-row pattern; voice 3 a 16-row one twice: two positions of 16.
    expect(grid.map((p) => [p.id, p.rows])).toEqual([
      ['sid-pos-0', 16],
      ['sid-pos-1', 16],
    ]);
    expect(grid[0]!.positionTranspose).toEqual([0, 0, 5]);
    const [v1, v2, v3] = grid[0]!.tracks;
    expect(v1!.entries[0]).toMatchObject({ row: 0, note: 'A-4', instrument: '01' });
    // The chip's pitch, not equal temperament: 7494 * 985248 / 2^24.
    expect(v1!.entries[0]!.frequency).toBeCloseTo(440.0878, 4);
    expect(v2!.entries[0]).toMatchObject({ row: 8, note: 'C-4', instrument: '02' });
    // E-3 transposed +5 sounds A-3.
    expect(v3!.entries[0]).toMatchObject({ row: 10, note: 'A-3', instrument: '03' });
    const [w1, w2, w3] = grid[1]!.tracks;
    expect(w1!.entries.map((e) => [e.row, e.note ?? e.macro])).toEqual([
      [0, '###'],
      [4, 'C-5'],
      [12, '102'],
    ]);
    expect(w1!.entries[2]).toMatchObject({ effectCommand: 1, effectParam: 2 });
    expect(w2!.entries).toEqual([{ row: 8, note: '###' }]);
    expect(w3!.entries[0]).toMatchObject({ row: 10, note: 'A-3' });
  });

  it('a shorter voice loops from its restart to fill the longest one', () => {
    let doc = createNewSidDoc({ patternRows: 8 });
    doc = must(setSidRow(doc, 1, 0, { note: 13, instrument: 1, command: 0, param: 0 }));
    doc = makeSidDoc({
      ...doc,
      patterns: [{ rows: Array(24).fill(BLANK_SID_ROW) }, ...doc.patterns.slice(1)],
    });
    const grid = projectSidPatterns(doc);
    // Voice 1: 24 rows; voices 2 and 3: 8-row patterns, looped three times.
    expect(grid.map((p) => p.rows)).toEqual([8, 8, 8]);
    expect(grid.map((p) => p.tracks[1]!.entries[0]?.note)).toEqual(['C-1', 'C-1', 'C-1']);
  });

  it('the tempo reaches the tracker as 125 BPM per 50 Hz and ticks per row', () => {
    const doc = buildSidChainSong();
    expect(sidDocTiming(doc)).toEqual({ bpm: 125, initialSpeed: 6 });
    expect(sidDocTiming(must(setSidTiming(doc, 6, 2)))).toEqual({ bpm: 250, initialSpeed: 6 });
    // Past the engine's 255 BPM: 250 BPM and the speed scaled to keep 200 frames/s / 8 = 25 rows/s.
    expect(sidDocTiming(must(setSidTiming(doc, 8, 4)))).toEqual({ bpm: 250, initialSpeed: 4 });
  });
});
