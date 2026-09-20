import type { TrackerSongFile } from 'src/stores/tracker-store';
import { ahxExporter } from './ahx-exporter';
import { SongExportError, type SongExportFormatId, type SongExporter } from './types';

export const NOT_IMPLEMENTED_REASON = 'Writer not implemented yet';

/** A row for a format whose writer does not exist yet: listed, disabled, never called. */
function createPlaceholderExporter(
  id: SongExportFormatId,
  label: string,
  extension: string,
  description: string,
): SongExporter {
  return {
    id,
    label,
    extension,
    mimeType: 'application/octet-stream',
    description,
    available: false,
    check: () => ({ ok: false, reason: NOT_IMPLEMENTED_REASON }),
    serialize: () => {
      throw new SongExportError(`${label} writer not implemented yet`);
    },
  };
}

/** Every format the export dialog lists, in display order. The dialog reads only this. */
export const SONG_EXPORTERS: readonly SongExporter[] = [
  ahxExporter,
  createPlaceholderExporter('mod', 'ProTracker MOD', '.mod', 'A ProTracker module file.'),
  createPlaceholderExporter('xm', 'FastTracker 2 XM', '.xm', 'A FastTracker 2 extended module file.'),
  createPlaceholderExporter('s3m', 'Scream Tracker 3 S3M', '.s3m', 'A Scream Tracker 3 module file.'),
];

export function getSongExporter(id: SongExportFormatId): SongExporter | undefined {
  return SONG_EXPORTERS.find((exporter) => exporter.id === id);
}

export interface SongExporterState {
  state: 'enabled' | 'not-implemented' | 'unavailable';
  /** Set unless `enabled`. */
  reason?: string;
}

/** What the dialog shows for a row: the one place a row's state is decided. */
export function describeSongExporter(exporter: SongExporter, song: TrackerSongFile): SongExporterState {
  if (!exporter.available) return { state: 'not-implemented', reason: NOT_IMPLEMENTED_REASON };
  try {
    const verdict = exporter.check(song);
    return verdict.ok ? { state: 'enabled' } : { state: 'unavailable', reason: verdict.reason };
  } catch (error) {
    return { state: 'unavailable', reason: `This song cannot be checked for export: ${(error as Error).message}` };
  }
}
