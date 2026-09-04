import type { TrackerSongFile } from 'src/stores/tracker-store';
import {
  CURRENT_SONG_FILE_VERSION,
  clampPatternRows,
} from 'src/stores/tracker-store';
import { buildSlotsAndPatches } from 'src/audio/tracker/instrument-slots';
import {
  looksLikeXm as looksLikeXmInternal,
  parseXm,
  buildXmTrackerPatterns,
  buildXmTrackerSamples,
  formatInstrumentId,
  type XmSong,
} from '@another-synth/tracker-playback';
import {
  createLinearPitchModel,
  createXmAmigaPitchModel,
  type PitchModel,
} from '@another-synth/tracker-playback';

/**
 * Both halves of this importer live in the library --
 * `buildXmTrackerPatterns` for the rows, `buildXmTrackerSamples` for the
 * instruments. What is left here is the app's own assembly: sampler patches
 * and instrument slots, wrapped in a `TrackerSongFile`.
 */

export const looksLikeXm = looksLikeXmInternal;

const DEFAULT_STEP_SIZE = 1;

export function importXmToTrackerSong(buffer: ArrayBuffer): TrackerSongFile {
  const bytes = new Uint8Array(buffer);
  const xm: XmSong = parseXm(bytes);

  // eslint-disable-next-line no-console
  console.log('[XM Import]', {
    title: xm.title,
    tracker: xm.trackerName,
    channels: xm.numChannels,
    patterns: xm.patterns.length,
    instruments: xm.instruments.length,
    linearFrequency: xm.linearFrequency,
  });

  warnIfMultiSample(xm);

  const pitch: PitchModel = xm.linearFrequency
    ? createLinearPitchModel()
    : createXmAmigaPitchModel();

  const { samples, slotForInstrument } = buildXmTrackerSamples(xm);
  const { slots, songPatches } = buildSlotsAndPatches(samples, {
    bankName: 'XM Import',
    category: 'Imported/XM',
  });

  const patterns = buildXmTrackerPatterns(xm, pitch, slotForInstrument);

  const sequenceIds: string[] = [];
  const orderLength = Math.min(xm.songLength || xm.orders.length, xm.orders.length);
  for (let i = 0; i < orderLength; i++) {
    const pattern = patterns[xm.orders[i] ?? 0];
    if (pattern) sequenceIds.push(pattern.id);
  }

  return {
    version: CURRENT_SONG_FILE_VERSION,
    data: {
      currentSong: {
        title: xm.title || 'Imported XM',
        author: 'Unknown',
        bpm: xm.defaultBpm || 125,
      },
      moduleFormat: 'xm',
      // XM declares its own ticks-per-row; most modules use something other
      // than the tracker default of 6.
      initialSpeed: xm.defaultSpeed || 6,
      // Which frequency table the module selected. This decides the pitch
      // model every pitch *effect* runs in, so it has to reach the engine --
      // note frequencies are resolved here and are correct either way, which
      // is why losing it leaves a song in tune but with every slide moving the
      // wrong distance.
      linearFrequency: xm.linearFrequency,
      patternRows: clampPatternRows(patterns[0]?.rows),
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
}


/**
 * How many of the instrument's 96 keymap entries point at a *different*
 * sample than the one we import. XM's keymap (note-to-sample table) is
 * parsed into `XmInstrument.keymap`, but the patch model is one sample per
 * instrument (D99): the scheduler routes notes to a patch by instrument
 * number only, so honouring splits would need per-note patch selection --
 * a bigger refactor than 6/882 corpus instruments justify. We import the
 * first audible sample, exactly as before, and say so once per song.
 */
function warnIfMultiSample(xm: XmSong): void {
  for (const [index, instrument] of xm.instruments.entries()) {
    if (!instrument || instrument.samples.length < 2) continue;
    const used = new Set(instrument.keymap);
    if (used.size <= 1) continue;
    // eslint-disable-next-line no-console
    console.warn(
      `[XM Import] Instrument ${index + 1} is multi-sample (keymap covers ` +
        `${used.size} samples); importing only its first audible sample ` +
        '(D99 -- per-note sample selection needs patch-per-range routing).',
    );
  }
}
