/**
 * Constants of the song model itself -- how many instrument slots a song can
 * hold, and what version its saved file is.
 *
 * These live here rather than in the app's Pinia store because the importers
 * need them and the store drags Vue, Pinia and the whole editor in behind it.
 * The store re-exports both, so it stays the app's single source of truth for
 * the UI without the library ever importing it.
 */

/**
 * Sized to XM's own maximum of 128 instruments, rather than to the corpus.
 *
 * This was 65, chosen because the busiest module then to hand referenced 42.
 * Sizing to what has been measured is a trap here: an import that runs out of
 * slots does not fail, it drops the instrument, and a note referencing a
 * dropped instrument carries no instrument at all -- so the channel keeps
 * playing whatever sample it had. The song plays on with the wrong sound and
 * nothing says so.
 *
 * radix_-_yuki_satellites.xm references 98 instruments and declares 117. Its
 * pattern 33 opens with `F-6 72` on channel 2, which came out as the previous
 * pattern's instrument 01 -- an audibly wrong sample, for a third of the
 * song's instruments.
 *
 * 130 slots, which no valid XM can exceed. The app pages them 5 at a time
 * in the instrument panel; see SLOTS_PER_PAGE in the tracker store. Empty
 * slots cost an object each; audio resources are allocated per *used*
 * instrument, so the headroom is close to free.
 */
export const TOTAL_SLOTS = 130;

/**
 * Song-file schema versions.
 *
 * v1: original format, no `moduleFormat` field.
 * v2: adds `data.moduleFormat`.
 * v3: row count moves onto each pattern (`patterns[].rows`); the song-level
 *     `patternRows` is retained only as the seed for newly created patterns.
 *
 * The reader accepts every version in this range; the writer always emits
 * `CURRENT_SONG_FILE_VERSION`.
 */
export type TrackerSongFileVersion = 1 | 2 | 3;
export const CURRENT_SONG_FILE_VERSION = 3;

/** Tracker default ticks per row. */
export const DEFAULT_SPEED = 6;

export const DEFAULT_PATTERN_ROWS = 64;
export const MIN_PATTERN_ROWS = 1;
/** FastTracker 2's per-pattern maximum. */
export const MAX_PATTERN_ROWS = 256;

export function clampPatternRows(rows: number | undefined | null): number {
  if (!Number.isFinite(rows as number)) return DEFAULT_PATTERN_ROWS;
  return Math.max(MIN_PATTERN_ROWS, Math.min(MAX_PATTERN_ROWS, Math.round(rows as number)));
}
