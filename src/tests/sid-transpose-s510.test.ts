import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { exportGtSong, importGtSong, sidGridLayout, type SidDoc } from 'src/audio/tracker/sid-doc';

/**
 * S5.10: GoatTracker's orderlist REPEAT, pinned on the bytes of Streets
 * (`.ai/s5.10-bugreport-streets.txt`), the song the report is about.
 *
 * GT: `cptr->repeat = byte - REPEAT` (gplay.c:977-980), and the pattern is
 * played again while `repeat` counts down to 0 (gplay.c:983-986), so $Dk
 * plays the next pattern k + 1 times: $D0 once, $DF 16 times. The editor
 * shows it as R((k + 1) & 15) (gdisplay.c:265, R0 = 16 plays, readme §3.1).
 * The transpose bytes $E0-$FE are `byte - $F0` (gplay.c:971-974).
 *
 * The expected orderlists below are decoded in-test from the file's bytes,
 * by a walker written from those gplay.c lines, not by the importer.
 */

const STREETS = resolve(__dirname, 'fixtures/gt-songs/aeuk/metal_warrior_4_streets.sng');
const bytes = new Uint8Array(readFileSync(STREETS));

interface Entry {
  pattern: number;
  transpose: number;
  repeat: number;
}

/** Subtune 0's three raw orderlists (+100 subtunes, +101 length byte, data, restart). */
function rawOrderlists(b: Uint8Array): Uint8Array[] {
  const lists: Uint8Array[] = [];
  let at = 101;
  for (let c = 0; c < 3; c++) {
    const n = b[at]!;
    lists.push(b.subarray(at + 1, at + 2 + n));
    at += n + 2;
  }
  return lists;
}

/** GT's sequencer, first pass: transpose then repeat then a pattern (gplay.c:970-987). */
function gtWalk(data: Uint8Array): Entry[] {
  const out: Entry[] = [];
  let trans = 0;
  let k = 0;
  while (data[k] !== 0xff) {
    if (data[k]! >= 0xe0) trans = data[k++]! - 0xf0;
    let repeat = 0;
    if (data[k]! >= 0xd0 && data[k]! < 0xe0) repeat = data[k++]! - 0xd0;
    out.push({ pattern: data[k++]!, transpose: trans, repeat: repeat + 1 });
  }
  return out;
}

function imported(): SidDoc {
  const result = importGtSong(bytes);
  if (!result.ok) throw new Error(result.reason);
  return result.doc;
}

describe('S5.10: Streets orderlists decode as GoatTracker plays them', () => {
  it('is the file the bug report names (GTS!, 3 subtunes)', () => {
    expect(String.fromCharCode(...bytes.subarray(0, 4))).toBe('GTS!');
    expect(bytes[100]).toBe(3);
  });

  it('channel 2 entries 55-60 keep their transposes (the transpose decode was already right)', () => {
    const entries = imported().subsongs[0]!.orderlists[1]!.entries;
    expect(entries).toHaveLength(61);
    expect(entries.slice(55, 61)).toEqual([
      { pattern: 0x0d, transpose: 1, repeat: 1 },
      { pattern: 0x06, transpose: -4, repeat: 1 },
      { pattern: 0x0d, transpose: -1, repeat: 1 },
      { pattern: 0x0d, transpose: 1, repeat: 1 },
      { pattern: 0x0d, transpose: -2, repeat: 1 },
      { pattern: 0x05, transpose: 0, repeat: 1 },
    ]);
  });

  it('a $Dk repeat plays the pattern k + 1 times: every channel equals GT\'s walk', () => {
    const doc = imported();
    const lists = rawOrderlists(bytes);
    for (let c = 0; c < 3; c++) {
      expect(doc.subsongs[0]!.orderlists[c]!.entries, `channel ${c + 1}`).toEqual(gtWalk(lists[c]!));
    }
    // The repeats by hand: $D8 01 = 9 plays, $D5 01 = 6, $D2 19 = 3 (twice);
    // $D2 00 = 3, $D2 16 = 3; $DA 02 = 11, $D5 02 = 6.
    const repeated = (c: number) =>
      doc.subsongs[0]!.orderlists[c]!.entries.filter((e) => e.repeat > 1).map((e) => [e.pattern, e.repeat]);
    expect(repeated(0)).toEqual([[0x01, 9], [0x01, 6], [0x19, 3], [0x19, 3]]);
    expect(repeated(1)).toEqual([[0x00, 3], [0x16, 3]]);
    expect(repeated(2)).toEqual([[0x02, 11], [0x02, 6]]);
  });

  it('the +3 key change lands on all three channels on the same song row', () => {
    // Channel 1 enters its +3 run at entry 26, channel 2 at 48, channel 3 at
    // 19. Played as GT plays the repeats, all three start at row 1568; with
    // the old off-by-one they started at rows 1440, 1488 and 1504 (the
    // report's "order 81" region, where channel 1 was a minor third above
    // channel 3).
    const doc = imported();
    const layout = sidGridLayout(doc);
    const startOf = (c: number, entry: number) => {
      const list = doc.subsongs[0]!.orderlists[c]!;
      let row = 0;
      for (let i = 0; i < entry; i++) {
        const e = list.entries[i]!;
        row += doc.patterns[e.pattern]!.rows.length * e.repeat;
      }
      return row;
    };
    expect([startOf(0, 26), startOf(1, 48), startOf(2, 19)]).toEqual([1568, 1568, 1568]);
    expect(layout.total).toBe(1824);
    expect(layout.starts).toContain(1568);
  });
});

describe('S5.10: the repeat marker both ways', () => {
  it('exports repeat k as $D0 + k - 1 ($D1 = 2 plays, $DF = 16) and Streets round-trips', () => {
    const doc = imported();
    const out = exportGtSong(doc);
    if (!out.ok) throw new Error(out.reason);
    const lists = rawOrderlists(out.bytes);
    // Channel 1 of the export: +0 (restated: the loop comes back from +3),
    // then $D8 01, the source's own bytes.
    expect(Array.from(lists[0]!.subarray(0, 3))).toEqual([0xf0, 0xd8, 0x01]);
    for (let c = 0; c < 3; c++) {
      expect(gtWalk(lists[c]!), `channel ${c + 1}`).toEqual(gtWalk(rawOrderlists(bytes)[c]!));
    }
    const back = importGtSong(out.bytes);
    if (!back.ok) throw new Error(back.reason);
    expect(back.doc.subsongs).toEqual(doc.subsongs);
  });
});
