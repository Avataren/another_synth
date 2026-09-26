import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
// Relative on purpose: the alias is mocked for other tests; this one renders on the real bytes.
import { SidPlayer, initSync } from '../../public/wasm/audio_processor.js';
import { createNewSidDoc, importGtSong, serializeSidFile, setSidRow, type SidDoc, type SidOpResult } from 'src/audio/tracker/sid-doc';
import {
  removeUnusedSidTableRows,
  sidInstrumentTableRows,
  sidReachedTableRows,
  sidRowSetsSize,
  sidUnusedTableRows,
} from 'src/audio/tracker/sid-table-rows';

/**
 * Removing the table rows nothing reaches: which rows count as reached (any
 * instrument, any pattern command, wave-table commands, jumps), and that a
 * cleaned song PLAYS exactly as before: rows are only renumbered, so the
 * real player's output must be identical sample for sample.
 */

const ROOT = resolve(__dirname, '../..');
const FIXTURES = resolve(ROOT, 'src/tests/fixtures/gt-songs');

beforeAll(() => {
  initSync({ module: new Uint8Array(readFileSync(resolve(ROOT, 'public/wasm/audio_processor_bg.wasm'))) });
});

const ok = (result: SidOpResult): SidDoc => {
  if (!result.ok) throw new Error(result.reason);
  return result.doc;
};

/** A new song with `wave` rows appended after its own two, and `speed` rows. */
function withRows(wave: { left: number; right: number }[], speed: { left: number; right: number }[] = []): SidDoc {
  const base = createNewSidDoc({});
  return { ...base, tables: { ...base.tables, wave: [...base.tables.wave, ...wave], speed } };
}

describe('which table rows are reached', () => {
  it('an instrument reaches its rows, following jumps and its wave rows\' commands', () => {
    // Wave: 1-2 the instrument's own (41 00, FF 00); 3: F2 slide on speed row 2; 4: jump back to 3.
    const doc0 = withRows([{ left: 0xf2, right: 0x02 }, { left: 0xff, right: 0x03 }], [{ left: 0, right: 1 }, { left: 0, right: 2 }]);
    const doc = { ...doc0, instruments: [{ ...doc0.instruments[0]!, wavePtr: 3 }] };
    const own = sidInstrumentTableRows(doc, 1);
    expect([...own.wave].sort()).toEqual([3, 4]);
    expect([...own.speed]).toEqual([2]);
    expect([...own.pulse]).toEqual([1, 2]);
  });

  it('a pattern command reaches rows no instrument does', () => {
    const doc = ok(setSidRow(withRows([{ left: 0x21, right: 0 }, { left: 0xff, right: 0 }]), 0, 5, { note: 0, instrument: 0, command: 0x8, param: 3 }));
    expect([...sidReachedTableRows(doc).wave].sort()).toEqual([1, 2, 3, 4]);
    expect(sidRowSetsSize(sidUnusedTableRows(doc))).toBe(0);
  });
});

describe('removing the rows nothing reaches', () => {
  it('drops them and renumbers every pointer, jump, wave command and pattern command', () => {
    // Wave rows 3-4 are orphans; rows 5-7 are a looping slide program on speed row 2 (row 1 an orphan).
    const doc0 = withRows(
      [{ left: 0x21, right: 0 }, { left: 0xff, right: 0 }, { left: 0x41, right: 0 }, { left: 0xf2, right: 0x02 }, { left: 0xff, right: 0x06 }],
      [{ left: 0x00, right: 0x10 }, { left: 0x00, right: 0x40 }],
    );
    const doc1 = { ...doc0, instruments: [...doc0.instruments, { ...doc0.instruments[0]!, wavePtr: 5 }] };
    const doc = ok(setSidRow(doc1, 0, 0, { note: 0, instrument: 0, command: 0x1, param: 2 }));
    expect(sidRowSetsSize(sidUnusedTableRows(doc))).toBe(3);
    const clean = ok(removeUnusedSidTableRows(doc));
    expect(clean.tables.wave).toEqual([
      { left: 0x41, right: 0 },
      { left: 0xff, right: 0 },
      { left: 0x41, right: 0 },
      { left: 0xf2, right: 0x01 },
      { left: 0xff, right: 0x04 },
    ]);
    expect(clean.tables.speed).toEqual([{ left: 0x00, right: 0x40 }]);
    expect(clean.instruments[1]!.wavePtr).toBe(3);
    expect(clean.patterns[0]!.rows[0]!.param).toBe(1);
    expect(sidRowSetsSize(sidUnusedTableRows(clean))).toBe(0);
  });

  it('is the same doc when there is nothing to remove', () => {
    const doc = createNewSidDoc({});
    expect(ok(removeUnusedSidTableRows(doc))).toBe(doc);
  });
});

describe('a cleaned corpus song plays exactly as before (the real player)', () => {
  const songs: string[] = [];
  for (const dir of readdirSync(FIXTURES)) {
    if (!statSync(join(FIXTURES, dir)).isDirectory()) continue;
    for (const file of readdirSync(join(FIXTURES, dir))) if (file.endsWith('.sng')) songs.push(`${dir}/${file}`);
  }
  // Every fixture is checked for reach; the ones whose tables shrink are also rendered.
  const docs = songs.map((song) => {
    const result = importGtSong(new Uint8Array(readFileSync(join(FIXTURES, song))));
    if (!result.ok) throw new Error(`${song}: ${result.reason}`);
    return { song, doc: result.doc };
  });

  function render(doc: SidDoc, seconds: number): Float32Array {
    const rate = 22050;
    const player = new SidPlayer(serializeSidFile(doc), rate);
    player.play();
    const out = new Float32Array(Math.round(seconds * rate));
    const taps = [new Float32Array(out.length), new Float32Array(out.length), new Float32Array(out.length)];
    player.render(out, taps[0]!, taps[1]!, taps[2]!);
    player.free();
    return out;
  }

  it('every corpus song cleans up and still passes the doc checks', () => {
    for (const { song, doc } of docs) {
      const clean = removeUnusedSidTableRows(doc);
      expect(clean.ok, song).toBe(true);
    }
  });

  const shrinking = docs.filter(({ doc }) => sidRowSetsSize(sidUnusedTableRows(doc)) > 0).slice(0, 12);
  it.each(shrinking.map(({ song, doc }) => [song, doc] as const))('%s: identical output for 8 s', (song, doc) => {
    const clean = ok(removeUnusedSidTableRows(doc));
    const a = render(doc, 8);
    const b = render(clean, 8);
    // Not a trivial pass: the song is heard.
    expect(a.reduce((m, x) => Math.max(m, Math.abs(x)), 0), song).toBeGreaterThan(0.01);
    let firstDiff = -1;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) {
        firstDiff = i;
        break;
      }
    }
    expect(firstDiff, song).toBe(-1);
  });

  it('the corpus has songs with unreached rows to test on', () => {
    expect(shrinking.length).toBeGreaterThan(0);
  });
});
