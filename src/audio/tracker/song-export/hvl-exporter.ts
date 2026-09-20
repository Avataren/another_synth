import { parseAhx, type AhxSong } from '@another-synth/tracker-playback';
import type { TrackerSongFile } from 'src/stores/tracker-store';
import type { AhxSource } from 'src/audio/tracker/ahx-source';
import { authorOrBpmChanged, AUTHOR_BPM_NOTE, songNameFor, sourceRecordFor, TITLE_NOTE } from './ahx-export-shared';
import { AhxEncodeError, serializeAhx } from './ahx-writer';
import { SongExportError, type SongExportCheck, type SongExporter } from './types';

/**
 * The HVL exporter: the file the song was imported from, written back.
 *
 * `serializeAhx` with the source bytes as `base` reproduces an HVL file byte
 * for byte, so an unedited song exports as the file it came from. Of what the
 * editor can change, only the title reaches an HVL file: an HVL song has no
 * instrument slots in the store (`importAhxToTrackerSong` leaves them empty and
 * `updateAhxInstrument` rejects an edit without one), so there is no
 * instrument edit to write, and none is invented. Author, BPM and the row model
 * have no HVL home.
 */

function plan(song: TrackerSongFile): { ok: true; source: AhxSource; base: AhxSong } | { ok: false; reason: string } {
  const found = sourceRecordFor(song, 'HVL');
  if (!found.ok) return found;
  if (found.record.format !== 'hvl') return { ok: false, reason: "AHX songs can't be saved as HVL." };
  try {
    return { ok: true, source: found.record, base: parseAhx(found.record.bytes) };
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
  const named: AhxSong = { ...planned.base, name: songNameFor(planned.base, song.data.currentSong.title).name };
  try {
    return serializeAhx(named, { base: planned.source.bytes });
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
  description: 'Saves the song as an .hvl file, with your title change.',
  available: true,
  check,
  warnings,
  serialize,
};
