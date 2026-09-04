/**
 * Scream Tracker 3 S3M instruments -> the tracker instrument model.
 *
 * The instrument half of the S3M importer: `S3mInstrument`s in,
 * `TrackerSample`s out. AdLib instruments come through too, carrying their OPL
 * register bytes instead of PCM -- they take a slot and play nothing, which is
 * how "parsed and preserved, inactive until the OPL core exists" is expressed.
 */
import type { S3mSong, S3mInstrument } from '../formats/s3m';
import type { TrackerSample, TrackerSampleSet } from '../tracker-sample';
import { TOTAL_SLOTS } from '../song-constants';

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

/**
 * The root note folds the sample's c2spd in (it is per-sample finetune in
 * S3M, D96): a sample whose c2spd differs from 8363 must play proportionally
 * faster/slower, so rootNote = S3M_ROOT_NOTE - 12*log2(c2spd/8363).
 */
function rootNoteForSample(sample: S3mInstrument): number {
  const c2spd = sample.c2spd > 0 ? sample.c2spd : S3M_C2FREQ;
  return S3M_ROOT_NOTE - 12 * Math.log2(c2spd / S3M_C2FREQ);
}

/**
 * One `TrackerSample` per instrument the pattern data actually references.
 *
 * The D76 guard: S3M declares up to 99 instruments and 130 slots cover them,
 * but only the referenced ones are allocated, packed into consecutive slots.
 * `slotForInstrument` carries that mapping to the pattern half.
 *
 * AdLib instruments consume a slot like any other -- they are part of the
 * song's instrument numbering -- but only PCM ones can be played, so only
 * those go into `slotForInstrument`.
 */
export function buildS3mTrackerSamples(s3m: S3mSong): TrackerSampleSet {
  const referenced = new Set<number>();
  for (const pattern of s3m.patterns) {
    for (const row of pattern.rows) {
      for (const cell of row) {
        if (cell.instrument > 0) referenced.add(cell.instrument);
      }
    }
  }

  const samples: TrackerSample[] = [];
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

    // AdLib/OPL: preserve the parsed register data, marked inactive by having
    // no sample data. Morten, 2026-09-03: the future OPL instrument type
    // consumes these bytes, so that phase never needs a re-parse.
    if (instrument.kind === 'adlib') {
      samples.push({
        slot: nextSlot,
        sourceIndex: instrumentNumber,
        name: instrument.name,
        data: new Float32Array(0),
        sampleRate: ASSET_SAMPLE_RATE,
        rootNote: S3M_ROOT_NOTE,
        detuneCents: 0,
        gain: 1,
        loop: 'off',
        loopStartFrames: 0,
        loopLengthFrames: 0,
        voiceCount: 1,
        opl: {
          kind: instrument.adlibKind ?? 'melody',
          registers: instrument.oplRegisters ?? [],
          volume: instrument.adlibVolume ?? 0,
          c2spd: instrument.c2spd,
        },
      });
      nextSlot++;
      continue;
    }

    // Stereo, packed or empty: counted and warned about by `measureS3m`, and
    // dropped here because there is nothing to play.
    if (instrument.data.length === 0) continue;

    samples.push(
      toTrackerSample(
        instrument,
        nextSlot,
        instrumentNumber,
        channelsPerInstrument.get(instrumentNumber)?.size ?? 1,
      ),
    );
    // Only PCM instruments map into the playable slot space.
    slotForInstrument.set(instrumentNumber, nextSlot);
    nextSlot++;
  }

  return { samples, slotForInstrument };
}

function toTrackerSample(
  sample: S3mInstrument,
  slot: number,
  instrumentNumber: number,
  channelCount: number,
): TrackerSample {
  const sampleLengthFrames = Math.max(1, sample.data.length);
  const loopEnabled = sample.loopEnabled && sample.loopEnd > sample.loopStart;

  return {
    slot,
    sourceIndex: instrumentNumber,
    name: sample.name,
    data: sample.data,
    sampleRate: ASSET_SAMPLE_RATE,
    rootNote: rootNoteForSample(sample),
    detuneCents: 0,
    // Unity -- the sample's default volume reaches playback through the
    // volume stamped on every note carrying an instrument, exactly as in the
    // XM/MOD importers.
    gain: 1,
    // S3M has no ping-pong loop.
    loop: loopEnabled ? 'forward' : 'off',
    loopStartFrames: loopEnabled ? sample.loopStart : 0,
    loopLengthFrames: loopEnabled
      ? sample.loopEnd - sample.loopStart
      : sampleLengthFrames,
    // One voice per channel that ever plays this instrument, so every
    // channel owns one and none has to steal.
    voiceCount: Math.max(1, Math.min(32, channelCount)),
  };
}
