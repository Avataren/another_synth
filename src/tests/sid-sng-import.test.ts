import { describe, expect, it } from 'vitest';
import {
  gtSongHintsFromName,
  importGtSong,
  looksLikeGtSong,
  type GtSongImport,
  type SidDoc,
} from 'src/audio/tracker/sid-doc';

/**
 * The `.sng` reader on hand-built bytes (plan-sid-tracking.md S5): the §6.1
 * offsets, the orderlist state machine, the note and gate-timer encodings,
 * every refusal (whole, with a true reason, never a throw), the dual-SID
 * probe, the name hints, and the GoatTracker 1 conversion.
 */

const text = (s: string, n: number) =>
  Array.from({ length: n }, (_, i) => (i < s.length ? s.charCodeAt(i) : 0));

interface Gts5Spec {
  magic?: string;
  name?: number[];
  subtunes?: number[][][];
  instruments?: number[][];
  tables?: [number[][], number[][], number[][], number[][]];
  patterns?: number[][][];
  trailing?: number[];
}

/** A GTS5 file, section by section (readme §6.1.1-6). Orderlists are given as their data bytes (endmark + restart included). */
function gts5(spec: Gts5Spec = {}): Uint8Array {
  const out: number[] = [
    ...(spec.magic ?? 'GTS5').split('').map((c) => c.charCodeAt(0)),
  ];
  out.push(
    ...(spec.name ?? text('Song', 32)),
    ...text('Author', 32),
    ...text('(C)', 32),
  );
  const subtunes = spec.subtunes ?? [
    [
      [0x00, 0xff, 0x00],
      [0x00, 0xff, 0x00],
      [0x00, 0xff, 0x00],
    ],
  ];
  out.push(subtunes.length);
  for (const lists of subtunes)
    for (const data of lists) out.push(data.length - 1, ...data);
  const instruments = spec.instruments ?? [
    [0x09, 0x00, 0, 0, 0, 0, 0, 0x02, 0x09, ...text('Lead', 16)],
  ];
  out.push(instruments.length);
  for (const ins of instruments) out.push(...ins);
  for (const table of spec.tables ?? [[], [], [], []]) {
    out.push(
      table.length,
      ...table.map((r) => r[0]!),
      ...table.map((r) => r[1]!),
    );
  }
  const patterns = spec.patterns ?? [[[0x60, 0x01, 0x00, 0x00]]];
  out.push(patterns.length);
  for (const rows of patterns) {
    out.push(rows.length + 1);
    for (const r of rows) out.push(...r);
    out.push(0xff, 0, 0, 0);
  }
  out.push(...(spec.trailing ?? []));
  return Uint8Array.from(out);
}

function ok(r: GtSongImport): Extract<GtSongImport, { ok: true }> {
  if (!r.ok) throw new Error(`refused: ${r.reason}`);
  return r;
}
const refusal = (bytes: Uint8Array) => {
  const r = importGtSong(bytes);
  expect(r.ok).toBe(false);
  return r.ok ? '' : r.reason;
};

describe('GTS5 (readme §6.1)', () => {
  it('reads the header texts at +4/+36/+68 up to their first NUL, and the defaults a .sng has no field for', () => {
    const name = text('Alien', 32);
    name[10] = 0x41; // bytes after the NUL are padding, not text
    const { doc, variant, notes } = ok(importGtSong(gts5({ name })));
    expect(variant).toBe('GTS5');
    expect(notes).toEqual([]);
    expect([doc.songName, doc.author, doc.copyright]).toEqual([
      'Alien',
      'Author',
      '(C)',
    ]);
    expect([
      doc.tempo,
      doc.speedMultiplier,
      doc.chipModel,
      doc.channels,
    ]).toEqual([6, 1, '6581', 3]);
  });

  it('maps notes $60-$BC to 1-93, $BD rest to 0, $BE key off to 126, $BF key on to 127; the $FF row ends the pattern', () => {
    const rows = [0x60, 0xbc, 0xbd, 0xbe, 0xbf].map((n) => [n, 0, 0x0f, 0x05]);
    const { doc } = ok(importGtSong(gts5({ patterns: [rows] })));
    expect(doc.patterns[0]!.rows.map((r) => r.note)).toEqual([
      1, 93, 0, 126, 127,
    ]);
    expect(doc.patterns[0]!.rows[0]).toEqual({
      note: 1,
      instrument: 0,
      command: 0xf,
      param: 5,
    });
  });

  it("maps an instrument's 25 bytes (§6.1.3) and the HR/Gate Timer bits (§3.3)", () => {
    const ins = (gate: number) => [
      0x1a,
      0xb2,
      1,
      1,
      1,
      1,
      0x07,
      gate,
      0x09,
      ...text('X', 16),
    ];
    const tables: Gts5Spec['tables'] = [
      [[0x41, 0x00]],
      [[0x88, 0x00]],
      [[0x90, 0xf1]],
      [[0x03, 0x40]],
    ];
    const { doc, notes } = ok(
      importGtSong(
        gts5({ instruments: [ins(0x02), ins(0x83), ins(0x42)], tables }),
      ),
    );
    expect(doc.instruments[0]).toEqual({
      name: 'X',
      attack: 1,
      decay: 0xa,
      sustain: 0xb,
      release: 2,
      firstWave: 9,
      gateTimer: 2,
      hardRestart: true,
      noGateOff: false,
      vibratoDelay: 7,
      wavePtr: 1,
      pulsePtr: 1,
      filterPtr: 1,
      speedPtr: 1,
    });
    expect([
      doc.instruments[1]!.gateTimer,
      doc.instruments[1]!.hardRestart,
    ]).toEqual([3, false]);
    // $40 (no gate-off) is the doc's noGateOff flag; the timer is kept (it
    // still says when the next row is read).
    expect([
      doc.instruments[2]!.gateTimer,
      doc.instruments[2]!.hardRestart,
      doc.instruments[2]!.noGateOff,
    ]).toEqual([2, true, true]);
    expect(notes).toEqual([]);
    expect(doc.tables.filter).toEqual([{ left: 0x90, right: 0xf1 }]);
  });

  it('pads a table an instrument points past with blank rows, and says so', () => {
    const { doc, notes } = ok(
      importGtSong(
        gts5({
          instruments: [[0, 0, 3, 0, 0, 0, 0, 0, 0, ...text('', 16)]],
          tables: [[[0x41, 0]], [], [], []],
        }),
      ),
    );
    expect(doc.tables.wave).toEqual([
      { left: 0x41, right: 0 },
      { left: 0, right: 0 },
      { left: 0, right: 0 },
    ]);
    expect(notes).toEqual([
      {
        kind: 'table-padded',
        message:
          "instrument 1: its wave pointer 3 is past the table's 1 rows; blank rows added",
      },
    ]);
  });

  it('plays orderlist commands as state: a transpose holds, a repeat $Dk plays the next pattern k + 1 times ($DF = 16, gplay.c:977-986), the restart byte names an entry', () => {
    const list = [0xf2, 0xd2, 0x00, 0x01, 0xe8, 0xdf, 0x00, 0xff, 0x04];
    const three = [list, [0x00, 0xff, 0x00], [0x00, 0xff, 0x00]];
    const { doc, notes } = ok(
      importGtSong(
        gts5({
          subtunes: [three],
          patterns: [[[0x60, 0, 0, 0]], [[0x61, 0, 0, 0]]],
        }),
      ),
    );
    expect(doc.subsongs[0]!.orderlists[0]).toEqual({
      entries: [
        { pattern: 0, transpose: 2, repeat: 3 },
        { pattern: 1, transpose: 2, repeat: 1 },
        { pattern: 0, transpose: -8, repeat: 16 },
      ],
      // Byte 4 is the $E8 that starts entry 2's commands.
      restart: 2,
    });
    expect(notes).toEqual([]);
  });

  it('reports a loop whose running transpose differs from the first pass (the doc keeps the first pass)', () => {
    // First pass: P0 at 0, P1 at +3. The loop restarts at P0's byte with +3 still running.
    const list = [0x00, 0xf3, 0x01, 0xff, 0x00];
    const { doc, notes } = ok(
      importGtSong(
        gts5({
          subtunes: [[list, [0x00, 0xff, 0x00], [0x00, 0xff, 0x00]]],
          patterns: [[[0x60, 0, 0, 0]], [[0x60, 0, 0, 0]]],
        }),
      ),
    );
    expect(
      doc.subsongs[0]!.orderlists[0]!.entries.map((e) => e.transpose),
    ).toEqual([0, 3]);
    expect(notes.map((n) => n.kind)).toEqual(['loop-transpose']);
  });

  it('refuses, whole and with the true reason, what is not a readable song', () => {
    expect(refusal(gts5({ magic: 'GTS4' }))).toMatch(
      /^it is a GoatTracker 2 beta song \(GTS4\); only GTS5/,
    );
    expect(refusal(gts5({ magic: 'GTSX' }))).toBe(
      'it is not a GoatTracker song (no GTS5 or GTS! identification string)',
    );
    expect(refusal(new Uint8Array(0))).toBe(
      'it is not a GoatTracker song (no GTS5 or GTS! identification string)',
    );
    const whole = gts5();
    expect(refusal(whole.subarray(0, 60))).toBe(
      'the file ends inside the song header',
    );
    expect(refusal(whole.subarray(0, 103))).toBe(
      "the file ends inside subtune 0 channel 1's orderlist",
    );
    expect(refusal(whole.subarray(0, 120))).toBe(
      'the file ends inside instrument 1',
    );
    expect(refusal(whole.subarray(0, whole.length - 3))).toBe(
      'the file ends inside pattern 0',
    );
    expect(refusal(gts5({ trailing: [0] }))).toBe(
      '1 bytes follow the last pattern',
    );
    expect(refusal(gts5({ subtunes: [] }))).toBe(
      'it declares 0 subtunes; a song has 1-32',
    );
    expect(
      refusal(
        gts5({
          instruments: Array.from(
            { length: 64 },
            () => Array(25).fill(0) as number[],
          ),
        }),
      ),
    ).toBe('it declares 64 instruments; a song has at most 63');
    expect(
      refusal(
        gts5({
          patterns: [Array.from({ length: 129 }, () => [0xbd, 0, 0, 0])],
        }),
      ),
    ).toBe('pattern 0 has 129 rows; a pattern has at most 128');
    expect(refusal(gts5({ patterns: [[[0x5f, 0, 0, 0]]] }))).toBe(
      'pattern 0 row 0: note byte $5F is not a GoatTracker note',
    );
    expect(refusal(gts5({ patterns: [[[0x60, 2, 0, 0]]] }))).toBe(
      'pattern 0 row 0: instrument 2 does not exist (the song has 1)',
    );
    expect(refusal(gts5({ patterns: [[[0x60, 0, 0x10, 0]]] }))).toBe(
      'pattern 0 row 0: command byte $10 is not 0-F',
    );
    const lists = (first: number[]) => [
      [first, [0x00, 0xff, 0x00], [0x00, 0xff, 0x00]],
    ];
    expect(refusal(gts5({ subtunes: lists([0x00, 0x00, 0x00]) }))).toBe(
      "subtune 0 channel 1's orderlist has no RST endmark",
    );
    expect(refusal(gts5({ subtunes: lists([0x00, 0xff, 0x01]) }))).toBe(
      "subtune 0 channel 1's orderlist restarts at byte 1, past its end",
    );
    expect(refusal(gts5({ subtunes: lists([0x01, 0xff, 0x00]) }))).toBe(
      "subtune 0 channel 1's orderlist plays pattern 1, but the song has 1",
    );
    expect(refusal(gts5({ subtunes: lists([0x00, 0xf2, 0xff, 0x00]) }))).toBe(
      "subtune 0 channel 1's orderlist ends with a command, not a pattern (readme §3.1)",
    );
    expect(refusal(gts5({ subtunes: lists([0xf2, 0xff, 0x00]) }))).toBe(
      "subtune 0 channel 1's orderlist plays no pattern",
    );
  });

  it('refuses a dual-SID (6-orderlist) song with that reason, not as corrupt bytes', () => {
    const six = Array.from({ length: 6 }, () => [0x00, 0xff, 0x00]);
    expect(refusal(gts5({ subtunes: [six] }))).toBe(
      'it is a dual-SID (6-channel) song; dual SID is not supported yet (plan-sid-tracking.md S7)',
    );
  });

  it('dispatches on the magic, not on a name', () => {
    expect(looksLikeGtSong(gts5())).toBe(true);
    expect(looksLikeGtSong(gts5({ magic: 'GTS!' }))).toBe(true);
    expect(looksLikeGtSong(gts5({ magic: 'GTS2' }))).toBe(true);
    expect(looksLikeGtSong(gts5({ magic: 'GTI5' }))).toBe(false);
    expect(looksLikeGtSong(new Uint8Array([0x47, 0x54]))).toBe(false);
  });
});

describe('the hints a file name carries (a .sng stores neither)', () => {
  it.each([
    ['defunkt_final_fv_po_ro_6581_ffff.sng', { chipModel: '6581' }],
    ['stinsen/song_8580.sng', { chipModel: '8580' }],
    ['space_2x.sng', { speedMultiplier: 2 }],
    ['mw%20title%20remix%2C%202x-speed.sng', { speedMultiplier: 2 }],
    ['Tune 4X 6581.SNG', { chipModel: '6581', speedMultiplier: 4 }],
    ['covert ops in 2d (funktempo).sng', {}],
    ['tribal18.sng', {}],
    ['x1x.sng', {}],
    ['a_1x.sng', {}],
    ['a_65810.sng', {}],
  ])('%s', (name, hints) => {
    expect(gtSongHintsFromName(name)).toEqual(hints);
  });

  it('are applied to the doc', () => {
    const { doc } = ok(
      importGtSong(gts5(), gtSongHintsFromName('x_6581_3x.sng')),
    );
    expect([doc.chipModel, doc.speedMultiplier]).toEqual(['6581', 3]);
  });
});

/** A GoatTracker 1 file: header, orderlists, 31 instruments with inline wave pairs, 3-byte-row patterns, optional filter table. */
function gt1(
  instruments: { h: number[]; name?: string; wave: number[][] }[],
  patterns: number[][][],
  filterTable?: number[][],
): Uint8Array {
  const out: number[] = [
    ...'GTS!'.split('').map((c) => c.charCodeAt(0)),
    ...text('', 96),
    1,
  ];
  for (let c = 0; c < 3; c++) out.push(2, 0x00, 0xff, 0x00);
  for (let i = 0; i < 31; i++) {
    const ins = instruments[i] ?? {
      h: [0, 0, 0, 0, 0, 0, 0],
      wave: [
        [0, 0],
        [0xff, 0],
      ],
    };
    out.push(
      ...ins.h,
      ins.wave.length * 2,
      ...text(ins.name ?? '', 16),
      ...ins.wave.flat(),
    );
  }
  out.push(patterns.length);
  for (const rows of patterns) {
    out.push((rows.length + 1) * 3);
    for (const r of rows) out.push(...r);
    out.push(0xff, 0, 0);
  }
  if (filterTable) {
    const ft = Array.from(
      { length: 64 },
      (_, i) => filterTable[i] ?? [0x80, 0x0f, 0, 0],
    );
    out.push(...ft.flat());
  }
  return Uint8Array.from(out);
}

describe('GoatTracker 1 (GTS!), converted', () => {
  const lead = {
    h: [0x09, 0x00, 0x80, 0x00, 0x00, 0x00, 0x01],
    name: 'Lead',
    wave: [
      [0x41, 0x00],
      [0xff, 0x00],
    ],
  };
  const sweep = {
    h: [0x00, 0xf0, 0x20, 0x18, 0x20, 0x80, 0x00],
    name: 'Sweep',
    wave: [
      [0x81, 0xc8],
      [0x41, 0x00],
      [0xff, 0x02],
    ],
  };
  const rows = [
    [0x30, (1 << 3) | 0, 0x37], // C-4, instrument 1, arpeggio 3,7
    [0x5e, 0, 0], // key off
    [0x5f, (2 << 3) | 4, 0x34], // rest, instrument 2, vibrato $34
    [0x5f, 1, 0x08], // portamento up $08
    [0x5f, 3, 0x00], // tie-note
    [0x5f, 7, 0x85], // tempo
    [0x5f, 5, 0x01], // filter row 1
  ];
  const filter = [
    [0x80, 0x0f, 0x00, 0x00],
    [0x91, 0x1f, 0x40, 0x02], // set: resonance 9, channel 1 ($D417); LP, volume F ($D418); cutoff $40; row 2 follows
    [0x00, 0x10, 0x01, 0x02], // modulate 16 frames at +1, looping on itself
  ];

  it('keeps notes and instruments, converts the commands (readme §3.4.4 for vibrato and portamento), trims unused instruments', () => {
    const { doc, variant, notes } = ok(
      importGtSong(gt1([lead, sweep], [rows], filter)),
    );
    expect(variant).toBe('GTS!');
    // Arpeggio $37 on instrument 1 -> a clone, "Lead037", on the instrument's
    // wave head then a looping 3/7/0 program (gsong.c:700-803).
    expect(doc.instruments.map((i) => i.name)).toEqual([
      'Lead',
      'Sweep',
      'Lead037',
    ]);
    const r = doc.patterns[0]!.rows;
    expect(r.map((x) => x.note)).toEqual([0x31, 126, 0, 0, 0, 0, 0]);
    expect(r.map((x) => x.instrument)).toEqual([3, 0, 2, 0, 0, 0, 0]);
    expect(r[0]).toMatchObject({ command: 0, param: 0 });
    const arp = doc.instruments[2]!.wavePtr;
    expect(doc.tables.wave.slice(arp - 1, arp + 4)).toEqual([
      { left: 0x41, right: 0 },
      { left: 0, right: 3 },
      { left: 0, right: 7 },
      { left: 0, right: 0 },
      { left: 0xff, right: arp + 1 },
    ]);
    // Vibrato $34 -> speed 03, depth 40; portamento $08 -> speed $0020.
    expect(r[2]).toMatchObject({ command: 4 });
    expect(doc.tables.speed[r[2]!.param - 1]).toEqual({
      left: 0x03,
      right: 0x40,
    });
    expect(r[3]).toMatchObject({ command: 1 });
    expect(doc.tables.speed[r[3]!.param - 1]).toEqual({
      left: 0x00,
      right: 0x20,
    });
    expect(r[4]).toEqual({ note: 0, instrument: 0, command: 3, param: 0 });
    expect(r[5]).toEqual({ note: 0, instrument: 0, command: 0xf, param: 0x85 });
    expect(r[6]).toMatchObject({
      command: 0xa,
      param: doc.instruments[0]!.filterPtr,
    });
    expect(notes.map((n) => n.kind)).toEqual(['gt1-convert']);
  });

  it('turns the inline wavetables, the pulse sweep and the filter table into GT2 tables', () => {
    const { doc } = ok(importGtSong(gt1([lead, sweep], [rows], filter)));
    const [a, b] = doc.instruments as [
      SidDoc['instruments'][0],
      SidDoc['instruments'][0],
    ];
    expect(doc.tables.wave.slice(a.wavePtr - 1, a.wavePtr + 1)).toEqual([
      { left: 0x41, right: 0 },
      { left: 0xff, right: 0 },
    ]);
    // A jump inside an instrument's own program is relocated.
    expect(doc.tables.wave.slice(b.wavePtr - 1, b.wavePtr + 2)).toEqual([
      { left: 0x81, right: 0xc8 },
      { left: 0x41, right: 0 },
      { left: 0xff, right: b.wavePtr + 1 },
    ]);
    // Static width $800, then stop.
    expect(doc.tables.pulse.slice(a.pulsePtr - 1, a.pulsePtr + 1)).toEqual([
      { left: 0x88, right: 0x00 },
      { left: 0xff, right: 0 },
    ]);
    // $200 swept at $18 = 24 between $200 and $800: up 64 frames, then down/up 64 forever.
    expect(doc.tables.pulse.slice(b.pulsePtr - 1, b.pulsePtr + 4)).toEqual([
      { left: 0x82, right: 0x00 },
      { left: 64, right: 24 },
      { left: 64, right: 0x100 - 24 },
      { left: 64, right: 24 },
      { left: 0xff, right: b.pulsePtr + 2 },
    ]);
    expect(doc.tables.filter.slice(a.filterPtr - 1, a.filterPtr + 3)).toEqual([
      { left: 0x90, right: 0x91 },
      { left: 0x00, right: 0x40 },
      { left: 16, right: 1 },
      { left: 0xff, right: a.filterPtr + 2 },
    ]);
    // GT2's defaults for what a GT1 instrument has no byte for.
    expect([
      a.firstWave,
      a.gateTimer,
      a.hardRestart,
      a.vibratoDelay,
      a.speedPtr,
    ]).toEqual([9, 2, true, 0, 0]);
  });

  it('reads a file without the trailing filter table, dropping (and reporting) what pointed into it', () => {
    const { doc, notes } = ok(importGtSong(gt1([lead, sweep], [rows])));
    expect(doc.instruments[0]!.filterPtr).toBe(0);
    expect(doc.tables.filter).toEqual([]);
    expect(doc.patterns[0]!.rows[6]).toEqual({
      note: 0,
      instrument: 0,
      command: 0,
      param: 0,
    });
    expect(
      notes.filter((n) => n.kind === 'gt1-dropped').map((n) => n.message),
    ).toEqual([
      'instrument 1: filter pointer $01 with no filter table in the file; dropped',
      'pattern 0 row 6: filter pointer $01 with no filter table in the file; dropped',
    ]);
  });

  it('refuses a GT1 file whose patterns desync or whose tail is neither empty nor a filter table', () => {
    const good = gt1([lead], [[[0x30, 8, 0]]]);
    const bad = good.slice();
    // The pattern's length byte, one short: no longer whole 3-byte rows.
    bad[good.length - 7] = 5;
    expect(refusal(bad)).toBe(
      'pattern 0 is 5 bytes long, not a whole number of 3-byte rows',
    );
    expect(refusal(Uint8Array.from([...good, 1, 2, 3]))).toBe(
      '3 bytes follow the last pattern; a GoatTracker 1 song ends there or after a 256-byte filter table',
    );
    // A pattern-end byte inside a pattern (other stray note bytes are rests, gsong.c:559-560).
    expect(
      refusal(
        gt1(
          [lead],
          [
            [
              [0xff, 8, 0],
              [0x30, 8, 0],
            ],
          ],
        ),
      ),
    ).toBe('pattern 0 row 0: note byte $FF is not a GoatTracker 1 note');
  });
});
