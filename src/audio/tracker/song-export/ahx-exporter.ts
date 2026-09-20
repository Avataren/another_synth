import {
  ahxInstrumentProblem,
  parseAhx,
  type AhxInstrument,
  type AhxSong,
  type ModuleFormat,
} from '@another-synth/tracker-playback';
import type { TrackerSongFile } from 'src/stores/tracker-store';
import { ahxSourceRecordOf, type AhxSource } from 'src/audio/tracker/ahx-source';
import { AhxEncodeError, serializeAhx } from './ahx-writer';
import { SongExportError, type SongExportCheck, type SongExporter } from './types';

/**
 * The AHX exporter: an overlay, not a serialization of the store.
 *
 * The store's row model of an AHX song is display only (no track table, no
 * transposes, latched instruments), so the file's structure comes from the
 * bytes the song was imported from (`ahx-source`), and what the editor can
 * change comes from the store: the instruments (`slot.ahxData`) and the title.
 * That is what plays, so it is what the export holds. Author, BPM and the row
 * model have no AHX home and are never written.
 */

/** What the import calls a song whose file has no name (`importAhxToTrackerSong`). */
const IMPORT_FALLBACK_TITLE = 'Imported AHX';

const NO_SOURCE_REASON =
  'This AHX song has no source file (it was loaded from a saved file), so it cannot be exported.';
const HVL_REASON = 'HVL (.hvl) songs are not exported yet: only .ahx songs.';
const TITLE_NOTE =
  "Some characters in the title can't be stored in an AHX file and are replaced or removed.";
const INSTRUMENT_NAME_NOTE =
  "Some characters in an instrument name can't be stored in an AHX file and are replaced or removed.";

const FORMAT_NAMES: Partial<Record<ModuleFormat, string>> = {
  protracker: 'a MOD',
  xm: 'an XM',
  s3m: 'an S3M',
};

/** The song's source record when it is exportable as `.ahx`, else why not. */
function sourceOf(song: TrackerSongFile): { ok: true; record: AhxSource } | { ok: false; reason: string } {
  const format = song.data.moduleFormat;
  if (format !== 'ahx') {
    const name = format === undefined || format === 'native' ? undefined : (FORMAT_NAMES[format] ?? 'a non-AHX');
    const what = name === undefined ? 'This song was made in the editor' : `This song is ${name} song`;
    return { ok: false, reason: `${what}, not an AHX song: converting between formats isn't supported.` };
  }
  const record = ahxSourceRecordOf(song);
  if (!record) return { ok: false, reason: NO_SOURCE_REASON };
  if (record.format !== 'ahx') return { ok: false, reason: HVL_REASON };
  return { ok: true, record };
}

/**
 * The song name to write. The title is the import's own derivation of the
 * file's name (trimmed, with a fallback), so a title that still equals it means
 * the user did not touch it and the file's name stays as it was (edge
 * whitespace included). A changed title is written with the characters the
 * format cannot hold (NUL, anything above U+00FF) removed or replaced by `?`.
 */
function songNameFor(base: AhxSong, title: string): { name: string; altered: boolean } {
  if (title === (base.name.trim() || IMPORT_FALLBACK_TITLE)) return { name: base.name, altered: false };
  const { text, altered } = toLatin1(title);
  return { name: text, altered };
}

/** `text` as the format can hold it: NUL removed, anything above U+00FF replaced by `?`. */
function toLatin1(text: string): { text: string; altered: boolean } {
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

function withStoreEdits(base: AhxSong, song: TrackerSongFile): AhxSong {
  const slots = song.data.instrumentSlots;
  const instruments: AhxInstrument[] = [...base.instruments];
  for (let n = 1; n <= base.instrumentNr; n++) {
    const data = slots[n - 1]?.ahxData;
    if (data === undefined) {
      throw new SongExportError(`Instrument ${n} is missing from the song, so it cannot be exported.`);
    }
    const problem = ahxInstrumentProblem(data, 'ahx');
    if (problem !== null) throw new SongExportError(`Instrument ${n} cannot be written to an AHX file: ${problem}.`);
    instruments[n] = { ...data, name: toLatin1(data.name).text };
  }
  return { ...base, instruments, name: songNameFor(base, song.data.currentSong.title).name };
}

function check(song: TrackerSongFile): SongExportCheck {
  const source = sourceOf(song);
  return source.ok ? { ok: true } : source;
}

function warnings(song: TrackerSongFile): string[] {
  const source = sourceOf(song);
  if (!source.ok) return [];
  let base: AhxSong;
  try {
    base = parseAhx(source.record.bytes);
  } catch {
    return [];
  }
  const notes: string[] = [];
  if (songNameFor(base, song.data.currentSong.title).altered) notes.push(TITLE_NOTE);
  const slots = song.data.instrumentSlots;
  const renamed = Array.from({ length: base.instrumentNr }, (_, i) => slots[i]?.ahxData?.name).some(
    (name) => name !== undefined && toLatin1(name).altered,
  );
  if (renamed) notes.push(INSTRUMENT_NAME_NOTE);
  return notes;
}

function serialize(song: TrackerSongFile): Uint8Array {
  const source = sourceOf(song);
  if (!source.ok) throw new SongExportError(source.reason);
  const { bytes } = source.record;
  let base: AhxSong;
  try {
    base = parseAhx(bytes);
  } catch (error) {
    throw new SongExportError(`The song's source file could not be read: ${(error as Error).message}`);
  }
  const merged = withStoreEdits(base, song);
  try {
    return serializeAhx(merged, { base: bytes });
  } catch (error) {
    if (error instanceof AhxEncodeError) throw new SongExportError(error.message);
    throw error;
  }
}

export const ahxExporter: SongExporter = {
  id: 'ahx',
  label: "AHX (Abyss' Highest eXperience)",
  extension: '.ahx',
  mimeType: 'application/octet-stream',
  description:
    'Writes the song as an .ahx file: the patterns of the loaded file plus your instrument edits. ' +
    'Changing the song title renames the song inside the file. The Author and BPM fields have no place in an AHX file ' +
    '(it has its own speed multiplier, and tempo is set by effects), so they are not saved.',
  available: true,
  check,
  warnings,
  serialize,
};
