import {
  ahxInstrumentProblem,
  parseAhx,
  type AhxInstrument,
  type AhxSong,
} from '@another-synth/tracker-playback';
import type { TrackerSongFile } from 'src/stores/tracker-store';
import type { AhxSource } from 'src/audio/tracker/ahx-source';
import {
  authorOrBpmChanged,
  AUTHOR_BPM_NOTE,
  INSTRUMENT_NAME_NOTE,
  songNameFor,
  sourceRecordFor,
  TITLE_NOTE,
  toLatin1,
} from './ahx-export-shared';
import { AhxEncodeError, serializeAhx } from './ahx-writer';
import { convertHvlToAhx, HVL_MIX_NOTE } from './hvl-to-ahx';
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
 *
 * An HVL song is exported as AHX only when it fits (`convertHvlToAhx`); it has
 * no instrument slots in the store, so only its title is overlaid.
 */

/** What the exporter works from: the parsed source, and the AHX song it becomes. */
type Plan =
  | { ok: true; source: AhxSource; base: AhxSong; ahx: AhxSong; converted: boolean }
  | { ok: false; reason: string };

function plan(song: TrackerSongFile): Plan {
  const found = sourceRecordFor(song, 'AHX');
  if (!found.ok) return found;
  const source = found.record;
  let base: AhxSong;
  try {
    base = parseAhx(source.bytes);
  } catch (error) {
    return { ok: false, reason: `The original file can't be read: ${(error as Error).message}` };
  }
  if (source.format === 'ahx') return { ok: true, source, base, ahx: base, converted: false };
  const converted = convertHvlToAhx(base);
  return converted.ok ? { ok: true, source, base, ahx: converted.song, converted: true } : converted;
}

function withStoreEdits(base: AhxSong, song: TrackerSongFile, instrumentEdits: boolean): AhxSong {
  const name = songNameFor(base, song.data.currentSong.title).name;
  if (!instrumentEdits) return { ...base, name };
  const slots = song.data.instrumentSlots;
  const instruments: AhxInstrument[] = [...base.instruments];
  for (let n = 1; n <= base.instrumentNr; n++) {
    const data = slots[n - 1]?.ahxData;
    if (data === undefined) throw new SongExportError(`Instrument ${n} is missing from the song.`);
    const problem = ahxInstrumentProblem(data, 'ahx');
    if (problem !== null) throw new SongExportError(`Instrument ${n} can't be saved: ${problem}.`);
    instruments[n] = { ...data, name: toLatin1(data.name).text };
  }
  return { ...base, instruments, name };
}

function check(song: TrackerSongFile): SongExportCheck {
  const planned = plan(song);
  return planned.ok ? { ok: true } : planned;
}

function warnings(song: TrackerSongFile): string[] {
  const planned = plan(song);
  if (!planned.ok) return [];
  const { base } = planned;
  const notes: string[] = [];
  if (songNameFor(base, song.data.currentSong.title).altered) notes.push(TITLE_NOTE);
  const slots = song.data.instrumentSlots;
  const renamed = Array.from({ length: base.instrumentNr }, (_, i) => slots[i]?.ahxData?.name).some(
    (name) => name !== undefined && toLatin1(name).altered,
  );
  if (renamed) notes.push(INSTRUMENT_NAME_NOTE);
  if (authorOrBpmChanged(song)) notes.push(AUTHOR_BPM_NOTE);
  if (planned.converted) notes.push(HVL_MIX_NOTE);
  return notes;
}

function serialize(song: TrackerSongFile): Uint8Array {
  const planned = plan(song);
  if (!planned.ok) throw new SongExportError(planned.reason);
  const merged = withStoreEdits(planned.ahx, song, !planned.converted);
  try {
    // A converted song has no AHX base to copy from; the writer works from the model alone.
    return serializeAhx(merged, planned.converted ? {} : { base: planned.source.bytes });
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
  description: 'Saves the song as an .ahx file, with your instrument and title changes.',
  available: true,
  check,
  warnings,
  serialize,
};
