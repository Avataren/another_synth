import type { TrackerSongFile } from 'src/stores/tracker-store';
import { CURRENT_SONG_FILE_VERSION } from 'src/stores/tracker-store';
import { buildSlotsAndPatches } from 'src/audio/tracker/instrument-slots';
import {
  looksLikeMod as looksLikeModInternal,
  parseMod,
  buildModTrackerPatterns,
  buildModTrackerSamples,
  formatInstrumentId,
  MOD_PATTERN_ROWS,
  type ModSong,
} from '@another-synth/tracker-playback';
import { usesVBlankTiming } from '@another-synth/tracker-playback';

// Moved into the library with the rest of the sample decoding; re-exported
// so existing importers of it keep working.
export { convertSampleToFloat32 } from '@another-synth/tracker-playback';

/**
 * Both halves of this importer now live in the library --
 * `buildModTrackerPatterns` for the rows, `buildModTrackerSamples` for the
 * instruments. What is left here is the app's own assembly: turning the
 * library's `TrackerSample`s into sampler patches and instrument slots, and
 * wrapping the result in a `TrackerSongFile`.
 */

const DEFAULT_BPM = 125;
const DEFAULT_STEP_SIZE = 1;

export const looksLikeMod = looksLikeModInternal;

export function importModToTrackerSong(buffer: ArrayBuffer): TrackerSongFile {
  const bytes = new Uint8Array(buffer);
  const mod: ModSong = parseMod(bytes);

  // Log basic MOD metadata on import to help debug tracker-specific behavior.
  // eslint-disable-next-line no-console
  console.log('[MOD Import]', {
    title: mod.title,
    signature: mod.signature,
    trackerFlavor: mod.trackerFlavor,
    numChannels: mod.numChannels,
    numSamples: mod.samples.length,
  });

  // Whether every Fxx on this module sets the speed rather than the tempo.
  // See `usesVBlankTiming`; carried on the song because the distinction is
  // per module, not per format, and cannot be recovered from the cells later.
  const vblankTiming = usesVBlankTiming(mod);
  if (vblankTiming) {
    // eslint-disable-next-line no-console
    console.log('[MOD Import] VBlank timing detected: Fxx sets speed, not tempo');
  }

  const patterns = buildModTrackerPatterns(mod);
  // Build song sequence from the MOD order table so repeated
  // patterns (e.g. first pattern listed twice) are preserved.
  const sequenceIds: string[] = [];
  const orderLength = mod.songLength || mod.orders.length;
  for (let i = 0; i < orderLength; i++) {
    const patIndex = mod.orders[i] ?? 0;
    const pattern = patterns[patIndex];
    if (pattern) {
      sequenceIds.push(pattern.id);
    }
  }

  const { samples } = buildModTrackerSamples(mod);
  const { slots, songPatches } = buildSlotsAndPatches(samples, {
    bankName: 'MOD Import',
    category: 'Imported/MOD',
  });

  const songFile: TrackerSongFile = {
    version: CURRENT_SONG_FILE_VERSION,
    data: {
      currentSong: {
        title: mod.title || 'Imported MOD',
        author: 'Unknown',
        bpm: DEFAULT_BPM,
      },
      moduleFormat: 'protracker',
      ...(vblankTiming ? { vblankTiming: true } : {}),
      patternRows: MOD_PATTERN_ROWS,
      stepSize: DEFAULT_STEP_SIZE,
      patterns,
      sequence: sequenceIds,
      currentPatternId: sequenceIds[0] ?? patterns[0]?.id ?? null,
      instrumentSlots: slots,
      activeInstrumentId: (() => {
        const firstUsed = slots.find((s) => s.patchId);
        return firstUsed ? formatInstrumentId(firstUsed.slot) : null;
      })(),
      currentInstrumentPage: 0,
      songPatches,
    },
  };

  return songFile;
}

/**
 * The order patterns are *converted* in, which is the order they are *played*
 * in, not the order they are stored in.
 *
 * The channel's latched sample number has to survive a pattern boundary --
 * ProTracker keeps it as channel state -- so conversion has to follow the
 * order list to know what each pattern inherits. Patterns the order list never
 * reaches are converted afterwards, from a clean latch, so an unused or
 * orphaned pattern still imports.
 *
 * A pattern played at more than one order position inherits whatever the
 * *first* of those positions had, since one pattern converts to one object
 * that every position shares. Resolving that properly means latching at
 * playback time rather than at import; see the note on `channelSamples`.
 */
