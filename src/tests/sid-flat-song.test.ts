// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BLANK_SID_ROW,
  blankSidFlatCell,
  compileSidFlatSong,
  createNewSidDoc,
  flattenSidDoc,
  flattenSidSubsong,
  gtSongHintsFromName,
  importGtSong,
  makeSidDoc,
  sidDocForSubsong,
  type SidDoc,
  type SidDocRow,
  type SidFlatSubsong,
  type SidOpResult,
} from 'src/audio/tracker/sid-doc';

/**
 * plan-sid-authoring.md phase 2, the flat model (agreed 2026-09-25): the
 * editor edits song-wide patterns and a sequence (`flat.ts`); GoatTracker's
 * per-voice structure is compiled from it. What must hold: flatten then
 * compile plays as the song did (the gtref gate measures it; here the row
 * streams, pattern starts and loop points), compile then flatten gives the
 * flat song back, and what GT cannot hold is refused with the true reason.
 */

const must = (r: SidOpResult): SidDoc => {
  if (!r.ok) throw new Error(r.reason);
  return r.doc;
};
const note = (n: number): SidDocRow => ({ ...BLANK_SID_ROW, note: n, instrument: 1 });
const rows = (length: number, marks: Record<number, number> = {}): SidDocRow[] =>
  Array.from({ length }, (_, r) => (marks[r] !== undefined ? note(marks[r]) : BLANK_SID_ROW));

/**
 * What a voice plays, row by row for `n` rows; with `marks`, each pattern's
 * first row is marked (GT skips the voice's pulse step there, gplay.c:853).
 */
function voiceStream(doc: SidDoc, subsong: number, voice: number, n: number, marks = true): string[] {
  const list = doc.subsongs[subsong]!.orderlists[voice]!;
  const out: string[] = [];
  for (let i = 0; out.length < n; i = i + 1 >= list.entries.length ? list.restart : i + 1) {
    const e = list.entries[i]!;
    for (let k = 0; k < e.repeat; k++) {
      doc.patterns[e.pattern]!.rows.forEach((r, j) => out.push(`${marks && j === 0 ? '|' : ''}${r.note}/${r.instrument}/${r.command}/${r.param}${e.transpose}`));
    }
  }
  return out.slice(0, n);
}

/** A drifting song: voice 1 loops 3 × 16 rows from entry 1, voice 2 plays one 64-row pattern, voice 3 loops a 24-row pattern. */
function driftSong(): SidDoc {
  const base = createNewSidDoc();
  return makeSidDoc({
    ...base,
    patterns: [rows(16, { 0: 25 }), rows(16, { 4: 30 }), rows(64, { 0: 40, 32: 42 }), rows(24, { 0: 13, 12: 15 })].map((r) => ({ rows: r })),
    subsongs: [
      {
        orderlists: [
          { entries: [{ pattern: 0, transpose: 0, repeat: 1 }, { pattern: 1, transpose: 2, repeat: 3 }], restart: 1 },
          { entries: [{ pattern: 2, transpose: 0, repeat: 1 }], restart: 0 },
          { entries: [{ pattern: 3, transpose: -3, repeat: 1 }], restart: 0 },
        ],
      },
    ],
  });
}

describe('flatten', () => {
  it('cuts a position wherever any voice starts a pattern, and records which voices start one', () => {
    const flat = flattenSidSubsong(driftSong(), 0);
    const lengths = flat.sequence.map((id) => flat.patterns[id]!.rows);
    // Voice 1 starts at 0,16,32,48; voice 2 at 0,64; voice 3 every 24 rows: 0,24,48,72,...
    expect(lengths.reduce((a, b) => a + b, 0)).toBe(192);
    const starts = (voice: number) => {
      let at = 0;
      const out: number[] = [];
      for (const id of flat.sequence) {
        if (flat.patterns[id]!.cells[voice]!.start) out.push(at);
        at += flat.patterns[id]!.rows;
      }
      return out;
    };
    expect(starts(0)).toEqual([0, 16, 32, 48, 64, 80, 96, 112, 128, 144, 160, 176]);
    expect(starts(1)).toEqual([0, 64, 128]);
    expect(starts(2)).toEqual([0, 24, 48, 72, 96, 120, 144, 168]);
  });

  it('makes the song long enough that every voice loops back to a pattern start of its own (exact loops)', () => {
    // First pass: voice 1 64 rows, voice 2 64, voice 3 24. At row 64 voice 3 is
    // 16 rows into its pattern; the first row where every voice starts a
    // pattern again is 192 (3 × 64, 8 × 24). There voice 1 is 48 rows into
    // its 48-row loop from row 16 (3 × P1): it loops back to row 48, where
    // its third P1 starts.
    const flat = flattenSidSubsong(driftSong(), 0);
    const at = (i: number) => flat.sequence.slice(0, i).reduce((n, id) => n + flat.patterns[id]!.rows, 0);
    expect(flat.restarts.map(at)).toEqual([48, 0, 0]);
    // At its first pass only, voice 3 would loop back into its pattern's middle, where compile must cut it.
    const short = flattenSidSubsong(driftSong(), 0, false);
    const shortAt = (i: number) => short.sequence.slice(0, i).reduce((n, id) => n + short.patterns[id]!.rows, 0);
    expect(short.restarts.map(shortAt)).toEqual([16, 0, 16]);
    const cut = short.patterns[short.sequence[short.restarts[2]!]!]!.cells[2]!;
    expect(cut.start).toBe(true);
  });

  it('compiles back to the same row streams, pattern starts and loops, for ever', () => {
    const doc = driftSong();
    const compiled = must(compileSidFlatSong(doc, flattenSidDoc(doc)));
    for (let v = 0; v < 3; v++) expect(voiceStream(compiled, 0, v, 2000)).toEqual(voiceStream(doc, 0, v, 2000));
  });
});

describe('compile', () => {
  it('shares identical cells as one pattern, collapses consecutive ones into a repeat, and keeps the transposes', () => {
    const doc = createNewSidDoc({ patternRows: 8 });
    const cell = (marks: Record<number, number>, transpose = 0) => ({ transpose, rows: rows(8, marks), start: true });
    const flat: SidFlatSubsong = {
      patterns: {
        a: { rows: 8, cells: [cell({ 0: 25 }), cell({ 0: 25 }, 3), blankSidFlatCell(8)] },
        b: { rows: 8, cells: [cell({ 0: 25 }), cell({ 2: 30 }), blankSidFlatCell(8)] },
      },
      sequence: ['a', 'a', 'b'],
      restarts: [0, 0, 0],
    };
    const out = must(compileSidFlatSong(doc, [flat]));
    // Patterns, numbered as first met voice by voice: 25 at row 0, 30 at row 2, blank.
    expect(out.patterns).toHaveLength(3);
    const lists = out.subsongs[0]!.orderlists;
    expect(lists[0]!.entries).toEqual([{ pattern: 0, transpose: 0, repeat: 3 }]);
    expect(lists[1]!.entries).toEqual([
      { pattern: 0, transpose: 3, repeat: 2 },
      { pattern: 1, transpose: 0, repeat: 1 },
    ]);
    expect(lists[2]!.entries).toEqual([{ pattern: 2, transpose: 0, repeat: 3 }]);
    // Compile then flatten: the same positions and cells back (ids are flatten's own).
    const again = flattenSidDoc(out)[0]!;
    expect(again.sequence.map((id) => again.patterns[id])).toEqual(flat.sequence.map((id) => flat.patterns[id]));
  });

  it('never repeats across a voice\'s loop point: the loop starts an entry', () => {
    const doc = createNewSidDoc({ patternRows: 4 });
    const flat: SidFlatSubsong = {
      patterns: { a: { rows: 4, cells: [blankSidFlatCell(4), blankSidFlatCell(4), blankSidFlatCell(4)] } },
      sequence: ['a', 'a', 'a'],
      restarts: [2, 0, 1],
    };
    const lists = must(compileSidFlatSong(doc, [flat])).subsongs[0]!.orderlists;
    expect(lists.map((l) => [l.entries.map((e) => e.repeat), l.restart])).toEqual([
      [[2, 1], 1],
      [[3], 0],
      [[1, 2], 1],
    ]);
  });

  it('refuses what GoatTracker cannot hold, and says so', () => {
    const doc = createNewSidDoc({ patternRows: 1 });
    const empty: SidFlatSubsong = { patterns: {}, sequence: [], restarts: [0, 0, 0] };
    expect(compileSidFlatSong(doc, [empty])).toEqual({ ok: false, reason: 'The song needs at least one pattern in its sequence.' });
    // 70 positions, each voice's row a different note: 210 distinct voice patterns.
    const patterns: Record<string, SidFlatSubsong['patterns'][string]> = {};
    const sequence: string[] = [];
    for (let i = 0; i < 70; i++) {
      // Each voice's row: note i+1 with its own command (none, 1, 2).
      patterns[`p${i}`] = { rows: 1, cells: [0, 1, 2].map((v) => ({ transpose: 0, rows: [{ ...BLANK_SID_ROW, note: 1 + i, command: v }], start: true })) };
      sequence.push(`p${i}`);
    }
    expect(compileSidFlatSong(doc, [{ patterns, sequence, restarts: [0, 0, 0] }])).toEqual({
      ok: false,
      reason: 'The song needs 210 different voice patterns; GoatTracker holds 208. Reuse patterns, or make them longer.',
    });
    // 254 bytes: 128 positions alternating the transpose take 256.
    const alt: Record<string, SidFlatSubsong['patterns'][string]> = {
      x: { rows: 1, cells: [{ ...blankSidFlatCell(1), transpose: 0 }, blankSidFlatCell(1), blankSidFlatCell(1)] },
      y: { rows: 1, cells: [{ ...blankSidFlatCell(1), transpose: 1 }, blankSidFlatCell(1), blankSidFlatCell(1)] },
    };
    const long = Array.from({ length: 128 }, (_, i) => (i % 2 ? 'y' : 'x'));
    expect(compileSidFlatSong(doc, [{ patterns: alt, sequence: long, restarts: [0, 0, 0] }])).toEqual({
      ok: false,
      reason: "Voice 1's GoatTracker orderlist would take 256 bytes; GoatTracker's holds 254. Use fewer or longer patterns.",
    });
  });
});

describe('the corpus', () => {
  const ROOT = resolve(__dirname, 'fixtures/gt-songs');
  const files = readdirSync(ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .flatMap((d) => readdirSync(resolve(ROOT, d.name)).map((f) => `${d.name}/${f}`))
    .sort();

  /**
   * Where a voice has to loop back into the middle of one of its patterns,
   * which a GT orderlist cannot do, so compile starts a pattern there: the
   * rows are the same, and GT skips that voice's pulse step on that row
   * (inaudible in both: gtref register-identical, run_flat_gate.sh).
   * forest_encounter subsong 1 never lines up (its voices' pattern grids are
   * 16 rows apart for ever); investigations lines up at row 5888, whose
   * orderlist would take 330 of GT's 254 bytes.
   */
  const LOOP_CUTS = new Set([
    'ansgaros/metal_warrior_4_forest_encounter.sng sub 1 voice 1',
    'ansgaros/metal_warrior_4_forest_encounter.sng sub 1 voice 2',
    'cadaver/metal_warrior_4_investigations.sng sub 0 voice 2',
  ]);

  it('every song flattens and compiles, plays the same rows with the same pattern starts, and compile then flatten is the identity', () => {
    let songs = 0;
    const cuts: string[] = [];
    for (const f of files) {
      const r = importGtSong(new Uint8Array(readFileSync(resolve(ROOT, f))), gtSongHintsFromName(f));
      if (!r.ok) throw new Error(`${f}: ${r.reason}`);
      const flat = flattenSidDoc(r.doc);
      const compiled = must(compileSidFlatSong(r.doc, flat));
      expect(flattenSidDoc(compiled), f).toEqual(flat);
      r.doc.subsongs.forEach((_, s) => {
        for (let v = 0; v < 3; v++) {
          const where = `${f} sub ${s} voice ${v + 1}`;
          expect(voiceStream(compiled, s, v, 3000, false), where).toEqual(voiceStream(r.doc, s, v, 3000, false));
          if (voiceStream(compiled, s, v, 3000).join() !== voiceStream(r.doc, s, v, 3000).join()) cuts.push(where);
        }
      });
      songs++;
    }
    expect(songs).toBe(84);
    expect(cuts).toEqual([...LOOP_CUTS]);
  });
});

describe('sidDocForSubsong', () => {
  it('is the doc with one subsong, the same object each time', () => {
    const doc = driftSong();
    expect(sidDocForSubsong(doc, 0)).toBe(doc);
    const two = makeSidDoc({ ...doc, subsongs: [doc.subsongs[0]!, { orderlists: doc.subsongs[0]!.orderlists.slice().reverse() }] });
    const second = sidDocForSubsong(two, 1);
    expect(second.subsongs).toEqual([two.subsongs[1]]);
    expect(second.patterns).toBe(two.patterns);
    expect(sidDocForSubsong(two, 1)).toBe(second);
  });
});
