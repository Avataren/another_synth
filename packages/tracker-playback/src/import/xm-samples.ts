/**
 * FastTracker 2 XM instruments -> the tracker instrument model.
 *
 * The instrument half of the XM importer: `XmInstrument`s in, `TrackerSample`s
 * out, envelopes and auto-vibrato included. Turning one into whatever the host
 * plays is the host's business; this app's answer is
 * `src/audio/tracker/sampler-patch-builder.ts`.
 */
import type { XmSong, XmInstrument, XmSample } from '../formats/xm';
import type {
  TrackerSample,
  TrackerSampleSet,
  TrackerVolumeEnvelope,
  TrackerPanningEnvelope,
  TrackerAutoVibrato,
} from '../tracker-sample';
import { TOTAL_SLOTS } from '../song-constants';

/**
 * The sample buffer is declared at this rate regardless of its true rate, and
 * the root note compensates. Matches what mod-import does.
 */
const ASSET_SAMPLE_RATE = 44100;

/**
 * MIDI note at which an XM sample with relativeNote 0 plays untransposed.
 *
 * The sampler computes playbackRate = scheduledFrequency / f(rootNote), and we
 * schedule frequencies in musical Hz (the XM rate divided by 32, see
 * pitch-model.ts). For the buffer -- declared at ASSET_SAMPLE_RATE -- to play
 * back at the XM rate, f(rootNote) must equal ASSET_SAMPLE_RATE / 32, so
 *
 *   rootNote = 69 + 12*log2(ASSET_SAMPLE_RATE / 32 / 440) = 88.77
 *
 * The same derivation with MOD's /128 scale gives 64.77, which is where
 * mod-import's empirically calibrated root note of 65 comes from -- a useful
 * check that this is the right relation rather than a fitted number.
 */
export const XM_ROOT_NOTE =
  69 + 12 * Math.log2(ASSET_SAMPLE_RATE / 32 / 440);

/** XM finetune spans -128..127 across one semitone. */
const FINETUNE_UNITS_PER_SEMITONE = 128;

/**
 * How many distinct channels ever play each instrument.
 *
 * A tracker channel is monophonic and owns a voice of its own, so an
 * instrument needs one voice per channel that ever uses it -- not merely
 * enough for the peak overlap. Sizing by peak would leave a channel without a
 * voice of its own and put it back to stealing from another channel, which is
 * heard as notes going missing.
 *
 * Voices cost nothing until a note actually sounds on them: the instrument
 * only builds audio nodes at note-on.
 */
function measureChannelsPerInstrument(xm: XmSong): Map<number, Set<number>> {
  const channels = new Map<number, Set<number>>();

  for (const pattern of xm.patterns) {
    for (const row of pattern.rows) {
      row.forEach((cell, channel) => {
        if (cell.instrument > 0) {
          let set = channels.get(cell.instrument);
          if (!set) {
            set = new Set<number>();
            channels.set(cell.instrument, set);
          }
          set.add(channel);
        }
      });
    }
  }

  return channels;
}

/**
 * Convert an XM instrument's volume envelope into the engine's form.
 *
 * Returns undefined when the instrument has no *enabled* volume envelope, and
 * deliberately ignores the fadeout in that case.
 *
 * FastTracker 2's key-off branches on exactly that flag: with a volume
 * envelope it clears sustain and lets the envelope and fadeout run, and
 * without one it sets the channel volume to zero on the spot. The fadeout
 * field still holds a value on such instruments -- it is simply never heard,
 * because the volume is already zero.
 *
 * Building an envelope out of the fadeout alone therefore turns an instant cut
 * into a long fade. `elw-sick.xm` is where that showed: eleven of the
 * instruments playing into order 10 have the envelope switched off with
 * fadeout 128, which is 32768/128 = 256 ticks, over five seconds at its tempo.
 * The pattern opens with key-offs on six channels meant to clear the way, and
 * instead every one of those notes ran on into the next pattern.
 */
function toTrackerEnvelope(
  instrument: XmInstrument,
): TrackerVolumeEnvelope | undefined {
  const env = instrument.volumeEnvelope;
  const hasEnvelope = env.enabled && env.points.length > 0;
  if (!hasEnvelope) return undefined;

  return {
    points: env.points.map((p) => ({ tick: p.frame, value: p.value })),
    // A sustain point only applies when the instrument enables sustain;
    // otherwise the envelope runs straight through.
    sustainPoint: env.sustainEnabled ? env.sustainPoint : -1,
    loopStart: env.loopStart,
    loopEnd: env.loopEnd,
    loopEnabled: env.loopEnabled,
    fadeout: instrument.volumeFadeout,
  };
}

/**
 * The instrument's panning envelope, or undefined when it has none.
 *
 * Unlike the volume envelope there is no fadeout counterpart, so an instrument
 * with the envelope disabled carries nothing at all. 20 of the 219 instruments
 * in the local XM corpus enable one, and they account for 7.3% of played
 * notes.
 */
function toPanningEnvelope(
  instrument: XmInstrument,
): TrackerPanningEnvelope | undefined {
  const env = instrument.panningEnvelope;
  if (!env.enabled || env.points.length === 0) return undefined;
  return {
    points: env.points.map((p) => ({ tick: p.frame, value: p.value })),
    sustainPoint: env.sustainEnabled ? env.sustainPoint : -1,
    loopStart: env.loopStart,
    loopEnd: env.loopEnd,
    loopEnabled: env.loopEnabled,
  };
}

/**
 * The instrument's autovibrato, or undefined when it asks for none.
 *
 * A zero depth means no vibrato however the other fields are set, so those
 * instruments carry no extra state. 20 of the 219 instruments in the local XM
 * corpus declare one, and they account for 13.4% of all played notes.
 */
function toAutoVibrato(
  instrument: XmInstrument,
): TrackerAutoVibrato | undefined {
  if (instrument.vibratoDepth <= 0 || instrument.vibratoRate <= 0) {
    return undefined;
  }
  return {
    type: instrument.vibratoType,
    sweepTicks: instrument.vibratoSweep,
    depth: instrument.vibratoDepth,
    rate: instrument.vibratoRate,
  };
}

/**
 * One `TrackerSample` per instrument, at the slot with the instrument's own
 * number.
 *
 * XM files routinely declare far more instruments than they use --
 * jt_letgo.xm declares 128 and uses 8 -- but a slot table sized to XM's own
 * maximum holds them all, and keeping the file's numbering is what lets an
 * edited song be written back as the same instrument list. Instruments with
 * no sample take no slot. Only a file declaring more instruments than there
 * are slots falls back to packing the referenced ones down.
 * `slotForInstrument` carries the mapping to the pattern half.
 */
export function buildXmTrackerSamples(xm: XmSong): TrackerSampleSet {
  const channelsPerInstrument = measureChannelsPerInstrument(xm);
  const samples: TrackerSample[] = [];
  const slotForInstrument = new Map<number, number>();

  let order: number[];
  let identity = true;
  if (xm.instruments.length <= TOTAL_SLOTS) {
    order = xm.instruments.map((_, i) => i + 1);
  } else {
    identity = false;
    const referenced = new Set<number>();
    for (const pattern of xm.patterns) {
      for (const row of pattern.rows) {
        for (const cell of row) {
          if (cell.instrument > 0) referenced.add(cell.instrument);
        }
      }
    }
    order = [...referenced].sort((a, b) => a - b);
  }

  let nextSlot = 1;
  for (const instrumentNumber of order) {
    const instrument = xm.instruments[instrumentNumber - 1];
    if (!instrument || instrument.samples.length === 0) continue;
    const slot = identity ? instrumentNumber : nextSlot;
    if (slot > TOTAL_SLOTS) {
      // eslint-disable-next-line no-console
      console.warn(
        `[XM Import] Out of instrument slots; dropping instrument ${instrumentNumber}`,
      );
      break;
    }
    samples.push(
      trackerSampleFromXm(
        instrument,
        slot,
        instrumentNumber,
        channelsPerInstrument.get(instrumentNumber)?.size ?? 1,
      ),
    );
    slotForInstrument.set(instrumentNumber, slot);
    nextSlot++;
  }

  return { samples, slotForInstrument };
}

/** XM keymap (note 0 = C-0) -> the sample's index, clamped to what exists. */
export function xmZoneMap(instrument: XmInstrument): number[] {
  const last = Math.max(0, instrument.samples.length - 1);
  return Array.from({ length: 96 }, (_, n) =>
    Math.min(last, instrument.keymap[n] ?? 0),
  );
}

function zoneFields(sample: XmSample) {
  const sampleLengthFrames = Math.max(1, sample.data.length);
  const loopEnabled = sample.loopType !== 'none' && sample.loopLength > 0;
  return {
    name: sample.name,
    data: sample.data,
    sampleRate: ASSET_SAMPLE_RATE,
    // relativeNote transposes the sample, which is equivalent to moving the
    // root note the other way. Folding it in here keeps note scheduling free
    // of per-sample tuning.
    rootNote: XM_ROOT_NOTE - sample.relativeNote,
    detuneCents: (sample.finetune / FINETUNE_UNITS_PER_SEMITONE) * 100,
    // Unity -- the sample's default volume reaches playback through the
    // volume column, which stamps it on every note carrying an instrument.
    // Baking it in here too left quiet-headered samples permanently
    // attenuated; see the same note in mod-samples.ts.
    gain: 1,
    // The sample header's default panning (byte 15), FT2's `s->panning`:
    // reset on every trigger, offset around by the panning envelope while it
    // runs, replaced outright by Cxx/8xx. 0..255 -> 0..1; centre (128) is
    // left unset -- the engine's historical default.
    ...(sample.panning !== 128 ? { pan: sample.panning / 255 } : {}),
    loop: loopEnabled
      ? sample.loopType === 'pingpong'
        ? ('pingpong' as const)
        : ('forward' as const)
      : ('off' as const),
    loopStartFrames: loopEnabled ? sample.loopStart : 0,
    loopLengthFrames: loopEnabled ? sample.loopLength : sampleLengthFrames,
  };
}

/**
 * An XM instrument as the tracker instrument model: sample 0 is the primary
 * sample, the rest are zones reached through the keymap. A single-sample
 * instrument carries no zones.
 */
export function trackerSampleFromXm(
  instrument: XmInstrument,
  slot: number,
  instrumentNumber: number,
  channelCount: number,
): TrackerSample {
  const first = instrument.samples[0];
  if (!first) throw new Error('XM instrument has no sample');
  const envelope = toTrackerEnvelope(instrument);
  const autoVibrato = toAutoVibrato(instrument);
  const panEnvelope = toPanningEnvelope(instrument);

  const map = xmZoneMap(instrument);
  // Every sample travels, even ones the keymap never reaches: the editor and
  // the .xm exporter need them.
  const multi = instrument.samples.length > 1;

  return {
    slot,
    sourceIndex: instrumentNumber,
    ...zoneFields(first),
    name: instrument.name || first.name,
    // One voice per channel that ever plays this instrument, so every channel
    // owns one and none has to steal.
    voiceCount: Math.max(1, Math.min(32, channelCount)),
    ...(envelope ? { volumeEnvelope: envelope } : {}),
    ...(panEnvelope ? { panEnvelope } : {}),
    ...(autoVibrato ? { autoVibrato } : {}),
    ...(multi
      ? {
          zones: instrument.samples.slice(1).map(zoneFields),
          zoneMap: map,
        }
      : {}),
  };
}
