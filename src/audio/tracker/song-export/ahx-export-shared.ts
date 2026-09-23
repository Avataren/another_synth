import type { AhxSong, ModuleFormat } from '@another-synth/tracker-playback';
import type { TrackerSongFile } from 'src/stores/tracker-store';
import { ahxSourceRecordOf, type AhxSource } from 'src/audio/tracker/ahx-source';
import { importFallbackTitle } from 'src/audio/tracker/ahx-doc/build-file';

/**
 * What the AHX and HVL exporters have in common: finding the source bytes of a
 * song, and the two edits the store can make to either kind (the title, and for
 * an AHX song its instruments).
 */

export const TITLE_NOTE = "Some characters in the title can't be saved and are replaced or removed.";
export const INSTRUMENT_NAME_NOTE = "Some characters in an instrument name can't be saved and are replaced or removed.";
export const AUTHOR_BPM_NOTE = "Author and BPM changes aren't saved.";

/** What `importAhxToTrackerSong` sets for a song whose file has no author or tempo. */
const IMPORT_AUTHOR = 'Unknown';
const IMPORT_BPM = 125;

const FORMAT_NAMES: Partial<Record<ModuleFormat, string>> = {
  protracker: 'MOD',
  xm: 'XM',
  s3m: 'S3M',
};

export type SourceLookup = { ok: true; record: AhxSource } | { ok: false; reason: string };

/**
 * The song's source record when it came from an AHX or HVL file (either format:
 * the caller decides which it wants), else why not. `target` names the file
 * type the caller writes, for the refusal.
 */
export function sourceRecordFor(song: TrackerSongFile, target: 'AHX' | 'HVL'): SourceLookup {
  const format = song.data.moduleFormat;
  if (format !== 'ahx') {
    if (format === undefined || format === 'native') {
      return { ok: false, reason: "Songs made from scratch can't be exported yet." };
    }
    const name = FORMAT_NAMES[format];
    return { ok: false, reason: `${name ? `${name} songs` : 'This song'} can't be saved as ${target}.` };
  }
  const record = ahxSourceRecordOf(song);
  if (!record) return { ok: false, reason: 'This song has no original file to export from.' };
  return { ok: true, record };
}

/**
 * The song name to write. The title is the import's own derivation of the
 * file's name (trimmed, with a fallback), so a title that still equals it means
 * the user did not touch it and the file's name stays as it was (edge
 * whitespace included). A changed title is written with the characters the
 * format cannot hold (NUL, anything above U+00FF) removed or replaced by `?`.
 */
export function songNameFor(base: AhxSong, title: string): { name: string; altered: boolean } {
  if (title === (base.name.trim() || importFallbackTitle(base.format))) return { name: base.name, altered: false };
  const { text, altered } = toLatin1(title);
  return { name: text, altered };
}

/** `text` as the format can hold it: NUL removed, anything above U+00FF replaced by `?`. */
export function toLatin1(text: string): { text: string; altered: boolean } {
  let out = '';
  let altered = false;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code === 0) altered = true;
    else if (code > 0xff) {
      out += '?';
      altered = true;
    } else out += char;
  }
  return { text: out, altered };
}

/** Whether the author or BPM was changed since the import: neither has a place in the file. */
export function authorOrBpmChanged(song: TrackerSongFile): boolean {
  const { author, bpm } = song.data.currentSong;
  return author !== IMPORT_AUTHOR || bpm !== IMPORT_BPM;
}
