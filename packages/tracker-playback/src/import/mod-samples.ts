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

/**
 * The rate MOD sample buffers are declared at, regardless of the rate the
 * Paula would have clocked them out at; `rootNote` compensates.
 */
const MOD_SAMPLE_RATE = 44100;

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
 * One `TrackerSample` per sample the pattern data actually references.
 *
 * MOD keeps the file's own numbering rather than packing: sample 7 lands in
 * slot 7, because a cell's sample byte *is* the instrument id (see
 * `buildModTrackerPatterns`). Samples past `TOTAL_SLOTS` are dropped; they
 * would have nowhere to live.
 */
export function buildModTrackerSamples(mod: ModSong): TrackerSampleSet {
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

  const samples: TrackerSample[] = [];
  const slotForInstrument = new Map<number, number>();

  for (const sampleNumber of [...usedSamples].sort((a, b) => a - b)) {
    if (sampleNumber < 1 || sampleNumber > mod.samples.length) continue;
    // Extra samples beyond the available slots are ignored; they show up with
    // instrument ids that have no instrument behind them.
    if (sampleNumber > TOTAL_SLOTS) continue;

    const sample = mod.samples[sampleNumber - 1];
    if (!sample) continue;

    const sampleLengthFrames = Math.max(1, sample.length);
    // ProTracker marks "no loop" with a loop length of 2 words or less.
    const loopEnabled = sample.loopLength > 2;
    const channelCount = channelsPerSample.get(sampleNumber)?.size ?? 1;

    samples.push({
      slot: sampleNumber,
      sourceIndex: sampleNumber,
      name: sample.name,
      data: convertSampleToFloat32(sample),
      sampleRate: MOD_SAMPLE_RATE,
      // Empirically calibrated root note for MOD import. A fixed root of 65
      // keeps most instruments (including AmegAs) close to their original
      // ProTracker pitch; per-sample finetune is baked into detune instead.
      rootNote: 65,
      // MOD finetune is -8..7 in 1/8 semitone steps.
      detuneCents: ((sample.finetune ?? 0) / 8) * 100,
      // Unity. The sample's default volume (0-64) is a *channel* volume in
      // ProTracker, not a property of the sample, and it already reaches
      // playback through the volume column -- every note with a sample number
      // is stamped with it at import. Baking it in here as well made the
      // instrument permanently quiet everywhere the volume column is not in
      // charge, most visibly when auditioning it from the keyboard: sample 23
      // of GSLINGER.MOD has a header volume of 8, so it played at an eighth of
      // the level of any sample whose header says 64, with no way to turn it
      // up.
      gain: 1,
      loop: loopEnabled ? 'forward' : 'off',
      loopStartFrames: loopEnabled ? sample.loopStart : 0,
      loopLengthFrames: loopEnabled ? sample.loopLength : sampleLengthFrames,
      // One voice per channel that ever plays this sample, so every channel
      // owns one and none has to steal. Four is right for a classic 4-channel
      // module and badly short for the multi-channel ones.
      voiceCount: Math.max(4, Math.min(32, channelCount)),
    });
    slotForInstrument.set(sampleNumber, sampleNumber);
  }

  return { samples, slotForInstrument };
}
