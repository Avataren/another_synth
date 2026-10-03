import type { TrackerSongFile } from 'src/stores/tracker-store';
import {
  a2mBytesFromSongSync,
  ensureA2mCodec,
  a2mText,
  a2mTextBytes,
  type A2mDoc,
  type A2mSongJson,
} from 'src/audio/tracker/a2m-codec';
import { A2mCompileError, compileA2mSong, type A2mCompileNotes } from 'src/audio/tracker/a2m-grid';
import { SongExportError, type SongExportCheck, type SongExporter } from './types';

/**
 * The Adlib Tracker II `.a2m` exporter.
 *
 * The song is its doc (instruments, macros, order list, tempo, flags) and its
 * grid; `compileA2mSong` joins them and the Rust writer (`a2m_from_json`)
 * makes the file. An imported module comes out as it was read: the corpus
 * round trip parses every file's rewrite back to the same song, and AdPlug
 * plays the rewrite register for register as it plays the original. What the
 * writer does differently is its packing: it writes valid aPLib (v9-11) and
 * LZH (v12-14) streams that are not byte-identical to AT2's own, and a
 * version 1 or 5 module (SIXPACK) as the uncompressed v4 or v8 it is a
 * layout twin of.
 */

/** Titles the importer shows for a module that has none. */
const PLACEHOLDER_TITLES = new Set(['Untitled A2M module', 'Untitled module']);
const PLACEHOLDER_AUTHORS = new Set(['Unknown', '']);

/** The song's name bytes: the title as edited, or the doc's own when the title is only a placeholder for it. */
function nameBytes(text: string, original: number[], placeholders: Set<string>): number[] {
  const trimmed = text.trim();
  if (trimmed === a2mText(original).trim()) return original;
  if (a2mText(original).trim() === '' && placeholders.has(trimmed)) return original;
  return a2mTextBytes(trimmed, 42);
}

function docOf(song: TrackerSongFile): A2mDoc | undefined {
  return song.data.moduleFormat === 'a2m' ? song.data.a2mDoc : undefined;
}

interface Plan {
  module: A2mSongJson;
  notes: A2mCompileNotes;
}

function plan(song: TrackerSongFile): Plan | { error: string } {
  const doc = docOf(song);
  if (!doc) return { error: 'Only an Adlib Tracker II song can be saved as an .a2m.' };
  const notes: A2mCompileNotes = { notesOutOfRange: 0 };
  try {
    const named: A2mDoc = {
      ...doc,
      name: nameBytes(song.data.currentSong.title, doc.name, PLACEHOLDER_TITLES),
      composer: nameBytes(song.data.currentSong.author, doc.composer, PLACEHOLDER_AUTHORS),
    };
    return {
      module: compileA2mSong(named, song.data.patterns, song.data.sequence, notes),
      notes,
    };
  } catch (error) {
    if (error instanceof A2mCompileError) return { error: error.message };
    throw error;
  }
}

function check(song: TrackerSongFile): SongExportCheck {
  const result = plan(song);
  return 'error' in result ? { ok: false, reason: result.error } : { ok: true };
}

function warnings(song: TrackerSongFile): string[] {
  const result = plan(song);
  if ('error' in result) return [];
  const out: string[] = [];
  if (result.notes.notesOutOfRange > 0) {
    out.push(`${result.notes.notesOutOfRange} notes outside C-0..B-7 were left out: an .a2m can't hold them.`);
  }
  const version = result.module.version;
  if (version === 1 || version === 5) {
    out.push(`A version ${version} module is saved uncompressed, as version ${version === 1 ? 4 : 8}.`);
  }
  return out;
}

function serialize(song: TrackerSongFile): Uint8Array {
  const result = plan(song);
  if ('error' in result) throw new SongExportError(result.error);
  try {
    return a2mBytesFromSongSync(result.module);
  } catch (error) {
    throw new SongExportError(error instanceof Error ? error.message : String(error));
  }
}

export const a2mExporter: SongExporter = {
  id: 'a2m',
  label: 'Adlib Tracker II module',
  extension: '.a2m',
  mimeType: 'application/octet-stream',
  available: true,
  prepare: ensureA2mCodec,
  check,
  warnings,
  serialize,
};
