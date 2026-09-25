import type { TrackerSongFile } from 'src/stores/tracker-store';
import { decodeSidFile, exportGtSong, setSidSongTexts, SID_MAX_TEXT_LENGTH, type SidDoc } from 'src/audio/tracker/sid-doc';
import { toLatin1 } from './ahx-export-shared';
import { SongExportError, type SongExportCheck, type SongExporter } from './types';

/**
 * The GoatTracker 2 `.sng` exporter (plan-sid-authoring.md phase 1).
 *
 * A SID song's snapshot carries its doc (`data.sidFile`, encoded from the live
 * doc when the song is serialized), and the doc is the song: orderlists,
 * patterns, instruments, tables and texts. `exportGtSong` writes it.
 *
 * The store's title and author are what `adoptSidDoc` derived from the doc's
 * texts (trimmed, with a fallback). One that no longer equals that derivation
 * was edited, and is written into the doc's text field: latin-1, at most
 * GoatTracker's 32 characters. (A song imported with an empty name shows its
 * file name as its title, so that is written as its name.)
 */

export const SNG_TEXT_NOTE =
  "The title or author has characters a .sng can't hold (more than 32, or outside latin-1); they are replaced or removed.";

/** What `adoptSidDoc` shows for a doc text that is empty. */
const IMPORT_TITLE = 'Untitled SID song';
const IMPORT_AUTHOR = 'Unknown';

const FORMAT_NAMES: Partial<Record<string, string>> = {
  // HVL songs are `ahx` songs too.
  ahx: 'AHX and HVL',
  protracker: 'MOD',
  xm: 'XM',
  s3m: 'S3M',
};

/** A SID song's doc as the exporters write it, or why the song has none. */
export type SidExportPlan = { ok: true; doc: SidDoc; altered: boolean } | { ok: false; reason: string };

/** `edited` as a doc text, or `original` when the store still shows the import's derivation of it. */
function textFor(original: string, edited: string, fallback: string): { text: string; altered: boolean } {
  if (edited === (original.trim() || fallback)) return { text: original, altered: false };
  const latin = toLatin1(edited);
  const text = latin.text.slice(0, SID_MAX_TEXT_LENGTH);
  return { text, altered: latin.altered || text.length < latin.text.length };
}

/**
 * The doc a SID song's snapshot carries, with the store's title and author
 * written into it when they were edited (`altered`: shortened or re-encoded
 * to fit). `as` finishes the refusal for other formats ("saved as ...").
 * Shared by the `.sng` and `.sid` exporters.
 */
export function planSidExport(song: TrackerSongFile, as = 'saved as GoatTracker .sng'): SidExportPlan {
  const format = song.data.moduleFormat;
  if (format !== 'sid') {
    if (format === undefined || format === 'native') {
      return { ok: false, reason: "Songs made from scratch can't be exported yet." };
    }
    const name = FORMAT_NAMES[format];
    return { ok: false, reason: `${name ? `${name} songs` : 'This song'} can't be ${as}.` };
  }
  if (song.data.sidFile === undefined) return { ok: false, reason: 'This song has no SID song data to export.' };
  const decoded = decodeSidFile(song.data.sidFile);
  if (!decoded.ok) return { ok: false, reason: `This song's SID data can't be read: ${decoded.reason}.` };
  const { title, author } = song.data.currentSong;
  const name = textFor(decoded.doc.songName, title, IMPORT_TITLE);
  const by = textFor(decoded.doc.author, author, IMPORT_AUTHOR);
  const texts = setSidSongTexts(decoded.doc, { songName: name.text, author: by.text });
  if (!texts.ok) return texts;
  return { ok: true, doc: texts.doc, altered: name.altered || by.altered };
}

/** Capitalized, with a full stop: the writer's reasons and notes are clauses. */
export const sentence = (clause: string): string => `${clause.charAt(0).toUpperCase()}${clause.slice(1)}.`;

function check(song: TrackerSongFile): SongExportCheck {
  const planned = planSidExport(song);
  if (!planned.ok) return planned;
  const written = exportGtSong(planned.doc);
  return written.ok ? { ok: true } : { ok: false, reason: `This song can't be saved as a .sng: ${written.reason}.` };
}

function warnings(song: TrackerSongFile): string[] {
  const planned = planSidExport(song);
  if (!planned.ok) return [];
  const written = exportGtSong(planned.doc);
  if (!written.ok) return [];
  return [...(planned.altered ? [SNG_TEXT_NOTE] : []), ...written.notes.map(sentence)];
}

function serialize(song: TrackerSongFile): Uint8Array {
  const planned = planSidExport(song);
  if (!planned.ok) throw new SongExportError(planned.reason);
  const written = exportGtSong(planned.doc);
  if (!written.ok) throw new SongExportError(`This song can't be saved as a .sng: ${written.reason}.`);
  return written.bytes;
}

export const sngExporter: SongExporter = {
  id: 'sng',
  label: 'GoatTracker 2 song',
  extension: '.sng',
  mimeType: 'application/octet-stream',
  description: 'Saves the song as a GoatTracker 2 .sng file, with all your edits.',
  available: true,
  check,
  warnings,
  serialize,
};
