import type { TrackerSongFile } from 'src/stores/tracker-store';

/** The formats the registry has a slot for. A later batch replaces a placeholder; nothing else changes. */
export type SongExportFormatId = 'ahx' | 'hvl' | 'sng' | 'sid' | 'prg' | 'bin' | 'mod' | 'xm' | 'a2m' | 's3m';

export type SongExportCheck = { ok: true } | { ok: false; reason: string };

/** A writer refused this song. The message is written for the user. */
export class SongExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SongExportError';
  }
}

export interface SongExporter {
  id: SongExportFormatId;
  /** e.g. `AHX (Abyss' Highest eXperience)`. */
  label: string;
  /** With the dot: `.ahx`. */
  extension: string;
  mimeType: string;
  /** Whether a writer exists at all. `false`: the row is disabled and `check` and `serialize` are never used. */
  available: boolean;
  /** Can this writer export this song? Only consulted when `available`. */
  check(song: TrackerSongFile): SongExportCheck;
  /** Lines the dialog shows under an enabled row, verbatim (a caveat that holds only for this song). */
  warnings?(song: TrackerSongFile): string[];
  /**
   * Whatever the writer needs loaded before `serialize` (A2M's is the audio
   * engine's wasm). The dialog awaits it, then calls `serialize` as usual.
   */
  prepare?(): Promise<void>;
  /** The file's bytes. Throws `SongExportError` (message for the user) when it cannot. */
  serialize(song: TrackerSongFile): Uint8Array;
}
