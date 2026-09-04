import type { TrackerSongFile } from 'src/stores/tracker-store';
import {
  buildPlaybackSong,
  type PlaybackMode,
  type PlaybackSongSource,
} from 'src/audio/tracker/playback-song-builder';

/**
 * The song source an imported module implies, for tests that just want to
 * play one.
 *
 * This is the shape six test files had each spelled out for themselves, in a
 * dozen `ref()`s apiece, back when the conversion could only be reached
 * through a Vue composable. It is now a plain object, so it lives here once.
 *
 * Test files whose context differs *deliberately* are deliberately not
 * migrated onto this: s3m-engine passes `initialGlobalVolume`, raw-effect-bytes
 * pins `linearFrequency` to true regardless of the file, mod-channel-volume-carry
 * supplies neither speed nor frequency table, xm-tone-portamento-keyoff keeps an
 * empty instrument id instead of mapping it to undefined, and
 * xm-amiga-frequency-table builds from a single pattern. Each of those
 * differences is the thing its test is about.
 */
export function sourceFromImport(file: TrackerSongFile): PlaybackSongSource {
  const patterns = file.data.patterns;
  return {
    currentSong: file.data.currentSong,
    moduleFormat: file.data.moduleFormat!,
    initialSpeed: file.data.initialSpeed ?? 6,
    linearFrequency: file.data.linearFrequency ?? true,
    patterns,
    sequence: file.data.sequence ?? patterns.map((p) => p.id),
    currentPatternId: patterns[0]!.id,
    currentPattern: patterns[0]!,
    defaultPatternRows: 64,
    normalizeInstrumentId: (id) => (id ? id : undefined),
  };
}

/** `sourceFromImport`, built straight into a `PlaybackSong`. */
export function songFromImport(
  file: TrackerSongFile,
  mode: PlaybackMode = 'song',
) {
  return buildPlaybackSong(sourceFromImport(file), mode);
}
