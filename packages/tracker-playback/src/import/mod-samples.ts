/**
 * ProTracker MOD samples -> the tracker instrument model.
 *
 * The instrument half of the MOD importer, in library terms: `ModSample`s in,
 * `TrackerSample`s out. What each one becomes -- a sampler `Patch` here, an
 * OPL voice somewhere else, a bare AudioBufferSourceNode in a third place --
 * is the host's business; see `src/audio/tracker/mod-import.ts` for this app's
 * answer.
 */
import type { ModSong, ModSample } from '../mod-parser';
import type { TrackerSample, TrackerSampleSet } from '../tracker-sample';
import { TOTAL_SLOTS } from '../song-constants';
import { PAULA_TO_SYNTH_SCALE } from '../pitch-model';

/**
 * The rate MOD sample buffers are declared at, regardless of the rate the
 * Paula would have clocked them out at; `rootNote` compensates.
 */
const MOD_SAMPLE_RATE = 44100;

/**
 * MIDI note at which a MOD sample plays at Paula's own rate.
 *
 * The engine schedules notes in musical Hz -- the Paula rate divided by
 * PAULA_TO_SYNTH_SCALE (see pitch-model.ts) -- and the sampler computes
 * playbackRate = scheduledFrequency / f(rootNote), reading a buffer declared
 * at MOD_SAMPLE_RATE. For the buffer to come out at the Paula rate,
 * f(rootNote) must equal MOD_SAMPLE_RATE / PAULA_TO_SYNTH_SCALE, so
 *
 *   rootNote = 69 + 12*log2(MOD_SAMPLE_RATE / PAULA_TO_SYNTH_SCALE / 440)
 *            ~= 64.76
 *
 * (The same derivation gives s3m-import's 100.78 and xm-import's 88.77 from
 * their own scales; this is the relation, not a fitted number.)
 *
 * It *was* a fitted 65, which is 23.7 cents sharp of the derivation -- a hand
 * calibration that half-cancelled the NTSC clock this engine used to run MODs
 * at, and left every module 7.6 cents flat of the real thing.
 */
const MOD_ROOT_NOTE =
  69 + 12 * Math.log2(MOD_SAMPLE_RATE / PAULA_TO_SYNTH_SCALE / 440);

/**
 * One MOD sample as a `TrackerSample` in `slot`: the importer's conversion, and
 * what an editor writes back after changing a sample, so both land on the same
 * numbers. `channelCount` is how many channels play it (voices to allocate).
 */
export function trackerSampleFromModSample(
  sample: ModSample,
  slot: number,
  channelCount = 4,
): TrackerSample {
  const sampleLengthFrames = Math.max(1, sample.length);
  // ProTracker marks "no loop" with a loop length of 2 words or less.
  const loopEnabled = sample.loopLength > 2;
  return {
    slot,
    sourceIndex: slot,
    name: sample.name,
    data: convertSampleToFloat32(sample),
    sampleRate: MOD_SAMPLE_RATE,
    // Per-sample finetune is baked into detune rather than the root.
    rootNote: MOD_ROOT_NOTE,
    // MOD finetune is -8..7 in 1/8 semitone steps.
    detuneCents: ((sample.finetune ?? 0) / 8) * 100,
    // Unity. The sample's default volume (0-64) is a *channel* volume in
    // ProTracker, not a property of the sample: it reaches playback through
    // the volume column (every note with a sample number is stamped with it
    // at import), so baking it in here would double-apply it.
    gain: 1,
    loop: loopEnabled ? 'forward' : 'off',
    loopStartFrames: loopEnabled ? sample.loopStart : 0,
    loopLengthFrames: loopEnabled ? sample.loopLength : sampleLengthFrames,
    // One voice per channel that ever plays this sample, so every channel
    // owns one and none has to steal.
    voiceCount: Math.max(4, Math.min(32, channelCount)),
  };
}

/** 8-bit signed PCM as the file stores it, to -1..1 floats. */
export function convertSampleToFloat32(sample: ModSample): Float32Array {
  const data = sample.data;
  const floats = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) {
    // 8-bit signed -> -1..1
    floats[i] = (data[i] ?? 0) / 128;
  }
  return floats;
}

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

/**
 * One `TrackerSample` per sample that holds audio or that the pattern data
 * references.
 *
 * MOD keeps the file's own numbering rather than packing: sample 7 lands in
 * slot 7, because a cell's sample byte *is* the instrument id (see
 * `buildModTrackerPatterns`). Samples past `TOTAL_SLOTS` are dropped; they
 * would have nowhere to live.
 */
export function buildModTrackerSamples(mod: ModSong): TrackerSampleSet {
  const channelsPerSample = measureChannelsPerSample(mod);

  // Every sample that holds audio, played or not: an unused sample is still
  // part of the module, and a .mod export has to write it back.
  const usedSamples = new Set<number>();
  mod.samples.forEach((sample, i) => {
    if (sample.length > 0) usedSamples.add(i + 1);
  });
  for (const pattern of mod.patterns) {
    for (const row of pattern.rows) {
      for (const cell of row) {
        if (cell.sampleNumber > 0) {
          usedSamples.add(cell.sampleNumber);
        }
      }
    }
  }

  const samples: TrackerSample[] = [];
  const slotForInstrument = new Map<number, number>();

  for (const sampleNumber of [...usedSamples].sort((a, b) => a - b)) {
    if (sampleNumber < 1 || sampleNumber > mod.samples.length) continue;
    // Extra samples beyond the available slots are ignored; they show up with
    // instrument ids that have no instrument behind them.
    if (sampleNumber > TOTAL_SLOTS) continue;

    const sample = mod.samples[sampleNumber - 1];
    if (!sample) continue;

    const channelCount = channelsPerSample.get(sampleNumber)?.size ?? 1;
    samples.push(
      trackerSampleFromModSample(sample, sampleNumber, channelCount),
    );
    slotForInstrument.set(sampleNumber, sampleNumber);
  }

  return { samples, slotForInstrument };
}
