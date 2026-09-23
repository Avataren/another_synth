import { parseAhx, type AhxSong } from '@another-synth/tracker-playback';
import type { TrackerSongFile } from 'src/stores/tracker-store';
import { decodeAhxFile } from 'src/audio/tracker/ahx-doc';
import { authorOrBpmChanged, AUTHOR_BPM_NOTE, songNameFor, sourceRecordFor, TITLE_NOTE } from './ahx-export-shared';
import { AhxEncodeError, serializeAhx } from './ahx-writer';
import { SongExportError, type SongExportCheck, type SongExporter } from './types';

/**
 * The HVL exporter.
 *
 * An HVL song with a doc carries its file (`data.ahxFile`, plan-hvl-editing.md
 * P3), built from the doc by the one writer the engine's bytes come from
 * (`buildAhxFile`): its grid and transpose edits, its instruments and its title.
 * That is what is exported, byte for byte, as the AHX exporter does with an
 * AHX song's. An untouched song's file is its source's own bytes
 * (`serializeSong`), so it exports as the file it came from.
 *
 * A song without one (a fresh import the store has not serialized) exports its
 * source bytes: as they are when the title is the import's, else written with
 * the title as the name, `serializeAhx` with the source as `base` keeping
 * everything else byte for byte. Instruments are not edited for HVL (no slots;
 * the doc carries them), and author, BPM and the row model have no HVL home.
 */

type Plan =
  | {
      ok: true;
      /** The song's own embedded HVL file, when it carries one: the export as it is. */
      file?: Uint8Array;
      /** The source record's bytes, otherwise. */
      source?: Uint8Array;
      base: AhxSong;
    }
  | { ok: false; reason: string };

const AHX_REFUSAL = "AHX songs can't be saved as HVL.";

function plan(song: TrackerSongFile): Plan {
  // The embedded file is the authority (see the AHX exporter): it is rebuilt
  // from the live doc, so a stale record cannot beat it.
  if (song.data.ahxFile !== undefined) {
    const decoded = decodeAhxFile(song.data.ahxFile);
    if (decoded.ok) {
      if (decoded.format !== 'hvl') return { ok: false, reason: AHX_REFUSAL };
      return { ok: true, file: decoded.bytes, base: parseAhx(decoded.bytes) };
    }
    // An unusable file falls through to the record, as the load does.
  }
  const found = sourceRecordFor(song, 'HVL');
  if (!found.ok) return found;
  if (found.record.format !== 'hvl') return { ok: false, reason: AHX_REFUSAL };
  try {
    return { ok: true, source: found.record.bytes, base: parseAhx(found.record.bytes) };
  } catch (error) {
    return { ok: false, reason: `The original file can't be read: ${(error as Error).message}` };
  }
}

function check(song: TrackerSongFile): SongExportCheck {
  const planned = plan(song);
  return planned.ok ? { ok: true } : planned;
}

function warnings(song: TrackerSongFile): string[] {
  const planned = plan(song);
  if (!planned.ok) return [];
  const notes: string[] = [];
  if (songNameFor(planned.base, song.data.currentSong.title).altered) notes.push(TITLE_NOTE);
  if (authorOrBpmChanged(song)) notes.push(AUTHOR_BPM_NOTE);
  return notes;
}

function serialize(song: TrackerSongFile): Uint8Array {
  const planned = plan(song);
  if (!planned.ok) throw new SongExportError(planned.reason);
  if (planned.file) return planned.file.slice();
  const source = planned.source as Uint8Array;
  const name = songNameFor(planned.base, song.data.currentSong.title).name;
  // The title is the file's: nothing to write, so no rebuild (a rebuild can
  // differ, meltwater_10ch.hvl's trailing NUL).
  if (name === planned.base.name) return source.slice();
  try {
    return serializeAhx({ ...planned.base, name }, { base: source });
  } catch (error) {
    if (error instanceof AhxEncodeError) throw new SongExportError(error.message);
    throw error;
  }
}

export const hvlExporter: SongExporter = {
  id: 'hvl',
  label: 'HVL (Hively Tracker)',
  extension: '.hvl',
  mimeType: 'application/octet-stream',
  description: 'Saves the song as an .hvl file, with your pattern, transpose and title changes.',
  available: true,
  check,
  warnings,
  serialize,
};
