import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { gtSongHintsFromName, importGtSong } from 'src/audio/tracker/sid-doc';
import { exportSid, GT_PACK_DEFAULTS } from 'src/audio/tracker/sid-export';
import { parsePsid, transcribePsid } from 'src/audio/tracker/psid';
import { measureFidelity } from 'src/audio/tracker/psid/fidelity';

/**
 * The transcriber against songs whose answer is known: a GoatTracker corpus
 * song exported to `.sid` and transcribed (not unpacked: `importPsid` would
 * read GoatTracker's own data back exactly), then compared with the original
 * (.ai/sid-roundtrip-findings.md, .ai/sid-oracle/transcribe_batch.ts). The
 * floors sit just under what it reaches today; the ceilings on instruments
 * are what the sharing of pulse programs, the silent test-bit frames and
 * the absolute-note drums and the test-frame row start (`RowGrid.lead` 0) bought (the originals have 9-22).
 */

const CORPUS = resolve(__dirname, '../../public/songs/goattracker');

const SONGS: readonly (readonly [string, number, number])[] = [
  ['stinsen/shadow.sng', 0.83, 43],
  ['stinsen/ballad.sng', 0.82, 16],
  ['stinsen/premonition_fv_po_ro_ffff.sng', 0.92, 50],
  ['mch/hybrid_song.sng', 0.90, 22],
];

describe('a GoatTracker song, exported to .sid and transcribed', () => {
  it.each(SONGS)('%s plays at least %f like the original on at most %i instruments', (name, floor, most) => {
    const path = resolve(CORPUS, name);
    const song = importGtSong(new Uint8Array(readFileSync(path)), gtSongHintsFromName(path));
    if (!song.ok) throw new Error(song.reason);
    const exported = exportSid(song.doc, GT_PACK_DEFAULTS);
    if (!exported.ok) throw new Error(exported.reason);
    const parsed = parsePsid(exported.bytes);
    if (!parsed.ok) throw new Error(parsed.reason);
    const t = transcribePsid(parsed.file, { subsongs: [0] });
    if (!t.ok) throw new Error(t.reason);
    const fidelity = measureFidelity(t.reports[0]!.trace!, t.doc, 0, 3000);
    if (typeof fidelity === 'string') throw new Error(fidelity);
    expect(fidelity.score).toBeGreaterThanOrEqual(floor);
    expect(t.doc.instruments.length).toBeLessThanOrEqual(most);
  });
});
