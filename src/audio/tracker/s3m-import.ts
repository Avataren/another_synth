import type { TrackerSongFile } from 'src/stores/tracker-store';
import {
  CURRENT_SONG_FILE_VERSION,
  clampPatternRows,
} from 'src/stores/tracker-store';
import { buildSlotsAndPatches } from 'src/audio/tracker/instrument-slots';
import {
  looksLikeS3m as looksLikeS3mInternal,
  parseS3m,
  buildS3mTrackerPatterns,
  buildS3mTrackerSamples,
  measureS3m,
  formatInstrumentId,
  UNMAPPED_COMMAND_BYTES,
} from '@another-synth/tracker-playback';
import { createS3mPitchModel } from '@another-synth/tracker-playback';

/**
 * Both halves of this importer live in the library --
 * `buildS3mTrackerPatterns` for the rows (with `measureS3m`, the drop-count
 * audit) and `buildS3mTrackerSamples` for the instruments. What is left here
 * is the app's own assembly: sampler patches and instrument slots, wrapped in
 * a `TrackerSongFile`.
 */

export const looksLikeS3m = looksLikeS3mInternal;

const DEFAULT_STEP_SIZE = 1;
export function importS3mToTrackerSong(buffer: ArrayBuffer): TrackerSongFile {
  const bytes = new Uint8Array(buffer);
  const s3m = parseS3m(bytes);

  const counts = measureS3m(s3m);

  // eslint-disable-next-line no-console
  console.log('[S3M Import]', {
    title: s3m.title,
    tracker: `cwtv ${s3m.trackerVersion.toString(16)}`,
    patterns: s3m.patterns.length,
    instruments: s3m.instruments.length,
    amigaLimits: s3m.amigaLimits,
    fastVolumeSlides: s3m.fastVolumeSlides,
    st2Vibrato: s3m.st2Vibrato,
    amigaSlidesBitSet: s3m.amigaSlidesBitSet,
    counts,
  });

  if (counts.adlibInstruments > 0 || counts.adlibNotes > 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `${counts.adlibInstruments} AdLib instruments ignored -- FM not supported yet ` +
        `(${counts.adlibNotes} notes on ${counts.adlibChannels} AdLib channels were not imported). ` +
        'Their OPL register data is preserved on the instrument slots for the future OPL task.',
    );
  }
  if (counts.stereoSamples > 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `${counts.stereoSamples} stereo sample(s) not decoded -- no stereo sampler path exists.`,
    );
  }
  if (counts.packedSamples > 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `${counts.packedSamples} DP30AD1F-packed 16-bit sample(s) not decoded -- no ` +
        'reference player implements the packing (OpenMPT: "unused"; Schism: "never used"), ' +
        'so decoding would be guesswork.',
    );
  }
  if (counts.unmappedCommands > 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `${counts.unmappedCommands} effect cell(s) use command bytes the S3M profile leaves ` +
        `unmapped (${UNMAPPED_COMMAND_BYTES.map((b) => '0x' + b.toString(16)).join('/')} ` +
        '-- M/N/Y/Z, D96/D97); they decode to nothing rather than to a borrowed reading.',
    );
  }

  // The pitch model every effect runs in. The amiga-limits header flag is
  // per-file song data (D1/D24: a file-level flag must not masquerade as a
  // format) and selects the variant profile exactly like XM's Amiga mode.
  const pitch = createS3mPitchModel({ amigaLimits: s3m.amigaLimits });

  const { samples, slotForInstrument } = buildS3mTrackerSamples(s3m);
  const { slots, songPatches } = buildSlotsAndPatches(samples, {
    bankName: 'S3M Import',
    category: 'Imported/S3M',
    oplBankName: 'S3M Import (FM inactive)',
  });

  const patterns = buildS3mTrackerPatterns(s3m, pitch, slotForInstrument);

  // Walk the order table in play order: 255 terminates the song, 254 is a
  // skipped separator (st3play digread.c neworder). The importer -- not the
  // parser -- owns that policy.
  const sequenceIds: string[] = [];
  const orderLength = Math.min(s3m.songLength || s3m.orders.length, s3m.orders.length);
  for (let i = 0; i < orderLength; i++) {
    const order = s3m.orders[i] ?? 255;
    if (order === 255) break; // end marker
    if (order === 254) continue; // pattern separator
    const pattern = patterns[order];
    if (pattern) sequenceIds.push(pattern.id);
  }

  // ST3's own loader defaults (st3play checkheader, quoted in D101):
  // `initspeed == 255` -> 6, `inittempo == 0` -> 125; OpenMPT adds "ST3
  // fails to load an otherwise valid default tempo of 32", so anything
  // below 33 falls back to 125.
  const speed = s3m.initialSpeed === 0 || s3m.initialSpeed === 255 ? 6 : s3m.initialSpeed;
  const tempo = s3m.initialTempo < 33 ? 125 : s3m.initialTempo;

  // Header global volume: OpenMPT clamps to 64 and -- quoting -- "fixes a
  // few tunes, e.g. DARKNESS.S3M by Purple Motion (ST 3.00)": a global
  // volume of 0 on a pre-ST3.20 file is treated as full, because ST3.01
  // exported 255-as-unset that those files read back as 0.
  const globalVolumeRaw = Math.min(s3m.globalVolume, 64);
  const initialGlobalVolume =
    globalVolumeRaw === 0 && s3m.trackerVersion < 0x1320 ? 1 : globalVolumeRaw / 64;

  return {
    version: CURRENT_SONG_FILE_VERSION,
    data: {
      currentSong: {
        title: s3m.title || 'Imported S3M',
        author: 'Unknown',
        bpm: tempo,
      },
      moduleFormat: 's3m',
      initialSpeed: speed,
      linearFrequency: true,
      // Per-file header data that must reach the engine's effect arithmetic
      // (D59 discipline). Serialized additively; no song-file version bump.
      ...(s3m.amigaLimits ? { amigaLimits: true } : {}),
      ...(initialGlobalVolume !== 1 ? { initialGlobalVolume } : {}),
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

