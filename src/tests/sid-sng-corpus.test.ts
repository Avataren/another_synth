import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SID_NOTE_KEY_OFF,
  SID_NOTE_KEY_ON,
  SID_NOTE_NONE,
  exportGtSong,
  gtSongHintsFromName,
  importGtSong,
  type GtImportNoteKind,
  type GtSongImport,
} from 'src/audio/tracker/sid-doc';

/**
 * plan-sid-tracking.md S5 corpus acceptance. The corpus is the 83 valid
 * GoatTracker songs curated from ModLand on 2026-09-23 (61 GTS5, 22 GTS!),
 * fixtured in `fixtures/gt-songs/<artist>/` (house names; provenance in its
 * README). Every file must:
 *   1. import (with the hints its name carries);
 *   2. import FAITHFULLY: an independent reader here re-reads the raw bytes
 *      and every row, instrument and table byte must be where the doc says;
 *   3. round-trip: import -> export (GTS5) -> import gives an equal doc, and
 *      the writer is at a fixed point (exporting the re-import gives the same
 *      bytes).
 * The deviations the import reports (`notes`) are pinned per kind: they are
 * the D-log's deviation list, measured, and a change in them is a change in
 * what the import does.
 */

const ROOT = resolve(__dirname, 'fixtures/gt-songs');
const files = readdirSync(ROOT, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .flatMap((d) => readdirSync(resolve(ROOT, d.name)).map((f) => `${d.name}/${f}`))
  .sort();
const bytesOf = (name: string) => new Uint8Array(readFileSync(resolve(ROOT, name)));
const imports = new Map<string, Extract<GtSongImport, { ok: true }>>();
for (const name of files) {
  const r = importGtSong(bytesOf(name), gtSongHintsFromName(name));
  if (r.ok) imports.set(name, r);
}
const magic = (b: Uint8Array) => String.fromCharCode(...b.subarray(0, 4));

/** GT2 note byte -> doc note, per readme §6.1.6 (re-derived here, independently of the reader). */
const gt2Note = (b: number) => (b === 0xbd ? SID_NOTE_NONE : b === 0xbe ? SID_NOTE_KEY_OFF : b === 0xbf ? SID_NOTE_KEY_ON : b - 0x5f);

/** Walks a GTS5 file by §6.1's byte counts. */
function rawGts5(b: Uint8Array) {
  let p = 100;
  const subtunes = b[p++]!;
  const lists: number[][] = [];
  for (let i = 0; i < subtunes * 3; i++) {
    const n = b[p++]!;
    lists.push(Array.from(b.subarray(p, p + n + 1)));
    p += n + 1;
  }
  const ni = b[p++]!;
  const instruments = Array.from({ length: ni }, (_, i) => b.subarray(p + i * 25, p + i * 25 + 25));
  p += ni * 25;
  const tables: { left: number[]; right: number[] }[] = [];
  for (let t = 0; t < 4; t++) {
    const n = b[p++]!;
    tables.push({ left: Array.from(b.subarray(p, p + n)), right: Array.from(b.subarray(p + n, p + 2 * n)) });
    p += 2 * n;
  }
  const np = b[p++]!;
  const patterns: Uint8Array[] = [];
  for (let i = 0; i < np; i++) {
    const m = b[p++]!;
    patterns.push(b.subarray(p, p + m * 4));
    p += m * 4;
  }
  return { subtunes, lists, instruments, tables, patterns, end: p };
}

describe('the GoatTracker corpus (fixtures/gt-songs)', () => {
  it('holds the 83 curated files: 61 GTS5 and 22 GTS!', () => {
    // corpus-size constant: re-measure when fixtures/gt-songs changes (83 files, 2026-09-23).
    expect(files).toHaveLength(83);
    const magics = files.map((f) => magic(bytesOf(f)));
    expect(magics.filter((m) => m === 'GTS5')).toHaveLength(61);
    expect(magics.filter((m) => m === 'GTS!')).toHaveLength(22);
  });

  it('every file imports, as the variant its magic names', () => {
    const refused = files.filter((f) => !imports.has(f)).map((f) => {
      const r = importGtSong(bytesOf(f), gtSongHintsFromName(f));
      return `${f}: ${r.ok ? '' : r.reason}`;
    });
    expect(refused).toEqual([]);
    for (const [name, r] of imports) expect(r.variant, name).toBe(magic(bytesOf(name)));
  });

  it('GTS5: every row, instrument, table byte and orderlist pattern is where the doc says', () => {
    let checked = 0;
    for (const [name, r] of imports) {
      if (r.variant !== 'GTS5') continue;
      const raw = rawGts5(bytesOf(name));
      const doc = r.doc;
      expect(raw.end, name).toBe(bytesOf(name).length);
      expect(doc.subsongs, name).toHaveLength(raw.subtunes);
      expect(doc.patterns, name).toHaveLength(raw.patterns.length);
      raw.patterns.forEach((data, p) => {
        const rows = doc.patterns[p]!.rows;
        expect(rows.length, `${name} pattern ${p}`).toBe(data.length / 4 - 1);
        rows.forEach((row, i) => {
          expect([row.note, row.instrument, row.command, row.param], `${name} p${p} r${i}`).toEqual([
            gt2Note(data[i * 4]!),
            data[i * 4 + 1],
            data[i * 4 + 2],
            data[i * 4 + 3],
          ]);
        });
      });
      expect(doc.instruments, name).toHaveLength(raw.instruments.length);
      raw.instruments.forEach((b, i) => {
        const ins = doc.instruments[i]!;
        const where = `${name} instrument ${i + 1}`;
        expect([(ins.attack << 4) | ins.decay, (ins.sustain << 4) | ins.release], where).toEqual([b[0], b[1]]);
        expect([ins.wavePtr, ins.pulsePtr, ins.filterPtr, ins.speedPtr, ins.vibratoDelay, ins.firstWave], where).toEqual([b[2], b[3], b[4], b[5], b[6], b[8]]);
        expect(ins.hardRestart, where).toBe((b[7]! & 0x80) === 0);
        // $40 (no gate-off) has no doc flag: the timer is 0 then (`no-gateoff`).
        expect(ins.gateTimer, where).toBe((b[7]! & 0x40) === 0 ? b[7]! & 0x3f : 0);
        expect(ins.name, where).toBe(String.fromCharCode(...b.subarray(9, 25)).replace(/\0.*$/s, ''));
      });
      (['wave', 'pulse', 'filter', 'speed'] as const).forEach((t, k) => {
        const table = doc.tables[t];
        const { left, right } = raw.tables[k]!;
        // The stored rows, then only blank padding (`table-padded`).
        expect(table.slice(0, left.length).map((row) => row.left), `${name} ${t}`).toEqual(left);
        expect(table.slice(0, left.length).map((row) => row.right), `${name} ${t}`).toEqual(right);
        expect(table.slice(left.length).every((row) => row.left === 0 && row.right === 0), `${name} ${t} padding`).toBe(true);
      });
      doc.subsongs.forEach((sub, s) =>
        sub.orderlists.forEach((list, c) => {
          const data = raw.lists[s * 3 + c]!;
          expect(list.entries.map((e) => e.pattern), `${name} s${s} c${c}`).toEqual(data.slice(0, -2).filter((v) => v < 0xd0));
        }),
      );
      checked += 1;
    }
    expect(checked).toBe(61);
  });

  it('GTS!: every row keeps its note and instrument; every pattern its length; every orderlist its patterns', () => {
    let checked = 0;
    for (const [name, r] of imports) {
      if (r.variant !== 'GTS!') continue;
      const b = bytesOf(name);
      let p = 100;
      const subtunes = b[p++]!;
      const lists: number[][] = [];
      for (let i = 0; i < subtunes * 3; i++) {
        const n = b[p++]!;
        lists.push(Array.from(b.subarray(p, p + n + 1)));
        p += n + 1;
      }
      for (let i = 0; i < 31; i++) p += 24 + (b[p + 7]! >> 1) * 2;
      const np = b[p++]!;
      expect(r.doc.patterns, name).toHaveLength(np);
      for (let k = 0; k < np; k++) {
        const len = b[p++]!;
        const rows = r.doc.patterns[k]!.rows;
        expect(rows.length, `${name} pattern ${k}`).toBe(len / 3 - 1);
        rows.forEach((row, i) => {
          const nb = b[p + i * 3]!;
          const note = nb <= 0x5c ? nb + 1 : nb === 0x5e ? SID_NOTE_KEY_OFF : SID_NOTE_NONE;
          expect([row.note, row.instrument], `${name} p${k} r${i}`).toEqual([note, b[p + i * 3 + 1]! >> 3]);
        });
        p += len;
      }
      expect([0, 256], name).toContain(b.length - p);
      r.doc.subsongs.forEach((sub, s) =>
        sub.orderlists.forEach((list, c) => {
          expect(list.entries.map((e) => e.pattern), `${name} s${s} c${c}`).toEqual(lists[s * 3 + c]!.slice(0, -2).filter((v) => v < 0xd0));
        }),
      );
      checked += 1;
    }
    expect(checked).toBe(22);
  });

  it('every file round-trips: import -> export (GTS5) -> import is the same doc, and the writer is at a fixed point', () => {
    let equal = 0;
    for (const [name, r] of imports) {
      const hints = gtSongHintsFromName(name);
      const out = exportGtSong(r.doc);
      if (!out.ok) throw new Error(`${name}: ${out.reason}`);
      expect(String.fromCharCode(...out.bytes.subarray(0, 4))).toBe('GTS5');
      const again = importGtSong(out.bytes, hints);
      if (!again.ok) throw new Error(`${name}: ${again.reason}`);
      expect(again.doc, name).toEqual(r.doc);
      // Nothing is left to report on a file the writer made.
      expect(again.notes, name).toEqual([]);
      const twice = exportGtSong(again.doc);
      expect(twice.ok && Array.from(twice.bytes), name).toEqual(Array.from(out.bytes));
      equal += 1;
    }
    expect(equal).toBe(83);
  });

  it('the deviations the import reports, per kind and per file (the D-log list; MEASURED 2026-09-23)', () => {
    const byKind: Partial<Record<GtImportNoteKind, number>> = {};
    const filesOf: Partial<Record<GtImportNoteKind, Set<string>>> = {};
    for (const [name, r] of imports) {
      for (const n of r.notes) {
        byKind[n.kind] = (byKind[n.kind] ?? 0) + 1;
        (filesOf[n.kind] ??= new Set()).add(name);
      }
    }
    expect(byKind).toEqual({ 'table-padded': 2, 'no-gateoff': 1, 'loop-transpose': 3, 'gt1-convert': 55, 'gt1-dropped': 41 });
    expect([...filesOf['table-padded']!].sort()).toEqual(['mch/balcony_princess.sng', 'mch/in_a_rush.sng']);
    expect([...filesOf['no-gateoff']!]).toEqual(['stinsen/upsandowns.sng']);
    expect([...filesOf['loop-transpose']!]).toEqual(['stinsen/game_tune.sng']);
    // Every GTS5 file other than those four imports with nothing to report.
    const quiet = [...imports].filter(([, r]) => r.variant === 'GTS5' && r.notes.length === 0);
    expect(quiet).toHaveLength(57);
    // GTS! is a conversion: seven of the 22 GT1 files have nothing to report.
    const gt1Quiet = [...imports].filter(([, r]) => r.variant === 'GTS!' && r.notes.length === 0).map(([n]) => n);
    expect(gt1Quiet.sort()).toEqual([
      'ansgaros/metal_warrior_4_forest_encounter.sng',
      'barfington/barfington_s_nintendometal.sng',
      'cadaver/galwaytest.sng',
      'cadaver/goattracker_classical_example.sng',
      'cadaver/goattracker_drum_example.sng',
      'cadaver/metal_warrior_4_the_chosen_path.sng',
      'cadaver/nintendo_style.sng',
    ]);
    expect([...filesOf['gt1-dropped']!].sort()).toEqual([
      'aeuk/metal_warrior_4_streets.sng',
      'cadaver/goattracker_example_mw1_title.sng',
      'cadaver/tarantula.sng',
      'shinobi/wod.sng',
      'yehar/b_o_f_h_ingame_death_victory.sng',
    ]);
  });

  it('the hints a name carries: 6581 for one file, 2x for four, the defaults for the rest', () => {
    const chips = [...imports].filter(([, r]) => r.doc.chipModel === '6581').map(([n]) => n);
    expect(chips).toEqual(['stinsen/defunkt_final_fv_po_ro_6581_ffff.sng']);
    const fast = [...imports].filter(([, r]) => r.doc.speedMultiplier === 2).map(([n]) => n).sort();
    expect(fast).toEqual(['cadaver/mw_title_remix_2x_speed.sng', 'stinsen/double_rainbow_2x.sng', 'stinsen/quaralline_2x.sng', 'stinsen/space_2x.sng']);
    expect([...imports.values()].every((r) => r.doc.tempo === 6)).toBe(true);
    // The export says what the .sng cannot carry.
    const space = exportGtSong(imports.get('stinsen/space_2x.sng')!.doc);
    expect(space.ok && space.notes).toEqual([
      'the chip model (8580) is not stored in a .sng: GoatTracker takes it from its -E option',
      'the 2x speed is not stored in a .sng: play it in GoatTracker with -S2',
    ]);
  });

  it('refuses the corrupt-as-published sleepwalk.sng whole, with the reason, and never throws', () => {
    const bad = new Uint8Array(readFileSync(resolve(__dirname, 'fixtures/gt-songs-corrupt/sleepwalk.sng')));
    const r = importGtSong(bad);
    expect(r).toEqual({ ok: false, reason: 'pattern 2 is 26 bytes long, not a whole number of 3-byte rows' });
    expect('doc' in r).toBe(false);
  });

  it('refuses a valid file with one byte desynced (a pattern length one row too long)', () => {
    const b = bytesOf('mch/alien_funk.sng').slice();
    const raw = rawGts5(b);
    // The first pattern's length byte sits just before its rows.
    const at = raw.patterns[0]!.byteOffset - b.byteOffset - 1;
    b[at] = b[at]! + 1;
    const r = importGtSong(b);
    expect(r.ok).toBe(false);
  });
});
