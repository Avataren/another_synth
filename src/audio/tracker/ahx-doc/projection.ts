import { buildAhxTrackerPatterns, type TrackerEntryData, type TrackerPattern } from '@another-synth/tracker-playback';
import { docToSong, makeAhxDoc } from './doc';
import { AHX_CHANNELS, type AhxDoc } from './types';

const PROJECTION = { latchInstruments: false, stableIds: true, clampNotes: false } as const;

/**
 * The grid of an editable AHX song: one pattern per position, with the three
 * options that make the projection invertible (`entriesToTrack` is its
 * inverse): no instrument latch, no note clamp, ids that are stable per
 * position (`ahx-pos-<n>`).
 */
export function projectAhxPatterns(doc: AhxDoc): TrackerPattern[] {
  return buildAhxTrackerPatterns(docToSong(doc, []), PROJECTION);
}

/**
 * The rows of the given tracks, as a grid cell shows them (each a fresh array,
 * keyed by track number). The projection has no state across tracks (no latch),
 * so a track is projected on its own; done through the same builder as
 * `projectAhxPatterns`, by a scratch doc whose positions just list the tracks.
 */
export function projectTracks(doc: AhxDoc, tracks: readonly number[]): Map<number, TrackerEntryData[]> {
  const wanted = [...new Set(tracks)];
  const positions = [];
  for (let i = 0; i < wanted.length; i += AHX_CHANNELS) {
    const track = wanted.slice(i, i + AHX_CHANNELS);
    while (track.length < AHX_CHANNELS) track.push(track[0] as number);
    positions.push({ track, transpose: [0, 0, 0, 0] });
  }
  const rows = new Map<number, TrackerEntryData[]>();
  if (positions.length === 0) return rows;
  const scratch = makeAhxDoc({ ...doc, positions, restart: 0, subsongs: [] });
  buildAhxTrackerPatterns(docToSong(scratch, []), PROJECTION).forEach((pattern, k) => {
    pattern.tracks.forEach((cell, j) => {
      const track = wanted[k * AHX_CHANNELS + j];
      if (track !== undefined && !rows.has(track)) rows.set(track, cell.entries);
    });
  });
  return rows;
}
