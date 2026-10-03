import type { TrackerSongFile } from 'src/stores/tracker-store';
import {
  CURRENT_SONG_FILE_VERSION,
  clampPatternRows,
} from 'src/stores/tracker-store';
import { xmOriginOf } from 'src/audio/tracker/xm-origin';
import { buildSlotsAndPatches } from 'src/audio/tracker/instrument-slots';
import {
  looksLikeXm as looksLikeXmInternal,
  parseXm,
  writeXm,
  FT2_TRACKER_NAME,
  buildXmTrackerPatterns,
  buildXmTrackerSamples,
  formatInstrumentId,
  xmMetaOf,
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

  const pitch: PitchModel = xm.linearFrequency
    ? createLinearPitchModel()
    : createXmAmigaPitchModel();

  const { samples, slotForInstrument } = buildXmTrackerSamples(xm);
  const { slots, songPatches } = buildSlotsAndPatches(samples, {
    bankName: 'XM Import',
    category: 'Imported/XM',
    format: 'xm',
  });

  // Header fields the patch has no place for, kept so the module can be
  // written back out (envelopes switched off, per-sample default volume, the
  // keymap, bit depth ...). Also instruments with a name but no audio.
  for (const [index, instrument] of xm.instruments.entries()) {
    const slot = slots[(slotForInstrument.get(index + 1) ?? 0) - 1];
    if (slot) {
      slot.xmInstrument = xmMetaOf(instrument);
    } else if (xm.instruments.length <= slots.length && instrument.name) {
      const empty = slots[index];
      if (empty && !empty.patchId) {
        empty.patchName = instrument.name;
        empty.instrumentName = instrument.name;
        empty.instrumentFormat = 'xm';
        empty.xmInstrument = xmMetaOf(instrument);
      }
    }
  }

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
      // Header facts a re-export has to keep (see xm-origin.ts).
      xmOrigin: xmOriginOf(xm),
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


/** An empty eight-channel XM module: one blank 64-row pattern and no instruments. */
export function createNewXmTrackerSong(): TrackerSongFile {
  const channels = 8;
  const rows = 64;
  const blank: XmSong = {
    title: '',
    trackerName: FT2_TRACKER_NAME,
    version: 0x0104,
    numChannels: channels,
    songLength: 1,
    restartPosition: 0,
    orders: new Array<number>(256).fill(0),
    patterns: [
      {
        numRows: rows,
        rows: Array.from({ length: rows }, () =>
          Array.from({ length: channels }, () => ({
            note: 0,
            instrument: 0,
            volumeColumn: 0,
            effectType: 0,
            effectParam: 0,
          })),
        ),
      },
    ],
    instruments: [],
    linearFrequency: true,
    defaultSpeed: 6,
    defaultBpm: 125,
  };
  const song = importXmToTrackerSong(writeXm(blank).slice().buffer);
  song.data.currentSong.title = 'Untitled module';
  return song;
}
