import { buildAhxTrackerPatterns, type TrackerEntryData, type TrackerPattern } from '@another-synth/tracker-playback';
import { docChannels, docToSong, makeAhxDoc } from './doc';
import type { AhxDoc } from './types';

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
 * The grid of a doc that is shown, not edited: exactly the rows the
 * file's display import builds (`importAhxToTrackerSong`: instruments latched
 * per channel, notes as the engine plays them), so reading them from the doc
 * changes nothing on screen, with the stable ids of the editable projection
 * and each position's transpose beside its rows for the read-only header chip.
 * The store used it for HVL songs while they were display-only (P1); since
 * plan-hvl-editing.md P2 an HVL doc is edited, so the store projects it with
 * `projectAhxPatterns` like an AHX one (the rows differ only in the latched
 * instrument numbers, which the editable grid shows where a step has one).
 */
export function projectDisplayPatterns(doc: AhxDoc): TrackerPattern[] {
  return buildAhxTrackerPatterns(docToSong(doc, []), { stableIds: true }).map((pattern, index) => {
    const transpose = doc.positions[index]?.transpose;
    return transpose === undefined ? pattern : { ...pattern, positionTranspose: transpose.slice() };
  });
}

/**
 * The rows of the given tracks, as a grid cell shows them (each a fresh array,
 * keyed by track number). The projection has no state across tracks (no latch),
 * so a track is projected on its own; done through the same builder as
 * `projectAhxPatterns`, by a scratch doc whose positions just list the tracks.
 */
export function projectTracks(doc: AhxDoc, tracks: readonly number[]): Map<number, TrackerEntryData[]> {
  const wanted = [...new Set(tracks)];
  const channels = docChannels(doc);
  const positions = [];
  for (let i = 0; i < wanted.length; i += channels) {
    const track = wanted.slice(i, i + channels);
    while (track.length < channels) track.push(track[0] as number);
    positions.push({ track, transpose: new Array<number>(channels).fill(0) });
  }
  const rows = new Map<number, TrackerEntryData[]>();
  if (positions.length === 0) return rows;
  const scratch = makeAhxDoc({ ...doc, positions, restart: 0, subsongs: [] });
  buildAhxTrackerPatterns(docToSong(scratch, []), PROJECTION).forEach((pattern, k) => {
    pattern.tracks.forEach((cell, j) => {
      const track = wanted[k * channels + j];
      if (track !== undefined && !rows.has(track)) rows.set(track, cell.entries);
    });
  });
  return rows;
}
