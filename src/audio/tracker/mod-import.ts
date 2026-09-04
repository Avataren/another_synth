import type { TrackerSongFile, InstrumentSlot } from 'src/stores/tracker-store';
import { TOTAL_SLOTS, CURRENT_SONG_FILE_VERSION } from 'src/stores/tracker-store';
import type { Patch } from 'src/audio/types/preset-types';
import { SamplerLoopMode } from 'src/audio/types/synth-layout';
import {
  createSamplerPatch,
} from 'src/audio/tracker/sampler-patch-builder';
import {
  looksLikeMod as looksLikeModInternal,
  parseMod,
  buildModTrackerPatterns,
  formatInstrumentId,
  MOD_PATTERN_ROWS,
  type ModSong,
  type ModSample,
} from '@another-synth/tracker-playback';
import { usesVBlankTiming } from '@another-synth/tracker-playback';

/**
 * The pattern half of this importer lives in the library, as
 * `buildModTrackerPatterns`: it needs only the parsed module, so a consumer
 * without the app can get from MOD bytes to rows. What stays here is the
 * sample half -- `ModSample`s into instrument slots and sampler patches --
 * because a `Patch` is the app's own synth preset.
 */

const DEFAULT_BPM = 125;
const DEFAULT_STEP_SIZE = 1;
const DEFAULT_SAMPLE_RATE = 44100;

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

  const { slots, songPatches } = buildInstrumentSlotsAndPatches(mod);

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

function measureChannelsPerSample(mod: ModSong): Map<number, Set<number>> {
  const channels = new Map<number, Set<number>>();
  for (const pattern of mod.patterns) {
    for (const row of pattern.rows) {
      row.forEach((cell, channel) => {
        if (cell.sampleNumber > 0) {
          let set = channels.get(cell.sampleNumber);
          if (!set) {
            set = new Set<number>();
            channels.set(cell.sampleNumber, set);
          }
          set.add(channel);
        }
      });
    }
  }
  return channels;
}

function buildInstrumentSlotsAndPatches(mod: ModSong): {
  slots: InstrumentSlot[];
  songPatches: Record<string, Patch>;
} {
  const channelsPerSample = measureChannelsPerSample(mod);
  const usedSamples = new Set<number>();
  for (const pattern of mod.patterns) {
    for (const row of pattern.rows) {
      for (const cell of row) {
        if (cell.sampleNumber > 0) {
          usedSamples.add(cell.sampleNumber);
        }
      }
    }
  }

  const slots: InstrumentSlot[] = [];
  for (let i = 0; i < TOTAL_SLOTS; i++) {
    slots.push({
      slot: i + 1,
      bankName: '',
      patchName: '',
      instrumentName: '',
    });
  }

  const songPatches: Record<string, Patch> = {};

  const sortedSamples = Array.from(usedSamples).sort((a, b) => a - b);

  for (const sampleNumber of sortedSamples) {
    if (sampleNumber < 1 || sampleNumber > mod.samples.length) continue;
    if (sampleNumber > TOTAL_SLOTS) {
      // Extra samples beyond available slots are ignored for now.
      // They will show up with instrument IDs that have no patch.
      continue;
    }

    const sampleMeta = mod.samples[sampleNumber - 1];
    if (!sampleMeta) continue;
    const patch = createSamplerPatchForSample(
      sampleMeta,
      sampleNumber,
      mod,
      channelsPerSample.get(sampleNumber)?.size ?? 1,
    );
    const slotIndex = sampleNumber - 1;
    const slot = slots[slotIndex];
    if (!slot) continue;

    slot.bankName = 'MOD Import';
    slot.patchId = patch.metadata.id;
    slot.patchName = patch.metadata.name;
    slot.instrumentName = patch.metadata.name;
    slot.source = 'song';
    slot.instrumentType = 'mod';
    console.log('[MOD Import] Setting slot instrumentType=mod for:', patch.metadata.name, 'slot:', slot.slot);
    // MOD sample volumes are handled via Cxx commands on notes, not sampler gain,
    // so slot volume remains at unity to avoid double-scaling.
    slot.volume = 1.0;

    songPatches[patch.metadata.id] = patch;
  }

  return { slots, songPatches };
}

function createSamplerPatchForSample(
  sample: ModSample,
  sampleIndex: number,
  _mod: ModSong,
  channelCount: number,
): Patch {
  const sampleLengthFrames = Math.max(1, sample.length);
  // ProTracker marks "no loop" with a loop length of 2 words or less.
  const loopEnabled = sample.loopLength > 2;

  const patch = createSamplerPatch({
    name: sample.name,
    fallbackName: `Instrument ${formatInstrumentId(sampleIndex)}`,
    category: 'Imported/MOD',
    data: convertSampleToFloat32(sample),
    sampleRate: DEFAULT_SAMPLE_RATE,
    // Empirically calibrated root note for MOD import. A fixed root of 65
    // keeps most instruments (including AmegAs) close to their original
    // ProTracker pitch; per-sample finetune is baked into detune instead.
    rootNote: 65,
    // MOD finetune is -8..7 in 1/8 semitone steps.
    detuneCents: ((sample.finetune ?? 0) / 8) * 100,
    // Unity. The sample's default volume (0-64) is a *channel* volume in
    // ProTracker, not a property of the sample, and it already reaches
    // playback through the volume column -- every note with a sample number is
    // stamped with it above. Baking it in here as well made the instrument
    // permanently quiet everywhere the volume column is not in charge, most
    // visibly when auditioning it from the keyboard: sample 23 of
    // GSLINGER.MOD has a header volume of 8, so it played at an eighth of the
    // level of any sample whose header says 64, with no way to turn it up.
    gain: 1,
    loopMode: loopEnabled ? SamplerLoopMode.Loop : SamplerLoopMode.Off,
    loopStartFrames: loopEnabled ? sample.loopStart : 0,
    loopLengthFrames: loopEnabled ? sample.loopLength : sampleLengthFrames,
    // One voice per channel that ever plays this sample, so every channel owns
    // one and none has to steal. Four is right for a classic 4-channel module
    // and badly short for the multi-channel ones.
    voiceCount: Math.max(4, Math.min(32, channelCount)),
  });

  console.log(
    '[MOD Import] Creating patch with instrumentType=mod:',
    patch.metadata.name,
  );
  return patch;
}
export function convertSampleToFloat32(sample: ModSample): Float32Array {
  const data = sample.data;
  const floats = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) {
    // 8-bit signed -> -1..1
    floats[i] = (data[i] ?? 0) / 128;
  }
  return floats;
}
