/**
 * Re-export shim: the tracker row model now lives in
 * `@another-synth/tracker-playback`, which is where the importers that
 * produce it and the builder that consumes it also live.
 *
 * `TrackerSelectionRect` stays here: it is a pattern-editor selection, with
 * no part in replay.
 */
export type {
  TrackerEntryData,
  TrackerInterpolationRange,
  TrackerTrackData,
} from '@another-synth/tracker-playback';

export interface TrackerSelectionRect {
  rowStart: number;
  rowEnd: number;
  trackStart: number;
  trackEnd: number;
}
