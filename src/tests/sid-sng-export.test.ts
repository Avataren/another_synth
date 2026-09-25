import { describe, expect, it } from 'vitest';
import {
  BLANK_SID_ROW,
  DEFAULT_SID_INSTRUMENT,
  SID_FILE_VERSION,
  SID_MAX_INSTRUMENTS,
  SID_MAX_PATTERN_ROWS,
  SID_MAX_PATTERNS,
  SID_MAX_SUBSONGS,
  SID_MAX_TABLE_ROWS,
  createNewSidDoc,
  exportGtSong,
  importGtSong,
  makeSidDoc,
  type SidDoc,
  type SidInstrument,
  type SidOrderlist,
} from 'src/audio/tracker/sid-doc';
import { newSidInstrument } from 'src/audio/tracker/sid-instrument-edit';

/**
 * The GTS5 writer (plan-sid-tracking.md S5): the exact bytes of a small song
 * (readme §6.1, section by section), what it refuses and why, the orderlist
 * command encoding (§3.1), the model's limits, and the round trip back.
 */

/** Every instrument is GoatTracker's (plan-sid-authoring.md D1). */
const GT_INSTRUMENT: SidInstrument = DEFAULT_SID_INSTRUMENT;
const list = (entries: SidOrderlist['entries'], restart = 0): SidOrderlist => ({ entries, restart });
const once = (pattern: number) => ({ pattern, transpose: 0, repeat: 1 });

function song(fields: Partial<SidDoc> = {}): SidDoc {
  return makeSidDoc({
    format: 'sid',
    version: SID_FILE_VERSION,
    songName: 'Tune',
    author: 'Me',
    copyright: '',
    chipModel: '6581',
    channels: 3,
    speedMultiplier: 1,
    tempo: 6,
    subsongs: [{ orderlists: [list([once(0)]), list([once(0)]), list([once(0)])] }],
    patterns: [{ rows: [{ note: 1, instrument: 1, command: 0xf, param: 5 }, BLANK_SID_ROW] }],
    instruments: [{ ...GT_INSTRUMENT, name: 'Lead', attack: 1, decay: 2, sustain: 3, release: 4, gateTimer: 2, hardRestart: true, firstWave: 9, wavePtr: 1 }],
    tables: { wave: [{ left: 0x41, right: 0 }, { left: 0xff, right: 0 }], pulse: [], filter: [], speed: [] },
    ...fields,
  });
}

function bytesOf(doc: SidDoc): Uint8Array {
  const out = exportGtSong(doc);
  if (!out.ok) throw new Error(out.reason);
  return out.bytes;
}
const reason = (doc: SidDoc): string => {
  const out = exportGtSong(doc);
  expect(out.ok).toBe(false);
  return out.ok ? '' : out.reason;
};
const pad = (s: string, n: number) => Array.from({ length: n }, (_, i) => (i < s.length ? s.charCodeAt(i) : 0));

describe('the GTS5 writer', () => {
  it('writes readme §6.1 section by section', () => {
    expect(Array.from(bytesOf(song()))).toEqual([
      ...'GTS5'.split('').map((c) => c.charCodeAt(0)),
      ...pad('Tune', 32),
      ...pad('Me', 32),
      ...pad('', 32),
      1, // subtunes
      2, 0x00, 0xff, 0x00, // each channel: length (endmark counted), pattern 0, RST, restart 0
      2, 0x00, 0xff, 0x00,
      2, 0x00, 0xff, 0x00,
      1, // instruments
      0x12, 0x34, 1, 0, 0, 0, 0, 0x02, 0x09, ...pad('Lead', 16),
      2, 0x41, 0xff, 0x00, 0x00, // wave: n, lefts, rights
      0, 0, 0, // pulse, filter, speed
      1, // patterns
      3, 0x60, 1, 0xf, 5, 0xbd, 0, 0, 0, 0xff, 0, 0, 0, // rows + the $FF end row, counted
    ]);
  });

  it('encodes hard restart off as gate-timer bit $80, and every note kind', () => {
    const doc = song({
      instruments: [{ ...GT_INSTRUMENT, hardRestart: false, gateTimer: 3 }],
      patterns: [{ rows: [{ ...BLANK_SID_ROW, note: 93 }, { ...BLANK_SID_ROW, note: 126 }, { ...BLANK_SID_ROW, note: 127 }] }],
      tables: { wave: [], pulse: [], filter: [], speed: [] },
    });
    const b = bytesOf(doc);
    const ins = 101 + 12;
    expect(b[ins + 1 + 7]).toBe(0x83);
    expect(Array.from(b.subarray(b.length - 16, b.length - 4)).filter((_, i) => i % 4 === 0)).toEqual([0xbc, 0xbe, 0xbf]);
  });

  it('encodes an orderlist as GT commands: a transpose when it changes, a repeat above 1 as $D0 + plays - 1 (gplay.c:977-986; $DF = 16), TRANSPOSE before REPEAT', () => {
    const doc = song({
      patterns: [{ rows: [BLANK_SID_ROW] }, { rows: [BLANK_SID_ROW] }],
      subsongs: [
        {
          orderlists: [
            list([{ pattern: 0, transpose: 2, repeat: 3 }, { pattern: 1, transpose: 2, repeat: 1 }, { pattern: 0, transpose: -16, repeat: 16 }, { pattern: 1, transpose: 14, repeat: 2 }]),
            list([once(0)]),
            list([once(0)]),
          ],
        },
      ],
    });
    const b = bytesOf(doc);
    expect(Array.from(b.subarray(101, 101 + 12))).toEqual([11, 0xf2, 0xd2, 0x00, 0x01, 0xe0, 0xdf, 0x00, 0xfe, 0xd1, 0x01, 0xff]);
    expect(b[113]).toBe(0x00);
    const back = importGtSong(b);
    expect(back.ok && back.doc).toEqual(doc);
  });

  it('restates the transpose at the restart entry when the loop would carry the end\'s into it', () => {
    const doc = song({
      subsongs: [{ orderlists: [list([once(0), { pattern: 0, transpose: 5, repeat: 1 }], 0), list([once(0)]), list([once(0)])] }],
    });
    const b = bytesOf(doc);
    // Entry 0 plays at 0 but the list ends at +5: $F0 restates it, and the restart points at it.
    expect(Array.from(b.subarray(101, 101 + 7))).toEqual([5, 0xf0, 0x00, 0xf5, 0x00, 0xff, 0x00]);
    const back = importGtSong(b);
    expect(back.ok && back.notes).toEqual([]);
    expect(back.ok && back.doc).toEqual(doc);
  });

  it('points the restart at the restart entry\'s first command byte', () => {
    const doc = song({ subsongs: [{ orderlists: [list([once(0), { pattern: 0, transpose: 3, repeat: 2 }], 1), list([once(0)]), list([once(0)])] }] });
    const b = bytesOf(doc);
    expect(Array.from(b.subarray(101, 101 + 7))).toEqual([5, 0x00, 0xf3, 0xd1, 0x00, 0xff, 0x01]);
  });

  it('refuses a start tempo other than GoatTracker\'s 6: a .sng has no tempo field', () => {
    expect(reason(song({ tempo: 4 }))).toBe(
      'a .sng has no tempo field (GoatTracker starts every song at tempo 6) and this song starts at tempo 4; put an F command with the tempo on its first row instead',
    );
  });

  it('writes a new SID song and an instrument added to it, and reads both back unchanged (plan-sid-authoring.md phase 1)', () => {
    const fresh = createNewSidDoc();
    const back = importGtSong(bytesOf(fresh));
    expect(back.ok && back.doc).toEqual(fresh);
    const added = newSidInstrument(fresh, 'Second');
    if (!added.ok) throw new Error(added.reason);
    const again = importGtSong(bytesOf(added.doc));
    expect(again.ok && again.doc).toEqual(added.doc);
  });

  it('refuses a transpose outside GT\'s $E0-$FE range, and an orderlist over 254 bytes', () => {
    const t = (transpose: number) => song({ subsongs: [{ orderlists: [list([{ pattern: 0, transpose, repeat: 1 }]), list([once(0)]), list([once(0)])] }] });
    expect(reason(t(15))).toBe('subsong 0 channel 1 entry 0 transposes by 15; a GoatTracker orderlist transposes -16..+14');
    expect(reason(t(-17))).toBe('subsong 0 channel 1 entry 0 transposes by -17; a GoatTracker orderlist transposes -16..+14');
    expect(exportGtSong(t(-16)).ok).toBe(true);
    // 128 entries alternating transpose and repeated: 3 bytes each.
    const long = Array.from({ length: 128 }, (_, i) => ({ pattern: 0, transpose: i % 2, repeat: 2 }));
    expect(reason(song({ subsongs: [{ orderlists: [list(long), list([once(0)]), list([once(0)])] }] }))).toBe(
      "subsong 0 channel 1's orderlist needs 384 bytes with its repeats and transposes; GoatTracker's holds 254",
    );
    // 254 plain entries fit exactly.
    const full = Array.from({ length: 254 }, () => once(0));
    const doc = song({ subsongs: [{ orderlists: [list(full, 253), list([once(0)]), list([once(0)])] }] });
    const back = importGtSong(bytesOf(doc));
    expect(back.ok && back.doc).toEqual(doc);
  });

  it('refuses a NUL inside a text, which would end the field early', () => {
    expect(reason(song({ author: 'A\0B' }))).toBe('the author contains a NUL character, which ends a .sng text field early');
    expect(reason(song({ instruments: [{ ...GT_INSTRUMENT, name: 'x\0' }] }))).toBe("instrument 1's name contains a NUL character, which ends a .sng text field early");
  });

  it('refuses what the model itself refuses, with the model\'s reason', () => {
    const broken = { ...song(), tempo: 0 } as SidDoc;
    expect(reason(broken)).toBe('the song breaks a rule of the SID model (the tempo is not 1-127)');
  });

  it('writes the model\'s limits and reads them back: 32 subsongs, 208 patterns of 128 rows, 63 instruments, 255-row tables, full texts', () => {
    const rows = Array.from({ length: SID_MAX_PATTERN_ROWS }, (_, i) => ({ note: (i % 93) + 1, instrument: (i % SID_MAX_INSTRUMENTS) + 1, command: i % 16, param: (i * 7) & 0xff }));
    const table = Array.from({ length: SID_MAX_TABLE_ROWS }, (_, i) => ({ left: i, right: 255 - i }));
    const doc = song({
      songName: 'N'.repeat(32),
      author: '\xe9'.repeat(32),
      copyright: ' edge ',
      subsongs: Array.from({ length: SID_MAX_SUBSONGS }, (_, s) => ({ orderlists: [list([once(s)]), list([once(207)]), list([once(0)])] })),
      patterns: Array.from({ length: SID_MAX_PATTERNS }, () => ({ rows })),
      instruments: Array.from({ length: SID_MAX_INSTRUMENTS }, (_, i) => ({
        ...GT_INSTRUMENT,
        name: 'I'.repeat(16),
        attack: i % 16,
        gateTimer: i,
        hardRestart: i % 2 === 0,
        noGateOff: i % 3 === 0,
        firstWave: 0xff - i,
        vibratoDelay: i * 4,
        wavePtr: 255,
        pulsePtr: 1,
        filterPtr: 2,
        speedPtr: 3,
      })),
      tables: { wave: table, pulse: table, filter: table, speed: table },
    });
    const b = bytesOf(doc);
    const back = importGtSong(b);
    expect(back.ok && back.doc).toEqual(doc);
  });

  it('says what the file cannot store: the chip model always, the speed multiplier when it is not 1', () => {
    const out = exportGtSong(song({ chipModel: '6581', speedMultiplier: 4 }));
    expect(out.ok && out.notes).toEqual([
      'the chip model (6581) is not stored in a .sng: GoatTracker takes it from its -E option',
      'the 4x speed is not stored in a .sng: play it in GoatTracker with -S4',
    ]);
    // And they come back from the hints, not from the bytes.
    const back = importGtSong(out.ok ? out.bytes : new Uint8Array(), { chipModel: '6581', speedMultiplier: 4 });
    expect(back.ok && back.doc).toEqual(song({ chipModel: '6581', speedMultiplier: 4 }));
  });
});
