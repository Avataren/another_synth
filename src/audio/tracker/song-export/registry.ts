import type { TrackerSongFile } from 'src/stores/tracker-store';
import { ahxExporter } from './ahx-exporter';
import { hvlExporter } from './hvl-exporter';
import { binExporter, prgExporter, sidExporter } from './sid-exporter';
import { sngExporter } from './sng-exporter';
import { SongExportError, type SongExportFormatId, type SongExporter } from './types';

export const NOT_IMPLEMENTED_REASON = 'Not available yet.';

/** A row for a format whose writer does not exist yet: listed, disabled, never called. */
function createPlaceholderExporter(
  id: SongExportFormatId,
  label: string,
  extension: string,
): SongExporter {
  return {
    id,
    label,
    extension,
    mimeType: 'application/octet-stream',
    description: '',
    available: false,
    check: () => ({ ok: false, reason: NOT_IMPLEMENTED_REASON }),
    serialize: () => {
      throw new SongExportError(`${label} export isn't available yet.`);
    },
  };
}

/** Every format the export dialog lists, in display order. The dialog reads only this. */
export const SONG_EXPORTERS: readonly SongExporter[] = [
  ahxExporter,
  hvlExporter,
  sngExporter,
  sidExporter,
  prgExporter,
  binExporter,
  createPlaceholderExporter('mod', 'ProTracker MOD', '.mod'),
  createPlaceholderExporter('xm', 'FastTracker 2 XM', '.xm'),
  createPlaceholderExporter('s3m', 'Scream Tracker 3 S3M', '.s3m'),
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
    return { state: 'unavailable', reason: `This song can't be checked for export: ${(error as Error).message}` };
  }
}
