import type { TrackerSongFile, InstrumentSlot } from 'src/stores/tracker-store';
import {
  TOTAL_SLOTS,
  CURRENT_SONG_FILE_VERSION,
  clampPatternRows,
} from 'src/stores/tracker-store';
import type { Patch } from 'src/audio/types/preset-types';
import {
  SamplerLoopMode,
} from 'src/audio/types/synth-layout';
import { createSamplerPatch } from 'src/audio/tracker/sampler-patch-builder';
import {
  looksLikeS3m as looksLikeS3mInternal,
  parseS3m,
  buildS3mTrackerPatterns,
  measureS3m,
  formatInstrumentId,
  UNMAPPED_COMMAND_BYTES,
  type S3mSong,
  type S3mInstrument,
} from '@another-synth/tracker-playback';
import { createS3mPitchModel } from '@another-synth/tracker-playback';

/**
 * The pattern half of this importer lives in the library, as
 * `buildS3mTrackerPatterns` (and `measureS3m`, the drop-count audit). What
 * stays here is the sample half: instruments into slots and sampler patches.
 */

export const looksLikeS3m = looksLikeS3mInternal;

const DEFAULT_STEP_SIZE = 1;
/**
 * The sample buffer is declared at this rate regardless of its true rate, and
 * the root note compensates. Matches what the other importers do.
 */
const ASSET_SAMPLE_RATE = 44100;

/**
 * MIDI note at which an S3M sample with c2spd 8363 plays untransposed.
 *
 * The engine schedules notes in musical Hz (the ST3 rate divided by 16 --
 * ST3's reference note C-5 is one octave above XM Amiga's C-4, see
 * pitch-model.ts), and the sampler computes playbackRate =
 * scheduledFrequency / f(rootNote). For the buffer -- declared at
 * ASSET_SAMPLE_RATE -- to play back at the ST3 rate, f(rootNote) must equal
 * ASSET_SAMPLE_RATE / 16, so
 *
 *   rootNote = 69 + 12*log2(ASSET_SAMPLE_RATE / 16 / 440) ~= 100.78
 *
 * (The same derivation with XM's /32 scale gives xm-import's 88.77, which is
 * the cross-check that this is the right relation rather than a fitted
 * number.)
 */
const S3M_ROOT_NOTE =
  69 + 12 * Math.log2(ASSET_SAMPLE_RATE / 16 / 440);

/** c2spd of a sample with no finetune (st3play digdata.h: C2FREQ). */
const S3M_C2FREQ = 8363;
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

  const { slots, songPatches, slotForInstrument } =
    buildInstrumentSlotsAndPatches(s3m);

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


/**
 * How many distinct channels ever play each instrument.
 *
 * A tracker channel is monophonic and owns a voice of its own (D32/D42) --
 * sized by peak, a channel without a voice steals notes.
 */
function measureChannelsPerInstrument(
  s3m: S3mSong,
): Map<number, Set<number>> {
  const channels = new Map<number, Set<number>>();

  for (const pattern of s3m.patterns) {
    for (const row of pattern.rows) {
      row.forEach((cell, ch) => {
        if (cell.instrument > 0) {
          let set = channels.get(cell.instrument);
          if (!set) {
            set = new Set<number>();
            channels.set(cell.instrument, set);
          }
          set.add(ch);
        }
      });
    }
  }

  return channels;
}

function buildInstrumentSlotsAndPatches(
  s3m: S3mSong,
): {
  slots: InstrumentSlot[];
  songPatches: Record<string, Patch>;
  slotForInstrument: Map<number, number>;
} {
  // Only instruments actually referenced by pattern data need a slot (the
  // D76 guard: S3M declares up to 99; 130 slots cover them).
  const referenced = new Set<number>();
  for (const pattern of s3m.patterns) {
    for (const row of pattern.rows) {
      for (const cell of row) {
        if (cell.instrument > 0) referenced.add(cell.instrument);
      }
    }
  }

  const slots: InstrumentSlot[] = Array.from({ length: TOTAL_SLOTS }, (_, i) => ({
    slot: i + 1,
    bankName: '',
    patchName: '',
    instrumentName: '',
  }));

  const songPatches: Record<string, Patch> = {};
  const slotForInstrument = new Map<number, number>();
  const channelsPerInstrument = measureChannelsPerInstrument(s3m);

  let nextSlot = 1;
  for (const instrumentNumber of [...referenced].sort((a, b) => a - b)) {
    if (nextSlot > TOTAL_SLOTS) {
      // eslint-disable-next-line no-console
      console.warn(
        `[S3M Import] Out of instrument slots; dropping instrument ${instrumentNumber}`,
      );
      break;
    }
    const instrument = s3m.instruments[instrumentNumber - 1];
    if (!instrument) continue;

    const slot = slots[nextSlot - 1]!;

    // AdLib/OPL instruments: preserve the parsed register data on the slot,
    // marked inactive (no patchId -- nothing can play it). Morten,
    // 2026-09-03: the future OPL instrument type consumes these bytes, so
    // that phase never needs a re-parse.
    if (instrument.kind === 'adlib') {
      slot.bankName = 'S3M Import (FM inactive)';
      slot.patchName = instrument.name || `Instrument ${formatInstrumentId(instrumentNumber)}`;
      slot.instrumentName = slot.patchName;
      slot.source = 'song';
      slot.instrumentType = 'mod';
      slot.oplData = {
        kind: instrument.adlibKind ?? 'melody',
        registers: instrument.oplRegisters ?? [],
        volume: instrument.adlibVolume ?? 0,
        c2spd: instrument.c2spd,
      };
      nextSlot++;
      continue;
    }

    const sample = instrument;
    if (sample.data.length === 0) continue; // stereo / packed / empty: counted, warned

    const patch = createSamplerPatchForS3mSample(
      instrument,
      instrumentNumber,
      channelsPerInstrument.get(instrumentNumber)?.size ?? 1,
    );

    slot.bankName = 'S3M Import';
    slot.patchId = patch.metadata.id;
    slot.patchName = patch.metadata.name;
    slot.instrumentName = patch.metadata.name;
    slot.source = 'song';
    slot.instrumentType = 'mod';
    slot.volume = 1.0;

    songPatches[patch.metadata.id] = patch;
    // Only PCM instruments map into the playable slot space.
    slotForInstrument.set(instrumentNumber, nextSlot);
    nextSlot++;
  }

  return { slots, songPatches, slotForInstrument };
}

/**
 * The root note folds the sample's c2spd in (it is per-sample finetune in
 * S3M, D96): a sample whose c2spd differs from 8363 must play proportionally
 * faster/slower, so rootNote = S3M_ROOT_NOTE - 12*log2(c2spd/8363).
 */
function rootNoteForSample(sample: S3mInstrument): number {
  const c2spd = sample.c2spd > 0 ? sample.c2spd : S3M_C2FREQ;
  return S3M_ROOT_NOTE - 12 * Math.log2(c2spd / S3M_C2FREQ);
}

function createSamplerPatchForS3mSample(
  sample: S3mInstrument,
  instrumentNumber: number,
  channelCount: number,
): Patch {
  const sampleLengthFrames = Math.max(1, sample.data.length);
  const loopEnabled = sample.loopEnabled && sample.loopEnd > sample.loopStart;

  return createSamplerPatch({
    name: sample.name,
    fallbackName: `Instrument ${formatInstrumentId(instrumentNumber)}`,
    category: 'Imported/S3M',
    data: sample.data,
    sampleRate: ASSET_SAMPLE_RATE,
    rootNote: rootNoteForSample(sample),
    detuneCents: 0,
    // Unity -- the sample's default volume reaches playback through the
    // volume stamped on every note carrying an instrument, exactly as in the
    // XM/MOD importers.
    gain: 1,
    // S3M has no ping-pong loop; SamplerLoopMode.Loop only.
    loopMode: loopEnabled ? SamplerLoopMode.Loop : SamplerLoopMode.Off,
    loopStartFrames: loopEnabled ? sample.loopStart : 0,
    loopLengthFrames: loopEnabled
      ? sample.loopEnd - sample.loopStart
      : sampleLengthFrames,
    // One voice per channel that ever plays this instrument, so every
    // channel owns one and none has to steal.
    voiceCount: Math.max(1, Math.min(32, channelCount)),
  });
}
