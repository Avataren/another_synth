/**
 * The tracker row model: what a pattern is made of before it becomes a
 * `PlaybackSong`.
 *
 * This is the model the importers emit and the pattern editor edits, and it
 * is deliberately the library's own rather than the app's. A `Step` (see
 * ./types) carries a *decoded* `EffectCommand`; a `TrackerEntryData` carries
 * the raw, format-native `effectCommand`/`effectParam` bytes that are the
 * source of truth for an imported row. A `PlaybackSong` therefore cannot
 * round-trip back to rows, so an importer that emitted only `PlaybackSong`
 * would leave a host unable to display or re-export what it loaded.
 */

export interface TrackerEntryData {
  row: number;
  note?: string;
  instrument?: string;
  volume?: string;
  macro?: string;
  /** Optional second effect/macro column for the tracker row */
  macro2?: string;
  /**
   * FastTracker 2 volume-column command, as the raw XM byte in hex (0x60-0xFF).
   *
   * Separate from `volume`, which is this tracker's own 00-FF velocity and is
   * what XM's 0x10-0x50 "set volume" range imports to. From 0x60 up the XM
   * volume column holds *commands* (slides, panning, vibrato, tone portamento)
   * that have no velocity meaning, so they need somewhere of their own rather
   * than an overloaded volume byte or a second effect column that a song may
   * already be using.
   */
  volumeCommand?: string;
  /**
   * True when this row's velocity came from an XM volume-column set-volume
   * command (0x10-0x50) rather than the sample's default volume.
   *
   * FT2 runs Rxy's tick-0 retrigger count through the volume column *after*
   * its volume handling, and skips the count when that handling consumed the
   * byte -- so an Rxy row that also carries a volume-column volume does not
   * count tick 0 toward its first retrigger. The engine needs to know which
   * kind of volume a row carries to reproduce that, and an imported velocity
   * byte alone cannot: a note with an instrument and no volume column also
   * imports a volume (the sample's default).
   */
  volumeColumnVolume?: boolean;
  /** Optional exact frequency in Hz (for ProTracker MOD imports) */
  frequency?: number;
  /**
   * Raw, format-native effect bytes for the first effect column.
   *
   * `effectCommand` is the module's own effect number (MOD/XM: 0x00-0x21,
   * FT2's extras continuing past 0x0F) and `effectParam` its 0x00-0xFF
   * parameter. Importers write these first; `macro` is derived from them for
   * display, making the raw bytes the single source of truth. Decoding goes
   * through the module format's `FormatProfile` command table, so a format
   * whose command numbers mean something else (S3M) is a data change, not a
   * parser fork.
   *
   * Optional so hand-authored rows (which have no raw bytes) and song files
   * saved before this field keep working unchanged; editing the macro column
   * by hand clears the raw bytes, making the text authoritative again.
   */
  effectCommand?: number;
  effectParam?: number;
}

export interface TrackerInterpolationRange {
  startRow: number;
  endRow: number;
  macroIndex: number;
  startValue: number; // normalized 0-1
  endValue: number;   // normalized 0-1
  interpolation: 'linear' | 'exponential';
}

export interface TrackerTrackData {
  id: string;
  name: string;
  color?: string;
  entries: TrackerEntryData[];
  interpolations?: TrackerInterpolationRange[];
}

/**
 * One pattern: a named block of rows, each track holding that track's
 * entries for them.
 */
export interface TrackerPattern {
  id: string;
  name: string;
  /**
   * Row count for this pattern. XM (and IT) allow this to vary per pattern,
   * so it lives here rather than on the song. Songs saved before v3 have it
   * backfilled from the old song-level `patternRows` on load.
   */
  rows: number;
  tracks: TrackerTrackData[];
}
