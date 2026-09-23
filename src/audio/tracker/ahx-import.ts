import type { TrackerSongFile } from 'src/stores/tracker-store';
import { CURRENT_SONG_FILE_VERSION } from 'src/stores/tracker-store';
import { attachAhxSource } from 'src/audio/tracker/ahx-source';
import { buildAhxSlots } from 'src/audio/tracker/instrument-slots';
import { importFallbackTitle } from 'src/audio/tracker/ahx-doc/build-file';
import {
  looksLikeAhx as looksLikeAhxInternal,
  parseAhx,
  buildAhxTrackerPatterns,
} from '@another-synth/tracker-playback';

/**
 * Assembly only, like the other `*-import.ts` files: the parse and the row
 * model live in the library. What is specific to AHX is what is *missing*: no
 * patches (the instruments are waveform/envelope/filter descriptors inside
 * the file and the worklet's engine plays them), and no timing fields (the engine owns the transport). The song file is the display
 * model; the file's bytes ride along via `ahx-source`.
 *
 * An AHX song lists its instruments as name-only slots (`ahx`/`ahx`, no
 * patch) that keep the parsed instrument for the display editor. An HVL song
 * lists its instruments the same way (plan-hvl-instruments-0923): the slots
 * are stamped `ahx`, the cores' lineage (`ModuleFormat` has no `hvl`), and the
 * file's instruments stay the doc's own (`fileInstrumentSlots`).
 */
export const looksLikeAhxModule = looksLikeAhxInternal;

const DEFAULT_BPM = 125;

export function importAhxToTrackerSong(buffer: ArrayBuffer): TrackerSongFile {
  const bytes = new Uint8Array(buffer);
  const song = parseAhx(bytes);
  const patterns = buildAhxTrackerPatterns(song).map((pattern, index) => {
    // Per-channel position transpose for the read-only header chip: the row
    // model drops it (the builder's display-only concern), but the format
    // carries it and the engine applies it, so keep it beside the rows.
    const transpose = song.positions[index]?.transpose;
    return transpose === undefined ? pattern : { ...pattern, positionTranspose: transpose.slice() };
  });
  // One row-model pattern per position, played in order: the engine's
  // position index is therefore also the sequence index.
  const sequenceIds = patterns.map((pattern) => pattern.id);

  const songFile: TrackerSongFile = {
    version: CURRENT_SONG_FILE_VERSION,
    data: {
      currentSong: {
        title: song.name.trim() || importFallbackTitle(song.format),
        author: 'Unknown',
        bpm: DEFAULT_BPM,
      },
      moduleFormat: 'ahx',
      patternRows: song.trackLength,
      stepSize: 1,
      patterns,
      sequence: sequenceIds,
      currentPatternId: sequenceIds[0] ?? null,
      instrumentSlots: buildAhxSlots(song),
      activeInstrumentId: null,
      currentInstrumentPage: 0,
      songPatches: {},
    },
  };

  attachAhxSource(songFile, bytes, { format: song.format, version: song.version });
  return songFile;
}
