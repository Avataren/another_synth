import type { InstrumentSlot, TrackerSongFile } from 'src/stores/tracker-store';
import { CURRENT_SONG_FILE_VERSION } from 'src/stores/tracker-store';
import {
  encodeSidFile,
  gtSongHintsFromName,
  importGtSong,
  looksLikeGtSong,
  projectSidPatterns,
  sidDocTiming,
  type SidDoc,
} from 'src/audio/tracker/sid-doc';

/**
 * Assembly only, like the other `*-import.ts` files: a GoatTracker `.sng`
 * (plan-sid-tracking.md S5; the parser is `sid-doc/gt-sng-read.ts`) becomes
 * a SID song file. Its authority is `data.sidFile`, the doc as the S3 codec
 * writes it: `loadSongFile` -> `adoptSidFile` rebuilds the doc, the grid, the
 * slots and the tempo from it, exactly as for a saved `.cmod` SID song, so an
 * imported song is edited and played through the one SID path there is. The
 * grid and slots written beside it are the same projection, for a reader
 * that looks before loading.
 *
 * The file name is a hint only (`gtSongHintsFromName`: a `6581`/`8580` or
 * `2x` token): a `.sng` does not store the chip model or the speed multiplier.
 */
export const looksLikeGtSongFile = looksLikeGtSong;

/** The doc's instruments as name-only slots, the way the store lists a SID song's (`showSidDoc`). */
function sidSlots(doc: SidDoc): InstrumentSlot[] {
  return doc.instruments.map((ins, i) => ({
    slot: i + 1,
    bankName: '',
    patchName: '',
    instrumentName: ins.name,
    instrumentFormat: 'sid' as const,
  }));
}

/** `name` without its directories and extension, URL-decoded when it is encoded. */
function fileTitle(name: string): string {
  let decoded = name;
  try {
    decoded = decodeURIComponent(name);
  } catch {
    // Not URL-encoded after all.
  }
  return decoded.replace(/^.*[\\/]/, '').replace(/\.sng$/i, '').trim();
}

/** The song file of a `.sng`. Throws, with the true reason, for bytes that are not an importable one. */
export function importGtSongToTrackerSong(buffer: ArrayBuffer, name = ''): TrackerSongFile {
  const imported = importGtSong(new Uint8Array(buffer), gtSongHintsFromName(name));
  if (!imported.ok) throw new Error(`Cannot import this GoatTracker song: ${imported.reason}.`);
  const doc = imported.doc;
  const patterns = projectSidPatterns(doc);
  const sequence = patterns.map((pattern) => pattern.id);
  const timing = sidDocTiming(doc);
  return {
    version: CURRENT_SONG_FILE_VERSION,
    data: {
      currentSong: {
        // GoatTracker 1 songs mostly leave the title empty: the file name is it then.
        title: doc.songName.trim() || fileTitle(name) || 'Untitled SID song',
        author: doc.author.trim() || 'Unknown',
        bpm: timing.bpm,
      },
      moduleFormat: 'sid',
      initialSpeed: timing.initialSpeed,
      patternRows: patterns[0]?.rows ?? 64,
      stepSize: 1,
      patterns,
      sequence,
      currentPatternId: sequence[0] ?? null,
      instrumentSlots: sidSlots(doc),
      activeInstrumentId: null,
      currentInstrumentPage: 0,
      songPatches: {},
      sidFile: encodeSidFile(doc),
    },
  };
}
