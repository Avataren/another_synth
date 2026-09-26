import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { flattenSidDoc, importGtSong, type SidDoc } from 'src/audio/tracker/sid-doc';
import { SidSongTransport, type SidSongTransportDeps } from 'src/audio/tracker/sid-song-transport';

/**
 * The SID playhead past the song's end: the player counts rows on (each voice
 * loops its orderlist from its restart), and the grid must follow it into the
 * loop, not back to the top. attitude_14 loops every voice to orderlist entry
 * 3, 144 rows in: row 1104 (the end) is played as row 144.
 */

function transportFor(doc: SidDoc): SidSongTransport {
  const flat = flattenSidDoc(doc);
  const subsong = flat[0]!;
  const trackerStore = {
    sidDoc: doc,
    sidSubsong: 0,
    sidFlat: flat,
    sequence: [...subsong.sequence],
    patterns: subsong.sequence.map((id) => ({ id, rows: subsong.patterns[id]!.rows })),
    syncSidWriteBack: () => false,
  };
  return new SidSongTransport({ trackerStore } as unknown as SidSongTransportDeps);
}

function load(path: string): SidDoc {
  const result = importGtSong(new Uint8Array(readFileSync(resolve(__dirname, '../..', path))));
  if (!result.ok) throw new Error(result.reason);
  return result.doc;
}

describe('SID playhead: past the end it follows the loop', () => {
  const transport = transportFor(load('src/tests/fixtures/gt-songs/mch/attitude_14.sng'));
  const starts = [0, 64, 128, 144];

  it('shows the first pass as it is', () => {
    expect(transport.placeOf(0)).toEqual({ position: 0, row: 0 });
    expect(transport.placeOf(130)).toEqual({ position: 2, row: 2 });
    expect(transport.placeOf(1103)).toEqual({ position: 22, row: 47 });
  });

  it('wraps to the restart (entry 3, row 144), not to the top', () => {
    expect(starts[3]).toBe(144);
    expect(transport.placeOf(1104)).toEqual({ position: 3, row: 0 });
    expect(transport.placeOf(1104 + 50)).toEqual({ position: 4, row: 2 });
    // A second time round: the loop is 1104 - 144 = 960 rows.
    expect(transport.placeOf(1104 + 960)).toEqual({ position: 3, row: 0 });
  });
});
