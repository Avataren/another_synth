import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useTrackerStore } from 'src/stores/tracker-store';
import { importAhxToTrackerSong } from 'src/audio/tracker/ahx-import';
import { ahxSourceInfoOf, setCurrentAhxSource, snapshotEditorSong } from 'src/audio/tracker/ahx-source';
import { ahxExporter, hvlExporter } from 'src/audio/tracker/song-export';

/**
 * T1(C): the whole app-side path, over the demo corpus. An unedited song
 * exported from its own record must be its source file, byte for byte: the
 * overlay (slots + title) adds nothing and loses nothing. Covers the two
 * corpus names with edge whitespace (the title is only the trimmed name).
 * The 22 `.hvl` files go through the HVL exporter the same way. 21 reach past
 * track 4, so the AHX exporter refuses them; ring_modulation_test_song fits 4
 * tracks but uses the second effect column, which AHX has no room for.
 * (chiprolled.hvl was removed 2026-09-23 — byte-identical dupe, user decision.)
 */
const DEMOS = resolve(__dirname, '../../public/demos/ahx');
const corpus = readdirSync(DEMOS)
  .filter((name) => /\.(ahx|hvl)$/.test(name))
  .sort()
  .map((name) => ({ name, bytes: new Uint8Array(readFileSync(resolve(DEMOS, name))) }));

/**
 * meltwater_10ch.hvl's string table omits the final (empty) instrument name's
 * NUL terminator, so the writer canonically emits it: the export is the source
 * plus exactly one trailing NUL byte, and the parse is the same song
 * (measured 2026-09-23, curated HVL batch).
 */
const TRAILING_NAME_NUL = ['meltwater_10ch.hvl'];

/** What `applySongFile` does for an AHX/HVL song: the store gets the file, `ahx-source` the bytes. */
function openInEditor(bytes: Uint8Array) {
  const store = useTrackerStore();
  store.loadSongFile(importAhxToTrackerSong(bytes.slice().buffer));
  setCurrentAhxSource(bytes.slice(), ahxSourceInfoOf(bytes));
  return store;
}

describe('the AHX exporter over the demo corpus, through the store', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    setCurrentAhxSource(null);
  });

  it('exports every unedited .ahx song byte-identically to its source', () => {
    let checked = 0;
    const differing: string[] = [];
    for (const { name, bytes } of corpus.filter((f) => name_isAhx(f.name))) {
      const store = openInEditor(bytes);
      const song = snapshotEditorSong(store);
      expect(ahxExporter.check(song), name).toEqual({ ok: true });
      const out = ahxExporter.serialize(song);
      if (out.length !== bytes.length || out.some((v, i) => v !== bytes[i])) differing.push(name);
      checked++;
    }
    expect(differing).toEqual([]);
    // corpus-size constant — re-measure when public/demos/ahx grows (last updated at 77 .ahx files, 2026-09-22)
    expect(checked).toBe(77);
  });

  it('exports every unedited .hvl song byte-identically to its source', () => {
    let checked = 0;
    for (const { name, bytes } of corpus.filter((f) => !name_isAhx(f.name))) {
      const song = snapshotEditorSong(openInEditor(bytes));
      expect(hvlExporter.check(song), name).toEqual({ ok: true });
      if (TRAILING_NAME_NUL.includes(name)) {
        const out = hvlExporter.serialize(song);
        expect(out.length, name).toBe(bytes.length + 1);
        expect(out.subarray(0, bytes.length), name).toEqual(bytes);
        expect(out[out.length - 1], name).toBe(0);
      } else {
        expect(hvlExporter.serialize(song), name).toEqual(bytes);
      }
      checked++;
    }
    expect(checked).toBe(22);
  });

  it('refuses all 22 .hvl songs as AHX, pointing at HVL', () => {
    let checked = 0;
    for (const { name, bytes } of corpus.filter((f) => !name_isAhx(f.name))) {
      const song = snapshotEditorSong(openInEditor(bytes));
      const verdict = ahxExporter.check(song);
      expect(verdict.ok, name).toBe(false);
      if (!verdict.ok) {
        if (name === 'ring_modulation_test_song.hvl') {
          // Fits 4 tracks, so the refusal is the second effect column instead.
          expect(verdict.reason, name).toBe("This song uses a second effect column, which AHX files don't have. Export it as HVL instead.");
        } else {
          expect(verdict.reason, name).toMatch(/^AHX files have 4 tracks; this song reaches track \d+\. Export it as HVL instead\.$/);
        }
      }
      expect(() => ahxExporter.serialize(song), name).toThrow(/Export it as HVL instead/);
      checked++;
    }
    expect(checked).toBe(22);
  });

  it('keeps a song name with edge whitespace verbatim when the title is untouched', () => {
    const padded = corpus.filter((f) => name_isAhx(f.name) && rawName(f.bytes) !== rawName(f.bytes).trim());
    // The corpus has two (the title is the trimmed name, so only the base name can restore the padding).
    expect(padded.map((f) => f.name)).toEqual(['blondie.ahx', 'carpe_noctem_theme.ahx']);
    for (const { name, bytes } of padded) {
      const song = snapshotEditorSong(openInEditor(bytes));
      expect(song.data.currentSong.title, name).toBe(rawName(bytes).trim());
      const out = ahxExporter.serialize(song);
      expect(rawName(out), name).toBe(rawName(bytes));
    }
  });
});

const name_isAhx = (name: string): boolean => name.endsWith('.ahx');

/** The song name as the file stores it (first string of the table at `nameOffset`). */
function rawName(bytes: Uint8Array): string {
  let at = ((bytes[4] ?? 0) << 8) | (bytes[5] ?? 0);
  let out = '';
  while (at < bytes.length && bytes[at] !== 0) out += String.fromCharCode(bytes[at++] ?? 0);
  return out;
}
