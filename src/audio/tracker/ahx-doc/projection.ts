import { buildAhxTrackerPatterns, type TrackerPattern } from '@another-synth/tracker-playback';
import { docToSong } from './doc';
import type { AhxDoc } from './types';

/**
 * The grid of an editable AHX song: one pattern per position, with the three
 * options that make the projection invertible (`entriesToTrack` is its
 * inverse): no instrument latch, no note clamp, ids that are stable per
 * position (`ahx-pos-<n>`).
 */
export function projectAhxPatterns(doc: AhxDoc): TrackerPattern[] {
  return buildAhxTrackerPatterns(docToSong(doc, []), { latchInstruments: false, stableIds: true, clampNotes: false });
}
