import type { TrackerTrackData } from './tracker-types';
import { trackPitchPx, trackWidthPx } from './track-metrics';

/**
 * Pure helpers extracted from the pattern-grid buffering work so the
 * selection rules and the bar-width math are unit-testable without mounting
 * pages that pull in audio stores.
 */

/** What the pattern grid renders while playing: the upcoming pattern. */
export interface UpcomingPatternInfo {
  id: string;
  tracks: TrackerTrackData[];
  rows: number;
}

/**
 * The pattern the sequencer plays after the current one.
 *
 * Same rules as TrackerPage/JukeboxPage feed the grid with:
 * - not playing -> null (buffers disabled)
 * - empty sequence or index outside it -> null
 * - single-entry sequence -> wraps to itself (the same pattern replays)
 * - next id no longer resolves (deleted mid-play) -> null
 */
export function selectUpcomingPattern(
  isPlaying: boolean,
  currentSequenceIndex: number,
  sequence: string[],
  resolvePattern: (id: string) => { id: string; tracks: TrackerTrackData[]; rows: number } | null | undefined,
): UpcomingPatternInfo | null {
  if (!isPlaying) return null;
  if (sequence.length === 0) return null;
  if (currentSequenceIndex < 0 || currentSequenceIndex >= sequence.length) return null;
  const nextId = sequence[(currentSequenceIndex + 1) % sequence.length];
  if (!nextId) return null;
  return resolvePattern(nextId) ?? null;
}

/**
 * Horizontal extent of the active-row bar: the first column's width plus one
 * pitch (width + gap) per additional column. Pure math from track-metrics,
 * replacing a nextTick DOM measurement that raced the pattern swap.
 */
export function activeRowBarWidthPx(trackCount: number, showExtraEffectColumn: boolean): number | null {
  if (trackCount <= 0) return null;
  return (
    trackWidthPx(trackCount, showExtraEffectColumn) +
    (trackCount - 1) * trackPitchPx(trackCount, showExtraEffectColumn)
  );
}
